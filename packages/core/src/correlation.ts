/**
 * @fileoverview
 * @summary Keeps a request's callbacks in the sender's realm until its reply arrives.
 * @description
 * Callbacks cannot cross `MessageChannel`, `BroadcastChannel`, `postMessage`
 * or the network. The sender registers them under a correlation id, sends
 * only the envelope, and settles them when the reply carrying the same id
 * comes back.
 *
 * @author MathAid
 */

import type { FingerprintTrail } from './packet';

/** @summary The callbacks kept for one pending request. */
export interface PendingCallbacks<R = unknown> {
  onComplete(result: R): void;
  onError(error: Error): void;
  /** Receives the final fingerprint trail, on completion and on error. */
  onLog?: (trail: FingerprintTrail) => void;
}

/**
 * @summary A registry of pending requests, keyed by correlation id.
 * @description
 * A callback that throws never breaks the transport: its error is passed to
 * `onUnhandled` (by default rethrown asynchronously).
 *
 * @example
 * ```ts
 * const registry = new CorrelationRegistry();
 * registry.register(id, { onComplete: resolve, onError: reject });
 * port.postMessage(envelope);
 * // later, when the reply arrives:
 * registry.resolve(reply.metadata.correlationId, reply.payload, reply.fingerprints);
 * ```
 */
export class CorrelationRegistry {
  // The result type is erased once registered.
  readonly #pending = new Map<string, PendingCallbacks<never>>();

  constructor(
    private readonly onUnhandled: (error: unknown, id: string) => void = (error) => {
      setTimeout(() => {
        throw error;
      });
    },
  ) {}

  /** @summary How many requests are pending. */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * @summary Stores the callbacks for `id`.
   * @throws {Error} When `id` is already pending: ids must be unique.
   */
  register<R>(id: string, callbacks: PendingCallbacks<R>): void {
    if (this.#pending.has(id)) throw new Error(`Correlation id ${id} is already pending.`);
    this.#pending.set(id, callbacks as PendingCallbacks<never>);
  }

  /** @summary True when `id` is pending. */
  has(id: string): boolean {
    return this.#pending.has(id);
  }

  /** @summary Completes the request `id`; unknown ids are ignored. */
  resolve<R>(id: string, result: R, trail?: FingerprintTrail): void {
    const callbacks = this.#take(id);
    if (!callbacks) return;
    this.#run(id, () => (callbacks.onComplete as (r: R) => void)(result));
    if (trail) this.#run(id, () => callbacks.onLog?.(trail));
  }

  /** @summary Fails the request `id`; unknown ids are ignored. */
  reject(id: string, error: Error, trail?: FingerprintTrail): void {
    const callbacks = this.#take(id);
    if (!callbacks) return;
    this.#run(id, () => callbacks.onError(error));
    if (trail) this.#run(id, () => callbacks.onLog?.(trail));
  }

  /**
   * @summary Fails every pending request, for example when the transport closes.
   * @param {Error} error The error each pending request receives.
   */
  rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.reject(id, error);
  }

  #take(id: string): PendingCallbacks<never> | undefined {
    const callbacks = this.#pending.get(id);
    this.#pending.delete(id);
    return callbacks;
  }

  #run(id: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.onUnhandled(error, id);
    }
  }
}
