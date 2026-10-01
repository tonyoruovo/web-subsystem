/**
 * @fileoverview CacheStorage storage backend implementation.
 *
 * ## Architectural intent
 * `CacheBackend` implements `IStorageBackend<string>` using the browser's
 * Cache API (`caches.open` / `cache.put` / `cache.match` / `cache.delete`)
 * as the storage medium.
 *
 * Its role in the wider storage subsystem is:
 * - **Tertiary persistent backend** in the fallback chain (priority = 2),
 *   positioned after IndexedDB (priority 0) and OPFS (priority 1). Preferred
 *   over LocalStorage and SessionStorage because it is not subject to the
 *   5 MB `localStorage` quota and does not expose values to the synchronous
 *   `window.localStorage` surface.
 * - Falls back transparently to Memory in environments where CacheStorage is
 *   unavailable (Firefox private mode, some embedded WebViews).
 *
 * ## The adaptation problem: Request → Response
 * The Cache API is designed for HTTP response caching. Its native key type is
 * a `Request` object (or URL string); its native value type is a `Response`
 * object. The storage subsystem's model is `CanonicalKey → StorageEnvelope`.
 *
 * `CacheBackend` bridges these by:
 * - **Key**: wrapping every canonical key in a synthetic URL
 *   (`https://storage.internal/<canonicalKey>`) that the Cache API accepts.
 * - **Value**: JSON-serializing the full `StorageEnvelope<string>` and
 *   storing it as the text body of a synthetic `Response` object with the
 *   `Content-Type: application/json` header.
 *
 * These adaptations are entirely internal. Callers interact only with the
 * standard `IStorageBackend<string>` interface.
 *
 * ## Data flow: write
 * ```txt
 * Pipeline (outside this class)
 *   │  value -> zod.parse -> serialize -> encrypt -> envelope{ payload: string }
 *   │
 *   ▼
 * CacheBackend.write(key, envelope)
 *   │
 *   ├─[no transactionId]──────────────────────────────────────────────────────┐
 *   │                                                                         │
 *   │   canonicalKeyToURL(key)  ->  'https://storage.internal/<key>'          │
 *   │   JSON.stringify(envelope) ->  envelopeJson                             │
 *   │   new Response(envelopeJson, { headers: { 'Content-Type': 'application/json' } })
 *   │   cache.put(url, response)                                              │
 *   │   _index.set(key, { written_at, expires_at, weight, schema_version })   │
 *   │   [optional] _enforceMaxEntries()                                       │
 *   │                                                                         │
 *   └─[transactionId present]──────────────────────────────────────────────────┘
 *       tx.bufferWrite(key, JSON.stringify(envelope))
 *       -> ops[] grows; zero Cache API activity until commit()
 * ```
 *
 * ## Data flow: read
 * ```txt
 * CacheBackend.read(key)
 *   │
 *   ├── _index.get(key)  ->  null  ->  return null
 *   │
 *   ├── TTL check (_isExpired)
 *   │     true  ->  cache.delete(url) + _index.delete(key)  ->  return null
 *   │
 *   ├── cache.match(url)   ->  null  ->  stale index cleanup  ->  return null
 *   │
 *   ├── response.text()  ->  envelopeJson
 *   │
 *   ├── JSON.parse(envelopeJson)  ->  StorageEnvelope<string>
 *   │
 *   ├── _readCount[key]++    <- LFU tracking
 *   │
 *   └── return envelope
 *         │
 *         ▼
 *       Pipeline (outside this class)
 *         decrypt -> user deserializer -> zod.parse -> typed value
 * ```
 *
 * ## Transaction commit sequence
 * ```txt
 * CacheTransaction.commit()
 *   │
 *   ▼
 * CacheBackend._applyCommit(txId, ops)
 *   │
 *   ├── for each op in ops:
 *   │     'write'  ->  cache.put(url, response) + _index.set(key, meta)
 *   │     'delete' ->  cache.delete(url) + _index.delete(key)
 *   │     'clear'  ->  iterate cache.keys(), delete matching, _index sweep
 *   │
 *   └── _transactions.delete(txId)
 * ```
 *
 * ## In-memory index
 * The Cache API provides no way to enumerate entries by key prefix or to
 * inspect entry metadata (TTL, weight, schema version) without fetching the
 * full Response body. To support prefix-filtered `query()`, efficient `count()`,
 * TTL checking, and eviction without a full cache scan, `CacheBackend` maintains
 * an in-memory `_index: Map<CanonicalKey, CacheIndexEntry>` that mirrors the
 * lightweight metadata for every stored entry.
 *
 * The index is loaded from the cache at `initialize()` time by iterating all
 * cache keys and fetching each Response body. This is the only time the index
 * is rebuilt from the cache; after that, all mutations (write, delete, clear)
 * update the index atomically alongside the Cache API call.
 *
 * A stale index entry (present in `_index` but missing from the cache) is
 * silently removed during `read()` or `query()`. A missing index entry (present
 * in cache but not in `_index`) is repopulated during `initialize()` — the
 * cache is the source of truth for recovery.
 *
 * ## No crash recovery
 * Unlike the OPFS backend, `CacheBackend` provides no write-ahead log and no
 * crash recovery mechanism. Transactions are `'best-effort'` only. If the
 * process dies mid-commit, the cache is left in a partially applied state.
 * On next `initialize()`, the index is rebuilt from whatever entries the cache
 * still holds — a self-healing but non-atomic approach.
 *
 * ## TRaw = string
 * `CacheBackend` is typed `IStorageBackend<string>`. `envelope.payload` is
 * always an **already-encrypted, already-serialized** string by the time it
 * reaches this backend. The backend stores it verbatim inside the JSON-encoded
 * envelope body and returns it as-is on read.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage | MDN: CacheStorage}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Cache | MDN: Cache}
 * @see {@link IStorageBackend} for the full interface contract.
 * @see {@link CacheTransaction} for the transaction implementation.
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
} from '../../storage.types';

import { CACHE_KEY_NAMESPACE } from './cache.const';
import { CacheTransaction } from './cache.transaction';
import type { CacheBackendConfig, CacheBufferedOp, CacheIndexEntry } from './cache.types';
import { canonicalKeyToURL, urlToCanonicalKey } from './cache.util';
// ─────────────────────────────────────────────────────────────────────────────
// CacheBackend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary CacheStorage-backed implementation of `IStorageBackend<string>`.
 *
 * @description
 * `CacheBackend` stores `StorageEnvelope<string>` values using the browser's
 * Cache API. Each envelope is JSON-serialized and wrapped in a synthetic
 * `Response` object; each canonical key is mapped to a synthetic URL so the
 * Cache API can key on it.
 *
 * **When to use**: when IndexedDB and OPFS are unavailable and a persistent
 * storage option that exceeds `localStorage`'s 5 MB limit is still required.
 * CacheStorage shares the same origin-partitioned quota pool as IndexedDB
 * and OPFS (inspectable via `navigator.storage.estimate()`), so it can
 * accommodate substantially larger datasets.
 *
 * **Limitations vs. OPFS / IndexedDB**:
 * - Transaction strength is `'best-effort'` only — no WAL, no crash recovery.
 * - No native enumeration by prefix; prefix queries iterate the in-memory index.
 * - Browser may evict entries under storage pressure without notice in some
 *   environments (though this is rare for explicitly named Cache buckets).
 * - Unavailable in Firefox private mode (probe returns `available: false`).
 *
 * **In-memory index**: `CacheBackend` maintains a `Map<CanonicalKey, CacheIndexEntry>`
 * mirroring lightweight entry metadata (TTL, weight, schema version) to avoid
 * repeatedly fetching Response bodies just for metadata inspection. The index
 * is populated at `initialize()` time and kept in sync on every mutation.
 *
 * @example Basic lifecycle
 * ```ts
 * const backend = new CacheBackend({ cacheName: 'app-storage' })
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
 *   backend:        'cache',
 * })
 *
 * const envelope = await backend.read(key)
 * // envelope.payload === 'AES-GCM-ENCRYPTED'
 *
 * await backend.close()
 * ```
 *
 * @example Transactional write
 * ```ts
 * const tx = await backend.beginTransaction()
 * try {
 *   await backend.write(keyA, envelopeA, { transactionId: tx.id })
 *   await backend.delete(keyB,           { transactionId: tx.id })
 *   await tx.commit()
 * } catch {
 *   await tx.rollback()
 * }
 * ```
 *
 * @see {@link CacheTransaction} for the transaction model.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage | MDN: CacheStorage}
 */
export class CacheBackend implements IStorageBackend<string> {
  /** @inheritdoc */
  readonly kind: BackendKind = 'cache';

  /**
   * @inheritdoc
   * CacheStorage has no native transaction primitive; ops are applied
   * sequentially with no atomic rollback on crash.
   */
  readonly transactionStrength: TransactionStrength = 'best-effort';

  /**
   * Priority 2 in the backend fallback chain — after IndexedDB (0) and OPFS
   * (1), ahead of LocalStorage (3) and Memory (4).
   */
  readonly priority: number = 2;

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _cacheName: string;
  private readonly _maxEntries?: number;

  // ── Runtime state ─────────────────────────────────────────────────────────

  private _cache: Cache | null = null;
  private _initialized: boolean = false;
  private _transactions: Map<string, CacheTransaction> = new Map();

  /**
   * Lightweight in-memory metadata mirror for all cache entries.
   *
   * Populated at `initialize()` by iterating the cache bucket. Updated
   * atomically on every write / delete / clear so it stays in sync without
   * requiring a cache re-scan. Used to answer TTL checks, count queries,
   * prefix scans, and eviction candidate sorting without fetching Response bodies.
   */
  private _index: Map<CanonicalKey, CacheIndexEntry> = new Map();

  /**
   * In-session read-access counter. Incremented on every successful `read()`.
   * Used as the tie-breaker during LFU eviction. Resets to zero on reload and
   * on entry overwrite.
   *
   * @see {@link evict} for the eviction model.
   */
  private _readCount: Map<CanonicalKey, number> = new Map();

  constructor({ cacheName, maxEntries }: CacheBackendConfig = {}) {
    this._cacheName = cacheName ?? 'storage-cache';
    this._maxEntries = maxEntries;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @summary Perform a write/match/delete smoke test to confirm CacheStorage
   * is usable in the current environment.
   *
   * @description
   * Executes a minimal round-trip against a disposable probe cache bucket:
   * open a temporary cache, write a synthetic entry, read it back, verify
   * the body, then delete the entry and the bucket. Returns
   * `{ available: false }` if any step throws or the read-back body does
   * not match the written value. This covers the known Firefox private-mode
   * failure case where `caches.open()` throws `SecurityError`.
   *
   * The probe uses a separate cache name (`__probe_<timestamp>__`) so it
   * does not pollute the application's cache bucket.
   *
   * @returns A `CapabilityResult` with `available: true` and a round-trip
   *   latency measurement on success, or `available: false` with a human-readable
   *   `reason` on failure.
   */
  async probe(): Promise<CapabilityResult> {
    const start = performance.now();
    const probeName = `__cache_probe_${Date.now()}__`;

    try {
      if (typeof caches === 'undefined') {
        return {
          available: false,
          reason: 'CacheStorage (caches) is not available in this context',
        };
      }

      const probeCache = await caches.open(probeName);
      const probeURL = `${CACHE_KEY_NAMESPACE}/__probe__`;
      await probeCache.put(
        probeURL,
        new Response('probe', { headers: { 'Content-Type': 'text/plain' } }),
      );
      const response = await probeCache.match(probeURL);
      if (!response)
        return {
          available: false,
          reason: 'CacheStorage probe: cache.match returned null after put',
        };

      const body = await response.text();
      if (body !== 'probe')
        return { available: false, reason: 'CacheStorage probe: read-back body mismatch' };

      await probeCache.delete(probeURL);
      await caches.delete(probeName);

      return { available: true, latency: performance.now() - start };
    } catch (err) {
      try {
        await caches.delete(probeName);
      } catch {
        /* best-effort cleanup */
      }
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @summary Open the cache bucket and rebuild the in-memory index from
   * existing entries.
   *
   * @description
   * Boot sequence:
   * 1. `caches.open(cacheName)` — opens (or creates) the named cache bucket.
   * 2. `cache.keys()` — retrieves all `Request` objects currently in the bucket.
   * 3. For each key, `cache.match()` fetches the `Response` and parses the
   *    JSON envelope body to extract index metadata.
   * 4. Entries whose URL does not match the `CACHE_KEY_NAMESPACE` prefix are
   *    silently skipped (defensive filtering against accidental cross-contamination).
   * 5. The `_index` is populated with one `CacheIndexEntry` per recovered entry.
   * 6. `_initialized = true`.
   *
   * An `AbortSignal` is checked after each key is processed. If aborted
   * mid-init, the index may be partially populated — a subsequent `close()`
   * followed by `initialize()` will rebuild it fully.
   *
   * @param signal - Optional abort signal. Checked between each key load.
   * @throws {DOMException} If `caches.open()` throws (e.g., storage permission denied).
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    this._cache = await caches.open(this._cacheName);

    // Rebuild the in-memory index from existing cache entries
    const requests = await this._cache.keys();
    for (const request of requests) {
      signal?.throwIfAborted();

      const key = urlToCanonicalKey(request.url);
      if (!key) continue; // Skip any non-storage entries

      try {
        const response = await this._cache.match(request);
        if (!response) continue;

        const envelope = JSON.parse(await response.text()) as StorageEnvelope<string>;
        this._index.set(key, {
          schema_version: envelope.schema_version,
          written_at: envelope.written_at,
          expires_at: envelope.expires_at,
          weight: envelope.weight,
          backend: envelope.backend,
        });
      } catch {
        // Corrupted entry — skip; leave in cache but omit from index.
        // It will be invisible to read/query and cleaned up on next eviction.
      }
    }

    this._initialized = true;
  }

  /**
   * @summary Roll back all pending transactions and release in-memory state.
   *
   * @description
   * Does not delete the cache bucket or its entries — the stored data
   * persists in the browser's CacheStorage across page loads. A subsequent
   * `initialize()` will restore the index from the cache.
   *
   * Pending transactions are rolled back (buffer discarded; no Cache API
   * writes occur) before the index and read-count map are cleared.
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
    this._index.clear();
    this._readCount.clear();
    this._cache = null;
    this._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * @summary Write a `StorageEnvelope<string>` to the cache under `key`.
   *
   * @description
   * Serializes the envelope to JSON, wraps it in a synthetic `Response`, and
   * stores it via `cache.put(syntheticURL, response)`. The in-memory index is
   * updated atomically. If `maxEntries` is configured and the write would push
   * the entry count over the limit, `_enforceMaxEntries()` is called to evict
   * the least-recently-written entries before resolving.
   *
   * If `options.transactionId` is set, the op is buffered inside the named
   * transaction and no Cache API writes occur until `commit()`.
   *
   * @param key      - The canonical key to write under.
   * @param envelope - The already-encrypted, already-serialized envelope.
   * @param options  - Optional write options (TTL override, weight, transactionId).
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    options?: WriteOptions,
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const envelopeJson = JSON.stringify(envelope);

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferWrite(key, envelopeJson);
      return;
    }

    await this._putEntry(key, envelope, envelopeJson);

    if (this._maxEntries !== undefined && this._index.size > this._maxEntries) {
      await this._enforceMaxEntries();
    }
  }

  /**
   * @summary Read the raw `StorageEnvelope<string>` stored under `key`.
   *
   * @description
   * Checks the in-memory index first; returns `null` immediately if the key
   * is absent. If TTL checking is enabled (default) and the entry is expired,
   * it is lazily deleted from the cache and index before returning `null`.
   *
   * On a cache miss despite an index hit (stale index entry), the index is
   * cleaned up and `null` is returned. This self-heals stale index state that
   * can arise after a browser-initiated cache eviction.
   *
   * Increments `_readCount[key]` on every successful read for LFU tracking.
   *
   * **Note**: `options.transactionId` is intentionally ignored. Reads always
   * reflect committed state. Read-your-own-writes is a pipeline-layer concern.
   *
   * @param key     - The canonical key to read.
   * @param options - Optional read options (`respectTtl`, `signal`).
   * @returns The raw envelope, or `null` if absent or expired.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<string> | null> {
    this._assertInitialized();

    const indexEntry = this._index.get(key);
    if (!indexEntry) return null;

    const respectTtl = options?.respectTtl ?? true;
    if (respectTtl && this._isExpired(indexEntry)) {
      await this._deleteEntry(key);
      return null;
    }

    const url = canonicalKeyToURL(key);
    const response = await this._cache!.match(url);

    if (!response) {
      // Stale index — cache was evicted by browser; clean up
      this._index.delete(key);
      this._readCount.delete(key);
      return null;
    }

    let envelope: StorageEnvelope<string>;
    try {
      envelope = JSON.parse(await response.text()) as StorageEnvelope<string>;
    } catch {
      // Corrupted response body — treat as missing
      await this._deleteEntry(key);
      return null;
    }

    this._readCount.set(key, (this._readCount.get(key) ?? 0) + 1);
    return envelope;
  }

  /**
   * @summary Delete the entry at `key` from the cache.
   *
   * @description
   * Idempotent — resolves without error if the key is not present in the
   * index or the cache. If `options.transactionId` is set, the op is buffered.
   *
   * @param key     - The canonical key to delete.
   * @param options - Optional `{ transactionId?, signal? }`.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferDelete(key);
      return;
    }

    await this._deleteEntry(key);
  }

  /**
   * @summary Delete all entries whose canonical key starts with `prefix`.
   *
   * @description
   * If `prefix` is omitted, all entries in this cache bucket are deleted
   * (full clear). Iterates the in-memory index to identify matching keys;
   * Cache API deletes are performed sequentially. The index is updated
   * atomically alongside each cache delete.
   *
   * The `signal` is checked between each delete. If `options.transactionId`
   * is set, the op is buffered.
   *
   * @param prefix  - Optional key prefix. Omit to clear all entries.
   * @param options - Optional `{ signal?, transactionId? }`.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async clear(
    prefix?: string,
    options?: { signal?: AbortSignal; transactionId?: string },
  ): Promise<void> {
    this._assertInitialized();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferClear(prefix);
      return;
    }
    options?.signal?.throwIfAborted();

    const toDelete: CanonicalKey[] = [];
    for (const key of this._index.keys()) {
      if (!prefix || key.startsWith(prefix)) toDelete.push(key);
    }

    for (const key of toDelete) {
      options?.signal?.throwIfAborted();
      await this._deleteEntry(key);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * @summary Return all raw envelopes matching the query criteria.
   *
   * @description
   * Performs prefix and schema-version filtering against the in-memory index
   * (O(n) scan, no Cache API calls). For each matching, non-expired entry,
   * the full Response body is fetched from the cache and the envelope is
   * reconstructed. Expired or unreadable entries are lazily deleted during
   * the scan, and the index is updated accordingly.
   *
   * Results are collected in insertion order, then sliced by `q.offset` and
   * `q.limit`. The signal is checked between each cache fetch.
   *
   * @param q       - Query parameters (prefix, schema_version, limit, offset, excludeExpired).
   * @param options - Optional `{ signal? }`.
   * @returns Array of `{ key, envelope }` pairs for all matching entries.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
    this._assertInitialized();

    const excludeExpired = q.excludeExpired ?? true;
    const results: Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }> = [];
    const toDelete: CanonicalKey[] = [];

    for (const [key, indexEntry] of this._index) {
      options?.signal?.throwIfAborted();

      if (q.prefix && !key.startsWith(q.prefix)) continue;
      if (q.schema_version !== undefined && indexEntry.schema_version !== q.schema_version)
        continue;
      if (excludeExpired && this._isExpired(indexEntry)) {
        toDelete.push(key);
        continue;
      }

      const url = canonicalKeyToURL(key);
      const response = await this._cache!.match(url);

      if (!response) {
        toDelete.push(key);
        continue;
      }

      try {
        const envelope = JSON.parse(await response.text()) as StorageEnvelope<string>;
        results.push({ key, envelope });
      } catch {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) await this._deleteEntry(key);

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * @summary Return the count of entries matching the optional key prefix.
   *
   * @description
   * Uses the in-memory index — no Cache API calls. The count includes all
   * index entries regardless of TTL (expired entries that have not yet been
   * lazily cleaned up are counted). For an expired-exclusive count, call
   * `query({ excludeExpired: true })` instead.
   *
   * @param prefix - Optional key prefix. Omit to count all entries.
   * @returns Integer count of matching entries.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async count(prefix?: string): Promise<number> {
    this._assertInitialized();
    if (!prefix) return this._index.size;
    let n = 0;
    for (const key of this._index.keys()) {
      if (key.startsWith(prefix)) n++;
    }
    return n;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * @summary Open a new best-effort transaction.
   *
   * @description
   * Returns a `CacheTransaction` whose buffered ops are applied sequentially
   * to the cache on `commit()`. There is no WAL, no crash recovery, and no
   * isolation from concurrent readers in other tabs.
   *
   * `'serializable'` and `'compensating'` strength requests are rejected
   * immediately — CacheStorage cannot provide either. Use IndexedDB for
   * serializable guarantees or OPFS for compensating (WAL-backed) transactions.
   *
   * @param strength - Must be `'best-effort'` or omitted.
   * @returns A `CacheTransaction` cast to the narrower `ITransaction` interface.
   *
   * @throws {Error} If `strength` is `'serializable'` or `'compensating'`.
   * @throws {Error} If the backend has not been initialized.
   */
  async beginTransaction(strength?: TransactionStrength): Promise<CacheTransaction> {
    this._assertInitialized();

    if (strength === 'serializable' || strength === 'compensating') {
      throw new Error(
        `[CacheBackend] Requested transaction strength "${strength}" is not supported. ` +
          'CacheStorage supports only "best-effort" transactions. ' +
          'Use IndexedDB for serializable or OPFS for compensating transactions.',
      );
    }

    const tx = new CacheTransaction(
      (txId: string, ops: CacheBufferedOp[]) => this._applyCommit(txId, ops),
      (txId: string) => this._transactions.delete(txId),
    );
    this._transactions.set(tx.id, tx);
    return tx;
  }

  /**
   * @summary Check whether any (or a specific) transaction is currently active.
   *
   * @description
   * When called without an argument, returns `true` if there is at least one
   * unsettled transaction in the registry. When called with a `txId`, returns
   * `true` only if that specific transaction is present and unsettled.
   *
   * @param txId - Optional transaction ID to check.
   * @returns `true` if the specified (or any) transaction is active.
   */
  isTransactionActive(txId?: string): boolean {
    try {
      if (txId) return this._transactions.has(txId);
      return this._transactions.size > 0;
    } catch {
      return false;
    }
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  /**
   * @summary Estimate storage usage for the current origin's CacheStorage
   * quota pool.
   *
   * @description
   * Prefers `navigator.storage.estimate()` which returns the true quota and
   * usage for the entire origin (shared across CacheStorage, IndexedDB, and
   * OPFS). Falls back to an in-memory approximation (sum of serialized
   * envelope sizes * 2 for UTF-16 overhead) against a 500 MB soft cap if the
   * Quota API throws or is unavailable.
   *
   * @returns A `QuotaEstimate` with `used`, `available`, and `ratio` fields.
   *
   * @throws {Error} If the backend has not been initialized.
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();

    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const soFar = estimate.usage ?? 0;
      return {
        used: soFar,
        available: Math.max(0, quota - soFar),
        ratio: quota > 0 ? soFar / quota : 0,
      };
    } catch {
      // Approximation: sum key + envelope lengths as UTF-16 byte count
      let used = 0;
      for (const [key, entry] of this._index) {
        used += key.length * 2;
        used += JSON.stringify(entry).length * 2; // rough per-entry estimate
      }
      const softCap = 500 * 1024 * 1024;
      return { used, available: Math.max(0, softCap - used), ratio: Math.min(1, used / softCap) };
    }
  }

  /**
   * @summary Evict entries to reclaim storage space.
   *
   * @description
   * Runs in two phases:
   *
   * ### Phase 1 — Free TTL sweep
   * All entries whose `expires_at < Date.now()` are deleted from the cache
   * and index. If the bytes freed in this phase satisfy `targetBytes`,
   * eviction stops here.
   *
   * ### Phase 2 — Weighted eviction
   * Remaining entries are sorted ascending by `weight` (lower weight =
   * evicted first). Ties are broken by `policy`:
   * - `'lru'` / `'fifo'` — oldest `written_at` first.
   * - `'lfu'` — lowest `_readCount` first (in-session only; resets on reload).
   * - `'user'` — `comparator` function supplied by the caller.
   *
   * When `policy === 'user'`, the comparator receives `StorageEnvelope<string>`
   * objects whose `payload` field is an **empty string** `''`. Fetching all
   * payloads just to sort candidates for eviction would require reading every
   * Response body — prohibitively expensive for large stores. Comparators that
   * need payload content should maintain an external index or use a different
   * policy.
   *
   * Byte estimation is based on the serialized envelope size (index entry +
   * key length * 2 as a UTF-16 proxy). This is an approximation; actual cache
   * memory usage varies by browser implementation.
   *
   * @param targetBytes - Stop evicting once this many bytes have been freed.
   * @param policy      - Tie-breaking eviction policy.
   * @param comparator  - Custom comparator; only consulted when `policy === 'user'`.
   * @returns Approximate number of bytes freed.
   *
   * @throws {Error} If the backend has not been initialized.
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

    // Phase 1: free TTL sweep
    let freed = 0;
    const stale: CanonicalKey[] = [];
    for (const [key, entry] of this._index) {
      if (this._isExpired(entry)) stale.push(key);
    }
    for (const key of stale) {
      freed += this._approximateEntryBytes(key);
      await this._deleteEntry(key);
    }
    if (freed >= targetBytes) return freed;

    // Phase 2: weighted eviction
    const candidates = [...this._index.entries()].map(([key, entry]) => ({ key, entry }));
    candidates.sort((a, b) => {
      const weightDiff = a.entry.weight - b.entry.weight;
      if (weightDiff !== 0) return weightDiff;

      if (policy === 'user' && comparator) {
        const stub = (
          key: CanonicalKey,
          entry: CacheIndexEntry,
        ): { key: CanonicalKey; envelope: StorageEnvelope<string> } => ({
          key,
          envelope: {
            payload: '',
            schema_version: entry.schema_version,
            written_at: entry.written_at,
            expires_at: entry.expires_at,
            weight: entry.weight,
            backend: entry.backend,
          },
        });
        return comparator(stub(a.key, a.entry), stub(b.key, b.entry));
      }
      return this._defaultTieBreak(a.key, a.entry, b.key, b.entry, policy);
    });

    for (const { key } of candidates) {
      if (freed >= targetBytes) break;
      freed += this._approximateEntryBytes(key);
      await this._deleteEntry(key);
    }

    return freed;
  }

  // ── Private: atomic ops ───────────────────────────────────────────────────

  /**
   * Write one entry to the cache and update the index. Does NOT enforce
   * `maxEntries`; callers are responsible for calling `_enforceMaxEntries()`
   * after all writes in a batch.
   */
  private async _putEntry(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    envelopeJson: string,
  ): Promise<void> {
    const url = canonicalKeyToURL(key);
    const response = new Response(envelopeJson, {
      headers: { 'Content-Type': 'application/json' },
    });
    await this._cache!.put(url, response);
    this._index.set(key, {
      schema_version: envelope.schema_version,
      written_at: envelope.written_at,
      expires_at: envelope.expires_at,
      weight: envelope.weight,
      backend: envelope.backend,
    });
    this._readCount.delete(key); // Reset LFU counter on overwrite
  }

  /**
   * Delete one entry from the cache and update the index. Idempotent.
   */
  private async _deleteEntry(key: CanonicalKey): Promise<void> {
    const url = canonicalKeyToURL(key);
    await this._cache!.delete(url); // No-op if already absent
    this._index.delete(key);
    this._readCount.delete(key);
  }

  /**
   * Apply a full prefix clear against the cache. Updates the index for each
   * deleted entry. Called by `clear()` for non-transactional clears and by
   * `_applyCommit()` for buffered clear ops.
   */
  private async _applyClear(prefix?: string, signal?: AbortSignal): Promise<void> {
    const toDelete: CanonicalKey[] = [];
    for (const key of this._index.keys()) {
      if (!prefix || key.startsWith(prefix)) toDelete.push(key);
    }
    for (const key of toDelete) {
      signal?.throwIfAborted();
      await this._deleteEntry(key);
    }
  }

  // ── Private: transaction commit ───────────────────────────────────────────

  /**
   * Called by `CacheTransaction.commit()` to apply buffered ops sequentially.
   *
   * No WAL is written; ops are applied directly to the cache. If a single op
   * throws, the error propagates and the transaction is removed from the
   * registry — the cache is left in a partially applied state.
   */
  private async _applyCommit(txId: string, ops: CacheBufferedOp[]): Promise<void> {
    try {
      for (const op of ops) {
        switch (op.kind) {
          case 'write': {
            const envelope = JSON.parse(op.envelopeJson) as StorageEnvelope<string>;
            await this._putEntry(op.key, envelope, op.envelopeJson);
            break;
          }
          case 'delete':
            await this._deleteEntry(op.key);
            break;
          case 'clear':
            await this._applyClear(op.prefix);
            break;
        }
      }

      if (this._maxEntries !== undefined && this._index.size > this._maxEntries) {
        await this._enforceMaxEntries();
      }
    } finally {
      this._transactions.delete(txId);
    }
  }

  // ── Private: maxEntries enforcement ───────────────────────────────────────

  /**
   * Evict the oldest (by `written_at`) entries until the index size is
   * at or below `_maxEntries`. Called after any write that pushes the count
   * over the configured limit.
   */
  private async _enforceMaxEntries(): Promise<void> {
    if (this._maxEntries === undefined) return;

    // First, sweep expired entries for free
    const stale: CanonicalKey[] = [];
    for (const [key, entry] of this._index) {
      if (this._isExpired(entry)) stale.push(key);
    }
    for (const key of stale) await this._deleteEntry(key);
    if (this._index.size <= this._maxEntries) return;

    // Then evict by LRU (oldest written_at)
    const sorted = [...this._index.entries()].sort(([, a], [, b]) => a.written_at - b.written_at);

    while (this._index.size > this._maxEntries && sorted.length > 0) {
      const [key] = sorted.shift()!;
      if (this._index.has(key)) await this._deleteEntry(key);
    }
  }

  // ── Private: guards and helpers ───────────────────────────────────────────

  private _assertInitialized(): void {
    if (!this._initialized || !this._cache) {
      throw new Error('[CacheBackend] Backend not initialized. Call initialize() first.');
    }
  }

  private _isExpired(entry: CacheIndexEntry): boolean {
    return entry.expires_at !== null && entry.expires_at < Date.now();
  }

  private _getTransaction(id: string): CacheTransaction {
    const tx = this._transactions.get(id);
    if (!tx) throw new Error(`[CacheBackend] No active transaction with id "${id}".`);
    return tx;
  }

  private _approximateEntryBytes(key: CanonicalKey): number {
    const entry = this._index.get(key);
    if (!entry) return 0;
    return key.length * 2 + JSON.stringify(entry).length * 2;
  }

  private _defaultTieBreak(
    aKey: CanonicalKey,
    aEntry: CacheIndexEntry,
    bKey: CanonicalKey,
    bEntry: CacheIndexEntry,
    policy: EvictionPolicy,
  ): number {
    switch (policy) {
      case 'lru':
      case 'fifo':
        return aEntry.written_at - bEntry.written_at;
      case 'lfu': {
        const aReads = this._readCount.get(aKey) ?? 0;
        const bReads = this._readCount.get(bKey) ?? 0;
        return aReads - bReads;
      }
      default:
        return 0;
    }
  }
}
