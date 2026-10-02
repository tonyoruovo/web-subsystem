/**
 * @fileoverview
 * @summary Scope relays: how broadcasts leave this tab, and how repeats are dropped when they come back.
 * @description
 * Page and Tab broadcasts stay in the realm. Window and Global broadcasts
 * also go to a **scope relay** (ARCHITECTURE §11.3, §11.4): the Window
 * client or the Global transport. The NotificationCenter hands each locally
 * sent broadcast of a relayed scope to the relay attached for that scope;
 * envelopes from other tabs come back through the Queue.
 *
 * A broadcast can arrive more than once (through the hub and the relay, or
 * a retried server push), so receivers keep a bounded memory of message ids
 * ({@linkcode createDeduplicator}).
 *
 * ```text
 *   local broadcast (scope window) --> NotificationCenter fan-out --> relay.publish(envelope)
 *   other tab --> relay --> Queue.ingest(envelope) --> deduplicate --> fan-out here
 *   ```
 *
 * @example
 * A relay that logs what leaves the tab
 * ```ts
 * const relay: ScopeRelay = { scope: 'window', publish: (envelope) => console.debug(envelope.eventId) };
 * ```
 *
 * @example
 * Dropping repeats
 * ```ts
 * const dedupe = createDeduplicator(1000);
 * if (!dedupe.seen(envelope.metadata.messageId)) deliver(envelope);
 * ```
 *
 * @author MathAid
 */

import type { PacketEnvelope } from './packet';
import type { Scope } from './scope';

/**
 * @summary Carries broadcasts of one scope beyond this tab.
 *
 * @description
 * `scope` is the scope it carries (`window` or `global`). `publish` sends one
 * envelope and must not throw for transport failures: the relay buffers,
 * retries or drops, and reports through its own status.
 *
 * @example
 * Example 1: Attaching the Window client to the NotificationCenter
 * ```ts
 * notification.commands.attachRelay({ scope: 'window', publish: (e) => client.publish(e) });
 * ```
 *
 * @example
 * Example 2: A relay for tests
 * ```ts
 * const sent: PacketEnvelope[] = [];
 * const relay: ScopeRelay = { scope: 'window', publish: (e) => void sent.push(e) };
 * ```
 *
 * @public
 */
export interface ScopeRelay {
  /**
   * @summary The scope that the relay carries: `window` or `global`.
   * @description The NotificationCenter keeps one relay for each scope.
   */
  readonly scope: Scope;
  /**
   * @summary Sends one envelope beyond this tab.
   * @description The relay must not throw for a transport failure. It buffers,
   * retries or drops the envelope, and reports the problem in its own status.
   * @example
   * The Window transport as a relay
   * ```ts
   * notification.commands.attachRelay({ scope: 'window', publish: (e) => client.publish(e) });
   * ```
   * @param {PacketEnvelope} envelope A broadcast of the relay's scope, sent from this tab.
   */
  publish(envelope: PacketEnvelope): void;
}

/**
 * @summary Remembers the last N ids, to drop repeats.
 *
 * @example
 * Example 1: The first sighting
 * ```ts
 * dedupe.seen('m1'); // false: deliver it
 * dedupe.seen('m1'); // true: drop it
 * ```
 *
 * @example
 * Example 2: Forgetting the oldest
 * ```ts
 * const dedupe = createDeduplicator(2);
 * dedupe.seen('a'); dedupe.seen('b'); dedupe.seen('c');
 * dedupe.seen('a'); // false: 'a' was forgotten
 * ```
 *
 * @public
 */
export interface Deduplicator {
  /**
   * @summary The largest number of ids that the deduplicator remembers.
   * @description When it is full, it forgets the oldest id.
   */
  readonly capacity: number;
  /**
   * @summary Records an id and says whether it was already remembered.
   * @example
   * Delivering each envelope one time
   * ```ts
   * if (!dedupe.seen(envelope.metadata.messageId)) deliver(envelope);
   * ```
   * @param {string} id A message id.
   * @returns {boolean} `true` for a repeat.
   */
  seen(id: string): boolean;
}

/**
 * @summary Creates a {@linkcode Deduplicator} that remembers the last `capacity` ids.
 *
 * @example
 * Example 1: In a receiver
 * ```ts
 * const dedupe = createDeduplicator(1000);
 * transport.onEnvelope((e) => { if (!dedupe.seen(e.metadata.messageId)) ingest(e); });
 * ```
 *
 * @example
 * Example 2: Sized for a burst
 * ```ts
 * createDeduplicator(10_000);
 * ```
 *
 * @param {number} capacity The most ids remembered; at least 1.
 * @returns {Deduplicator} The deduplicator.
 * @throws {RangeError} When `capacity` is below 1.
 *
 * @public
 */
export function createDeduplicator(capacity: number): Deduplicator {
  if (!(capacity >= 1)) throw new RangeError('Deduplicator capacity must be at least 1.');
  const ids = new Set<string>();
  return {
    capacity,
    seen(id) {
      if (ids.has(id)) return true;
      ids.add(id);
      if (ids.size > capacity) ids.delete(ids.values().next().value!);
      return false;
    },
  };
}
