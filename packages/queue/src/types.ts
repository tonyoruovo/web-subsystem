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
  readonly commands: {
    canAccept(importance: Importance): boolean;
    beginWork(work: {
      readonly id: string;
      readonly subsystemId: string;
      readonly importance: Importance;
      readonly label?: string;
    }): boolean;
    endWork(id: string): void;
  };
  /** Not used by the Queue; present because every control interface has views. */
  readonly views: Readonly<Record<string, View<unknown>>>;
}

/**
 * @summary Hands a broadcast to the Notification Center.
 * @description `@platform/notification`'s `fanOut` matches it. Without one,
 * the Queue uses the kernel's direct broadcast.
 * @public
 */
export type FanOut = (kernel: Kernel, envelope: PacketEnvelope) => Promise<void>;

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
 * - `scheduler`, `now` and `random`: replace the scheduler, clock and jitter source.
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
  readonly fanOut?: FanOut;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly retryStrategy?: BackoffStrategy;
  readonly maxDepth?: number;
  readonly maxActive?: number;
  readonly deadLetterCapacity?: number;
  readonly trailHistory?: number;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly random?: () => number;
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
  override readonly name = 'QueueRejectedError';

  /**
   * @param {RejectionReason} reason Why.
   * @param {string} messageId The refused packet.
   */
  constructor(
    readonly reason: RejectionReason,
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
 * Dead letters are kept in memory and written to the sink bound with
 * `bindDeadLetterSink` (Storage, from M6). `replay(messageId)` sends one again.
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
  readonly envelope: PacketEnvelope;
  readonly reason: 'undeliverable' | 'expired';
  readonly attempts: number;
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
  readonly messageId: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly source: string;
  readonly target: string | null;
  readonly outcome: 'completed' | 'failed' | 'dead-lettered' | 'rejected';
  readonly reason: string | null;
  readonly trail: FingerprintTrail;
}

/**
 * @summary The Queue's state: counters.
 *
 * @example
 * Example 1: A quiet queue
 * ```ts
 * // { depth: 0, inFlight: 0, retrying: 0, deadLetters: 0, completed: 42, failed: 0, rejected: 0 }
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
  /** Packets waiting (including those waiting to retry). */
  depth: number;
  /** Packets being delivered. */
  inFlight: number;
  /** Packets waiting to retry. */
  retrying: number;
  /** Dead letters kept in memory. */
  deadLetters: number;
  completed: number;
  failed: number;
  rejected: number;
}

/**
 * @summary The Queue's control interface.
 *
 * @description
 * `replay(messageId)` sends a dead letter again; `bindDeadLetterSink(sink)`
 * writes buffered and future dead letters to a sink (Storage, from M6);
 * `unbindDeadLetterSink()` goes back to buffering. Views: `state` (counters),
 * `trails` (recently settled packets) and `deadLetters`.
 *
 * @example
 * Example 1: Persisting dead letters once Storage runs
 * ```ts
 * await queue.commands.bindDeadLetterSink((letter) => storage.commands.append('dead-letters', letter));
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
  readonly commands: {
    replay(messageId: string): boolean;
    bindDeadLetterSink(sink: (letter: DeadLetter) => void | Promise<void>): Promise<void>;
    unbindDeadLetterSink(): void;
  };
  readonly views: {
    readonly state: View<Partial<QueueData>>;
    readonly trails: View<readonly SettledPacket[]>;
    readonly deadLetters: View<readonly DeadLetter[]>;
  };
}
