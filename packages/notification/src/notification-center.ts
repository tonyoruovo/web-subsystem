/**
 * @fileoverview
 * @summary The Notification Center: broadcast routing, subscriptions, access control and history.
 * @description
 * Implements the Notification Center of docs/ARCHITECTURE.md §10 and §10.1
 * (amendment A10). It owns **routing only**: the Queue owns scheduling and
 * retries and hands every broadcast to {@linkcode NotificationCenter.fanOut}.
 *
 * ```text
 *   Queue --fanOut(kernel, envelope)--> Notification Center
 *                                       +-- access control: may the source publish this event?
 *                                       +-- subscribers: subsystems listing it in `subscribes`
 *                                       |                + programmatic subscriptions
 *                                       |   each: access control, circuit breaker, filter
 *                                       |   each gets its own copy of the payload
 *                                       +-- history: one record and one trail per broadcast
 *                                       +-- scope relay (Window, Global): sent on beyond this tab
 *   ```
 *
 * A subscriber that throws is recorded as failed; it never fails the
 * broadcast or the sender.
 *
 * @example
 * Wiring it to the Queue and the kernel
 * ```ts
 * import { Kernel } from '@platform/core';
 * import { createNotificationCenter } from '@platform/notification';
 * import { createQueue } from '@platform/queue';
 *
 * const notification = createNotificationCenter({
 *   events: [{ eventId: 'auth:login', publishers: ['auth'] }],
 * });
 * const queue = createQueue({ fanOut: notification.fanOut });
 * const kernel = new Kernel([queue.subsystem, notification.subsystem, ...subsystems], {
 *   router: queue.router,
 * });
 * ```
 *
 * @example
 * Subscribing from UI code
 * ```ts
 * const control = kernel.unit<NotificationControl>('notification').control!;
 * const stop = control.commands.subscribe('auth:login', (payload) => showWelcome(payload));
 * ```
 *
 * @throws {BroadcastRejectedError} From {@linkcode NotificationCenter.fanOut} when access control or strict mode refuses a broadcast.
 * @author MathAid
 */

import {
  UnitUnavailableError,
  appendFingerprint,
  createRingBuffer,
  defineSubsystem,
  makeFingerprint,
  type FingerprintTrail,
  type Kernel,
  type PacketEnvelope,
  type PacketHeader,
  type Scope,
  type ScopeRelay,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import { CircuitBreakers } from './circuit-breaker';

/**
 * @summary The id the Notification Center registers under.
 * @constant {'notification'}
 * @public
 */
export const NOTIFICATION_ID = 'notification';

/**
 * @summary A registered event, with its access control.
 *
 * @description
 * `eventId` names the event. `publishers` lists the subsystems allowed to
 * broadcast it, and `subscribers` those allowed to receive it; leaving a list
 * out allows everyone. `description` documents the event.
 *
 * Register events up front (`events` option) or later (`registerEvent`).
 * With `strict: true`, unregistered events are refused.
 *
 * @example
 * Example 1: Only Auth may announce a login
 * ```ts
 * const login: EventDefinition = { eventId: 'auth:login', publishers: ['auth'] };
 * ```
 *
 * @example
 * Example 2: Only consented analytics may hear page views
 * ```ts
 * const pageView: EventDefinition = { eventId: 'ui:page-view', subscribers: ['analytics', 'app'] };
 * ```
 *
 * @public
 */
export interface EventDefinition {
  readonly eventId: string;
  readonly description?: string;
  /** Subsystems allowed to broadcast the event. Absent: anyone. */
  readonly publishers?: readonly string[];
  /** Subscribers allowed to receive the event. Absent: anyone. */
  readonly subscribers?: readonly string[];
}

/**
 * @summary A programmatic subscriber: receives a copy of the payload and the packet's header.
 * @description It may be async. What it throws is recorded as a failed delivery.
 * @public
 */
export type EventListener = (payload: unknown, header: PacketHeader) => void | Promise<void>;

/**
 * @summary Options for a programmatic subscription.
 *
 * @description
 * `subscriber` names it for access control and history (default `'app'`).
 * `priority` orders deliveries, higher first (default `0`, the same as
 * subsystem subscribers). `filter` skips payloads it returns `false` for.
 * `maxExecutions` removes the subscription after that many deliveries.
 *
 * @example
 * Example 1: A one-off subscription
 * ```ts
 * subscribe('sync:done', resolve, { maxExecutions: 1 });
 * ```
 *
 * @example
 * Example 2: Only large uploads, before anyone else
 * ```ts
 * subscribe('storage:changed', onBig, { priority: 10, filter: (p) => (p as { size: number }).size > 1e6 });
 * ```
 *
 * @public
 */
export interface SubscriptionOptions {
  readonly subscriber?: string;
  readonly priority?: number;
  readonly filter?: (payload: unknown) => boolean;
  readonly maxExecutions?: number;
}

/**
 * @summary What happened to one delivery of a broadcast.
 *
 * @example
 * Example 1: Delivered
 * ```ts
 * // { subscriber: 'audit', outcome: 'delivered', reason: null }
 * ```
 *
 * @example
 * Example 2: Skipped by an open circuit
 * ```ts
 * // { subscriber: 'analytics', outcome: 'skipped', reason: 'circuit open' }
 * ```
 *
 * @public
 */
export interface DeliveryRecord {
  readonly subscriber: string;
  readonly outcome: 'delivered' | 'failed' | 'skipped';
  readonly reason: string | null;
}

/**
 * @summary One broadcast, as kept in the history.
 *
 * @description
 * Identifies the broadcast (`messageId`, `traceId`, `eventId`, `source`,
 * `timestamp`), says whether it came from another tab (`remote`), whether
 * it was `fanned-out` or `rejected` (with the `reason`), lists every
 * delivery, names the scope relay it was sent on to (`relayed`, or `null`),
 * and holds the full fingerprint `trail`: the sender's entries,
 * `fanned-out`, one entry per delivery, then `relayed` when it was.
 *
 * @example
 * Example 1: Reading the latest broadcast
 * ```ts
 * const [latest] = control.views.history.getSnapshot().slice(-1);
 * console.table(latest.deliveries);
 * ```
 *
 * @example
 * Example 2: Following a trace
 * ```ts
 * history.getSnapshot().filter((r) => r.traceId === traceId);
 * ```
 *
 * @public
 */
export interface BroadcastRecord {
  readonly messageId: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly source: string;
  readonly timestamp: number;
  readonly remote: boolean;
  readonly outcome: 'fanned-out' | 'rejected';
  readonly relayed: Scope | null;
  readonly reason: string | null;
  readonly deliveries: readonly DeliveryRecord[];
  readonly trail: FingerprintTrail;
}

/**
 * @summary The Notification Center's state: counters.
 *
 * @example
 * Example 1: A quiet platform
 * ```ts
 * // { events: 4, subscriptions: 2, broadcasts: 10, delivered: 18, failed: 0, rejected: 0, relayed: 3 }
 * ```
 *
 * @example
 * Example 2: Alerting on failing subscribers
 * ```ts
 * if (state.getSnapshot().failed! > 0) console.warn('a subscriber is failing');
 * ```
 *
 * @public
 */
export interface NotificationData {
  /** Registered events. */
  events: number;
  /** Programmatic subscriptions. */
  subscriptions: number;
  /** Broadcasts fanned out. */
  broadcasts: number;
  /** Deliveries that succeeded. */
  delivered: number;
  /** Deliveries that threw. */
  failed: number;
  /** Broadcasts refused. */
  rejected: number;
  /** Broadcasts sent on to a scope relay. */
  relayed: number;
}

/**
 * @summary The Notification Center's control interface.
 *
 * @description
 * `registerEvent` adds or replaces an event definition. `subscribe` adds a
 * programmatic subscription and returns its unsubscribe function. `observe`
 * calls an observer with every history record (the view keeps only the last
 * ones) and returns the function that stops it. `attachRelay` attaches the
 * scope relay for one scope (replacing any earlier one) and returns the
 * function that detaches it: every broadcast of that scope sent from this tab
 * is handed to it after the local fan-out. Views: `state` (counters) and
 * `history` (the last broadcasts, oldest first).
 *
 * @example
 * Example 1: Registering an event at runtime
 * ```ts
 * control.commands.registerEvent({ eventId: 'chat:typing', publishers: ['chat'] });
 * ```
 *
 * @example
 * Example 2: A subscription tied to a component's life
 * ```ts
 * onMounted(() => (stop = control.commands.subscribe('chat:typing', showTyping)));
 * onUnmounted(() => stop());
 * ```
 *
 * @public
 */
export interface NotificationControl {
  readonly commands: {
    registerEvent(definition: EventDefinition): void;
    subscribe(eventId: string, listener: EventListener, options?: SubscriptionOptions): () => void;
    observe(observer: (record: BroadcastRecord) => void): () => void;
    attachRelay(relay: ScopeRelay): () => void;
  };
  readonly views: {
    readonly state: View<Partial<NotificationData>>;
    readonly history: View<readonly BroadcastRecord[]>;
  };
}

/**
 * @summary Options for {@linkcode createNotificationCenter}.
 *
 * @description
 * `events` registers events up front. `strict` refuses broadcasts of
 * unregistered events (default `false`). `historySize` bounds the history
 * (default 100). `failureThreshold` and `resetTimeoutMs` tune the circuit
 * breakers (defaults 3 and 30 000 ms). `now` replaces the clock.
 *
 * @example
 * Example 1: A strict registry
 * ```ts
 * createNotificationCenter({ strict: true, events: catalog });
 * ```
 *
 * @example
 * Example 2: Fast breakers in a test
 * ```ts
 * createNotificationCenter({ failureThreshold: 1, resetTimeoutMs: 10 });
 * ```
 *
 * @public
 */
export interface NotificationOptions {
  readonly events?: readonly EventDefinition[];
  readonly strict?: boolean;
  readonly historySize?: number;
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * @summary Thrown when a broadcast is refused: the source may not publish the event, or strict mode does not know it.
 *
 * @example
 * Example 1: An unauthorized publisher
 * ```ts
 * await ctx.port.send({ eventId: 'auth:login', payload }); // from 'ui': rejects with BroadcastRejectedError
 * ```
 *
 * @example
 * Example 2: Reading why
 * ```ts
 * catch (error) { if (error instanceof BroadcastRejectedError) console.warn(error.eventId, error.message); }
 * ```
 *
 * @public
 */
export class BroadcastRejectedError extends Error {
  override readonly name = 'BroadcastRejectedError';

  /**
   * @param {string} eventId The refused event.
   * @param {string} reason Why.
   */
  constructor(
    readonly eventId: string,
    reason: string,
  ) {
    super(`Broadcast of "${eventId}" refused: ${reason}`);
  }
}

/**
 * @summary How a broadcast reached this tab, for {@linkcode NotificationCenter.fanOut}.
 *
 * @description
 * `remote: true` marks a broadcast that came from another tab (through a
 * scope relay and the Queue's `ingest`). It is delivered to every
 * subscriber here, including one with the sender's id (that is another
 * instance of it), and it is not relayed again.
 *
 * @example
 * Example 1: A local broadcast (the default)
 * ```ts
 * await notification.fanOut(kernel, envelope);
 * ```
 *
 * @example
 * Example 2: One from another tab
 * ```ts
 * await notification.fanOut(kernel, envelope, { remote: true });
 * ```
 *
 * @public
 */
export interface FanOutOptions {
  readonly remote?: boolean;
}

/**
 * @summary The Notification Center: its subsystem and the fan-out the Queue calls.
 *
 * @description
 * `subsystem` is the centralized, tab-scoped subsystem to register with the
 * kernel. `fanOut(kernel, envelope)` delivers one broadcast to every allowed
 * subscriber; pass it to the Queue's `fanOut` option.
 *
 * @example
 * Example 1: Registering and wiring
 * ```ts
 * const notification = createNotificationCenter();
 * const queue = createQueue({ fanOut: notification.fanOut });
 * ```
 *
 * @example
 * Example 2: Using the fan-out without the Queue
 * ```ts
 * new Kernel([notification.subsystem, ...subsystems], {
 *   router: (kernel) => ({
 *     route: (envelope) =>
 *       envelope.metadata.target === null ? notification.fanOut(kernel, envelope) : kernel.deliver(envelope),
 *   }),
 * });
 * ```
 *
 * @public
 */
export interface NotificationCenter {
  readonly subsystem: SubsystemDefinition<NotificationData, NotificationControl>;
  /**
   * @summary Delivers one broadcast to every allowed subscriber.
   * @param {Kernel} kernel The kernel, to reach subsystem subscribers.
   * @param {PacketEnvelope} envelope The broadcast (`metadata.target` is `null`).
   * @param {FanOutOptions} [options] `remote: true` for a broadcast from another tab.
   * @returns {Promise<void>} Resolves once every subscriber has been handled (and the relay, if any, has it).
   * @throws {UnitUnavailableError} While the Notification Center is not running.
   * @throws {BroadcastRejectedError} When the source may not publish the event, or strict mode does not know it.
   */
  fanOut(kernel: Kernel, envelope: PacketEnvelope, options?: FanOutOptions): Promise<void>;
}

/** @summary A programmatic subscription. @internal */
interface Subscription {
  readonly key: string;
  readonly eventId: string;
  readonly listener: EventListener;
  readonly subscriber: string;
  readonly priority: number;
  readonly filter?: (payload: unknown) => boolean;
  readonly maxExecutions?: number;
  executions: number;
}

/** @summary One delivery target: a subsystem or a programmatic subscription. @internal */
type Target =
  | { readonly kind: 'unit'; readonly subscriber: string; readonly priority: number }
  | {
      readonly kind: 'listener';
      readonly subscriber: string;
      readonly priority: number;
      readonly subscription: Subscription;
    };

/**
 * @summary Creates the Notification Center.
 *
 * @description
 * Returns the subsystem (id {@linkcode NOTIFICATION_ID}, centralized, Tab
 * scope) and its `fanOut`. The two share one registry, one set of
 * subscriptions, one set of circuit breakers and one history.
 *
 * @example
 * Example 1: With an event catalogue
 * ```ts
 * const notification = createNotificationCenter({
 *   events: [
 *     { eventId: 'auth:login', publishers: ['auth'] },
 *     { eventId: 'storage:changed', publishers: ['storage'] },
 *   ],
 * });
 * ```
 *
 * @example
 * Example 2: Reading the history in a debug panel
 * ```ts
 * const history = kernel.unit<NotificationControl>('notification').control!.views.history;
 * history.subscribe(() => render(history.getSnapshot()));
 * ```
 *
 * @param {NotificationOptions} [options] Events, strict mode, history size, breaker tuning and clock.
 * @returns {NotificationCenter} The subsystem and its fan-out.
 *
 * @public
 */
export function createNotificationCenter(options: NotificationOptions = {}): NotificationCenter {
  const now = options.now ?? Date.now;
  const historySize = options.historySize ?? 100;
  const events = new Map((options.events ?? []).map((e) => [e.eventId, e]));
  const subscriptions: Subscription[] = [];
  const breakers = new CircuitBreakers({
    failureThreshold: options.failureThreshold ?? 3,
    resetTimeoutMs: options.resetTimeoutMs ?? 30_000,
    now,
  });
  const history = createRingBuffer<BroadcastRecord>(historySize);
  const observers = new Set<(record: BroadcastRecord) => void>();
  const relays = new Map<Scope, ScopeRelay>();
  let counters: ((update: (s: NotificationData) => void) => void) | null = null;
  let report: (error: unknown) => void = () => {};
  let nextKey = 0;

  const allowed = (list: readonly string[] | undefined, id: string) =>
    list === undefined || list.includes(id);

  const remember = (record: BroadcastRecord) => {
    history.push(record);
    for (const observer of [...observers]) {
      try {
        observer(record);
      } catch (error) {
        report(error);
      }
    }
  };

  const fingerprint = (actionName: string, extra: Parameters<typeof makeFingerprint>[2] = {}) =>
    makeFingerprint(NOTIFICATION_ID, actionName, { timestamp: now(), ...extra });

  async function fanOut(
    kernel: Kernel,
    envelope: PacketEnvelope,
    fanOutOptions: FanOutOptions = {},
  ): Promise<void> {
    if (!counters) throw new UnitUnavailableError(NOTIFICATION_ID, 'not running');
    const remote = fanOutOptions.remote === true;
    const { eventId, metadata } = envelope;
    const definition = events.get(eventId);
    const base = {
      messageId: metadata.messageId,
      traceId: metadata.traceId,
      eventId,
      source: metadata.source,
      timestamp: now(),
      remote,
    };

    const refusal =
      definition === undefined && options.strict
        ? 'the event is not registered'
        : !allowed(definition?.publishers, metadata.source)
          ? `"${metadata.source}" may not publish it`
          : null;
    if (refusal) {
      const trail = appendFingerprint(
        envelope.fingerprints,
        fingerprint('rejected', { level: 'WARN', message: refusal }),
      );
      remember({
        ...base,
        outcome: 'rejected',
        reason: refusal,
        deliveries: [],
        relayed: null,
        trail,
      });
      counters((s) => void s.rejected++);
      throw new BroadcastRejectedError(eventId, refusal);
    }

    let trail = appendFingerprint(envelope.fingerprints, fingerprint('fanned-out'));
    const stamped: PacketEnvelope = { ...envelope, fingerprints: trail };

    const targets: Target[] = [
      ...kernel
        .subscribers(eventId)
        .filter((id) => remote || id !== metadata.source) // a remote sender is another instance
        .map((id) => ({ kind: 'unit' as const, subscriber: id, priority: 0 })),
      ...subscriptions
        .filter((s) => s.eventId === eventId)
        .map((s) => ({
          kind: 'listener' as const,
          subscriber: s.subscriber,
          priority: s.priority,
          subscription: s,
        })),
    ]
      .filter((t) => allowed(definition?.subscribers, t.subscriber))
      .sort((a, b) => b.priority - a.priority); // stable: equal priorities keep their order

    const deliveries: DeliveryRecord[] = [];
    const record = (target: Target, outcome: DeliveryRecord['outcome'], reason: string | null) => {
      deliveries.push({ subscriber: target.subscriber, outcome, reason });
      trail = appendFingerprint(
        trail,
        fingerprint(outcome, {
          componentId: target.subscriber,
          level: outcome === 'failed' ? 'ERROR' : 'INFO',
          message: reason,
        }),
      );
    };

    for (const target of targets) {
      const key = target.kind === 'unit' ? `unit:${target.subscriber}` : target.subscription.key;
      if (!breakers.allows(key)) {
        record(target, 'skipped', 'circuit open');
        continue;
      }
      try {
        if (target.kind === 'unit') {
          await kernel.deliver(stamped, { to: target.subscriber, clone: true });
        } else {
          const subscription = target.subscription;
          const payload = structuredClone(envelope.payload);
          if (subscription.filter && !subscription.filter(payload)) {
            record(target, 'skipped', 'filtered');
            continue;
          }
          subscription.executions += 1;
          if (
            subscription.maxExecutions !== undefined &&
            subscription.executions >= subscription.maxExecutions
          ) {
            removeSubscription(subscription);
          }
          const { payload: _payload, ...header } = stamped;
          await subscription.listener(payload, header);
        }
        breakers.succeeded(key);
        record(target, 'delivered', null);
      } catch (error) {
        breakers.failed(key);
        record(target, 'failed', error instanceof Error ? error.message : String(error));
      }
    }

    // Send it on beyond this tab, without the trail: receivers start their own (ARCHITECTURE §9.4).
    const relay = remote ? undefined : relays.get(metadata.scope);
    let relayed: Scope | null = null;
    if (relay) {
      try {
        relay.publish({ ...envelope, fingerprints: { entries: [], dropped: 0 } });
        relayed = relay.scope;
        trail = appendFingerprint(trail, fingerprint('relayed', { componentId: relay.scope }));
      } catch (error) {
        report(error);
        trail = appendFingerprint(
          trail,
          fingerprint('relay-failed', {
            componentId: relay.scope,
            level: 'ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    remember({
      ...base,
      outcome: 'fanned-out',
      reason: null,
      deliveries,
      relayed,
      trail,
    });
    counters((s) => {
      s.broadcasts += 1;
      if (relayed) s.relayed += 1;
      s.delivered += deliveries.filter((d) => d.outcome === 'delivered').length;
      s.failed += deliveries.filter((d) => d.outcome === 'failed').length;
    });
  }

  function removeSubscription(subscription: Subscription): void {
    const index = subscriptions.indexOf(subscription);
    if (index < 0) return;
    subscriptions.splice(index, 1);
    breakers.forget(subscription.key);
    counters?.((s) => void (s.subscriptions = subscriptions.length));
  }

  const readable = { readable: true } as const;
  const subsystem = defineSubsystem({
    id: NOTIFICATION_ID,
    scope: 'tab',
    kind: 'centralized',
    state: {
      initial: {
        events: events.size,
        subscriptions: 0,
        broadcasts: 0,
        delivered: 0,
        failed: 0,
        rejected: 0,
        relayed: 0,
      } as NotificationData,
      policy: {
        events: readable,
        subscriptions: readable,
        broadcasts: readable,
        delivered: readable,
        failed: readable,
        rejected: readable,
        relayed: readable,
      },
    },
    init(ctx) {
      counters = (update) => ctx.state.update(update);
      report = (error) => ctx.report(error);
      return () => {
        counters = null;
        report = () => {};
      };
    },
    control: (ctx) => ({
      commands: {
        registerEvent(definition: EventDefinition) {
          events.set(definition.eventId, definition);
          ctx.state.update((s) => void (s.events = events.size));
        },
        subscribe(
          eventId: string,
          listener: EventListener,
          subscribeOptions: SubscriptionOptions = {},
        ) {
          const subscription: Subscription = {
            key: `listener:${++nextKey}`,
            eventId,
            listener,
            subscriber: subscribeOptions.subscriber ?? 'app',
            priority: subscribeOptions.priority ?? 0,
            filter: subscribeOptions.filter,
            maxExecutions: subscribeOptions.maxExecutions,
            executions: 0,
          };
          subscriptions.push(subscription);
          ctx.state.update((s) => void (s.subscriptions = subscriptions.length));
          return () => removeSubscription(subscription);
        },
        observe(observer: (record: BroadcastRecord) => void) {
          observers.add(observer);
          return () => void observers.delete(observer);
        },
        attachRelay(relay: ScopeRelay) {
          relays.set(relay.scope, relay);
          return () => {
            if (relays.get(relay.scope) === relay) relays.delete(relay.scope);
          };
        },
      },
      views: { state: ctx.state.readable, history: history.view },
    }),
  });

  return { subsystem, fanOut };
}
