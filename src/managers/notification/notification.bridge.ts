/**
 * @fileoverview
 * @summary A BroadcastChannel bridge for cross-tab notification fan-out.
 * @description
 * The Notification Center fans out to same-tab subscribers in memory. This
 * bridge adds the cross-tab leg. `fire` delivers locally and posts the event to
 * every other tab on the same origin. A tab that receives a broadcast delivers
 * it to its own local subscribers and does not re-post, so there is no loop.
 *
 * ```text
 *   Tab A                           Tab B
 *   bridge.fire(...)                bridge.onmessage(...)
 *     |-- center.fireEvent (local)    |-- center.fireEvent (local only)
 *     |-- channel.postMessage  ------>|
 *   ```
 *
 * BroadcastChannel is fire-and-forget. A tab that is closed or not listening
 * misses the event. This is acceptable because every tab reconciles from
 * state, per the architecture.
 *
 * @see {@linkcode NotificationCenter}
 * @author MathAid
 */

import type { EventMetadata } from './notification.dto';
import { NotificationCenter } from './notification.manager';

/**
 * @summary The minimal BroadcastChannel surface the bridge needs.
 * @description
 * An interface so tests can substitute a fake. The real `BroadcastChannel`
 * satisfies this shape.
 */
export interface BroadcastChannelLike {
  /** Posts a message to every other tab on the channel. */
  postMessage(message: unknown): void;
  /** Handler for messages from other tabs. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Closes the channel. */
  close(): void;
}

/**
 * @summary The wire shape posted across the channel.
 */
export interface BridgeMessage {
  /** The event id to deliver. */
  eventId: string;
  /** The payload. */
  payload: unknown;
  /** The full metadata, including the correlation id and fingerprints. */
  metadata: EventMetadata;
}

/**
 * @summary Options for constructing a {@linkcode NotificationBridge}.
 */
export interface NotificationBridgeOptions {
  /** The center this bridge fans out from. */
  center: NotificationCenter;
  /** The channel to broadcast over. */
  channel: BroadcastChannelLike;
}

/**
 * @summary The cross-tab bridge for the Notification Center.
 * @description
 * Wraps a center and a channel. Call `connect` to start listening. Use `fire`
 * instead of the center's `fireEvent` to also reach other tabs.
 *
 * @example
 * Example 1: Fire an event that reaches this tab and every other tab
 * ```ts
 * const bridge = new NotificationBridge({ center, channel: new BroadcastChannel('events') });
 * bridge.connect();
 * bridge.fire('auth:login-success', { userId: 'abc' });
 * ```
 */
export class NotificationBridge {
  /** @internal The center. */
  private readonly center: NotificationCenter;

  /** @internal The channel. */
  private readonly channel: BroadcastChannelLike;

  /**
   * @summary Creates a NotificationBridge.
   * @param {NotificationBridgeOptions} options The center and channel.
   */
  constructor(options: NotificationBridgeOptions) {
    this.center = options.center;
    this.channel = options.channel;
  }

  /**
   * @summary Starts listening for broadcasts from other tabs.
   * @returns {void}
   */
  connect(): void {
    this.channel.onmessage = (event) => this.onMessage(event.data as BridgeMessage);
  }

  /**
   * @summary Fires an event locally and to every other tab.
   * @description
   * Delivers locally through the center, then posts the full metadata to the
   * channel. Other tabs deliver it to their own subscribers.
   *
   * @param {string} eventId The event to fire.
   * @param {unknown} payload The payload.
   * @param {Partial<EventMetadata>} [metadata] Optional metadata overrides.
   * @returns {void}
   */
  fire(eventId: string, payload: unknown, metadata: Partial<EventMetadata> = {}): void {
    const full = this.center.fireEvent(eventId, payload, metadata);
    if (full) {
      this.channel.postMessage({ eventId, payload, metadata: full } satisfies BridgeMessage);
    }
  }

  /**
   * @summary Closes the channel and stops listening.
   * @returns {void}
   */
  close(): void {
    this.channel.onmessage = null;
    this.channel.close();
  }

  /**
   * @summary Delivers a received broadcast locally without re-posting.
   * @param {BridgeMessage} message The message from another tab.
   * @returns {void}
   * @internal
   */
  private onMessage(message: BridgeMessage): void {
    if (!message || typeof message.eventId !== 'string') return;
    // Local only. Calling fire() here would loop forever.
    this.center.fireEvent(message.eventId, message.payload, message.metadata);
  }
}
