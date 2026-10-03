/**
 * @fileoverview
 * @summary The Queue's public types: options, records, state, control interface and errors.
 * @description
 * Declarations shared by `queue.ts` and its users. The Queue does not import
 * `@platform/global-state` or `@platform/notification`: it describes the
 * parts of them it uses ({@linkcode AdmissionControl}, {@linkcode FanOut}),
 * so the three packages stay independent.
 *
 * ```text
 *   QueueOptions --> createQueue() --> Queue { subsystem, router }
 *   every settled packet --> SettledPacket (in views.trails)
 *   every undeliverable packet --> DeadLetter (in views.deadLetters, and the late-bound sink)
 *   ```
 *
 * @example
 * Typing a Queue's control interface
 * ```ts
 * import type { QueueControl } from '@platform/queue';
 *
 * const queue = kernel.unit<QueueControl>('queue').control!;
 * queue.views.state.getSnapshot(); // { depth, inFlight, completed, ... }
 * ```
 *
 * @example
 * Telling rejections apart
 * ```ts
 * import { QueueRejectedError } from '@platform/queue';
 *
 * catch (error) {
 *   if (error instanceof QueueRejectedError && error.reason === 'admission') showBusyNotice();
 * }
 * ```
 *
 * @author MathAid
 */

import type {
  BackoffStrategy,
  ControlInterface,
  FingerprintTrail,
  Importance,
  Kernel,
  PacketEnvelope,
  Scheduler,
  View,
} from '@platform/core';

/**
 * @summary The id the Queue registers under.
 * @constant {'queue'}
 * @public
 */
export const QUEUE_ID = 'queue';

/**
 * @summary The parts of Global State's control interface the Queue uses.
 *
 * @description
 * Admission (`canAccept`) and pending-work tracking (`beginWork`, `endWork`).
 * `@platform/global-state`'s control interface satisfies it; the Queue reads
 * it through its optional dependency on `global-state`.
 *
 * @example
 * Example 1: What the Queue calls for each packet
 * ```ts
 * if (!admission.commands.canAccept(envelope.importance)) reject();
 * admission.commands.beginWork({ id: messageId, subsystemId: source, importance, label: eventId });
 * // ... when settled:
 * admission.commands.endWork(messageId);
 * ```
 *
 * @example
 * Example 2: A stand-in for tests
 * ```ts
 * const admission: AdmissionControl = {
 *   commands: { canAccept: () => true, beginWork: () => true, endWork: () => {} },
 *   views: {},
 * };
 * ```
 *
 * @public
 */
export interface AdmissionControl {
  /**
   * @summary The admission commands that the Queue calls.
   */
  readonly commands: {
    /**
     * @summary Tells if the platform accepts a packet of this importance now.
     * @param {Importance} importance The importance of the packet.
     * @returns {boolean} `true` when the packet is accepted.
     */
    canAccept(importance: Importance): boolean;
    /**
     * @summary Records a packet as work in progress.
     * @param {object} work The `id`, `subsystemId`, `importance` and optional `label` of the work.
     * @returns {boolean} `true` when the work is recorded.
     */
    beginWork(work: {
      /**
       * @summary The id of the work: the `messageId` of the packet.
       */
      readonly id: string;
      /**
       * @summary The id of the subsystem that sent the packet.
       */
      readonly subsystemId: string;
      /**
       * @summary The importance of the packet.
       */
      readonly importance: Importance;
      /**
       * @summary A short text for the user: the event id of the packet.
       */
      readonly label?: string;
    }): boolean;
    /**
     * @summary Removes a packet from the work in progress.
     * @param {string} id The `messageId` of the packet.
     */
    endWork(id: string): void;
  };
  /**
   * @summary The views of the control interface.
   * @description The Queue does not use them. They are here because every control interface has views.
   */
  readonly views: Readonly<Record<string, View<unknown>>>;
}

/**
 * @summary How a broadcast reached this tab: `remote: true` for one from another tab.
 * @description The same shape as `@platform/notification`'s `FanOutOptions`.
 * @public
 */
export interface FanOutOptions {
  /**
   * @summary Marks a broadcast that came from another tab.
   * @description The default is `false`.
   */
  readonly remote?: boolean;
}

/**
 * @summary Hands a broadcast to the Notification Center.
 * @description `@platform/notification`'s `fanOut` matches it. Without one,
 * the Queue uses the kernel's direct broadcast.
 * @public
 */
export type FanOut = (
  kernel: Kernel,
  envelope: PacketEnvelope,
  options?: FanOutOptions,
) => Promise<void>;

/**
 * @summary Options for `createQueue`.
 *
 * @description
 * - `fanOut`: where broadcasts go (the Notification Center's `fanOut`).
 * - `maxRetries` (default 3), `retryBaseMs` (default 100) and
 *   `retryStrategy` (default `exponential-jitter`): retries of packets whose
 *   target is not running.
 * - `maxDepth` (default 1000): packets waiting before non-critical ones are refused.
 * - `maxActive` (default 8): packets dispatched at the same time.
 * - `deadLetterCapacity` (default 100) and `trailHistory` (default 50): how
 *   many dead letters and settled trails are kept.
 * - `dedupeCapacity` (default 1000): message ids remembered to drop repeats from other tabs.
 * - `scheduler`, `now`, `random` and `ids`: replace the scheduler, clock, jitter source and span ids.
 *
 * @example
 * Example 1: Wired to the Notification Center
 * ```ts
 * createQueue({ fanOut: notification.fanOut });
 * ```
 *
 * @example
 * Example 2: Fast, deterministic retries in a test
 * ```ts
 * createQueue({ retryBaseMs: 1, retryStrategy: 'exponential', maxRetries: 2 });
 * ```
 *
 * @public
 */
export interface QueueOptions {
  /**
   * @summary Where broadcasts go: the `fanOut` of the Notification Center.
   * @description Without it, the Queue uses the direct broadcast of the kernel.
   */
  readonly fanOut?: FanOut;
  /**
   * @summary The number of retries for a packet whose target does not run.
   * @description The default is 3. After the last retry, the packet becomes a dead letter.
   */
  readonly maxRetries?: number;
  /**
   * @summary The first wait before a retry, in milliseconds.
   * @description The default is 100.
   */
  readonly retryBaseMs?: number;
  /**
   * @summary The backoff formula for retries.
   * @description The default is `exponential-jitter`.
   */
  readonly retryStrategy?: BackoffStrategy;
  /**
   * @summary The number of waiting packets above which the Queue refuses new ones.
   * @description The default is 1000. `CRITICAL` packets are never refused for depth.
   */
  readonly maxDepth?: number;
  /**
   * @summary The number of packets that the Queue delivers at the same time.
   * @description The default is 8.
   */
  readonly maxActive?: number;
  /**
   * @summary The number of dead letters that the Queue keeps and buffers.
   * @description The default is 100.
   */
  readonly deadLetterCapacity?: number;
  /**
   * @summary Keeps the dead letters in Storage when Storage runs, so they survive a reload.
   * @description The default is `true`. The Queue then binds the dead-letter
   * sink itself. Set `false` to bind your own sink.
   */
  readonly persistDeadLetters?: boolean;
  /**
   * @summary The number of settled packets that the `trails` view keeps.
   * @description The default is 50.
   */
  readonly trailHistory?: number;
  /**
   * @summary Runs the non-critical deliveries.
   * @description The default is a scheduler from `createScheduler`.
   */
  readonly scheduler?: Scheduler;
  /**
   * @summary The clock, in Unix milliseconds.
   * @description The default is `Date.now`.
   */
  readonly now?: () => number;
  /**
   * @summary The source of random numbers for the backoff jitter.
   * @description The default uses `crypto.getRandomValues`.
   */
  readonly random?: () => number;
  /**
   * @summary Makes the span ids of envelopes from other tabs.
   * @description The default is `crypto.randomUUID`.
   */
  readonly ids?: () => string;
  /**
   * @summary The number of message ids that the Queue remembers to drop repeats from other tabs.
   * @description The default is 1000.
   */
  readonly dedupeCapacity?: number;
}

/**
 * @summary Why the Queue refused a packet.
 * @description
 * - `scope`: a broadcast outside its sender's scope.
 * - `admission`: Global State does not admit its importance now.
 * - `overflow`: too many packets are waiting.
 * - `stopped`: the Queue shut down with the packet still waiting.
 *
 * @public
 */
export type RejectionReason = 'scope' | 'admission' | 'overflow' | 'stopped';

/**
 * @summary Thrown when the Queue refuses a packet.
 *
 * @example
 * Example 1: Backing off while the platform is busy
 * ```ts
 * try {
 *   await ctx.port.send({ eventId: 'analytics:batch', payload, importance: 'LOW' });
 * } catch (error) {
 *   if (error instanceof QueueRejectedError && error.reason === 'admission') retryLater();
 * }
 * ```
 *
 * @example
 * Example 2: The message
 * ```ts
 * new QueueRejectedError('overflow', 'm-1').message; // 'Packet m-1 refused by the Queue: overflow.'
 * ```
 *
 * @public
 */
export class QueueRejectedError extends Error {
  /**
   * @summary The name of the error class: `'QueueRejectedError'`.
   */
  override readonly name = 'QueueRejectedError';

  /**
   * @summary Creates the error for one refused packet.
   * @param {RejectionReason} reason The reason.
   * @param {string} messageId The id of the refused packet.
   */
  constructor(
    /**
     * @summary Why the Queue refused the packet.
     */
    readonly reason: RejectionReason,
    /**
     * @summary The id of the refused packet.
     */
    readonly messageId: string,
  ) {
    super(`Packet ${messageId} refused by the Queue: ${reason}.`);
  }
}

/**
 * @summary A packet the Queue could not deliver.
 *
 * @description
 * `envelope` is the packet with its trail, `reason` says why (`undeliverable`
 * after the last retry, or `expired`), `attempts` counts deliveries tried,
 * and `failedAt` is when it was given up.
 *
 * Dead letters are kept in memory. When Storage runs, the Queue also keeps
 * them in the collection `queue.dead-letters`, so they survive a reload.
 * `replay(messageId)` sends one again.
 *
 * @example
 * Example 1: Listing dead letters
 * ```ts
 * for (const letter of queue.views.deadLetters.getSnapshot()) console.warn(letter.reason, letter.envelope.eventId);
 * ```
 *
 * @example
 * Example 2: Replaying everything after an outage
 * ```ts
 * for (const letter of queue.views.deadLetters.getSnapshot()) queue.commands.replay(letter.envelope.metadata.messageId);
 * ```
 *
 * @public
 */
export interface DeadLetter {
  /**
   * @summary The packet, with its fingerprint trail.
   */
  readonly envelope: PacketEnvelope;
  /**
   * @summary Why the Queue gave the packet up.
   * @description `undeliverable` means that the target did not run after the
   * last retry, or was destroyed. `expired` means that the time to live passed.
   */
  readonly reason: 'undeliverable' | 'expired';
  /**
   * @summary The number of deliveries that the Queue tried.
   */
  readonly attempts: number;
  /**
   * @summary The time when the Queue gave the packet up, in Unix milliseconds.
   */
  readonly failedAt: number;
}

/**
 * @summary A packet the Queue has finished with, and its final trail.
 *
 * @description
 * `outcome` is `completed`, `failed` (the target or a subscriber refused it),
 * `dead-lettered` or `rejected`, with the `reason` when it is not
 * `completed`. `trail` is the full fingerprint trail: `sent`, `enqueued`,
 * `dispatched`, the target's own entries, then the outcome.
 *
 * @example
 * Example 1: A completed request
 * ```ts
 * // { eventId: 'auth:whoami', outcome: 'completed', trail: sent, enqueued, dispatched, delivered, completed }
 * ```
 *
 * @example
 * Example 2: Feeding a logger
 * ```ts
 * queue.views.trails.subscribe(() => logger.trace(queue.views.trails.getSnapshot().at(-1)));
 * ```
 *
 * @public
 */
export interface SettledPacket {
  /**
   * @summary The id of the packet.
   */
  readonly messageId: string;
  /**
   * @summary The id of the trace of the packet.
   */
  readonly traceId: string;
  /**
   * @summary The id of the event.
   */
  readonly eventId: string;
  /**
   * @summary The id of the subsystem that sent the packet.
   */
  readonly source: string;
  /**
   * @summary The id of the target, or `null` for a broadcast.
   */
  readonly target: string | null;
  /**
   * @summary The result of the packet.
   * @description `failed` means that the target or a subscriber refused it.
   * `rejected` means that the Queue refused it before delivery.
   */
  readonly outcome: 'completed' | 'failed' | 'dead-lettered' | 'rejected';
  /**
   * @summary Why the packet did not complete, or `null`.
   */
  readonly reason: string | null;
  /**
   * @summary The full fingerprint trail of the packet.
   */
  readonly trail: FingerprintTrail;
}

/**
 * @summary The Queue's state: counters.
 *
 * @example
 * Example 1: A quiet queue
 * ```ts
 * // { depth: 0, inFlight: 0, retrying: 0, deadLetters: 0, completed: 42, failed: 0, rejected: 0, duplicates: 0 }
 * ```
 *
 * @example
 * Example 2: Showing a backlog
 * ```ts
 * if (state.getSnapshot().depth! > 100) showBacklogNotice();
 * ```
 *
 * @public
 */
export interface QueueData {
  /**
   * @summary The number of waiting packets, including the packets that wait to retry.
   */
  depth: number;
  /**
   * @summary The number of packets that the Queue delivers now.
   */
  inFlight: number;
  /**
   * @summary The number of packets that wait to retry.
   */
  retrying: number;
  /**
   * @summary The number of dead letters in memory.
   */
  deadLetters: number;
  /**
   * @summary The number of packets that completed.
   */
  completed: number;
  /**
   * @summary The number of packets that the target or a subscriber refused.
   */
  failed: number;
  /**
   * @summary The number of packets that the Queue refused.
   */
  rejected: number;
  /**
   * @summary The number of envelopes from other tabs that the Queue dropped as repeats.
   */
  duplicates: number;
}

/**
 * @summary The Queue's control interface.
 *
 * @description
 * `replay(messageId)` sends a dead letter again; `bindDeadLetterSink(sink)`
 * writes buffered and future dead letters to a sink (with Storage, the Queue binds it itself);
 * `unbindDeadLetterSink()` goes back to buffering; `observe(observer)` calls
 * `observer` with every settled packet (the `trails` view keeps only the last
 * ones, so a log must observe) and returns the function that stops it;
 * `ingest(envelope)` admits a Window or Global broadcast from another tab
 * (resolving `false` for a repeat), starting a new span on its trace.
 * Views: `state` (counters),
 * `trails` (recently settled packets) and `deadLetters`.
 *
 * @example
 * Example 1: Sending dead letters to your own log (with `persistDeadLetters: false`)
 * ```ts
 * await queue.commands.bindDeadLetterSink((letter) => myLog.write(letter));
 * ```
 *
 * @example
 * Example 2: Watching the queue in a debug panel
 * ```ts
 * queue.views.state.subscribe(() => render(queue.views.state.getSnapshot()));
 * ```
 *
 * @public
 */
export interface QueueControl {
  /**
   * @summary The commands of the Queue.
   */
  readonly commands: {
    /**
     * @summary Sends a dead letter again.
     * @description The Queue removes the letter, drops its time to live, and
     * routes it again. The result shows in `trails`, and in `deadLetters` if it fails again.
     * @example
     * Replaying all dead letters after an outage
     * ```ts
     * for (const letter of views.deadLetters.getSnapshot()) commands.replay(letter.envelope.metadata.messageId);
     * ```
     * @param {string} messageId The id of the dead letter.
     * @returns {boolean} `true` when the letter was found and sent again.
     */
    replay(messageId: string): boolean;
    /**
     * @summary Sends the buffered and the future dead letters to a sink.
     * @description Storage binds a sink from M6. If the sink throws while the
     * buffer drains, the Queue goes back to buffering and the promise rejects.
     * @example
     * Persisting dead letters
     * ```ts
     * await commands.bindDeadLetterSink((letter) => myLog.write(letter));
     * ```
     * @param {(letter: DeadLetter) => void | Promise<void>} sink Receives each dead letter.
     * @returns {Promise<void>} Resolves after the buffer drains.
     */
    bindDeadLetterSink(sink: (letter: DeadLetter) => void | Promise<void>): Promise<void>;
    /**
     * @summary Stops the sink. New dead letters go to the buffer again.
     * @example
     * Unbinding when Storage stops
     * ```ts
     * commands.unbindDeadLetterSink();
     * ```
     */
    unbindDeadLetterSink(): void;
    /**
     * @summary Calls an observer with each settled packet.
     * @description The `trails` view keeps only the last packets. Use this
     * command to see each packet, as the Logger does.
     * @example
     * Archiving every settled packet
     * ```ts
     * const stop = commands.observe((settled) => archive(settled));
     * ```
     * @param {(settled: SettledPacket) => void} observer Called with each settled packet.
     * @returns {() => void} Stops the observer.
     */
    observe(observer: (settled: SettledPacket) => void): () => void;
    /**
     * @summary Admits a Window or Global broadcast from another tab.
     * @description The Queue drops a repeat, starts a new span on the same
     * trace, and fans the broadcast out in remote mode. The Window transport calls it.
     * @example
     * Handing envelopes from the hub to the Queue
     * ```ts
     * client.onEnvelope((envelope) => void commands.ingest(envelope));
     * ```
     * @param {PacketEnvelope} envelope The envelope from the other tab.
     * @returns {Promise<boolean>} `true` after the fan-out, `false` for a repeat.
     * @throws {QueueRejectedError} For a request or a Page or Tab broadcast (`scope`), or when the Queue refuses it.
     */
    ingest(envelope: PacketEnvelope): Promise<boolean>;
  };
  /**
   * @summary The views of the Queue.
   */
  readonly views: {
    /**
     * @summary The counters of the Queue.
     */
    readonly state: View<Partial<QueueData>>;
    /**
     * @summary The last settled packets, oldest first.
     * @description The view keeps `trailHistory` packets.
     */
    readonly trails: View<readonly SettledPacket[]>;
    /**
     * @summary The dead letters in memory, oldest first.
     */
    readonly deadLetters: View<readonly DeadLetter[]>;
  };
}

/**
 * @summary The name of the Storage collection that keeps the dead letters.
 * @public
 */
export const DEAD_LETTER_COLLECTION = 'queue.dead-letters';

/**
 * @summary The part of a Storage collection that the Queue uses.
 * @description The Queue does not import `@platform/storage`. Any control
 * with this shape works.
 * @template T The type of the values.
 * @public
 */
export interface StoredCollection<T> {
  /**
   * @summary Writes a value.
   * @example
   * Writing
   * ```ts
   * await collection.set(letter.envelope.metadata.messageId, letter);
   * ```
   * @param {string} key The key.
   * @param {T} value The value.
   * @returns {Promise<void>} Resolves when the value is stored.
   */
  set(key: string, value: T): Promise<void>;
  /**
   * @summary Deletes a value.
   * @example
   * Deleting after a replay
   * ```ts
   * await collection.delete(messageId);
   * ```
   * @param {string} key The key.
   * @returns {Promise<void>} Resolves when the value is deleted.
   */
  delete(key: string): Promise<void>;
  /**
   * @summary Returns all the entries, oldest first.
   * @example
   * Loading after a reload
   * ```ts
   * const letters = (await collection.entries()).map((entry) => entry.value);
   * ```
   * @returns {Promise<Array<{ key: string; value: T }>>} The entries.
   */
  entries(): Promise<Array<{ key: string; value: T }>>;
}

/**
 * @summary The part of the Storage control that the Queue and the Logger use.
 * @example
 * Example 1: Watching Storage
 * ```ts
 * ctx.watch<CollectionSource>('storage', (storage) => storage?.commands.collection({ name: 'x' }));
 * ```
 * @example
 * Example 2: A fake for a test
 * ```ts
 * const source: CollectionSource = { commands: { collection: () => memoryCollection() }, views: {} };
 * ```
 * @public
 */
export interface CollectionSource extends ControlInterface {
  /**
   * @summary The commands that the Queue uses.
   */
  readonly commands: {
    /**
     * @summary Returns a collection.
     * @example
     * Getting the collection of dead letters
     * ```ts
     * storage.commands.collection<DeadLetter>({ name: DEAD_LETTER_COLLECTION, maxEntries: 100 });
     * ```
     * @param definition The name and the largest number of entries.
     * @returns {StoredCollection<T>} The collection.
     */
    collection<T>(definition: { name: string; maxEntries?: number }): StoredCollection<T>;
  };
}
