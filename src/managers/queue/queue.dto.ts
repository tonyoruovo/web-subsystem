/**
 * @fileoverview
 * @summary Typed interfaces for the Message Queue topology and configuration.
 * @description
 * Defines the shapes the Message Queue uses to schedule point-to-point packet
 * delivery. The queue is the SQS pattern. It holds packets in priority queues,
 * retries failures, and moves exhausted failures to a dead-letter queue. These
 * types describe the state. The queue logic that operates on them lives in the
 * queue manager.
 *
 * ```text
 *   QueueTopology
 *   +-- CRITICAL     priority queue
 *   +-- HIGH         priority queue
 *   +-- MEDIUM       FIFO queue
 *   +-- LOW          FIFO queue
 *   +-- RETRY        id -> retryable item
 *   +-- DEAD_LETTER  failed items, oldest first
 *   ```
 *
 * @see {@linkcode PacketEnvelope}
 * @author MathAid
 */

import type { Fingerprint, Importance, PacketEnvelope } from '../packet.dto';

/**
 * @summary Operational status of the queue.
 */
export type QueueStatus =
  'INITIALIZING' | 'IDLE' | 'PROCESSING' | 'PAUSED' | 'DRAINING' | 'STOPPED' | 'ERROR';

/**
 * @summary Lifecycle status of one message.
 */
export type MessageStatus =
  'PENDING' | 'DISPATCHING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'DEAD_LETTER';

/**
 * @summary The priority tier a queue holds.
 * @description
 * Mirrors {@linkcode Importance}. `CRITICAL` and `HIGH` use a priority queue.
 * `MEDIUM` and `LOW` use a FIFO queue.
 */
export type QueuePriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * @summary Strategy for delaying a retry.
 */
export type RetryStrategy =
  'IMMEDIATE' | 'LINEAR' | 'FIXED_DELAY' | 'EXPONENTIAL_BACKOFF' | 'CUSTOM';

/**
 * @summary One packet held in a queue, plus its scheduling state.
 * @description
 * Wraps a {@linkcode PacketEnvelope} with the fields the scheduler needs. The
 * envelope is what the queue ultimately dispatches. `attempts` and
 * `priorityScore` live only in the queue.
 */
export interface QueueItem {
  /** The packet to dispatch. */
  packet: PacketEnvelope;
  /** Unix milliseconds when the packet entered the queue. */
  enqueuedAt: number;
  /** Number of dispatch attempts so far. */
  attempts: number;
  /** Computed scheduling score from importance and dependencies. */
  priorityScore: number;
  /** Fingerprints added by the queue itself. */
  fingerprint: Fingerprint[];
}

/**
 * @summary A failed packet waiting to retry.
 * @description
 * A packet moves here after a dispatch failure, before it is retried. It
 * carries the next retry time and the last error.
 */
export interface RetryableItem extends QueueItem {
  /** Unix milliseconds when the next retry may run. */
  retryAt: number;
  /** The error from the most recent failed attempt. */
  lastError: Error;
}

/**
 * @summary A packet that failed past the retry limit.
 * @description
 * A packet moves here after it exhausts `maxRetryAttempts`. It keeps the full
 * failure history so an operator can replay it or analyze the pattern.
 */
export interface FailedItem extends QueueItem {
  /** Unix milliseconds when the packet was declared dead. */
  failedAt: number;
  /** The terminal error. */
  finalError: Error;
  /** Every recorded failure, in order. */
  failureReasons: Array<{ error: Error; timestamp: number; retryCount: number }>;
}

/**
 * @summary The full set of queues the Message Queue owns.
 * @description
 * Holds the four priority tiers, the retry map, and the dead-letter array.
 * `CRITICAL` and `HIGH` are priority queues. `MEDIUM` and `LOW` are FIFO.
 */
export interface QueueTopology {
  /** Critical packets, dispatched before all others. */
  CRITICAL: QueueItem[];
  /** High-priority packets. */
  HIGH: QueueItem[];
  /** Medium-priority packets, FIFO. */
  MEDIUM: QueueItem[];
  /** Low-priority packets, FIFO. */
  LOW: QueueItem[];
  /** Failed packets waiting for a retry, keyed by message id. */
  RETRY: Map<string, RetryableItem>;
  /** Packets that failed past the retry limit. */
  DEAD_LETTER: FailedItem[];
}

/**
 * @summary Runtime configuration for the queue.
 * @description
 * Holds the limits and the retry policy. The queue manager reads this from
 * Global State at boot and applies defaults for missing fields.
 */
export interface QueueConfiguration {
  /** Total packets allowed across all queues. */
  maxQueueSize: number;
  /** Packets allowed per target manager. */
  maxQueueSizePerSubsystem: number;
  /** Packets allowed in dispatch at once. */
  maxActiveMessages: number;
  /** Default retry attempts before dead-letter. */
  maxRetryAttempts: number;
  /** Age in milliseconds after which a packet is discarded. */
  maxMessageAge: number;
  /** Timeout per dispatch, in milliseconds. */
  processingTimeout: number;
  /** Max packets per dispatch batch. */
  batchSize: number;
  /** Milliseconds between dispatch cycles. */
  dispatchInterval: number;
  /** Delay strategy for retries. */
  retryStrategy: RetryStrategy;
  /** Base delay for backoff, in milliseconds. */
  retryDelayBase: number;
  /** Multiplier for exponential backoff. */
  retryDelayMultiplier: number;
  /** Whether to keep a dead-letter queue. */
  enableDeadLetterQueue: boolean;
  /** Max dead-letter entries. */
  deadLetterMaxSize: number;
  /** Days to keep a dead-letter entry. */
  deadLetterRetentionDays: number;
  /** Whether to drop duplicate packets within a window. */
  enableDeduplication: boolean;
  /** Deduplication window, in milliseconds. */
  deduplicationWindow: number;
}
