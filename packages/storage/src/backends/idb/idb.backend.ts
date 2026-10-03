/**
 * @fileoverview IndexedDB storage backend implementation.
 *
 * ## Architectural intent
 * `IDBBackend` implements `IStorageBackend<string>` using the browser's
 * IndexedDB API as the storage medium.
 *
 * Its role in the wider storage subsystem:
 * - **Highest-priority persistent backend** in the fallback chain (priority 0).
 * - The only backend capable of `'serializable'` transactions — backed by IDB's
 *   native `readwrite` transaction locking.
 * - Falls back to OPFS, CacheStorage, LocalStorage, or Memory when unavailable.
 *
 * ## Database schema
 * ```
 * DB: <dbName>  (version 1)
 *  └── objectStore: 'entries'   (keyPath: 'key')
 *        ├── index: 'by_expires_at'  keyPath: 'expires_at'  (TTL sweeps)
 *        └── index: 'by_weight'      keyPath: 'weight'      (eviction sorting)
 * ```
 *
 * All canonical keys are stored verbatim as the IDB key. Records are flat
 * `IDBRecord` objects: `{ key, payload, schema_version, written_at, expires_at,
 * weight, backend }`. One record per canonical key.
 *
 * ## Data flow: write (non-transactional)
 * ```txt
 * Pipeline
 *   │  value -> zod.parse -> serialize -> encrypt -> StorageEnvelope<string>
 *   ▼
 * IDBBackend.write(key, envelope)
 *   │
 *   ├─[no transactionId]──────────────────────────────────────────────────────┐
 *   │   build IDBRecord { key, payload, schema_version, ... }                 │
 *   │   db.transaction(['entries'], 'readwrite')                              │
 *   │   store.put(record)                                                     │
 *   │   await idbTransactionDone(nativeTx)                                   │
 *   │   _readCount.delete(key)                                               │
 *   │                                                                         │
 *   └─[transactionId present]──────────────────────────────────────────────── ┘
 *       tx.bufferWrite(key, record)
 *       -> ops[] grows; zero IDB activity until commit()
 * ```
 *
 * ## Data flow: read
 * ```txt
 * IDBBackend.read(key)
 *   │
 *   ├── db.transaction(['entries'], 'readonly')
 *   ├── store.get(key)                 -> null  ->  return null
 *   │
 *   ├── TTL check (record.expires_at)
 *   │     expired  -> delete(key)  ->  return null
 *   │
 *   ├── _readCount[key]++
 *   │
 *   └── return StorageEnvelope reconstructed from IDBRecord
 * ```
 *
 * ## Transaction commit sequence (serializable)
 * ```txt
 * IDBTransaction.commit()
 *   │
 *   ▼
 * IDBBackend._applyCommit(txId, ops)
 *   │
 *   ├── open one native IDBTransaction(readwrite)
 *   ├── for each op in ops:
 *   │     'write'  -> store.put(record)
 *   │     'delete' -> store.delete(key)
 *   │     'clear'  -> cursorDeleteMatching(store, prefix?) or store.clear()
 *   ├── await idbTransactionDone(nativeTx)   <- IDB auto-commits
 *   └── _transactions.delete(txId)
 *
 * On any IDB request error:
 *   <- IDB aborts the entire native transaction atomically
 *   <- no partial writes survive
 *   <- error propagates to the caller
 * ```
 *
 * ## No WAL needed
 * Unlike OPFS, IDB has its own durability model — committed `readwrite`
 * transactions survive process death without application-layer journaling.
 * Crash recovery is IDB's responsibility, not this backend's.
 *
 * ## TRaw = string
 * `IDBBackend` is typed `IStorageBackend<string>`. `envelope.payload` is always
 * an **already-encrypted, already-serialized string** by the time it reaches
 * this backend. The backend stores it verbatim in the IDB record's `payload`
 * field and returns it as-is on read. Decryption and deserialization are the
 * pipeline's concern.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | MDN: IndexedDB}
 * @see {@link IStorageBackend} for the full interface contract.
 * @see {@link IDBTransaction} for the transaction implementation.
 * @see {@link idb.utils} for IDB Promise wrappers and cursor helpers.
 */

import type {
  BackendKind,
  CanonicalKey,
  CapabilityResult,
  EvictionPolicy,
  IStorageBackend,
  QuotaEstimate,
  ReadOptions,
  StorageEnvelope,
  StorageQuery,
  TransactionStrength,
  WriteOptions,
} from '../../types';

import { IDBTransaction } from './idb.transaction';
import type { IDBBackendConfig, IDBBufferedOp, IDBRecord } from './idb.types';
import {
  collectByWeight,
  collectExpired,
  countPrefix,
  cursorCollectPrefix,
  cursorDeleteMatching,
  idbRequest,
  idbTransactionDone,
  openDatabase,
} from './idb.utils';

// ─────────────────────────────────────────────────────────────────────────────
// IDBBackend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary IndexedDB-backed implementation of `IStorageBackend<string>`.
 *
 * @description
 * `IDBBackend` stores `StorageEnvelope<string>` values as flat `IDBRecord`
 * objects inside a single IndexedDB object store (`entries`). Each canonical
 * key becomes the IDB key; the encrypted payload and metadata fields are stored
 * alongside it as record properties.
 *
 * **Serializable transactions**: at commit time, all buffered ops are applied
 * inside one native `IDBTransaction(readwrite)`. IDB's lock manager prevents
 * concurrent `readwrite` transactions from interleaving. IDB's storage engine
 * ensures atomicity and durability: either all ops commit or none do.
 *
 * **Indexes**: two IDB indexes enable efficient server-side filtering without
 * loading all records:
 * - `by_expires_at` — `IDBKeyRange.upperBound(now)` cursor for TTL sweeps.
 * - `by_weight` — ascending cursor for eviction candidate ordering.
 *
 * **When to use**: always prefer `IDBBackend` over other persistent backends
 * when IndexedDB is available. It is the only backend with true serializable
 * transaction semantics and the only one with index-assisted filtering. OPFS
 * and CacheStorage are fallbacks.
 *
 * @example Basic lifecycle
 * ```ts
 * const backend = new IDBBackend({ dbName: 'my-app', storeName: 'entries' })
 *
 * const probe = await backend.probe()
 * if (!probe.available) throw new Error(probe.reason)
 *
 * await backend.initialize()
 *
 * const key = 'myapp:chrome:130:auth:session' as CanonicalKey
 * await backend.write(key, {
 *   payload:        'AES-GCM-ENCRYPTED',
 *   schema_version: 1,
 *   written_at:     Date.now(),
 *   expires_at:     Date.now() + 3_600_000,
 *   weight:         5,
 *   backend:        'indexeddb',
 * })
 *
 * const envelope = await backend.read(key)
 * await backend.close()
 * ```
 *
 * @example Serializable transaction
 * ```ts
 * const tx = await backend.beginTransaction()
 * try {
 *   await backend.write(keyA, envA, { transactionId: tx.id })
 *   await backend.delete(keyB,       { transactionId: tx.id })
 *   await tx.commit()  // atomic — both land or neither does
 * } catch {
 *   await tx.rollback()  // buffer discarded; nothing was written to IDB
 * }
 * ```
 *
 * @see {@link IDBTransaction} for the transaction model.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | MDN: IndexedDB}
 */
export class IDBBackend implements IStorageBackend<string> {
  // ── IStorageBackend identity ──────────────────────────────────────────────

  /**
   * @summary The kind of the backend.
   */
  readonly kind: BackendKind = 'indexeddb';

  /**
   * @summary The strongest transaction that the backend can give.
   * @description
   * Backed by native IDB `readwrite` transactions. All other backends sit
   * below this in the strength hierarchy.
   */
  readonly transactionStrength: TransactionStrength = 'serializable';

  /**
   * @summary Priority 0 — highest in the fallback chain. IDB is always preferred when available.
   */
  readonly priority: number = 0;

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _dbName: string;
  private readonly _storeName: string;

  // ── Runtime state ─────────────────────────────────────────────────────────

  private _db: IDBDatabase | null = null;
  private _initialized: boolean = false;
  private _transactions: Map<string, IDBTransaction> = new Map();

  /**
   * In-session read-access counter. Incremented on every successful `read()`.
   * Used as the tie-breaker during LFU eviction. Resets to zero on page reload
   * and on entry overwrite.
   */
  private _readCount: Map<CanonicalKey, number> = new Map();

  /**
   * @summary Makes a `IDBBackend`.
   */
  constructor(config: IDBBackendConfig = {}) {
    this._dbName = config.dbName ?? 'storage';
    this._storeName = config.storeName ?? 'entries';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @summary Perform a write/read/delete smoke test to confirm IndexedDB is
   * usable in the current environment.
   *
   * @description
   * Opens a temporary probe database (`__idb_probe_<timestamp>__`), creates an
   * object store, writes a record, reads it back, verifies the round-trip, then
   * deletes the probe database entirely. Returns `{ available: false }` if any
   * step fails.
   *
   * Known failure scenarios:
   * - Firefox with `dom.indexedDB.enabled = false` in `about:config`.
   * - Some sandboxed `iframe` environments that block `indexedDB` access.
   * - WebKit in certain private-browsing configurations.
   *
   * @returns `{ available: true, latency }` or `{ available: false, reason }`.
   */
  async probe(): Promise<CapabilityResult> {
    const start = performance.now();
    const probeName = `__idb_probe_${Date.now()}__`;
    let probeDb: IDBDatabase | null = null;

    try {
      if (typeof indexedDB === 'undefined') {
        return { available: false, reason: 'indexedDB is not defined in this context' };
      }

      probeDb = await openDatabase(probeName, 'probe');

      const nativeTx = probeDb.transaction(['probe'], 'readwrite');
      const store = nativeTx.objectStore('probe');
      const record = { key: '__probe__', value: 'ok' };
      store.put(record);
      await idbTransactionDone(nativeTx);

      const readTx = probeDb.transaction(['probe'], 'readonly');
      const readStore = readTx.objectStore('probe');
      const result = await idbRequest<{ key: string; value: string }>(readStore.get('__probe__'));

      if (!result || result.value !== 'ok') {
        return { available: false, reason: 'IDB probe: read-back value mismatch' };
      }

      return { available: true, latency: performance.now() - start };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      probeDb?.close();
      try {
        indexedDB.deleteDatabase(probeName);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /**
   * @summary Open the IDB database and mark the backend as initialized.
   *
   * @description
   * Calls `openDatabase(dbName, storeName)` which opens the database at
   * `DB_VERSION = 1`, creating the `entries` object store and its two indexes
   * (`by_expires_at`, `by_weight`) on first run.
   *
   * The `signal` is checked once before opening the database to honour
   * lifecycle abort signals from the SharedWorker.
   *
   * @param signal - Optional abort signal.
   * @throws {DOMException} If `indexedDB.open()` fails.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this._db = await openDatabase(this._dbName, this._storeName);
    this._initialized = true;
  }

  /**
   * @summary Roll back all pending transactions, close the IDB connection, and
   * release in-memory state.
   *
   * @description
   * Does not delete the database or any stored records. A subsequent
   * `initialize()` will reopen the same database and find all data intact.
   *
   * Pending transactions are rolled back (buffer discarded; no IDB ops were
   * issued so there is nothing to undo). The IDB connection is then closed via
   * `db.close()`, which prevents the connection from blocking future version
   * upgrades on this database.
   */
  async close(): Promise<void> {
    for (const tx of this._transactions.values()) {
      try {
        await tx.rollback();
      } catch {
        /* already settled */
      }
    }
    this._transactions.clear();
    this._readCount.clear();
    this._db?.close();
    this._db = null;
    this._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * @summary Write a `StorageEnvelope<string>` under `key`.
   *
   * @description
   * Builds an `IDBRecord` from the envelope and key, then issues a `store.put`
   * inside a `readwrite` transaction. `put` is an upsert — it creates or
   * replaces any existing record for that key.
   *
   * If `options.transactionId` is set, the record is buffered inside the named
   * transaction and no IDB ops occur until `commit()`.
   *
   * @param key      - The canonical key to write under.
   * @param envelope - The already-encrypted, already-serialized envelope.
   * @param options  - Optional write options (transactionId, signal).
   *
   * @throws {Error} If not initialized.
   * @throws {DOMException} If the IDB transaction fails.
   */
  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    options?: WriteOptions,
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const record: IDBRecord = {
      key,
      payload: envelope.payload,
      schema_version: envelope.schema_version,
      written_at: envelope.written_at,
      expires_at: envelope.expires_at,
      weight: envelope.weight,
      backend: envelope.backend,
      ...(envelope.integrity === undefined ? {} : { integrity: envelope.integrity }),
    };

    if (options?.transactionId) {
      this._getTransaction(options.transactionId).bufferWrite(key, record);
      return;
    }

    const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
    const store = nativeTx.objectStore(this._storeName);
    store.put(record);
    await idbTransactionDone(nativeTx);
    this._readCount.delete(key); // Reset LFU counter on overwrite
  }

  /**
   * @summary Read the raw `StorageEnvelope<string>` stored under `key`.
   *
   * @description
   * Issues a `store.get(key)` in a `readonly` transaction. Returns `null` if
   * the key does not exist. If TTL checking is enabled (default) and the entry
   * is expired, it is lazily deleted before returning `null`.
   *
   * Increments `_readCount[key]` on every successful (non-null, non-expired)
   * read for LFU tracking.
   *
   * @param key     - The canonical key to read.
   * @param options - Optional read options.
   * @returns The raw envelope, or `null` if absent or expired.
   *
   * @throws {Error} If not initialized.
   * @throws {DOMException} If the IDB request fails.
   */
  async read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<string> | null> {
    this._assertInitialized();

    const tx = this._db!.transaction([this._storeName], 'readonly');
    const store = tx.objectStore(this._storeName);
    const record = await idbRequest<IDBRecord | undefined>(store.get(key));

    if (!record) return null;

    const respectTtl = options?.respectTtl ?? true;
    if (respectTtl && this._isExpired(record)) {
      // Lazy TTL delete — fire and forget; don't block the read return.
      this._deleteRecord(key).catch(() => {
        /* best-effort */
      });
      this._readCount.delete(key);
      return null;
    }

    this._readCount.set(key, (this._readCount.get(key) ?? 0) + 1);
    return this._recordToEnvelope(record);
  }

  /**
   * @summary Delete the entry at `key`.
   *
   * @description
   * Idempotent — `store.delete(key)` succeeds even if the key does not exist
   * (IDB spec guarantee). If `options.transactionId` is set, the op is buffered.
   *
   * @param key     - The canonical key to delete.
   * @param options - Optional `{ transactionId?, signal? }`.
   *
   * @throws {Error} If not initialized.
   * @throws {DOMException} If the IDB transaction fails.
   */
  async delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    if (options?.transactionId) {
      this._getTransaction(options.transactionId).bufferDelete(key);
      return;
    }

    await this._deleteRecord(key);
  }

  /**
   * @summary Delete all entries whose canonical key starts with `prefix`.
   *
   * @description
   * When `prefix` is omitted, `store.clear()` wipes the entire object store —
   * more efficient than a cursor walk. When `prefix` is supplied,
   * `cursorDeleteMatching` opens a write cursor bounded by
   * `[prefix, prefix\uffff]` and deletes each matching record.
   *
   * If `options.transactionId` is set, the op is buffered.
   *
   * @param prefix  - Optional canonical key prefix. Absent = clear entire store.
   * @param options - Optional `{ signal?, transactionId? }`.
   *
   * @throws {Error} If not initialized.
   * @throws {DOMException} If the IDB transaction fails.
   */
  async clear(
    prefix?: string,
    options?: { signal?: AbortSignal; transactionId?: string },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    if (options?.transactionId) {
      this._getTransaction(options.transactionId).bufferClear(prefix);
      return;
    }

    const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
    const store = nativeTx.objectStore(this._storeName);
    await cursorDeleteMatching(store, prefix);
    await idbTransactionDone(nativeTx);
    // Clear any matching LFU counts that are now stale
    for (const key of [...this._readCount.keys()]) {
      if (!prefix || key.startsWith(prefix)) this._readCount.delete(key);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * @summary Return all raw envelopes matching the query criteria.
   *
   * @description
   * Collects all records from the object store, filtered by prefix using an
   * IDB key cursor (`cursorCollectPrefix`). Post-cursor filtering applies
   * `schema_version` and TTL predicates in JS. Expired records encountered
   * during the scan are lazily deleted.
   *
   * The IDB cursor uses a tight key range (`[prefix, prefix\uffff]`) when a
   * prefix is supplied, so the number of records loaded from disk is bounded
   * by the matching count rather than the total store size.
   *
   * @param q       - Query parameters.
   * @param options - Optional `{ signal? }`.
   * @returns Array of `{ key, envelope }` pairs.
   *
   * @throws {Error} If not initialized.
   */
  async query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
    this._assertInitialized();

    const excludeExpired = q.excludeExpired ?? true;
    const tx = this._db!.transaction([this._storeName], 'readonly');
    const store = tx.objectStore(this._storeName);
    const records = await cursorCollectPrefix(store, q.prefix);

    const results: Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }> = [];
    const toDelete: CanonicalKey[] = [];

    for (const record of records) {
      options?.signal?.throwIfAborted();

      if (q.schema_version !== undefined && record.schema_version !== q.schema_version) continue;
      if (excludeExpired && this._isExpired(record)) {
        toDelete.push(record.key);
        continue;
      }

      results.push({ key: record.key, envelope: this._recordToEnvelope(record) });
    }

    // Lazy TTL cleanup — fire and forget to avoid blocking query return.
    if (toDelete.length > 0) {
      Promise.all(toDelete.map((k) => this._deleteRecord(k).catch(() => {}))).catch(() => {});
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * @summary Return the count of entries matching the optional key prefix.
   *
   * @description
   * Uses `store.count(range?)` — a native IDB operation that avoids opening a
   * cursor and is O(log n) rather than O(n). No records are loaded into memory.
   *
   * @param prefix - Optional canonical key prefix.
   * @returns Integer count of matching entries.
   *
   * @throws {Error} If not initialized.
   */
  async count(prefix?: string): Promise<number> {
    this._assertInitialized();
    const tx = this._db!.transaction([this._storeName], 'readonly');
    const store = tx.objectStore(this._storeName);
    return countPrefix(store, prefix);
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * @summary Open a new serializable transaction.
   *
   * @description
   * Returns an `IDBTransaction` whose buffered ops are applied inside a single
   * native IDB `readwrite` transaction at `commit()` time.
   *
   * All strength levels (`'serializable'`, `'compensating'`, `'best-effort'`)
   * are accepted — the implementation provides serializable guarantees regardless
   * of the requested label, so weaker requests get more than they asked for.
   *
   * @param strength - Optional strength hint. Any value is accepted.
   * @returns An `IDBTransaction` typed as `ITransaction`.
   *
   * @throws {Error} If not initialized.
   */
  async beginTransaction(strength?: TransactionStrength): Promise<IDBTransaction> {
    this._assertInitialized();
    void strength; // All strengths are accepted; IDB always provides serializable.

    const tx = new IDBTransaction(
      (txId: string, ops: IDBBufferedOp[]) => this._applyCommit(txId, ops),
      (txId: string) => this._transactions.delete(txId),
    );
    this._transactions.set(tx.id, tx);
    return tx;
  }

  /**
   * @summary Check whether any (or a specific) transaction is currently active.
   *
   * @param txId - Optional transaction ID to check specifically.
   * @returns `true` if the specified (or any) transaction is active.
   */
  isTransactionActive(txId?: string): boolean {
    if (txId) return this._transactions.has(txId);
    return this._transactions.size > 0;
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  /**
   * @summary Estimate storage usage for the current origin's IndexedDB quota pool.
   *
   * @description
   * Delegates to `navigator.storage.estimate()`, which reports the true quota
   * and total usage for the entire origin (shared across IndexedDB, OPFS, and
   * CacheStorage). Falls back to `{ used: 0, available: 250MB, ratio: 0 }` if
   * the Quota API is unavailable.
   *
   * @returns `{ used, available, ratio }` in bytes.
   *
   * @throws {Error} If not initialized.
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();
    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      return {
        used: usage,
        available: Math.max(0, quota - usage),
        ratio: quota > 0 ? usage / quota : 0,
      };
    } catch {
      // No StorageManager API: measure this store's own records instead of
      // reporting zero usage, which would make eviction targets meaningless.
      const softCap = 250 * 1024 * 1024;
      const records = await collectByWeight(this._db!, this._storeName);
      const used = records.reduce((sum, rec) => sum + this._approximateBytes(rec), 0);
      return { used, available: Math.max(0, softCap - used), ratio: Math.min(1, used / softCap) };
    }
  }

  /**
   * @summary Evict entries to reclaim storage space.
   *
   * @description
   * Runs in two phases, mirroring the pattern used by all other backends:
   *
   * ### Phase 1 — Free TTL sweep
   * Uses the `by_expires_at` IDB index to collect all records with
   * `expires_at <= Date.now()` via an index cursor bounded by
   * `IDBKeyRange.upperBound(now)`. This is efficient: only records with
   * numeric (finite) `expires_at` values appear in the index; null (never-expiring)
   * records are invisible to it. Each expired record is deleted in a single
   * `readwrite` transaction. If the bytes freed satisfy `targetBytes`, Phase 2
   * is skipped.
   *
   * ### Phase 2 — Weighted eviction
   * Uses the `by_weight` index cursor (ascending weight order) to collect
   * eviction candidates. Candidates are sorted by weight ascending; ties are
   * broken by `policy`. Records are deleted one-by-one until `targetBytes`
   * bytes have been freed.
   *
   * Byte size estimation: `JSON.stringify(record).length * 2` (UTF-16 proxy).
   * Actual IDB storage overhead varies by browser engine but this approximation
   * is sufficient for eviction targeting.
   *
   * When `policy === 'user'`, the comparator receives full envelopes including
   * the actual payload — unlike OPFS/Cache which return stub envelopes. Because
   * IDB records are already in memory after the cursor walk, there is no extra
   * I/O cost to supply the payload.
   *
   * @param targetBytes - Stop evicting once this many bytes have been freed.
   * @param policy      - Tie-breaking eviction policy.
   * @param comparator  - Custom comparator; used only when `policy === 'user'`.
   * @returns Approximate bytes freed.
   *
   * @throws {Error} If not initialized.
   */
  async evict(
    targetBytes: number,
    policy: EvictionPolicy,
    comparator?: (
      a: { key: CanonicalKey; envelope: StorageEnvelope<string> },
      b: { key: CanonicalKey; envelope: StorageEnvelope<string> },
    ) => number,
  ): Promise<number> {
    this._assertInitialized();

    // ── Phase 1: TTL sweep via by_expires_at index ─────────────────────────
    let freed = 0;
    const expired = await collectExpired(this._db!, this._storeName);

    if (expired.length > 0) {
      const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
      const store = nativeTx.objectStore(this._storeName);
      for (const rec of expired) {
        store.delete(rec.key);
        freed += this._approximateBytes(rec);
        this._readCount.delete(rec.key);
      }
      await idbTransactionDone(nativeTx);
    }

    if (freed >= targetBytes) return freed;

    // ── Phase 2: weighted eviction via by_weight index ────────────────────
    const candidates = await collectByWeight(this._db!, this._storeName);

    // Apply secondary sort within weight ties
    candidates.sort((a, b) => {
      const weightDiff = a.weight - b.weight;
      if (weightDiff !== 0) return weightDiff;

      if (policy === 'user' && comparator) {
        return comparator(
          { key: a.key, envelope: this._recordToEnvelope(a) },
          { key: b.key, envelope: this._recordToEnvelope(b) },
        );
      }
      return this._defaultTieBreak(a, b, policy);
    });

    const toEvict: CanonicalKey[] = [];
    for (const rec of candidates) {
      if (freed >= targetBytes) break;
      freed += this._approximateBytes(rec);
      toEvict.push(rec.key);
    }

    if (toEvict.length > 0) {
      const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
      const store = nativeTx.objectStore(this._storeName);
      for (const key of toEvict) {
        store.delete(key);
        this._readCount.delete(key);
      }
      await idbTransactionDone(nativeTx);
    }

    return freed;
  }

  // ── Private: transaction commit ───────────────────────────────────────────

  /**
   * Apply a batch of buffered ops inside one native IDB `readwrite` transaction.
   *
   * All requests are issued synchronously against the same `IDBObjectStore`.
   * The native transaction is kept alive because IDB requests are queued on it
   * without any intermediate `await` between request issuances. IDB auto-commits
   * once all requests settle without error.
   *
   * If any request fails (e.g., constraint violation), IDB aborts the entire
   * transaction atomically. `idbTransactionDone` then rejects, the error
   * propagates to the caller's `commit()` await, and no partial writes survive.
   */
  private async _applyCommit(txId: string, ops: IDBBufferedOp[]): Promise<void> {
    try {
      if (ops.length === 0) return;

      const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
      const store = nativeTx.objectStore(this._storeName);

      for (const op of ops) {
        switch (op.kind) {
          case 'write':
            store.put(op.record);
            this._readCount.delete(op.key);
            break;
          case 'delete':
            store.delete(op.key);
            this._readCount.delete(op.key);
            break;
          case 'clear':
            // cursorDeleteMatching must be called within the same transaction.
            // Because it uses its own IDB request internally we can't simply
            // call it here and mix it with the loop — instead we handle the
            // clear case by issuing the requests directly inline.
            if (!op.prefix) {
              store.clear();
              this._readCount.clear();
            } else {
              // We cannot use cursorDeleteMatching here because its async
              // Promise resolution would let the transaction auto-commit before
              // subsequent ops run. Instead, emit a synchronous key-range delete
              // request using the built-in IDBObjectStore.delete(keyRange) API,
              // which is synchronous and does not drain the request queue.
              const range = IDBKeyRange.bound(op.prefix, op.prefix + '\uffff');
              store.delete(range);
              for (const key of [...this._readCount.keys()]) {
                if (key.startsWith(op.prefix)) this._readCount.delete(key);
              }
            }
            break;
        }
      }

      await idbTransactionDone(nativeTx);
    } finally {
      this._transactions.delete(txId);
    }
  }

  // ── Private: atomic op primitives ─────────────────────────────────────────

  /** Delete one record by key. Idempotent. */
  private async _deleteRecord(key: CanonicalKey): Promise<void> {
    const nativeTx = this._db!.transaction([this._storeName], 'readwrite');
    const store = nativeTx.objectStore(this._storeName);
    store.delete(key);
    await idbTransactionDone(nativeTx);
    this._readCount.delete(key);
  }

  // ── Private: guards and helpers ───────────────────────────────────────────

  private _assertInitialized(): void {
    if (!this._initialized || !this._db) {
      throw new Error('[IDBBackend] Backend not initialized. Call initialize() first.');
    }
  }

  private _isExpired(record: IDBRecord): boolean {
    return record.expires_at !== null && record.expires_at < Date.now();
  }

  private _getTransaction(id: string): IDBTransaction {
    const tx = this._transactions.get(id);
    if (!tx) throw new Error(`[IDBBackend] No active transaction with id "${id}".`);
    return tx;
  }

  private _recordToEnvelope(record: IDBRecord): StorageEnvelope<string> {
    return {
      payload: record.payload,
      schema_version: record.schema_version,
      written_at: record.written_at,
      expires_at: record.expires_at,
      weight: record.weight,
      backend: record.backend,
      ...(record.integrity === undefined ? {} : { integrity: record.integrity }),
    };
  }

  /** UTF-16 byte-length approximation for an IDB record. */
  private _approximateBytes(record: IDBRecord): number {
    return JSON.stringify(record).length * 2;
  }

  private _defaultTieBreak(a: IDBRecord, b: IDBRecord, policy: EvictionPolicy): number {
    switch (policy) {
      case 'lru':
      case 'fifo':
        return a.written_at - b.written_at;
      case 'lfu': {
        const aReads = this._readCount.get(a.key) ?? 0;
        const bReads = this._readCount.get(b.key) ?? 0;
        return aReads - bReads;
      }
      default:
        return 0;
    }
  }
}
