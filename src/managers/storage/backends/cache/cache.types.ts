/**
 * @fileoverview CacheStorage backend domain types.
 *
 * ## Overview
 * This module defines every type exclusive to the CacheStorage backend.
 * Types shared across all backends (envelopes, canonical keys, eviction
 * policies, etc.) live in `storage.types.ts`; this file only introduces
 * concepts specific to the CacheStorage implementation:
 *
 * - The URL-keying scheme that adapts canonical keys to the `Request → Response`
 *   model of the Cache API.
 * - Backend configuration.
 * - The transaction interface, which the CacheStorage backend uses for its
 *   best-effort buffered transaction model.
 *
 * ## Why CacheStorage requires an adapter layer
 * The Cache API was designed for intercepting and caching HTTP responses in
 * Service Workers. Its native key type is a `Request` object (or a URL string),
 * and its native value type is a `Response` object. Neither maps naturally to
 * the storage subsystem's `CanonicalKey → StorageEnvelope` model, so this
 * backend wraps every entry:
 *
 * - **Key**: canonical key string → synthetic URL (`https://<namespace>/<key>`)
 * - **Value**: `StorageEnvelope<string>` → JSON body → `Response` object
 *
 * This adapter layer is entirely internal. Callers interact only with the
 * standard `IStorageBackend<string>` interface.
 *
 * ## Dependency graph (within the cache module)
 * ```
 * cache.types  <==  cache.transaction
 *              <==  cache.backend
 * ```
 * `cache.types` is a leaf: it imports nothing from the cache module itself.
 */

import type {
  BackendKind,
  CanonicalKey,
  ITransaction,
  ITransactionOp,
  TransactionStrength,
} from '../../storage.types';

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight in-memory index entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata mirror for a single cache entry, held in the in-memory `_index`.
 *
 * Mirrors `StorageEnvelope` fields needed for TTL checking, eviction
 * candidate sorting, and prefix-filtered queries — without the `payload`
 * field, which lives exclusively in the Cache API response body.
 */
export interface CacheIndexEntry {
  schema_version: number;
  written_at: number;
  expires_at: number | null;
  weight: number;
  backend: BackendKind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Construction-time configuration for `CacheBackend`.
 *
 * @description
 * `CacheBackendConfig` controls the two knobs that isolate and tune the
 * CacheStorage backend at construction time. Both fields are optional;
 * defaults are documented per-field.
 *
 * A `cacheName` is the logical bucket name passed to `caches.open()`. Two
 * `CacheBackend` instances with different `cacheName` values operate on
 * completely separate cache buckets with no shared state — useful when an
 * application needs to maintain independent storage namespaces (e.g., one
 * for encrypted auth tokens, one for large media manifests) without
 * canonical-key-prefix collisions.
 *
 * The `maxEntries` limit is not enforced by the Cache API itself; it is an
 * application-level eviction trigger maintained by this backend. When
 * `maxEntries` is exceeded, the backend runs a synchronous (in-memory) TTL
 * sweep followed by an LRU pass to bring the count back below the limit
 * before resolving the `write()` call.
 *
 * @example Default configuration (single global bucket)
 * ```ts
 * const backend = new CacheBackend()
 * // Uses cacheName: 'storage-cache', no maxEntries limit
 * ```
 *
 * @example Isolated per-feature buckets
 * ```ts
 * const authCache  = new CacheBackend({ cacheName: 'auth-tokens' })
 * const mediaCache = new CacheBackend({ cacheName: 'media-manifests', maxEntries: 200 })
 * ```
 *
 * @see {@link CacheBackend} for the implementation that consumes this config.
 */
export interface CacheBackendConfig {
  /**
   * Name of the Cache bucket opened via `caches.open(cacheName)`.
   *
   * Different names isolate independent stores within the same origin.
   * The name is visible in browser DevTools under Application → Cache Storage.
   *
   * @default `'storage-cache'`
   */
  cacheName?: string;

  /**
   * Optional upper bound on the number of entries stored in this cache bucket.
   *
   * When a `write()` would exceed this limit, the backend automatically evicts
   * entries using the LRU policy (oldest `written_at` first) until the entry
   * count is below `maxEntries`. TTL-expired entries are swept first as a free
   * eviction pass before weight-based sorting is applied.
   *
   * Set to `undefined` (the default) to disable automatic count-based eviction.
   * Quota-pressure eviction via `evict()` is always available regardless of
   * this setting.
   *
   * @default `undefined` (no limit)
   */
  maxEntries?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffered ops for CacheTransaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The discriminated op kind for operations buffered inside a
 * `CacheTransaction`.
 *
 * @description
 * `CacheOpKind` narrows the set of mutation types that the Cache backend's
 * transaction implementation uses in its internal op buffer. It mirrors the
 * `TransactionOpKind` from `storage.types` but is typed here as a standalone
 * literal union so that the `CacheBufferedOp` discriminant is explicit and
 * exhaustively checkable by TypeScript without importing the shared union.
 *
 * Read ops do not appear here — reads are never buffered in a transaction
 * buffer because they do not change state and require no journaling.
 *
 * @see {@link CacheBufferedOp} for the full per-op shape.
 */
export type CacheOpKind = 'write' | 'delete' | 'clear';

/**
 * @summary A single buffered operation inside a `CacheTransaction`.
 *
 * @description
 * `CacheBufferedOp` is the element type of `CacheTransaction`'s internal
 * `_ops` array. Each element represents a single mutation that the caller
 * has staged but not yet committed to the live Cache bucket.
 *
 * The three variants share the `ITransactionOp` base shape (which carries
 * `kind` and optional `key` / `prefix`) and extend it only with the
 * payload data needed to replay the mutation at commit time:
 *
 * - `write` — carries the serialized envelope JSON string that the backend
 *   will wrap in a synthetic `Response` object and store under the key's
 *   synthetic URL.
 * - `delete` — carries the canonical key; no additional payload.
 * - `clear` — carries an optional key prefix; if absent, the entire bucket
 *   is cleared on commit.
 *
 * The payload is stored as `envelopeJson` (a pre-serialized JSON string)
 * rather than as a raw `StorageEnvelope` object. This mirrors the on-disk
 * representation and avoids a second serialization pass at commit time.
 *
 * @template TRaw — Constrained to `string` in the cache backend context.
 *   CacheStorage stores `StorageEnvelope<string>` because the payload has
 *   already been encrypted and serialized by the pipeline layer before
 *   reaching this backend.
 *
 * @example Snapshot of a write op inside a transaction buffer
 * ```ts
 * const op: CacheBufferedOp = {
 *   kind:         'write',
 *   key:          'myapp:chrome:130:auth:session' as CanonicalKey,
 *   envelopeJson: JSON.stringify({
 *     payload:        'AES-GCM-ENCRYPTED',
 *     schema_version: 2,
 *     written_at:     Date.now(),
 *     expires_at:     null,
 *     weight:         5,
 *     backend:        'cache',
 *   }),
 * }
 * ```
 *
 * @see {@link CacheTransaction} for the transaction class that holds these ops.
 * @see {@link ICacheTransaction} for the public interface consumed by the backend.
 */
export type CacheBufferedOp =
  | ({ kind: 'write'; key: CanonicalKey; envelopeJson: string } & ITransactionOp)
  | ({ kind: 'delete'; key: CanonicalKey } & ITransactionOp)
  | ({ kind: 'clear'; prefix?: string } & ITransactionOp);

// ─────────────────────────────────────────────────────────────────────────────
// CacheStorage transaction interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The CacheStorage-specific transaction handle, extending the
 * base `ITransaction` with internal op-buffering methods.
 *
 * @description
 * `ICacheTransaction` is the internal contract between `CacheBackend` and
 * `CacheTransaction`. It extends the public `ITransaction` interface with
 * three `buffer*` methods that `CacheBackend` calls when a `transactionId`
 * is present on a mutating operation.
 *
 * Callers who obtain a transaction via `CacheBackend.beginTransaction()` see
 * only the narrower `ITransaction` type — the `buffer*` methods are not
 * part of the public API surface and are intentionally hidden from external
 * consumers.
 *
 * **Transaction strength: `'best-effort'`**
 *
 * The Cache API provides no native multi-entry transaction primitive. The
 * `CacheTransaction` implementation buffers ops in memory and applies them
 * sequentially in a single async commit pass. Atomicity within the JS event
 * loop is guaranteed, but there is no crash recovery mechanism (unlike the
 * OPFS backend's WAL). A crash mid-commit leaves the cache in a partially
 * applied state with no automatic recovery. This is the definition of
 * `'best-effort'` strength.
 *
 * @example Internal usage within CacheBackend
 * ```ts
 * // Inside CacheBackend.write() when transactionId is present:
 * const tx = this._getTransaction(options.transactionId)
 * tx.bufferWrite(key, JSON.stringify(envelope))
 *
 * // Inside CacheBackend.delete() when transactionId is present:
 * tx.bufferDelete(key)
 *
 * // Inside CacheBackend.clear() when transactionId is present:
 * tx.bufferClear(prefix)
 * ```
 *
 * @see {@link CacheTransaction} for the concrete implementation.
 * @see {@link ITransaction} for the public interface.
 */
export interface ICacheTransaction extends ITransaction {
  /** Always `'best-effort'` — CacheStorage cannot provide serializable or compensating transactions. */
  readonly strength: Extract<TransactionStrength, 'best-effort'>;

  /** The accumulated op buffer. Exposed for inspection; do not mutate externally. */
  readonly operations: ReadonlyArray<CacheBufferedOp>;

  /**
   * Buffer a write op.
   *
   * @param key          - The canonical key being written.
   * @param envelopeJson - The pre-serialized JSON string of `StorageEnvelope<string>`.
   *   Storing the serialized form avoids a redundant `JSON.stringify` at commit time.
   */
  bufferWrite(key: CanonicalKey, envelopeJson: string): void;

  /**
   * Buffer a delete op.
   *
   * @param key - The canonical key of the entry to delete.
   */
  bufferDelete(key: CanonicalKey): void;

  /**
   * Buffer a clear op.
   *
   * @param prefix - When present, only entries whose canonical key begins with
   *   this string are cleared. When absent, the entire cache bucket is cleared
   *   on commit.
   */
  bufferClear(prefix?: string): void;
}
