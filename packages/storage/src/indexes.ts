/**
 * @fileoverview
 * @summary Query indexes of collections: the index entries, their keys and their values.
 *
 * @description
 * The coordinator keeps the index entries of a collection in the reserved
 * module `<collection>~index` of the same backend (docs/ARCHITECTURE.md §18.3).
 *
 * ```text
 *   index entry    <index>:<value>:<key>     one for each index value of each entry
 *   reverse entry  @:<key>                   the index entry keys of one entry, so a write removes the old ones
 *   value          plain collection:     encodeURIComponent(JSON.stringify(value))
 *                  encrypted collection: base64url(HMAC-SHA-256(hmac key, JSON.stringify(value)))
 *   ```
 *
 * @example
 * The index entries of an order
 * ```ts
 * const keys = await indexKeys(spec, 'o1', { status: 'open' }, null);
 * // ['status:%22open%22:o1']
 * ```
 *
 * @author MathAid
 */

import { toBase64Url, utf8, type KeyRecord, type KeyStore } from '@platform/crypto';

/**
 * @summary A value that an index function can return: one value, or several for a multi-entry index.
 * @public
 */
export type IndexValue = string | number | boolean;

/**
 * @summary An index function: returns the index value (or values) of a stored value.
 * @description It runs in the coordinator, maybe in a worker, so it must be self-contained.
 * @public
 */
export type IndexFunction = (
  value: unknown,
) => IndexValue | readonly IndexValue[] | null | undefined;

/**
 * @summary The suffix of the reserved module that keeps the index entries of a collection.
 * @public
 */
export const INDEX_MODULE_SUFFIX = '~index';

/**
 * @summary The first part of the key of a reverse entry.
 * @public
 */
export const REVERSE_PREFIX = '@:';

/**
 * @summary Returns the reserved module of the index entries of a collection.
 * @example
 * The module of `orders`
 * ```ts
 * indexModule('orders'); // 'orders~index'
 * ```
 * @param {string} collection The name of the collection.
 * @returns {string} The module name.
 * @public
 */
export function indexModule(collection: string): string {
  return `${collection}${INDEX_MODULE_SUFFIX}`;
}

/**
 * @summary Returns the key of the reverse entry of an entry.
 * @example
 * The reverse entry of `o1`
 * ```ts
 * reverseKey('o1'); // '@:o1'
 * ```
 * @param {string} key The key of the entry.
 * @returns {string} The key of the reverse entry, in the index module.
 * @public
 */
export function reverseKey(key: string): string {
  return `${REVERSE_PREFIX}${encodeURIComponent(key)}`;
}

async function hmacPart(record: KeyRecord, json: string): Promise<string> {
  const tag = await crypto.subtle.sign('HMAC', record.key, utf8(json));
  return toBase64Url(new Uint8Array(tag));
}

/**
 * @summary Returns the value parts that a lookup must try for one value.
 * @description A plain collection has one part. An encrypted collection has
 * one part for each HMAC key of the store, so entries written before a rotation still match.
 * @example
 * A plain lookup
 * ```ts
 * await valueParts('open', null); // ['%22open%22']
 * ```
 * @param {IndexValue} value The value to look up.
 * @param {KeyStore | null} keys The key store, for an encrypted collection. `null` for a plain collection.
 * @returns {Promise<string[]>} The value parts.
 * @public
 */
export async function valueParts(value: IndexValue, keys: KeyStore | null): Promise<string[]> {
  const json = JSON.stringify(value);
  if (!keys) return [encodeURIComponent(json)];
  const records = keys.records().filter((record) => record.purpose === 'hmac');
  return Promise.all(records.map((record) => hmacPart(record, json)));
}

/**
 * @summary Returns the index entry keys of one entry, for all indexes of its collection.
 * @example
 * An order with two tags
 * ```ts
 * await indexKeys({ tag: (o) => (o as { tags: string[] }).tags }, 'o1', { tags: ['a', 'b'] }, null);
 * // ['tag:%22a%22:o1', 'tag:%22b%22:o1']
 * ```
 * @param {Readonly<Record<string, IndexFunction>>} indexes The index functions, by name.
 * @param {string} key The key of the entry.
 * @param {unknown} value The value of the entry.
 * @param {KeyStore | null} keys The key store, for an encrypted collection. `null` for a plain collection.
 * @returns {Promise<string[]>} The keys, without repeats.
 * @throws {TypeError} When an index function returns a value that is not a string, number or boolean.
 * @public
 */
export async function indexKeys(
  indexes: Readonly<Record<string, IndexFunction>>,
  key: string,
  value: unknown,
  keys: KeyStore | null,
): Promise<string[]> {
  const out = new Set<string>();
  const hmac = keys?.active('hmac') ?? null;
  for (const [name, fn] of Object.entries(indexes)) {
    const result = fn(value);
    if (result === null || result === undefined) continue;
    for (const item of Array.isArray(result) ? result : [result]) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) {
        throw new TypeError(
          `[storage] The index "${name}" returned a value that is not a string, number or boolean.`,
        );
      }
      const json = JSON.stringify(item);
      const part = hmac ? await hmacPart(hmac, json) : encodeURIComponent(json);
      out.add(`${encodeURIComponent(name)}:${part}:${encodeURIComponent(key)}`);
    }
  }
  return [...out];
}

/**
 * @summary Returns the key of the entry that an index entry points to.
 * @example
 * Reading an index entry key
 * ```ts
 * entryOf('status:%22open%22:o1'); // 'o1'
 * ```
 * @param {string} indexKey The key of the index entry.
 * @returns {string} The key of the entry.
 * @public
 */
export function entryOf(indexKey: string): string {
  return decodeURIComponent(indexKey.slice(indexKey.lastIndexOf(':') + 1));
}
