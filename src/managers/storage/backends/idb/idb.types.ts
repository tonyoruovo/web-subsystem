/**
 * @fileoverview IndexedDB backend domain types.
 *
 * ## Overview
 * Defines every type exclusive to the `IDBBackend` implementation. Types shared
 * across all backends live in `storage.types.ts`; this file only introduces
 * IndexedDB-specific concepts:
 *
 * - The on-disk record shape stored inside the `entries` object store.
 * - Backend construction configuration.
 * - The buffered-op types used by `IDBTransaction`.
 * - The internal transaction interface that couples `IDBBackend` to its
 *   transaction implementation without leaking op-buffer methods into the
 *   public `ITransaction` surface.
 *
 * ## Database schema
 * The backend uses a single IndexedDB database with one object store:
 *
 * ```
 * DB: <dbName>  (version 1)
 *  └── objectStore: 'entries'   (keyPath: 'key')
 *        ├── index: 'by_expires_at'   (keyPath: 'expires_at',  multiEntry: false)
 *        └── index: 'by_weight'       (keyPath: 'weight',      multiEntry: false)
 * ```
 *
 * The `by_expires_at` index enables efficient TTL sweeps during eviction
 * (open a bound cursor for `expires_at < Date.now()` without a full-store scan).
 * The `by_weight` index allows the eviction candidate sort to use an IDB cursor
 * in ascending weight order rather than loading all records into memory first.
 *
 * ## Dependency graph (within this module)
 * ```
 * idb.types  <==  idb.transaction
 *            <==  idb.backend
 * ```
 * `idb.types` is a leaf: it imports nothing from within this module.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | MDN: IndexedDB}
 */

import type {
  BackendKind,
  CanonicalKey,
  ITransaction,
  ITransactionOp,
  TransactionStrength,
} from '../../storage.types';

// ─────────────────────────────────────────────────────────────────────────────
// On-disk record shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The exact shape of every record stored in the `entries` object store.
 *
 * @description
 * `IDBRecord` is the wire format that IndexedDB persists for each stored entry.
 * It is a flat object (IDB cannot index into nested structures without
 * multi-entry indexes) combining the canonical key, the serialized envelope
 * metadata, and the encrypted payload string.
 *
 * Unlike OPFS — where payload bytes live in separate files and metadata lives
 * in a separate manifest — IDB stores everything in a single record per entry.
 * This removes the need for an in-memory manifest index: the object store's
 * native indexes (`by_expires_at`, `by_weight`) serve the same role for
 * TTL sweeps and eviction candidate sorting.
 *
 * The `key` field is the IDB `keyPath`, so IDB auto-indexes every record by
 * canonical key. No separate key store is needed.
 *
 * `payload` is the **already-encrypted, already-serialized string** from the
 * pipeline layer. This backend never inspects or transforms it.
 *
 * `expires_at` is stored as a number (or `null`) so that the `by_expires_at`
 * IDB index can open a bound range cursor (`IDBKeyRange.upperBound(Date.now())`)
 * to collect all expired records efficiently. IDB cannot index `null` values,
 * so records with `expires_at === null` are invisible to the TTL index — they
 * are never-expiring by definition and are correctly excluded from TTL sweeps.
 *
 * @example A stored record
 * ```ts
 * const record: IDBRecord = {
 *   key:            'myapp:chrome:130:auth:session',
 *   payload:        'AES-GCM-ENCRYPTED-STRING',
 *   schema_version: 2,
 *   written_at:     1_700_000_000_000,
 *   expires_at:     1_700_003_600_000,
 *   weight:         5,
 *   backend:        'indexeddb',
 * }
 * ```
 *
 * @see {@link IDBBackendConfig} for how the database name and store name are configured.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore | MDN: IDBObjectStore}
 */
export interface IDBRecord {
  /** Canonical storage key — the IDB keyPath. Auto-indexed by the object store. */
  key: CanonicalKey;
  /** Encrypted, serialized payload. Opaque to this backend. */
  payload: string;
  /** Schema version at write time. Used for migration detection. */
  schema_version: number;
  /** Unix ms timestamp when this entry was written. Used for LRU/FIFO eviction. */
  written_at: number;
  /**
   * Unix ms timestamp after which this entry is expired. `null` = never expires.
   *
   * Stored as a number so the `by_expires_at` IDB index can use a bound range
   * cursor for efficient TTL sweeps. Null values are invisible to this index
   * (IDB does not index `null`), which is correct: never-expiring entries
   * must never appear in a TTL sweep.
   */
  expires_at: number | null;
  /** Eviction weight. Higher = more important = evicted last. Indexed by `by_weight`. */
  weight: number;
  /** Which backend wrote this entry. Always `'indexeddb'` for this backend's writes. */
  backend: BackendKind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Construction-time configuration for `IDBBackend`.
 *
 * @description
 * `IDBBackendConfig` controls the identity of the IndexedDB database and the
 * name of its single object store. Both fields are optional; defaults allow
 * zero-config construction (`new IDBBackend()`).
 *
 * `dbName` is the string passed to `indexedDB.open(dbName)`. Two `IDBBackend`
 * instances with different `dbName` values are fully isolated — they operate on
 * independent databases, each with their own quota allocation and transaction
 * scopes. This is the correct way to separate storage for unrelated domains
 * (e.g., one IDB for user preferences, one for cached API responses) without
 * key-namespace collisions.
 *
 * `storeName` is the name of the single object store within the database. In
 * the vast majority of use cases the default (`'entries'`) is correct. Override
 * it only if you need to run this backend alongside code that already uses the
 * same database name with a different schema.
 *
 * @example Default construction — zero configuration
 * ```ts
 * const backend = new IDBBackend()
 * // Opens / creates the database 'storage' with object store 'entries'
 * ```
 *
 * @example Isolated per-feature databases
 * ```ts
 * const authBackend   = new IDBBackend({ dbName: 'auth-storage' })
 * const cacheBackend  = new IDBBackend({ dbName: 'cache-storage', storeName: 'cache' })
 * ```
 *
 * @see {@link IDBBackend} for the implementation that consumes this config.
 */
export interface IDBBackendConfig {
  /**
   * Name of the IndexedDB database to open or create.
   *
   * Visible in browser DevTools under Application → IndexedDB.
   *
   * @default `'storage'`
   */
  dbName?: string;

  /**
   * Name of the object store within the database.
   *
   * Created during the `onupgradeneeded` event when the database is first
   * opened. Must not be changed after the database has been created, as
   * changing it would require a DB version bump and migration.
   *
   * @default `'entries'`
   */
  storeName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction buffered ops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The op-kind discriminant for operations buffered in `IDBTransaction`.
 *
 * @description
 * `IDBOpKind` narrows the set of mutation types that appear in a transaction's
 * op buffer. Reads are excluded — they do not change state and require no
 * journaling. This is the same three-way discriminant used by all other backends
 * in this subsystem, kept as a standalone literal union here for explicit
 * exhaustive checks in `IDBTransaction`.
 *
 * @see {@link IDBBufferedOp} for the full per-op shape.
 */
export type IDBOpKind = 'write' | 'delete' | 'clear';

/**
 * @summary A single buffered operation held inside an `IDBTransaction`.
 *
 * @description
 * `IDBBufferedOp` is the element type of `IDBTransaction`'s internal `_ops`
 * array. Each element represents a mutation that the caller has staged but not
 * yet applied to the live IndexedDB object store.
 *
 * Unlike the OPFS WAL (which stores full payload bytes for crash recovery) or
 * the WebStorage snapshot (which captures pre-mutation values for rollback),
 * the IDB transaction buffer exists purely to collect ops before handing them
 * to a single native `IDBTransaction`. Native IDB transactions provide their
 * own atomicity and durability — the buffer's only job is to gather ops and
 * replay them inside one transaction scope at commit time.
 *
 * The three variants are:
 * - `write` — carries the full `IDBRecord` to store. Pre-building the record
 *   at buffer time means commit only needs to call `store.put(record)`.
 * - `delete` — carries the canonical key to pass to `store.delete(key)`.
 * - `clear` — carries an optional prefix. Because IDB has no native prefix
 *   delete, commit must open a key cursor over the full store and call
 *   `cursor.delete()` for every matching key.
 *
 * @example A write op inside the buffer
 * ```ts
 * const op: IDBBufferedOp = {
 *   kind:   'write',
 *   key:    'myapp:chrome:130:auth:session' as CanonicalKey,
 *   record: {
 *     key:            'myapp:chrome:130:auth:session',
 *     payload:        'ENCRYPTED',
 *     schema_version: 1,
 *     written_at:     Date.now(),
 *     expires_at:     null,
 *     weight:         5,
 *     backend:        'indexeddb',
 *   },
 * }
 * ```
 *
 * @see {@link IDBTransaction} for the transaction class that holds these ops.
 * @see {@link IIDBTransaction} for the public-internal interface.
 */
export type IDBBufferedOp =
  | ({ kind: 'write'; key: CanonicalKey; record: IDBRecord } & ITransactionOp)
  | ({ kind: 'delete'; key: CanonicalKey } & ITransactionOp)
  | ({ kind: 'clear'; prefix?: string } & ITransactionOp);

// ─────────────────────────────────────────────────────────────────────────────
// IDB transaction interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The IndexedDB-specific transaction handle, extending `ITransaction`
 * with the internal op-buffering methods used by `IDBBackend`.
 *
 * @description
 * `IIDBTransaction` is the internal contract between `IDBBackend` and
 * `IDBTransaction`. It extends the public `ITransaction` with three `buffer*`
 * methods called by the backend when a `transactionId` is present on a mutating
 * op.
 *
 * Callers who obtain a transaction via `IDBBackend.beginTransaction()` see only
 * the narrower `ITransaction` type. The `buffer*` methods are an internal
 * contract and are intentionally hidden from external consumers.
 *
 * **Transaction strength: `'serializable'`**
 *
 * At commit time, `IDBTransaction` opens a single native `IDBTransaction` in
 * `'readwrite'` mode, applies all buffered ops sequentially within it, and lets
 * IDB commit. IDB's native transaction semantics provide:
 *
 * - **Atomicity**: all ops commit or none do (native IDB guarantee).
 * - **Durability**: committed writes survive process death (native IDB guarantee).
 * - **Isolation**: concurrent `readwrite` transactions on the same object store
 *   are serialized by IDB's lock manager — no interleaving is possible.
 *
 * This is the definition of `'serializable'` strength in this subsystem.
 * `'compensating'` and `'best-effort'` can also be requested (the implementation
 * uses the same mechanism regardless of the strength label, so weaker requests
 * still get serializable behaviour).
 *
 * @example Internal usage within IDBBackend.write()
 * ```ts
 * // When transactionId is present:
 * const tx = this._getTransaction(options.transactionId)
 * tx.bufferWrite(key, record)
 * ```
 *
 * @see {@link IDBTransaction} for the concrete implementation.
 * @see {@link ITransaction} for the public interface.
 */
export interface IIDBTransaction extends ITransaction {
  /** Always `'serializable'` — backed by a native IDB readwrite transaction. */
  readonly strength: Extract<TransactionStrength, 'serializable'>;

  /** The accumulated op buffer. Exposed for inspection; do not mutate externally. */
  readonly operations: ReadonlyArray<IDBBufferedOp>;

  /**
   * Buffer a write op.
   *
   * @param key    - The canonical key (also embedded in `record.key`).
   * @param record - The pre-built `IDBRecord` ready to pass to `store.put()`.
   */
  bufferWrite(key: CanonicalKey, record: IDBRecord): void;

  /**
   * Buffer a delete op.
   *
   * @param key - The canonical key to delete on commit.
   */
  bufferDelete(key: CanonicalKey): void;

  /**
   * Buffer a clear op.
   *
   * @param prefix - When present, only records whose `key` starts with this
   *   string are deleted. When absent, the entire object store is cleared.
   */
  bufferClear(prefix?: string): void;
}
