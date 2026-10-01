/**
 * @fileoverview
 * @summary The bus: wires Global State, the Message Queue, and the Notification Center.
 * @description
 * Assembles the three centralized managers of M0 into one object. The queue's
 * admission gate is wired to Global State, so `BUSY` rejects LOW and MEDIUM
 * packets while CRITICAL still passes. An optional BroadcastChannel connects
 * the notification bridge for cross-tab fan-out.
 *
 * ```text
 *   createBus()
 *     +-- GlobalState         (admission + health)
 *     +-- MessageQueue        (admission -> globalState.canAcceptWork)
 *     +-- NotificationCenter  (in-memory fan-out)
 *     +-- NotificationBridge  (optional cross-tab BroadcastChannel)
 *   ```
 *
 * This is the drop-in entry point. Each manager is also usable alone, as the
 * individual specs and tests show.
 *
 * @see {@linkcode GlobalState}
 * @see {@linkcode MessageQueue}
 * @see {@linkcode NotificationCenter}
 * @author MathAid
 */

import { GlobalState } from './global/global-state.manager';
import { NotificationBridge, type BroadcastChannelLike } from './notification/notification.bridge';
import { NotificationCenter } from './notification/notification.manager';
import type { QueueConfiguration } from './queue/queue.dto';
import { MessageQueue } from './queue/queue.manager';

/**
 * @summary Options for {@linkcode createBus}.
 */
export interface BusOptions {
  /** The queue configuration. Defaults to {@linkcode defaultQueueConfig}. */
  queueConfig?: QueueConfiguration;
  /** The busy threshold for Global State. Defaults to 50. */
  busyThreshold?: number;
  /** Optional BroadcastChannel for cross-tab notification fan-out. */
  broadcastChannel?: BroadcastChannelLike;
}

/**
 * @summary The assembled bus.
 */
export interface Bus {
  /** The Global State manager. */
  readonly globalState: GlobalState;
  /** The Message Queue manager. */
  readonly queue: MessageQueue;
  /** The Notification Center manager. */
  readonly notifications: NotificationCenter;
  /** The cross-tab bridge, or `null` when no channel was provided. */
  readonly bridge: NotificationBridge | null;
  /** Transitions Global State from INITIALIZING to IDLE. */
  markReady(): void;
  /** Stops the platform, blocking new work. */
  stop(): void;
  /** Closes the bridge. */
  close(): void;
}

/**
 * @summary A sensible default queue configuration.
 * @returns {QueueConfiguration} The defaults.
 */
export function defaultQueueConfig(): QueueConfiguration {
  return {
    maxQueueSize: 1_000,
    maxQueueSizePerSubsystem: 100,
    maxActiveMessages: 10,
    maxRetryAttempts: 3,
    maxMessageAge: 60_000,
    processingTimeout: 5_000,
    batchSize: 10,
    dispatchInterval: 16,
    retryStrategy: 'EXPONENTIAL_BACKOFF',
    retryDelayBase: 100,
    retryDelayMultiplier: 2,
    enableDeadLetterQueue: true,
    deadLetterMaxSize: 100,
    deadLetterRetentionDays: 7,
    enableDeduplication: false,
    deduplicationWindow: 1_000,
  };
}

/**
 * @summary Creates and wires the bus.
 * @description
 * Instantiates the three managers and connects the queue's admission gate to
 * Global State. When a `broadcastChannel` is provided, it also connects the
 * cross-tab notification bridge.
 *
 * @example
 * Example 1: Boot the bus and use it
 * ```ts
 * const bus = createBus({ busyThreshold: 50 });
 * bus.markReady();
 * bus.queue.registerReceiver('storage', async (packet) => { await write(packet.payload); });
 * bus.notifications.registerEvent(loginEvent);
 * ```
 *
 * @param {BusOptions} [options] The configuration.
 * @returns {Bus} The assembled bus.
 */
export function createBus(options: BusOptions = {}): Bus {
  const globalState = new GlobalState({ busyThreshold: options.busyThreshold });
  const queue = new MessageQueue({
    config: options.queueConfig ?? defaultQueueConfig(),
    admission: (importance) => globalState.canAcceptWork(importance),
  });
  const notifications = new NotificationCenter();

  let bridge: NotificationBridge | null = null;
  if (options.broadcastChannel) {
    bridge = new NotificationBridge({ center: notifications, channel: options.broadcastChannel });
    bridge.connect();
  }

  return {
    globalState,
    queue,
    notifications,
    bridge,
    markReady: () => globalState.markReady(),
    stop: () => globalState.stop(),
    close: () => {
      bridge?.close();
    },
  };
}
