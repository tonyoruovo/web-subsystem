/**
 * @fileoverview
 * @summary Helpers shared by the hub page and the client: origin matching, partition ids, the message protocol.
 * @description
 * The hub page is a static file with one inline script (see `page.ts`). The
 * functions it needs from here are **self-contained**: they reference no
 * import and no outer variable, so `page.ts` can inline their source text
 * and the page runs the same code the client runs.
 *
 * ```text
 *   originAllowed     origin vs. allowlist ('https://example.com', 'https://*.example.com')
 *   readPartitionId   the hub partition's random id, kept in IndexedDB
 *   HubMessage        client <-> hub messages, tagged so foreign messages are ignored
 *   ```
 *
 * @example
 * Checking an origin
 * ```ts
 * originAllowed('https://a.example.com', ['https://*.example.com']); // true
 * ```
 *
 * @example
 * Reading the partition id in a tab on the apex
 * ```ts
 * const partition = await readPartitionId(indexedDB);
 * ```
 *
 * @author MathAid
 */

import type { PacketEnvelope } from '@platform/core';

/**
 * @summary Whether an origin matches an allowlist.
 *
 * @description
 * A pattern is an exact origin (`https://example.com`) or a wildcard for
 * subdomains at any depth (`https://*.example.com`, which does not match the
 * apex itself). Scheme and port must match exactly. `null` origins never
 * match. Self-contained: the hub page inlines it.
 *
 * @example
 * Example 1: The apex and its subdomains
 * ```ts
 * const site = ['https://example.com', 'https://*.example.com'];
 * originAllowed('https://shop.example.com', site); // true
 * originAllowed('https://example.com.evil.test', site); // false
 * ```
 *
 * @example
 * Example 2: Ports and schemes are part of the origin
 * ```ts
 * originAllowed('http://a.example.com', ['https://*.example.com']); // false
 * ```
 *
 * @param {string} origin The origin to check, as in `MessageEvent.origin`.
 * @param {readonly string[]} patterns The allowlist.
 * @returns {boolean} Whether it matches one pattern.
 *
 * @public
 */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  if (!origin || origin === 'null' || origin.includes('*')) return false;
  for (const pattern of patterns) {
    if (pattern === origin) return true;
    const star = pattern.indexOf('://*.');
    if (star < 0) continue;
    const scheme = pattern.slice(0, star + 3);
    const suffix = pattern.slice(star + 4); // '.example.com' or '.example.com:8443'
    if (!origin.startsWith(scheme) || !origin.endsWith(suffix)) continue;
    const label = origin.slice(scheme.length, origin.length - suffix.length);
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(label)) return true;
  }
  return false;
}

/**
 * @summary Returns this storage partition's random id, creating it on first use.
 *
 * @description
 * The id lives in IndexedDB (database `__platform_hub`, store `meta`), which
 * browsers partition the same way as `BroadcastChannel`. Two hubs that read
 * the same id share a partition. Self-contained: the hub page inlines it.
 *
 * @example
 * Example 1: In the hub page
 * ```ts
 * const partitionId = await readPartitionId(indexedDB);
 * ```
 *
 * @example
 * Example 2: In tests, with fake-indexeddb
 * ```ts
 * import { indexedDB } from 'fake-indexeddb';
 * await readPartitionId(indexedDB);
 * ```
 *
 * @param {IDBFactory} factory The IndexedDB factory.
 * @returns {Promise<string>} The partition id.
 *
 * @public
 */
export function readPartitionId(factory: IDBFactory): Promise<string> {
  return new Promise((resolve, reject) => {
    const open = factory.open('__platform_hub', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('meta');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const get = store.get('partition');
      let id = '';
      get.onsuccess = () => {
        id = typeof get.result === 'string' ? get.result : crypto.randomUUID();
        if (get.result !== id) store.put(id, 'partition');
      };
      tx.oncomplete = () => {
        db.close();
        resolve(id);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/**
 * @summary The tag every hub message carries, so other `postMessage` traffic is ignored.
 * @constant {'__platform_hub'}
 * @public
 */
export const HUB_TAG = '__platform_hub';

/**
 * @summary The default `BroadcastChannel` name the hubs share.
 * @constant {'__platform_window'}
 * @public
 */
export const DEFAULT_CHANNEL = '__platform_window';

/**
 * @summary A message between a client and a hub.
 *
 * @description
 * Client to hub: `hello` (connect), `publish` (an envelope for the other
 * tabs), `ping`. Hub to client: `welcome` (with the hub's partition id),
 * `envelope` (from another tab), `pong`. Every message carries
 * `[HUB_TAG]: 1`.
 *
 * @example
 * Example 1: Connecting
 * ```ts
 * const hello: HubMessage = { [HUB_TAG]: 1, type: 'hello' };
 * ```
 *
 * @example
 * Example 2: Publishing
 * ```ts
 * const message: HubMessage = { [HUB_TAG]: 1, type: 'publish', envelope };
 * ```
 *
 * @public
 */
export type HubMessage = { readonly [HUB_TAG]: 1 } & (
  | { readonly type: 'hello' }
  | { readonly type: 'welcome'; readonly partitionId: string }
  | { readonly type: 'publish'; readonly envelope: PacketEnvelope }
  | { readonly type: 'envelope'; readonly envelope: PacketEnvelope }
  | { readonly type: 'ping' }
  | { readonly type: 'pong' }
);

/**
 * @summary Whether a value is a hub message.
 *
 * @example
 * Example 1: Filtering `message` events
 * ```ts
 * addEventListener('message', (e) => { if (isHubMessage(e.data)) handle(e.data); });
 * ```
 *
 * @example
 * Example 2: Foreign traffic
 * ```ts
 * isHubMessage({ type: 'hello' }); // false: no tag
 * ```
 *
 * @param {unknown} value Anything.
 * @returns {boolean} Whether it is a {@linkcode HubMessage}.
 *
 * @public
 */
export function isHubMessage(value: unknown): value is HubMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[HUB_TAG] === 1 &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * @summary Whether a value looks like a Window-scope broadcast envelope.
 *
 * @description
 * The hub and the client only carry these: an object with an `eventId`, and
 * metadata with a `messageId`, `scope: 'window'` and `target: null`. Anything
 * else is dropped. Self-contained: the hub page inlines it.
 *
 * @example
 * Example 1: A valid envelope
 * ```ts
 * isWindowBroadcast(createEnvelope({ eventId: 'x', payload: 1 }, { source: 's', scope: 'window' })); // true
 * ```
 *
 * @example
 * Example 2: A request is not carried
 * ```ts
 * isWindowBroadcast({ eventId: 'x', metadata: { messageId: 'm', scope: 'window', target: 'auth' } }); // false
 * ```
 *
 * @param {unknown} value Anything.
 * @returns {boolean} Whether it may cross the hub.
 *
 * @public
 */
export function isWindowBroadcast(value: unknown): value is PacketEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as { eventId?: unknown; metadata?: Record<string, unknown> };
  const metadata = envelope.metadata;
  return (
    typeof envelope.eventId === 'string' &&
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof metadata.messageId === 'string' &&
    metadata.scope === 'window' &&
    metadata.target === null
  );
}
