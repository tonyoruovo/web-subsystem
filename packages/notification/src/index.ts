/**
 * @fileoverview
 * @module @platform/notification
 * @summary The public API of `@platform/notification`.
 * @description
 * Re-exports the Notification Center ({@linkcode createNotificationCenter})
 * and its per-subscriber circuit breakers ({@linkcode CircuitBreakers}).
 *
 * ```text
 *   @platform/notification
 *   +-- createNotificationCenter   { subsystem, fanOut }
 *   |   subsystem: id 'notification', centralized, Tab scope
 *   |   fanOut:    passed to the Queue, which hands it every broadcast
 *   +-- CircuitBreakers            stops calling a subscriber that keeps failing
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
 * Listening to a broadcast from application code
 * ```ts
 * import type { NotificationControl } from '@platform/notification';
 *
 * const { commands } = kernel.unit<NotificationControl>('notification').control!;
 * commands.subscribe('settings:changed', (payload) => applySettings(payload));
 * ```
 *
 * @see [Package README](../README.md)
 * @author MathAid
 */

export * from './circuit-breaker';
export * from './notification-center';
