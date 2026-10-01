/**
 * @fileoverview
 * @summary Keeps a request's callbacks in the sender's realm until its reply arrives.
 * @description
 * Callbacks cannot cross `MessageChannel`, `BroadcastChannel`, `postMessage`
 * or the network. The sender registers them under a correlation id, sends
 * only the envelope, and settles them when the reply carrying the same id
 * comes back.
 *
 * ```text
 *   sender realm                                   other realm
 *   registry.register(id, callbacks)
 *   send({ ..., metadata: { correlationId: id } })  -->  handle
 *   registry.resolve(id, reply)                     <--  reply (same id)
 *   ```
 *
 * @example
 * Correlating requests over a raw port
 * ```ts
 * import { CorrelationRegistry } from '@platform/core';
 *
 * const registry = new CorrelationRegistry();
 * port.onmessage = ({ data }) => registry.resolve(data.correlationId, data.result);
 *
 * function request(envelope: PacketEnvelope) {
 *   return new Promise((onComplete, onError) => {
 *     registry.register(envelope.metadata.correlationId!, { onComplete, onError });
 *     port.postMessage(envelope);
 *   });
 * }
 * ```
 *
 * @example
 * Failing everything when the connection drops
 * ```ts
 * socket.addEventListener('close', () => registry.rejectAll(new Error('Connection lost')));
 * ```
 *
 * @author MathAid
 */

import type { FingerprintTrail } from './packet';

/**
 * @summary The callbacks kept for one pending request.
 *
 * @description
 * `onComplete` receives the reply, `onError` receives the failure, and the
 * optional `onLog` receives the reply's final {@linkcode FingerprintTrail},
 * on completion and on error alike.
 *
 * @example
 * Example 1: Wiring a promise
 * ```ts
 * new Promise((onComplete, onError) => registry.register(id, { onComplete, onError }));
 * ```
 *
 * @example
 * Example 2: Logging the trail
 * ```ts
 * registry.register(id, { onComplete, onError, onLog: (trail) => logger.trace(trail) });
 * ```
 *
 * @template R The reply type.
 * @public
 */
export interface PendingCallbacks<R = unknown> {
  /** Called with the reply. */
  onComplete(result: R): void;
  /** Called with the failure. */
  onError(error: Error): void;
  /** Receives the final fingerprint trail, on completion and on error. */
  onLog?: (trail: FingerprintTrail) => void;
}

/**
 * @summary A registry of pending requests, keyed by correlation id.
 *
 * @description
 * Stores {@linkcode PendingCallbacks} per correlation id and settles each
 * entry exactly once: `resolve` and `reject` remove the entry before calling
 * it, and unknown ids are ignored. A callback that throws never breaks the
 * caller (a transport's message loop): its error goes to `onUnhandled`,
 * which by default rethrows it asynchronously.
 *
 * Transports and routers that carry requests across realms use it. Code that
 * only uses `ctx.port.request` never sees it.
 *
 * @example
 * Example 1: Register, send, settle
 * ```ts
 * const registry = new CorrelationRegistry();
 * registry.register(id, { onComplete: resolve, onError: reject });
 * port.postMessage(envelope);
 * // later, when the reply arrives:
 * registry.resolve(reply.metadata.correlationId, reply.payload, reply.fingerprints);
 * ```
 *
 * @example
 * Example 2: Reporting callback bugs to a logger instead of rethrowing
 * ```ts
 * const registry = new CorrelationRegistry((error, id) => logger.error(`callback ${id}`, error));
 * ```
 *
 * @public
 */
export class CorrelationRegistry {
  // The result type is erased once registered.
  readonly #pending = new Map<string, PendingCallbacks<never>>();

  /**
   * @param {(error: unknown, id: string) => void} [onUnhandled] Receives errors thrown by callbacks.
   * Defaults to rethrowing them asynchronously.
   */
  constructor(
    private readonly onUnhandled: (error: unknown, id: string) => void = (error) => {
      setTimeout(() => {
        throw error;
      });
    },
  ) {}

  /**
   * @summary How many requests are pending.
   * @returns {number} The count.
   */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * @summary Stores the callbacks for `id`.
   * @template R The reply type.
   * @param {string} id The correlation id the reply will carry.
   * @param {PendingCallbacks<R>} callbacks The callbacks to settle.
   * @throws {Error} When `id` is already pending: ids must be unique.
   */
  register<R>(id: string, callbacks: PendingCallbacks<R>): void {
    if (this.#pending.has(id)) throw new Error(`Correlation id ${id} is already pending.`);
    this.#pending.set(id, callbacks as PendingCallbacks<never>);
  }

  /**
   * @summary Tells whether `id` is pending.
   * @param {string} id The correlation id.
   * @returns {boolean} `true` while the request is unsettled.
   */
  has(id: string): boolean {
    return this.#pending.has(id);
  }

  /**
   * @summary Completes the request `id`. Unknown ids are ignored.
   * @template R The reply type.
   * @param {string} id The correlation id.
   * @param {R} result The reply.
   * @param {FingerprintTrail} [trail] The reply's trail, passed to `onLog`.
   */
  resolve<R>(id: string, result: R, trail?: FingerprintTrail): void {
    const callbacks = this.#take(id);
    if (!callbacks) return;
    this.#run(id, () => (callbacks.onComplete as (r: R) => void)(result));
    if (trail) this.#run(id, () => callbacks.onLog?.(trail));
  }

  /**
   * @summary Fails the request `id`. Unknown ids are ignored.
   * @param {string} id The correlation id.
   * @param {Error} error The failure.
   * @param {FingerprintTrail} [trail] The trail, passed to `onLog`.
   */
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

  /**
   * @summary Removes and returns the callbacks for `id`.
   * @internal
   */
  #take(id: string): PendingCallbacks<never> | undefined {
    const callbacks = this.#pending.get(id);
    this.#pending.delete(id);
    return callbacks;
  }

  /**
   * @summary Runs a callback, sending what it throws to `onUnhandled`.
   * @internal
   */
  #run(id: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.onUnhandled(error, id);
    }
  }
}
