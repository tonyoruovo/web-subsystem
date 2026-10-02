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
  /**
   * @summary The id of the event, for example `auth:login`.
   */
  readonly eventId: string;
  /**
   * @summary A text that tells what the event means.
   */
  readonly description?: string;
  /**
   * @summary The ids of the subsystems that can broadcast the event.
   * @description Without the list, any subsystem can broadcast it. A
   * broadcast from another subsystem fails with {@linkcode BroadcastRejectedError}.
   */
  readonly publishers?: readonly string[];
  /**
   * @summary The names of the subscribers that can receive the event.
   * @description Without the list, any subscriber receives it. A name is a
   * subsystem id or the `subscriber` of a programmatic subscription.
   */
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
  /**
   * @summary The name of the subscriber, for access control and history.
   * @description The default is `'app'`.
   */
  readonly subscriber?: string;
  /**
   * @summary The delivery order: a higher priority receives the broadcast first.
   * @description The default is 0, the same as subsystem subscribers.
   */
  readonly priority?: number;
  /**
   * @summary Skips the payloads for which it returns `false`.
   * @description A skipped delivery shows as `skipped` with the reason `filtered`.
   */
  readonly filter?: (payload: unknown) => boolean;
  /**
   * @summary The number of deliveries after which the subscription removes itself.
   * @description Without it, the subscription stays until you call its unsubscribe function.
   */
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
  /**
   * @summary The name of the subscriber: a subsystem id or a subscription name.
   */
  readonly subscriber: string;
  /**
   * @summary The result of the delivery.
   * @description `failed` means that the subscriber threw. `skipped` means
   * that its circuit was open or its filter refused the payload.
   */
  readonly outcome: 'delivered' | 'failed' | 'skipped';
  /**
   * @summary Why the delivery failed or was skipped, or `null` for a delivery.
   */
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
  /**
   * @summary The id of the broadcast packet.
   */
  readonly messageId: string;
  /**
   * @summary The id of the trace of the broadcast.
   */
  readonly traceId: string;
  /**
   * @summary The id of the event.
   */
  readonly eventId: string;
  /**
   * @summary The id of the subsystem that sent the broadcast.
   */
  readonly source: string;
  /**
   * @summary The time of the fan-out, in Unix milliseconds.
   */
  readonly timestamp: number;
  /**
   * @summary Tells if the broadcast came from another tab.
   */
  readonly remote: boolean;
  /**
   * @summary The result of the broadcast: `fanned-out` or `rejected`.
   * @description A failed delivery does not change the result. See `deliveries`.
   */
  readonly outcome: 'fanned-out' | 'rejected';
  /**
   * @summary The scope relay that got the broadcast, or `null`.
   */
  readonly relayed: Scope | null;
  /**
   * @summary Why the broadcast was rejected, or `null`.
   */
  readonly reason: string | null;
  /**
   * @summary One record for each subscriber, in delivery order.
   */
  readonly deliveries: readonly DeliveryRecord[];
  /**
   * @summary The full fingerprint trail of the broadcast.
   * @description The trail has the entries of the sender, then `fanned-out`,
   * one entry for each delivery, and `relayed` when a relay got it.
   */
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
  /**
   * @summary The number of registered events.
   */
  events: number;
  /**
   * @summary The number of programmatic subscriptions.
   */
  subscriptions: number;
  /**
   * @summary The number of broadcasts that the center fanned out.
   */
  broadcasts: number;
  /**
   * @summary The number of deliveries that succeeded.
   */
  delivered: number;
  /**
   * @summary The number of deliveries where the subscriber threw.
   */
  failed: number;
  /**
   * @summary The number of broadcasts that access control or strict mode refused.
   */
  rejected: number;
  /**
   * @summary The number of broadcasts that went to a scope relay.
   */
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
  /**
   * @summary The commands of the Notification Center.
   */
  readonly commands: {
    /**
     * @summary Adds an event definition, or replaces the one with the same id.
     * @example
     * Letting only Chat announce typing
     * ```ts
     * commands.registerEvent({ eventId: 'chat:typing', publishers: ['chat'] });
     * ```
     * @param {EventDefinition} definition The definition.
     */
    registerEvent(definition: EventDefinition): void;
    /**
     * @summary Adds a programmatic subscription to an event.
     * @description The listener gets a copy of the payload and the header of
     * the packet. A listener that throws is recorded as `failed`.
     * @example
     * A subscription that ends with a component
     * ```ts
     * const stop = commands.subscribe('chat:typing', showTyping, { subscriber: 'ui' });
     * onUnmounted(stop);
     * ```
     * @param {string} eventId The id of the event.
     * @param {EventListener} listener Called for each broadcast of the event.
     * @param {SubscriptionOptions} [options] The name, priority, filter and limit of the subscription.
     * @returns {() => void} Removes the subscription.
     */
    subscribe(eventId: string, listener: EventListener, options?: SubscriptionOptions): () => void;
    /**
     * @summary Calls an observer with each history record.
     * @description The `history` view keeps only the last records. Use this
     * command to see each record, as the Logger does.
     * @example
     * Archiving every broadcast
     * ```ts
     * const stop = commands.observe((record) => archive(record));
     * ```
     * @param {(record: BroadcastRecord) => void} observer Called with each new record.
     * @returns {() => void} Stops the observer.
     */
    observe(observer: (record: BroadcastRecord) => void): () => void;
    /**
     * @summary Attaches the scope relay for one scope.
     * @description After the local fan-out, the center gives each broadcast of
     * that scope that this tab sent to the relay. A new relay for the same scope
     * replaces the old one.
     * @example
     * Attaching the Window client
     * ```ts
     * const detach = commands.attachRelay({ scope: 'window', publish: (e) => client.publish(e) });
     * ```
     * @param {ScopeRelay} relay The relay.
     * @returns {() => void} Detaches the relay, if it is still the attached one.
     */
    attachRelay(relay: ScopeRelay): () => void;
  };
  /**
   * @summary The views of the Notification Center.
   */
  readonly views: {
    /**
     * @summary The counters of the Notification Center.
     */
    readonly state: View<Partial<NotificationData>>;
    /**
     * @summary The last broadcasts, oldest first.
     * @description The view keeps `historySize` records.
     */
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
  /**
   * @summary The events to register at the start.
   */
  readonly events?: readonly EventDefinition[];
  /**
   * @summary Refuses broadcasts of events that are not registered.
   * @description The default is `false`.
   */
  readonly strict?: boolean;
  /**
   * @summary The number of broadcasts that the history keeps.
   * @description The default is 100.
   */
  readonly historySize?: number;
  /**
   * @summary The number of failures in a row that opens the circuit of a subscriber.
   * @description The default is 3.
   */
  readonly failureThreshold?: number;
  /**
   * @summary The time that a circuit stays open, in milliseconds.
   * @description The default is 30000. After it, the breaker lets one delivery through as a test.
   */
  readonly resetTimeoutMs?: number;
  /**
   * @summary The clock, in Unix milliseconds.
   * @description The default is `Date.now`.
   */
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
  /**
   * @summary The name of the error class: `'BroadcastRejectedError'`.
   */
  override readonly name = 'BroadcastRejectedError';

  /**
   * @summary Creates the error for one refused broadcast.
   * @param {string} eventId The refused event.
   * @param {string} reason The reason.
   */
  constructor(
    /**
     * @summary The id of the refused event.
     */
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
  /**
   * @summary Marks a broadcast that came from another tab.
   * @description The default is `false`. A remote broadcast reaches a
   * subscriber with the id of the sender, and it does not go to a relay.
   */
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
  /**
   * @summary The subsystem to register with the kernel: id `notification`, centralized, Tab scope.
   */
  readonly subsystem: SubsystemDefinition<NotificationData, NotificationControl>;
  /**
   * @summary Delivers one broadcast to every allowed subscriber.
   * @description The Queue calls it for each broadcast. Give it to the Queue
   * as the `fanOut` option.
   * @example
   * Wiring it to the Queue
   * ```ts
   * const queue = createQueue({ fanOut: notification.fanOut });
   * ```
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
