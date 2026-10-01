/**
 * @fileoverview
 * @summary A correlation registry that resolves packet callbacks by id.
 * @description
 * A packet's callbacks cannot cross `MessageChannel` or `BroadcastChannel`.
 * This registry is the bridge. The sender stores its callbacks under a
 * {@linkcode CorrelationId}. The sender posts only the
 * {@linkcode PacketEnvelope}. When the response envelope returns, the transport
 * handler calls {@linkcode CorrelationRegistry.resolve},
 * {@linkcode CorrelationRegistry.reject}, or {@linkcode CorrelationRegistry.log}
 * with the echoed correlation id. The matching callbacks then run and the
 * entry is removed.
 *
 * @see {@linkcode Packet}
 * @see {@linkcode PacketEnvelope}
 * @author MathAid
 */

import type { CorrelationId, Fingerprint, Packet, PacketEnvelope } from './packet.dto';

/**
 * @summary The callbacks stored for one pending packet.
 * @description
 * Mirrors the callback fields of a {@linkcode Packet} without the envelope.
 * This is the smallest unit the registry holds per correlation id.
 */
export interface PendingCallbacks<R = unknown> {
  /** Called with the result when the response resolves. */
  onComplete: (result: R) => void;
  /** Called with the error when the response rejects. */
  onError: (error: Error) => void;
  /** Optional log hook that receives the final fingerprint trail. */
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
}

/**
 * @summary Maps correlation ids to the callbacks of pending packets.
 * @description
 * A manager owns one registry per transport (one per worker port, one per
 * broadcast channel). The manager registers callbacks before it posts an
 * envelope. The transport handler resolves, rejects, or logs them when the
 * response envelope returns. Every operation removes its entry, so the
 * registry never grows without bound.
 *
 * @example
 * Example 1: Register, then resolve when the response returns
 * ```ts
 * const registry = new CorrelationRegistry();
 *
 * registry.register('corr-1', {
 *   onComplete: (r) => console.log(r),
 *   onError: (e) => console.error(e),
 *   onLog: null,
 * });
 *
 * // Later, when the response envelope arrives with metadata.correlationId:
 * registry.resolve('corr-1', { ok: true });
 * ```
 *
 * @example
 * Example 2: Drain every pending entry on teardown
 * ```ts
 * const registry = new CorrelationRegistry();
 * registry.register('corr-2', {
 *   onComplete: () => {},
 *   onError: () => {},
 *   onLog: null,
 * });
 * registry.drain(); // no entry stays pending after the transport closes
 * ```
 */
export class CorrelationRegistry {
  /** @internal Pending callbacks keyed by correlation id. The result type is erased here. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pending = new Map<CorrelationId, PendingCallbacks<any>>();

  /**
   * @summary Stores callbacks for a correlation id.
   * @description
   * Call this before posting the envelope. The id must be unique for the
   * lifetime of the pending entry. A duplicate id overwrites the previous
   * callbacks, so generate ids with `crypto.randomUUID()`.
   *
   * @param {CorrelationId} id The id echoed in the response envelope.
   * @param {PendingCallbacks<R>} callbacks The callbacks to run on resolution.
   * @returns {void}
   */
  register<R>(id: CorrelationId, callbacks: PendingCallbacks<R>): void {
    this.pending.set(id, callbacks);
  }

  /**
   * @summary True when a correlation id has pending callbacks.
   * @param {CorrelationId} id The id to check.
   * @returns {boolean} `true` when the id is registered and not yet settled.
   */
  has(id: CorrelationId): boolean {
    return this.pending.has(id);
  }

  /**
   * @summary Runs the `onComplete` callback for a correlation id and removes it.
   * @description
   * The transport handler calls this when a response envelope resolves. The
   * callback runs inside a try/catch so a throwing callback cannot break the
   * transport loop.
   *
   * @param {CorrelationId} id The id echoed in the response envelope.
   * @param {R} result The resolved value passed to `onComplete`.
   * @returns {void}
   */
  resolve<R>(id: CorrelationId, result: R): void {
    const callbacks = this.pending.get(id);
    if (!callbacks) return;
    this.pending.delete(id);
    try {
      callbacks.onComplete(result);
    } catch (error) {
      this.reportUnhandled(id, error);
    }
  }

  /**
   * @summary Runs the `onError` callback for a correlation id and removes it.
   * @description
   * The transport handler calls this when a response envelope rejects. The
   * callback runs inside a try/catch so a throwing callback cannot break the
   * transport loop.
   *
   * @param {CorrelationId} id The id echoed in the response envelope.
   * @param {Error} error The error passed to `onError`.
   * @returns {void}
   */
  reject(id: CorrelationId, error: Error): void {
    const callbacks = this.pending.get(id);
    if (!callbacks) return;
    this.pending.delete(id);
    try {
      callbacks.onError(error);
    } catch (inner) {
      this.reportUnhandled(id, inner);
    }
  }

  /**
   * @summary Runs the `onLog` callback for a correlation id with the final trail.
   * @description
   * The transport handler calls this when a packet completes and carries a
   * final fingerprint array. Unlike resolve and reject, this does not remove
   * the entry, because the packet may still await a completion or error.
   *
   * @param {CorrelationId} id The id echoed in the response envelope.
   * @param {Fingerprint[]} fingerprints The final fingerprint trail.
   * @returns {void}
   */
  log(id: CorrelationId, fingerprints: Fingerprint[]): void {
    const callbacks = this.pending.get(id);
    if (!callbacks || !callbacks.onLog) return;
    try {
      callbacks.onLog(fingerprints);
    } catch (error) {
      this.reportUnhandled(id, error);
    }
  }

  /**
   * @summary Clears every pending entry.
   * @description
   * Call this when the transport closes. Unresolved promises stay unresolved,
   * but no entry remains to leak. This mirrors the cleanup pattern used by the
   * tab-count strategies.
   *
   * @returns {void}
   */
  drain(): void {
    this.pending.clear();
  }

  /**
   * @summary Number of pending entries.
   * @returns {number} The count of correlation ids that are not yet settled.
   */
  size(): number {
    return this.pending.size;
  }

  /**
   * @summary Reports a throwing callback without breaking the caller.
   * @description
   * A callback error must not crash the transport loop. This forwards the
   * error to the console. The Logger reports it once the Logger manager is
   * wired.
   *
   * @param {CorrelationId} id The id whose callback threw.
   * @param {unknown} error The error the callback raised.
   * @returns {void}
   * @internal
   */
  private reportUnhandled(id: CorrelationId, error: unknown): void {
    // console.warn is a stopgap until the Logger manager dispatches errors.
    console.warn(`[CorrelationRegistry] callback for "${id}" threw`, error);
  }
}
