/**
 * @fileoverview
 * @summary The Message Queue manager: point-to-point packet delivery.
 * @description
 * Implements the SQS pattern for manager-to-manager communication. A packet
 * enters a priority tier, dispatches to its single target receiver, retries
 * with backoff on failure, and moves to a dead-letter queue when retries are
 * exhausted. This is the point-to-point half of the bus. The fan-out half is
 * the Notification Center.
 *
 * ```text
 *   enqueue(packet)
 *        |
 *        v
 *   priority tier (CRITICAL > HIGH > MEDIUM > LOW)
 *        |
 *        v
 *   deliver to target receiver   --failure-->  RETRY (backoff)
 *        |                                      |
 *        v                                      v (attempts > maxRetryAttempts)
 *     done                                 DEAD_LETTER
 *   ```
 *
 * Delivery is a direct in-realm call to a registered receiver. The
 * `MessageChannel` worker leg registers a receiver that forwards to a port. The
 * result callbacks resolve through a {@linkcode CorrelationRegistry}.
 *
 * @see {@linkcode PacketEnvelope}
 * @see {@linkcode QueueTopology}
 * @author MathAid
 */

import { CorrelationRegistry } from '../packet.registry';
import { makeFingerprint, type Importance, type PacketEnvelope } from '../packet.dto';
import type { QueueConfiguration, QueueItem, QueueStatus, QueueTopology } from './queue.dto';

/**
 * @summary A function that receives a packet for one target manager.
 * @description
 * May be synchronous or asynchronous. A synchronous receiver that throws, or an
 * asynchronous one that rejects, counts as a failed delivery and triggers retry.
 */
export type Receiver = (envelope: PacketEnvelope) => void | Promise<void>;

/**
 * @summary Options for constructing a {@linkcode MessageQueue}.
 */
export interface MessageQueueOptions {
  /** Runtime configuration. */
  config: QueueConfiguration;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable retry delay. Defaults to exponential backoff. */
  retryDelay?: (attempt: number, config: QueueConfiguration) => number;
  /**
   * Optional admission gate. When provided, `enqueue` rejects a packet whose
   * importance the gate denies. Wire this to Global State's `canAcceptWork`.
   */
  admission?: (importance: Importance) => boolean;
}

/**
 * @summary The priority tiers, in dispatch order.
 */
const PRIORITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/**
 * @summary Default retry delay: `base * multiplier^attempt`.
 * @param {number} attempt The failed attempt count.
 * @param {QueueConfiguration} config The queue configuration.
 * @returns {number} The delay in milliseconds before the next retry.
 */
function defaultRetryDelay(attempt: number, config: QueueConfiguration): number {
  return config.retryDelayBase * Math.pow(config.retryDelayMultiplier, attempt);
}

/**
 * @summary The Message Queue manager.
 * @description
 * Holds the queue topology, a registry of target receivers, and a correlation
 * registry for request/response matching. One instance serves one realm. The
 * `dispatchOnce` method is the unit of scheduling; `drain` loops it.
 *
 * @example
 * Example 1: Enqueue a packet and deliver it to a registered receiver
 * ```ts
 * const queue = new MessageQueue({ config });
 * queue.registerReceiver('storage', async (packet) => {
 *   await storage.write(packet.payload);
 * });
 * const messageId = queue.enqueue(envelope);
 * await queue.dispatchOnce();
 * ```
 */
export class MessageQueue {
  /** @internal The queues, retry map, and dead-letter array. */
  private readonly topology: QueueTopology;

  /** @internal The configuration. */
  private readonly config: QueueConfiguration;

  /** @internal Target subsystem id to receiver. */
  private readonly receivers = new Map<string, Receiver>();

  /** @internal Resolves request/response callbacks. */
  private readonly registry = new CorrelationRegistry();

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The retry delay function. */
  private readonly retryDelay: (attempt: number, config: QueueConfiguration) => number;

  /** @internal The optional admission gate. */
  private readonly admission?: (importance: Importance) => boolean;

  /** @internal The current status. */
  private status: QueueStatus = 'IDLE';

  /**
   * @summary Creates a MessageQueue.
   * @param {MessageQueueOptions} options The configuration and injectables.
   */
  constructor(options: MessageQueueOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.admission = options.admission;
    this.topology = {
      CRITICAL: [],
      HIGH: [],
      MEDIUM: [],
      LOW: [],
      RETRY: new Map(),
      DEAD_LETTER: [],
    };
  }

  /**
   * @summary Registers a receiver for a target manager.
   * @param {string} subsystemId The id the receiver answers for.
   * @param {Receiver} receiver The function that handles delivery.
   * @returns {void}
   */
  registerReceiver(subsystemId: string, receiver: Receiver): void {
    this.receivers.set(subsystemId, receiver);
  }

  /**
   * @summary Removes a receiver for a target manager.
   * @param {string} subsystemId The id to remove.
   * @returns {void}
   */
  unregisterReceiver(subsystemId: string): void {
    this.receivers.delete(subsystemId);
  }

  /**
   * @summary True when a receiver is registered for the target.
   * @param {string} subsystemId The id to check.
   * @returns {boolean} `true` when the receiver exists.
   */
  hasReceiver(subsystemId: string): boolean {
    return this.receivers.has(subsystemId);
  }

  /**
   * @summary Adds a packet to its priority tier.
   * @description
   * The packet keeps its own `metadata.messageId`. The queue wraps it in a
   * {@linkcode QueueItem} with scheduling fields. A packet with no
   * `targetSubsystem` belongs to the Notification Center, not the queue.
   *
   * @param {PacketEnvelope} packet The packet to enqueue.
   * @returns {string | null} The message id of the enqueued packet, or `null`
   * when the admission gate rejects it.
   */
  enqueue(packet: PacketEnvelope): string | null {
    if (this.admission && !this.admission(packet.importance)) {
      return null;
    }

    const item: QueueItem = {
      packet,
      enqueuedAt: this.now(),
      attempts: 0,
      priorityScore: 0,
      fingerprint: [],
    };
    packet.fingerprints.push(
      makeFingerprint('message-queue', 'enqueued', { timestamp: this.now() }),
    );

    const tier = packet.importance as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    this.topology[tier].push(item);
    return packet.metadata.messageId;
  }

  /**
   * @summary Dispatches one due item.
   * @description
   * Picks the highest-priority due item: first a retry whose `retryAt` passed,
   * then the highest non-empty priority tier. Delivers it to its receiver. On
   * failure it retries or dead-letters.
   *
   * @returns {Promise<boolean>} `true` when an item was dispatched, `false`
   * when nothing was due.
   */
  async dispatchOnce(): Promise<boolean> {
    const item = this.nextDueItem();
    if (!item) return false;

    this.status = 'PROCESSING';
    await this.deliver(item);
    this.status = 'IDLE';
    return true;
  }

  /**
   * @summary Dispatches every due item until the queue is empty or nothing is due.
   * @returns {Promise<void>}
   */
  async drain(): Promise<void> {
    while (await this.dispatchOnce()) {
      // keep dispatching until nothing is due
    }
  }

  /**
   * @summary Number of items across every queue, retry map, and dead-letter array.
   * @returns {number} The total item count.
   */
  getQueueDepth(): number {
    return (
      this.topology.CRITICAL.length +
      this.topology.HIGH.length +
      this.topology.MEDIUM.length +
      this.topology.LOW.length +
      this.topology.RETRY.size +
      this.topology.DEAD_LETTER.length
    );
  }

  /**
   * @summary The dead-letter array, oldest first.
   * @returns {ReadonlyArray<QueueItem>} The items that failed past the retry limit.
   */
  getDeadLetter(): ReadonlyArray<QueueItem> {
    return this.topology.DEAD_LETTER;
  }

  /**
   * @summary Replays a dead-lettered packet back into its priority tier.
   * @description
   * Removes the packet from the dead-letter array and re-enqueues it with a
   * reset attempt count. An operator calls this after fixing the receiver.
   *
   * @param {string} messageId The message id to replay.
   * @returns {boolean} `true` when the packet was replayed, `false` when not found.
   */
  replayDeadLetter(messageId: string): boolean {
    const index = this.topology.DEAD_LETTER.findIndex(
      (f) => f.packet.metadata.messageId === messageId,
    );
    if (index < 0) return false;

    const [failed] = this.topology.DEAD_LETTER.splice(index, 1);
    const tier = failed.packet.importance as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    const item: QueueItem = {
      packet: failed.packet,
      enqueuedAt: this.now(),
      attempts: 0,
      priorityScore: 0,
      fingerprint: failed.fingerprint,
    };
    this.topology[tier].push(item);
    return true;
  }

  /**
   * @summary The current queue status.
   * @returns {QueueStatus} The status.
   */
  getStatus(): QueueStatus {
    return this.status;
  }

  /**
   * @summary The correlation registry for this queue instance.
   * @returns {CorrelationRegistry} The registry.
   */
  getRegistry(): CorrelationRegistry {
    return this.registry;
  }

  /**
   * @summary Picks the highest-priority due item.
   * @description
   * Due retries come first, in no guaranteed order across senders. Then the
   * priority tiers, in CRITICAL, HIGH, MEDIUM, LOW order. Removing an item from
   * its queue happens here, so a popped item is no longer counted.
   *
   * @returns {QueueItem | undefined} The next item, or `undefined` when none is due.
   * @internal
   */
  private nextDueItem(): QueueItem | undefined {
    for (const [id, item] of this.topology.RETRY) {
      if (item.retryAt <= this.now()) {
        this.topology.RETRY.delete(id);
        return item;
      }
    }

    for (const tier of PRIORITY_ORDER) {
      const queue = this.topology[tier];
      if (queue.length > 0) {
        return queue.shift()!;
      }
    }

    return undefined;
  }

  /**
   * @summary Delivers one item to its target receiver.
   * @param {QueueItem} item The item to deliver.
   * @returns {Promise<void>}
   * @internal
   */
  private async deliver(item: QueueItem): Promise<void> {
    const target = item.packet.metadata.targetSubsystem;
    if (target === null) {
      this.handleFailure(item, new Error('[MessageQueue] a queue packet needs a targetSubsystem'));
      return;
    }

    const receiver = this.receivers.get(target);
    if (!receiver) {
      this.handleFailure(item, new Error(`[MessageQueue] no receiver for "${target}"`));
      return;
    }

    try {
      await receiver(item.packet);
      item.packet.fingerprints.push(
        makeFingerprint('message-queue', 'delivered', { timestamp: this.now() }),
      );
    } catch (error) {
      this.handleFailure(item, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * @summary Moves a failed item to retry or dead-letter.
   * @description
   * Increments the attempt count. When the count exceeds `maxRetryAttempts`,
   * the item moves to the dead-letter queue if it is enabled, otherwise it is
   * dropped. Otherwise it moves to the retry map with a backoff delay.
   *
   * @param {QueueItem} item The failed item.
   * @param {Error} error The delivery error.
   * @returns {void}
   * @internal
   */
  private handleFailure(item: QueueItem, error: Error): void {
    item.attempts += 1;

    if (item.attempts > this.config.maxRetryAttempts) {
      if (this.config.enableDeadLetterQueue) {
        this.topology.DEAD_LETTER.push({
          ...item,
          failedAt: this.now(),
          finalError: error,
          failureReasons: [{ error, timestamp: this.now(), retryCount: item.attempts - 1 }],
        });
      }
      return;
    }

    item.fingerprint.push({
      actionName: 'retry-scheduled',
      valueType: 'error',
      timestamp: this.now(),
      subsystemId: 'message-queue',
      componentId: 'queue.manager',
      counter: item.attempts,
      level: 'WARN',
      message: error.message,
    });

    const retryAt = this.now() + this.retryDelay(item.attempts, this.config);
    this.topology.RETRY.set(item.packet.metadata.messageId, { ...item, retryAt, lastError: error });
  }
}
