/**
 * @fileoverview
 * @module @platform/queue
 * @summary The public API of `@platform/queue`.
 * @description
 * Re-exports the Queue ({@linkcode createQueue}), its id, its rejection
 * error, and the types of its options, records and control interface.
 *
 * ```text
 *   @platform/queue
 *   +-- createQueue          { subsystem, router }
 *   |   subsystem: id 'queue', centralized, Tab scope
 *   |   router:    the kernel's `router` option; every packet goes through it
 *   +-- QueueRejectedError   scope | admission | overflow | stopped
 *   +-- types                QueueOptions, QueueControl, QueueData, SettledPacket, DeadLetter,
 *                            AdmissionControl, FanOut, RejectionReason
 *   ```
 *
 * @example
 * Wiring the three centralized subsystems
 * ```ts
 * import { Kernel } from '@platform/core';
 * import { createGlobalState } from '@platform/global-state';
 * import { createNotificationCenter } from '@platform/notification';
 * import { createQueue } from '@platform/queue';
 *
 * const notification = createNotificationCenter();
 * const queue = createQueue({ fanOut: notification.fanOut });
 * const kernel = new Kernel(
 *   [createGlobalState(), queue.subsystem, notification.subsystem, ...subsystems],
 *   { router: queue.router },
 * );
 * ```
 *
 * @example
 * Watching dead letters
 * ```ts
 * import type { QueueControl } from '@platform/queue';
 *
 * const { views } = kernel.unit<QueueControl>('queue').control!;
 * views.deadLetters.subscribe(() => console.warn(views.deadLetters.getSnapshot()));
 * ```
 *
 * @author MathAid
 */

export { createQueue, type Queue } from './queue';
export {
  QUEUE_ID,
  QueueRejectedError,
  type AdmissionControl,
  type DeadLetter,
  type FanOut,
  type QueueControl,
  type QueueData,
  type QueueOptions,
  type RejectionReason,
  type SettledPacket,
} from './types';
