/**
 * @fileoverview
 * @summary The Queue: the kernel's packet router, with admission, priorities, ordering, retries and dead letters.
 * @description
 * Implements the Queue of docs/ARCHITECTURE.md §10 and §10.1. Every packet a
 * port produces reaches {@linkcode Queue.router}; the Queue owns scheduling,
 * the kernel owns delivery, and the Notification Center owns broadcast fan-out.
 *
 * ```text
 *   port.send / port.request
 *     --> route(envelope)
 *           send rule (broadcasts stay in their sender's scope)    --> QueueRejectedError('scope')
 *           admission (Global State's canAccept, when it runs)      --> QueueRejectedError('admission')
 *           depth limit (CRITICAL is never refused)                 --> QueueRejectedError('overflow')
 *           stamp `enqueued`, beginWork
 *     --> waiting, by tier: CRITICAL > HIGH > MEDIUM > LOW, FIFO within a tier;
 *         packets sharing an orderingKey go one at a time
 *     --> dispatch (CRITICAL at once, the rest through the scheduler), at most maxActive at a time
 *           stamp `dispatched`
 *           request  --> kernel.deliver          broadcast --> fanOut (Notification Center)
 *   other tabs --ingest(envelope)--> deduplicate (messageId) --> new span, same trace --> admission
 *     --> waiting --> fanOut(kernel, envelope, { remote: true })
 *     --> settle
 *           completed                    stamp `completed`, resolve with the reply
 *           target not running           stamp `retry-scheduled`, retry with backoff; then dead letter
 *           expired                      dead letter
 *           target threw                 stamp `failed`, reject (not retried)
 *           endWork, record the trail
 *   ```
 *
 * Nothing is dispatched while the Queue is not running or is suspended;
 * packets wait. When the Queue is destroyed, waiting packets are refused
 * (`stopped`).
 *
 * @example
 * Wiring the three centralized subsystems
 * ```ts
 * const notification = createNotificationCenter();
 * const queue = createQueue({ fanOut: notification.fanOut });
 * const kernel = new Kernel(
 *   [createGlobalState(), queue.subsystem, notification.subsystem, ...subsystems],
 *   { router: queue.router },
 * );
 * ```
 *
 * @example
 * Following a packet
 * ```ts
 * const { views } = kernel.unit<QueueControl>('queue').control!;
 * views.trails.getSnapshot().find((p) => p.messageId === id)?.trail.entries;
 * ```
 *
 * @throws {QueueRejectedError} From the router when a packet is refused.
 * @author MathAid
 */

import {
  LateBinding,
  PacketExpiredError,
  UnitUnavailableError,
  appendFingerprint,
  assertSendAllowed,
  computeBackoff,
  createDeduplicator,
  createRingBuffer,
  createScheduler,
  createStore,
  defineSubsystem,
  makeFingerprint,
  type Fingerprint,
  type FingerprintTrail,
  type Importance,
  type Kernel,
  type PacketEnvelope,
  type PacketRouter,
  type SubsystemDefinition,
  type TaskPriority,
  type UnitContext,
} from '@platform/core';

import {
  QUEUE_ID,
  QueueRejectedError,
  type AdmissionControl,
  type DeadLetter,
  type FanOut,
  type FanOutOptions,
  type QueueControl,
  type QueueData,
  type QueueOptions,
  type RejectionReason,
  type SettledPacket,
} from './types';

/**
 * @summary The Queue: its subsystem and the router to give the kernel.
 *
 * @description
 * `subsystem` is the centralized, tab-scoped subsystem to register.
 * `router` is the kernel's `router` option. Both share one queue.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * const queue = createQueue();
 * new Kernel([queue.subsystem, ...subsystems], { router: queue.router });
 * ```
 *
 * @example
 * Example 2: Reading the counters
 * ```ts
 * kernel.unit<QueueControl>('queue').control!.views.state.getSnapshot().depth;
 * ```
 *
 * @public
 */
export interface Queue {
  readonly subsystem: SubsystemDefinition<QueueData, QueueControl>;
  /**
   * @summary Builds the kernel's packet router.
   * @param {Kernel} kernel The kernel that will route through it.
   * @returns {PacketRouter} The router.
   */
  router(kernel: Kernel): PacketRouter;
}

/** @summary Priority tiers, highest first. @internal */
const TIERS: readonly Importance[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** @summary Scheduler priority per tier (CRITICAL never goes through the scheduler). @internal */
const TASK_PRIORITY: Readonly<Record<Importance, TaskPriority>> = {
  CRITICAL: 'user-blocking',
  HIGH: 'user-blocking',
  MEDIUM: 'user-visible',
  LOW: 'background',
};

/** @summary Statuses of a target that may still come to run: worth a retry. @internal */
const RETRYABLE = new Set(['UNINITIALIZED', 'INITIALIZING', 'SUSPENDED', 'FAILED']);

/** @summary Statuses of a target that will never run again. @internal */
const FINAL = new Set(['DESTROYING', 'DESTROYED']);

/** @summary A packet held by the Queue. @internal */
interface Item {
  envelope: PacketEnvelope;
  readonly expectReply: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly kernel: Kernel;
  /** Came from another tab through `ingest`. */
  readonly remote: boolean;
  attempts: number;
  previousWait: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * @summary Creates the Queue.
 *
 * @description
 * Returns the subsystem (id {@linkcode QUEUE_ID}, centralized, Tab scope,
 * optionally depending on `global-state` for admission) and the router.
 * Broadcasts go to `options.fanOut` (the Notification Center's), or to the
 * kernel's direct broadcast without one.
 *
 * @example
 * Example 1: With the Notification Center
 * ```ts
 * const queue = createQueue({ fanOut: notification.fanOut });
 * ```
 *
 * @example
 * Example 2: Persisting dead letters once Storage runs
 * ```ts
 * const { commands } = kernel.unit<QueueControl>('queue').control!;
 * await commands.bindDeadLetterSink((letter) => storage.commands.append('dead-letters', letter));
 * ```
 *
 * @param {QueueOptions} [options] Fan-out, retries, limits, history sizes, scheduler, clock and jitter source.
 * @returns {Queue} The subsystem and its router.
 *
 * @public
 */
export function createQueue(options: QueueOptions = {}): Queue {
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 100;
  const retryStrategy = options.retryStrategy ?? 'exponential-jitter';
  const maxDepth = options.maxDepth ?? 1000;
  const maxActive = options.maxActive ?? 8;
  const deadLetterCapacity = options.deadLetterCapacity ?? 100;
  const trailHistory = options.trailHistory ?? 50;
  const scheduler = options.scheduler ?? createScheduler();
  const ids = options.ids ?? (() => crypto.randomUUID());
  const dedupe = createDeduplicator(options.dedupeCapacity ?? 1000);
  const fanOut: FanOut = options.fanOut ?? directFanOut;

  const tiers = new Map<Importance, Item[]>(TIERS.map((tier) => [tier, []]));
  const retrying = new Set<Item>();
  const busyKeys = new Set<string>();
  const trails = createRingBuffer<SettledPacket>(trailHistory);
  const observers = new Set<(settled: SettledPacket) => void>();
  const deadLetters = createStore<readonly DeadLetter[]>([]);
  const sink = new LateBinding<DeadLetter>({ capacity: deadLetterCapacity });
  let context: UnitContext<QueueData> | null = null;
  let suspended = false;
  let stopped = false;
  let active = 0;
  /** The kernel routing through the Queue, for replays. */
  let lastKernel: Kernel | null = null;

  const waiting = () => TIERS.reduce((sum, tier) => sum + tiers.get(tier)!.length, 0);
  const counters = (update?: (s: QueueData) => void) =>
    context?.state.update((s) => {
      update?.(s);
      s.depth = waiting() + retrying.size;
      s.inFlight = active;
      s.retrying = retrying.size;
      s.deadLetters = deadLetters.view.getSnapshot().length;
    });

  const fingerprint = (actionName: string, extra: Partial<Fingerprint> = {}) =>
    makeFingerprint(QUEUE_ID, actionName, { timestamp: now(), ...extra });

  const stamp = (item: Item, actionName: string, extra: Partial<Fingerprint> = {}) => {
    item.envelope = {
      ...item.envelope,
      fingerprints: appendFingerprint(item.envelope.fingerprints, fingerprint(actionName, extra)),
    };
  };

  const bounded = <T>(list: readonly T[], item: T, size: number) => {
    const next = [...list, item];
    return next.length > size ? next.slice(next.length - size) : next;
  };

  const record = (
    envelope: PacketEnvelope,
    outcome: SettledPacket['outcome'],
    reason: string | null,
    trail: FingerprintTrail = envelope.fingerprints,
  ) => {
    const { messageId, traceId, source, target } = envelope.metadata;
    const settled: SettledPacket = {
      messageId,
      traceId,
      eventId: envelope.eventId,
      source,
      target,
      outcome,
      reason,
      trail,
    };
    trails.push(settled);
    for (const observer of [...observers]) {
      try {
        observer(settled);
      } catch (error) {
        context?.report(error);
      }
    }
  };

  const admission = () => context?.dependency<AdmissionControl>('global-state');

  function refuse(envelope: PacketEnvelope, reason: RejectionReason, detail?: string): never {
    const message = detail ?? reason;
    const trail = appendFingerprint(
      envelope.fingerprints,
      fingerprint('rejected', { level: 'WARN', message }),
    );
    record(envelope, 'rejected', message, trail);
    counters((s) => void s.rejected++);
    throw new QueueRejectedError(reason, envelope.metadata.messageId);
  }

  async function route(
    kernel: Kernel,
    envelope: PacketEnvelope,
    expectReply: boolean,
    remote = false,
  ): Promise<unknown> {
    const { metadata, importance } = envelope;
    if (stopped) refuse(envelope, 'stopped');

    // The send rule binds this tab's senders; a remote sender was checked in its own tab.
    const senderScope = remote ? undefined : kernel.scopeOf(metadata.source);
    if (senderScope !== undefined) {
      try {
        assertSendAllowed({
          sender: metadata.source,
          senderScope,
          packetScope: metadata.scope,
          target: metadata.target,
        });
      } catch (error) {
        refuse(envelope, 'scope', (error as Error).message);
      }
    }
    const control = admission();
    if (control && !control.commands.canAccept(importance)) refuse(envelope, 'admission');
    if (importance !== 'CRITICAL' && waiting() + retrying.size >= maxDepth) {
      refuse(envelope, 'overflow');
    }

    return new Promise((resolve, reject) => {
      const item: Item = {
        envelope,
        expectReply,
        resolve,
        reject,
        kernel,
        remote,
        attempts: 0,
        previousWait: retryBaseMs,
        timer: null,
      };
      stamp(item, remote ? 'ingested' : 'enqueued');
      control?.commands.beginWork({
        id: metadata.messageId,
        subsystemId: metadata.source,
        importance,
        label: envelope.eventId,
      });
      tiers.get(importance)!.push(item);
      counters();
      pump();
    });
  }

  /** Takes the next item that may run: highest tier first, skipping busy ordering keys. */
  function next(): Item | undefined {
    for (const tier of TIERS) {
      const list = tiers.get(tier)!;
      const index = list.findIndex((item) => {
        const key = item.envelope.metadata.orderingKey;
        return key === undefined || !busyKeys.has(key);
      });
      if (index >= 0) return list.splice(index, 1)[0];
    }
    return undefined;
  }

  function pump(): void {
    while (context && !suspended && !stopped && active < maxActive) {
      const item = next();
      if (!item) break;
      const key = item.envelope.metadata.orderingKey;
      if (key !== undefined) busyKeys.add(key);
      active += 1;
      const run = () => dispatch(item);
      if (item.envelope.importance === 'CRITICAL') void run();
      else void scheduler.postTask(run, TASK_PRIORITY[item.envelope.importance]);
    }
    counters();
  }

  async function dispatch(item: Item): Promise<void> {
    const { metadata } = item.envelope;
    item.attempts += 1;
    try {
      if (metadata.ttl !== undefined && now() > metadata.timestamp + metadata.ttl) {
        throw new PacketExpiredError(`Packet ${metadata.messageId} expired before delivery.`);
      }
      stamp(item, 'dispatched', { counter: item.attempts > 1 ? item.attempts : null });
      let reply: unknown;
      if (metadata.target === null) {
        await fanOut(item.kernel, item.envelope, item.remote ? { remote: true } : undefined);
      } else {
        // The trail comes back with the target's own entries, whether it replies or throws.
        reply = await item.kernel.deliver(item.envelope, {
          onTrail: (trail) => (item.envelope = { ...item.envelope, fingerprints: trail }),
        });
      }
      stamp(item, 'completed');
      settle(item, 'completed', null);
      counters((s) => void s.completed++);
      item.resolve(item.expectReply ? reply : undefined);
    } catch (error) {
      failed(item, error);
    }
  }

  function failed(item: Item, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnitUnavailableError && RETRYABLE.has(error.status)) {
      if (item.attempts <= maxRetries) return retry(item, message);
      return deadLetter(item, 'undeliverable', error);
    }
    if (error instanceof UnitUnavailableError && FINAL.has(error.status)) {
      return deadLetter(item, 'undeliverable', error);
    }
    if (error instanceof PacketExpiredError) return deadLetter(item, 'expired', error);

    stamp(item, 'failed', { level: 'ERROR', message });
    settle(item, 'failed', message);
    counters((s) => void s.failed++);
    item.reject(error);
  }

  function retry(item: Item, message: string): void {
    const wait = computeBackoff({
      base: retryBaseMs,
      attempts: item.attempts,
      strategy: retryStrategy,
      previousWait: item.previousWait,
      random: options.random,
    });
    item.previousWait = wait;
    stamp(item, 'retry-scheduled', { level: 'WARN', counter: item.attempts, message });
    active -= 1; // keeps its ordering key, so later packets with that key stay behind it
    retrying.add(item);
    item.timer = setTimeout(() => {
      item.timer = null;
      retrying.delete(item);
      const key = item.envelope.metadata.orderingKey;
      if (key !== undefined) busyKeys.delete(key);
      tiers.get(item.envelope.importance)!.unshift(item);
      pump();
    }, wait);
    pump();
  }

  function deadLetter(item: Item, reason: DeadLetter['reason'], error: Error): void {
    stamp(item, 'dead-lettered', { level: 'ERROR', message: error.message });
    const letter: DeadLetter = {
      envelope: item.envelope,
      reason,
      attempts: item.attempts,
      failedAt: now(),
    };
    deadLetters.set(bounded(deadLetters.view.getSnapshot(), letter, deadLetterCapacity));
    void Promise.resolve()
      .then(() => sink.write(letter))
      .catch((sinkError: unknown) => console.warn('[queue] dead-letter sink failed:', sinkError));
    settle(item, 'dead-lettered', reason);
    counters();
    item.reject(error);
  }

  /** Releases an item that left the Queue: work tracking, ordering key, slot, trail. */
  function settle(item: Item, outcome: SettledPacket['outcome'], reason: string | null): void {
    const { messageId, orderingKey } = item.envelope.metadata;
    admission()?.commands.endWork(messageId);
    if (orderingKey !== undefined) busyKeys.delete(orderingKey);
    active -= 1;
    record(item.envelope, outcome, reason);
    pump();
  }

  /** Refuses every waiting packet: the Queue is going away. */
  function drain(): void {
    const pending = [...TIERS.flatMap((tier) => tiers.get(tier)!.splice(0)), ...retrying];
    for (const item of pending) {
      if (item.timer !== null) clearTimeout(item.timer);
      admission()?.commands.endWork(item.envelope.metadata.messageId);
      const trail = appendFingerprint(
        item.envelope.fingerprints,
        fingerprint('rejected', { level: 'WARN', message: 'stopped' }),
      );
      record(item.envelope, 'rejected', 'stopped', trail);
      item.reject(new QueueRejectedError('stopped', item.envelope.metadata.messageId));
    }
    retrying.clear();
    busyKeys.clear();
  }

  const readable = { readable: true } as const;
  const subsystem = defineSubsystem({
    id: QUEUE_ID,
    scope: 'tab',
    kind: 'centralized',
    requires: [{ target: 'global-state', kind: 'optional' }],
    state: {
      initial: {
        depth: 0,
        inFlight: 0,
        retrying: 0,
        deadLetters: 0,
        completed: 0,
        failed: 0,
        rejected: 0,
        duplicates: 0,
      } as QueueData,
      policy: {
        depth: readable,
        inFlight: readable,
        retrying: readable,
        deadLetters: readable,
        completed: readable,
        failed: readable,
        rejected: readable,
        duplicates: readable,
      },
    },
    init(ctx) {
      context = ctx;
      stopped = false;
      suspended = false;
      pump();
      return () => {
        stopped = true;
        drain();
        counters();
        context = null;
      };
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      pump();
    },
    control: (ctx) => ({
      commands: {
        replay(messageId: string): boolean {
          const letters = deadLetters.view.getSnapshot();
          const letter = letters.find((l) => l.envelope.metadata.messageId === messageId);
          if (!letter) return false;
          const kernel = lastKernel;
          if (!kernel) return false;
          deadLetters.set(letters.filter((l) => l !== letter));
          const { ttl: _ttl, ...metadata } = letter.envelope.metadata;
          const envelope: PacketEnvelope = {
            ...letter.envelope,
            metadata: { ...metadata, timestamp: now() },
            fingerprints: appendFingerprint(letter.envelope.fingerprints, fingerprint('replayed')),
          };
          counters();
          // The original caller is gone: the outcome is recorded in `trails` (and `deadLetters` again).
          route(kernel, envelope, false).catch(() => undefined);
          return true;
        },
        bindDeadLetterSink: (deadLetterSink: (letter: DeadLetter) => void | Promise<void>) =>
          sink.bind(deadLetterSink),
        unbindDeadLetterSink: () => sink.unbind(),
        async ingest(envelope: PacketEnvelope): Promise<boolean> {
          const kernel = lastKernel;
          if (!kernel || stopped)
            throw new QueueRejectedError('stopped', envelope.metadata.messageId);
          const { metadata } = envelope;
          if (metadata.target !== null || metadata.scope === 'page' || metadata.scope === 'tab') {
            refuse(envelope, 'scope', 'Only Window and Global broadcasts arrive from other tabs.');
          }
          if (dedupe.seen(metadata.messageId)) {
            ctx.state.update((s) => void s.duplicates++);
            return false;
          }
          // A receiver starts its own trail on the same trace (ARCHITECTURE §9.4).
          const received: PacketEnvelope = {
            ...envelope,
            metadata: { ...metadata, spanId: ids(), parentSpanId: metadata.spanId },
            fingerprints: { entries: [], dropped: 0 },
          };
          await route(kernel, received, false, true);
          return true;
        },
        observe(observer: (settled: SettledPacket) => void) {
          observers.add(observer);
          return () => void observers.delete(observer);
        },
      },
      views: { state: ctx.state.readable, trails: trails.view, deadLetters: deadLetters.view },
    }),
  });

  return {
    subsystem,
    router(kernel) {
      lastKernel = kernel;
      return { route: (envelope, expectReply) => route(kernel, envelope, expectReply) };
    },
  };
}

/**
 * @summary The fan-out without a Notification Center: the kernel's direct broadcast.
 * @description A remote broadcast also reaches a subscriber with the sender's
 * id (another instance of it); a subscriber that throws is not the sender's problem.
 * @internal
 */
async function directFanOut(
  kernel: Kernel,
  envelope: PacketEnvelope,
  options?: FanOutOptions,
): Promise<void> {
  if (!options?.remote) return kernel.broadcast(envelope);
  for (const id of kernel.subscribers(envelope.eventId)) {
    await kernel.deliver(envelope, { to: id, clone: true }).catch(() => undefined);
  }
}
