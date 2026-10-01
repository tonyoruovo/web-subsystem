/**
 * @fileoverview
 * @summary The Storage broadcaster: local and cross-tab change events.
 * @description
 * Fans storage change events out to local subscribers and, when a channel is
 * provided, to every other tab on the same origin. The facade calls `emit`
 * after each mutation. A subscriber matching the key prefix receives the event.
 * This is what lets a mutation in one tab notify another tab, and lets the
 * Logger beacon the change.
 *
 * ```text
 *   facade.set/delete/clear -> emitChange -> broadcaster.emit(event)
 *     |-- dispatch to local subscribers (key startsWith prefix)
 *     |-- channel.postMessage(event) -> other tabs dispatch locally
 *   ```
 *
 * BroadcastChannel is fire-and-forget, like the notification bridge. A tab that
 * is not listening misses the event, which is fine because every tab reconciles
 * from state.
 *
 * @see {@linkcode StorageChangeEvent}
 * @author MathAid
 */

import type { ISubscription, StorageChangeEvent, StorageChangeHandler } from './storage.types';

/**
 * @summary The minimal BroadcastChannel surface the broadcaster needs.
 */
export interface StorageBroadcastChannelLike {
  /** Posts a message to every other tab on the channel. */
  postMessage(message: unknown): void;
  /** Handler for messages from other tabs. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Closes the channel. */
  close(): void;
}

/**
 * @summary Options for constructing a {@linkcode StorageBroadcaster}.
 */
export interface StorageBroadcasterOptions {
  /** Optional channel for cross-tab fan-out. */
  channel?: StorageBroadcastChannelLike;
}

/**
 * @summary The Storage broadcaster.
 * @description
 * Holds local subscribers and an optional channel. The facade's `emit` hook
 * points at {@linkcode StorageBroadcaster.emit}.
 *
 * @example
 * Example 1: Subscribe to changes and wire the facade
 * ```ts
 * const broadcaster = new StorageBroadcaster({ channel: new BroadcastChannel('storage') });
 * broadcaster.subscribe('app:chrome:1:test:', (e) => console.log(e.op));
 * const facade = new StorageFacade({ backend, config, emit: (e) => broadcaster.emit(e) });
 * ```
 */
export class StorageBroadcaster {
  /** @internal subscription id to prefix and handler. */
  private readonly subscribers = new Map<
    string,
    { prefix: string; handler: StorageChangeHandler }
  >();

  /** @internal The channel, or `undefined`. */
  private readonly channel?: StorageBroadcastChannelLike;

  /** @internal Monotonic id counter. */
  private counter = 0;

  /**
   * @summary Creates a StorageBroadcaster.
   * @param {StorageBroadcasterOptions} [options] The optional channel.
   */
  constructor(options: StorageBroadcasterOptions = {}) {
    this.channel = options.channel;
    if (this.channel) {
      this.channel.onmessage = (event) => this.dispatch(event.data as StorageChangeEvent);
    }
  }

  /**
   * @summary Subscribes to changes whose key starts with a prefix.
   * @param {string} keyOrPrefix The key or prefix to match.
   * @param {StorageChangeHandler} handler The handler.
   * @returns {ISubscription} An unsubscribe handle.
   */
  subscribe(keyOrPrefix: string, handler: StorageChangeHandler): ISubscription {
    const id = `sub-${++this.counter}`;
    this.subscribers.set(id, { prefix: keyOrPrefix, handler });
    return {
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  /**
   * @summary Emits an event locally and across tabs.
   * @param {StorageChangeEvent} event The change event.
   * @returns {void}
   */
  emit(event: StorageChangeEvent): void {
    this.dispatch(event);
    this.channel?.postMessage(event);
  }

  /**
   * @summary Closes the channel and drops subscribers.
   * @returns {void}
   */
  close(): void {
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.subscribers.clear();
  }

  /**
   * @summary Delivers an event to matching local subscribers.
   * @param {StorageChangeEvent} event The event.
   * @returns {void}
   * @internal
   */
  private dispatch(event: StorageChangeEvent): void {
    for (const { prefix, handler } of this.subscribers.values()) {
      if (event.key.startsWith(prefix)) handler(event);
    }
  }
}
