/**
 * @fileoverview
 * @summary The Storage pipeline: a value to an envelope on a write, and an envelope to a value on a read.
 *
 * @description
 * The coordinator runs these functions, in the realm of its host
 * (docs/ARCHITECTURE.md §18.2). The functions of a collection come as portable
 * functions, so they run in the worker too.
 *
 * ```text
 *   encode: value --serialize--> text --compress?--> gzip --encrypt?--> token --> payload '<flags>:<data>'
 *                                                                     HMAC tag of the payload --> envelope.integrity
 *   decode: envelope --verify tag--> payload --decrypt--> --decompress--> text --deserialize--> value
 *           --> migrate from envelope.schema_version up to the version of the collection
 *   ```
 *
 * The flags of the payload (`z` compressed, `e` encrypted) tell a read what to
 * undo. A collection can therefore turn on compression or encryption later:
 * old entries still read.
 *
 * @example
 * A round trip
 * ```ts
 * const envelope = await encode({ total: 3 }, spec, keys);
 * const { value } = await decode(envelope, spec, keys); // { total: 3 }
 * ```
 *
 * @author MathAid
 */

import {
  decryptText,
  encryptText,
  fromBase64Url,
  hmacText,
  toBase64Url,
  verifyHmacText,
  type KeyStore,
} from '@platform/crypto';

import type { IndexFunction } from './indexes';
import type { BackendKind, StorageEnvelope } from './types';

/**
 * @summary A migration step: turns a value of the previous schema version into a value of this version.
 * @public
 */
export type Migration = (value: unknown) => unknown;

/**
 * @summary What the coordinator must know about a collection.
 *
 * @description
 * The main thread makes it from a {@linkcode CollectionDefinition}. The
 * functions travel to the worker as portable functions, so they must be
 * self-contained (docs/ARCHITECTURE.md §8.8).
 *
 * @example
 * Example 1: An encrypted collection
 * ```ts
 * const spec: CollectionSpec = { name: 'vault', version: 1, ttl: null, weight: 10, encrypt: true, compress: false, maxEntries: null };
 * ```
 *
 * @example
 * Example 2: A collection at version 2
 * ```ts
 * const spec: CollectionSpec = { ...base, version: 2, migrations: { 2: (old) => ({ ...(old as object), tags: [] }) } };
 * ```
 *
 * @public
 */
export interface CollectionSpec {
  /**
   * @summary The name of the collection. It is the module segment of the canonical key.
   */
  readonly name: string;
  /**
   * @summary The schema version of new entries.
   */
  readonly version: number;
  /**
   * @summary The default time to live of an entry, in milliseconds, or `null` for no expiry.
   */
  readonly ttl: number | null;
  /**
   * @summary The eviction weight of the entries. A higher weight is evicted later.
   */
  readonly weight: number;
  /**
   * @summary Encrypts new entries and adds an HMAC tag.
   */
  readonly encrypt: boolean;
  /**
   * @summary Compresses new entries with gzip.
   */
  readonly compress: boolean;
  /**
   * @summary The largest number of entries. A write removes the oldest entries above it.
   */
  readonly maxEntries: number | null;
  /**
   * @summary Turns a value into text. The default is `JSON.stringify`.
   */
  readonly serialize?: (value: unknown) => string;
  /**
   * @summary Turns text back into a value. The default is `JSON.parse`.
   */
  readonly deserialize?: (text: string) => unknown;
  /**
   * @summary The migration steps, by the version that they make.
   * @description `migrations[2]` turns a version 1 value into a version 2
   * value. A missing step keeps the value as it is.
   */
  readonly migrations?: Readonly<Record<number, Migration>>;
  /**
   * @summary The query indexes, by name. Each function returns the index value (or values) of a value.
   */
  readonly indexes?: Readonly<Record<string, IndexFunction>>;
}

/**
 * @summary An entry cannot be read: its tag is wrong, or it does not decrypt or parse.
 * @example
 * Detecting it
 * ```ts
 * try { await decode(envelope, spec, keys); } catch (error) { if (error instanceof CorruptEntryError) remove(); }
 * ```
 * @public
 */
export class CorruptEntryError extends Error {
  /**
   * @summary The name of the error: `CorruptEntryError`.
   */
  override readonly name = 'CorruptEntryError';
}

/**
 * @summary The result of {@linkcode decode}.
 * @example
 * Example 1: A current entry
 * ```ts
 * // { value: { total: 3 }, migrated: false }
 * ```
 * @example
 * Example 2: A migrated entry, to write back
 * ```ts
 * if (result.migrated) await backend.write(key, await encode(result.value, spec, keys));
 * ```
 * @public
 */
export interface Decoded {
  /**
   * @summary The value, migrated to the version of the collection.
   */
  readonly value: unknown;
  /**
   * @summary Tells if a migration step ran, so the entry must be written back.
   */
  readonly migrated: boolean;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * @summary Turns a value into an envelope: serialize, compress, encrypt and tag.
 * @example
 * Encoding
 * ```ts
 * const envelope = await encode({ total: 3 }, spec, keys, { backend: 'indexeddb' });
 * ```
 * @param {unknown} value The value.
 * @param {CollectionSpec} spec The collection.
 * @param {KeyStore | null} keys The key store. An encrypted collection needs it.
 * @param {object} [options] The time to live, the weight and the backend of this write.
 * @returns {Promise<StorageEnvelope<string>>} The envelope.
 * @throws {Error} When the collection encrypts and there are no keys, or the value does not serialize.
 * @public
 */
export async function encode(
  value: unknown,
  spec: CollectionSpec,
  keys: KeyStore | null,
  options: { ttl?: number | null; weight?: number; backend?: BackendKind } = {},
): Promise<StorageEnvelope<string>> {
  const text = spec.serialize ? spec.serialize(value) : JSON.stringify(value);
  if (typeof text !== 'string') {
    throw new TypeError(`[storage] The value for "${spec.name}" does not serialize to text.`);
  }
  let flags = '';
  let data = text;
  if (spec.compress) {
    flags += 'z';
    data = toBase64Url(await pipe(new TextEncoder().encode(data), new CompressionStream('gzip')));
  }
  if (spec.encrypt) {
    if (!keys) throw new Error(`[storage] "${spec.name}" is encrypted, but no keys are available.`);
    flags += 'e';
    data = await encryptText(keys, data);
  }
  const payload = `${flags}:${data}`;
  const now = Date.now();
  const ttl = options.ttl === undefined ? spec.ttl : options.ttl;
  return {
    payload,
    schema_version: spec.version,
    written_at: now,
    expires_at: ttl === null ? null : now + ttl,
    weight: options.weight ?? spec.weight,
    backend: options.backend ?? 'memory',
    ...(spec.encrypt && keys ? { integrity: await hmacText(keys, payload) } : {}),
  };
}

/**
 * @summary Turns an envelope back into a value: verify, decrypt, decompress, parse and migrate.
 * @example
 * Decoding
 * ```ts
 * const { value, migrated } = await decode(envelope, spec, keys);
 * ```
 * @param {StorageEnvelope<unknown>} envelope The envelope.
 * @param {CollectionSpec} spec The collection.
 * @param {KeyStore | null} keys The key store. An encrypted entry needs it.
 * @returns {Promise<Decoded>} The value, and whether it was migrated.
 * @throws {CorruptEntryError} When the tag is wrong, or the entry does not decrypt, decompress or parse.
 * @throws {Error} When a migration step throws.
 * @public
 */
export async function decode(
  envelope: StorageEnvelope<unknown>,
  spec: CollectionSpec,
  keys: KeyStore | null,
): Promise<Decoded> {
  const payload = envelope.payload;
  if (typeof payload !== 'string') throw new CorruptEntryError('The payload is not text.');
  const at = payload.indexOf(':');
  if (at < 0) throw new CorruptEntryError('The payload has no flags.');
  const flags = payload.slice(0, at);
  let data = payload.slice(at + 1);

  if (flags.includes('e')) {
    if (!keys)
      throw new Error(
        `[storage] An entry of "${spec.name}" is encrypted, but no keys are available.`,
      );
    if (!envelope.integrity || !(await verifyHmacText(keys, payload, envelope.integrity))) {
      throw new CorruptEntryError('The integrity tag is wrong.');
    }
  }
  let value: unknown;
  try {
    if (flags.includes('e')) data = await decryptText(keys!, data);
    if (flags.includes('z')) {
      data = new TextDecoder().decode(
        await pipe(fromBase64Url(data), new DecompressionStream('gzip')),
      );
    }
    value = spec.deserialize ? spec.deserialize(data) : JSON.parse(data);
  } catch (cause) {
    throw new CorruptEntryError('The entry does not decode.', { cause });
  }

  let migrated = false;
  for (let version = envelope.schema_version + 1; version <= spec.version; version++) {
    const step = spec.migrations?.[version];
    if (step) value = step(value);
    migrated = true;
  }
  return { value, migrated };
}
