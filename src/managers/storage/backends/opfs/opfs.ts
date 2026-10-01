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

import {
  AsyncIOAdapterFactory,
  SyncIOAdapterFactory,
  decodeBytes,
  detectIOAdapterFactory,
  encodeString,
} from './opfs.io';
import { OPFSTransaction } from './opfs.transaction';
import type {
  IIOAdapterFactory,
  Manifest,
  ManifestEntry,
  OPFSBackendConfig,
  WALOp,
} from './opfs.types';
import {
  base64ToBytes,
  bytesToBase64,
  clearWAL,
  deleteDataFile,
  keyToFilePath,
  openDataFile,
  readManifest,
  readWAL,
  writeManifest,
  writeWAL,
} from './opfs.utils';

// ─────────────────────────────────────────────────────────────────────────────
// OPFSBackend
// ─────────────────────────────────────────────────────────────────────────────ackend · TS
/**
 * @fileoverview OPFS storage backend implementation.
 *
 * ## Architectural intent
 * {@link OPFSBackend} implements {@link IStorageBackend}<`string`> using the
 * browser's Origin Private File System (OPFS) as the storage medium.
 *
 * Its role in the wider storage subsystem is:
 * - **Preferred persistent backend** when available (priority = 0).
 * - Operated exclusively by the SharedWorker scheduler, which serializes all
 *   ops through a single thread - eliminating concurrent write races without
 *   any additional locking.
 * - Falls back gracefully to the main thread (async IO path) when the
 *   SharedWorker is unavailable.
 *
 * ## Storage layout
 * ```txt
 * navigator.storage (OPFS origin root)
 *   |
 *   +-- <rootDirName>/              default: 'storage'
 *         |
 *         +-- _manifest.json        in-memory index, rewritten on every mutation
 *         |
 *         +-- _wal.json             write-ahead log, cleared after every commit
 *         |
 *         +-- <domain>/
 *               |
 *               +-- <platform>/
 *                     |
 *                     +-- <version>/
 *                           |
 *                           +-- <module>/
 *                                 |
 *                                 +-- <encodedActualKey>   <- raw payload bytes
 * ```
 *
 * ## Data flow: write
 * ```txt
 * Pipeline (outside this class)
 *   |  value -> zod.parse -> user serializer -> encrypt -> envelope{payload: string}
 *   |
 *   ▼
 * OPFSBackend.write(key, envelope)
 *   |
 *   +--[no transactionId]----------------------------------------------+
 *   |                                                                  |
 *   |   keyToFilePath(key) -> filePath                                 |
 *   |   encodeString(envelope.payload) -> Uint8Array                   |
 *   |   bytesToBase64(bytes) -> payloadB64   [for WAL safety]          |
 *   |   build ManifestEntry { filePath, byteLength, meta... }          |
 *   |   _applyWrite(key, filePath, payloadB64, meta)                   |
 *   |     |                                                            |
 *   |     +-- openDataFile(root, filePath, create=true)                |
 *   |     |                                                            |
 *   |     +-- factory.open(handle) -> adapter                          |
 *   |     |                                                            |
 *   |     +-- adapter.writeAll(base64ToBytes(payloadB64))              |
 *   |     |                                                            |
 *   |     +-- adapter.close()                                          |
 *   |     |                                                            |
 *   |     +-- _manifest.set(key, meta)                                 |
 *   |   writeManifest(root, factory, _manifest)                        |
 *   |                                                                  |
 *   +--[transactionId present]-----------------------------------------+
 *       tx.bufferWrite(key, filePath, payloadB64, meta)
 *       -> ops[] grows; no filesystem activity until commit()
 * ```
 *
 * ## Data flow: read
 * ```txt
 * OPFSBackend.read(key)
 *   |
 *   +-- _manifest.get(key)  ->  null  ->  return null
 *   |
 *   +-- TTL check (_isExpired)
 *   |     true  ->  _applyDelete(key, filePath) + writeManifest  ->  return null
 *   |
 *   +-- openDataFile(root, filePath, create=false)
 *   |
 *   +-- factory.open(handle) -> adapter
 *   |
 *   +-- adapter.readAll() -> Uint8Array
 *   |
 *   +-- adapter.close()
 *   |
 *   +-- decodeBytes(bytes) -> payload string
 *   |
 *   +-- _readCount[key]++    <- LFU tracking
 *   |
 *   +-- return StorageEnvelope{ payload, ...meta }
 *         |
 *         ▼
 *       Pipeline (outside this class)
 *         decrypt -> user deserializer -> zod.parse -> typed value
 * ```
 *
 * ## Transaction commit sequence
 * ```txt
 * OPFSTransaction.commit()
 *   |
 *   ▼
 * OPFSBackend._commitTransaction(txId, ops)
 *   |
 *   +-- 1. writeWAL(_wal.json)        <- crash here: nothing applied; WAL replayed next boot
 *   |
 *   +-- 2. _applyWALOps(ops)          <- crash here: WAL replayed; reach final state
 *   |       for each op:
 *   |         'write'  -> _applyWrite (file + manifest)
 *   |         'delete' -> _applyDelete (file + manifest)
 *   |         'clear'  -> _applyClear (files + manifest entries)
 *   +-- 3. writeManifest(_manifest.json)  <- crash here: WAL replay -> same result
 *   |
 *   +-- 4. clearWAL(_wal.json)            <- crash here: next boot replays; idempotent
 *   |
 *   +-- 5. _transactions.delete(txId)
 * ```
 *
 * ## Crash recovery (WAL replay)
 * Occurs inside `initialize()` before the manifest is loaded:
 * ```txt
 * readWAL() -> non-null?
 *   |
 *   +-- readManifest() into _manifest  (may be stale; WAL has the truth)
 *   |
 *   +-- _applyWALOps(wal.ops)          (idempotent - safe to re-apply)
 *   |
 *   +-- writeManifest(_manifest)       (persist corrected state)
 *   |
 *   +-- clearWAL()                     (signal recovery complete)
 *   |
 *   then initialize() reads the now-correct manifest normally
 * ```
 *
 * ## TRaw = string
 * `OPFSBackend` is typed `IStorageBackend<string>`. `envelope.payload` is
 * always an **already-encrypted, already-serialized** string by the time it
 * reaches this backend. The backend stores it as raw UTF-8 bytes in the data
 * file and returns it as-is on read. Decryption and deserialization are the
 * pipeline's concern.
 *
 * ## _readCount and LFU eviction
 * An in-memory `Map<CanonicalKey, number>` tracks how many times each entry
 * has been successfully `read()` in the current session. This counter is used
 * exclusively by `evict()` when `policy === 'lfu'` to break ties between
 * entries of equal weight. It resets to zero on page reload (all sessions
 * start without historical read data) and on overwrite (a rewritten entry is
 * treated as newly stored). Outside of LFU tie-breaking it has no effect on
 * behavior.
 *
 * ## Quirks
 * ### One sync handle per file
 * `FileSystemSyncAccessHandle` holds an **exclusive lock** on the file for
 * its lifetime. Every helper in `opfs.helpers.ts` opens an adapter, performs
 * its operation, and closes the adapter in a `finally` block. Failing to
 * close would cause subsequent opens of the same file to queue indefinitely
 * (up to `lockTimeoutMs`).
 *
 * ### No read-your-own-writes in transactions
 * `read()` ignores `transactionId` - it always reads from committed state.
 * Uncommitted writes buffered in a transaction are invisible to subsequent
 * reads within that same transaction. This is a known gap; the pipeline layer
 * will maintain a per-transaction read buffer to bridge it.
 *
 * ### Serializable transactions not supported
 * OPFS has no native multi-file transaction primitive. `beginTransaction()`
 * throws if `'serializable'` is requested. Use IndexedDB for serializable
 * semantics.
 *
 * ### User eviction comparator receives stub envelopes
 * The user-supplied comparator in `evict()` receives `StorageEnvelope<string>`
 * objects whose `payload` field is an empty string `''`. Reading all payloads
 * just to sort them for eviction would be prohibitively expensive. If your
 * comparator needs payload content, use a different policy or maintain
 * an external index.
 *
 * The write-through/read-through cache pattern belongs at the **pipeline layer**,
 * not inside any backend. The reason: the pipeline already touches every read and
 * write sequentially - it's the only place that can intercept a miss (read from
 * OPFS, populate Memory) and a write (write to OPFS, invalidate/update Memory)
 * without either backend knowing about the other. If Memory were cache-aware
 * inside itself, it would need a reference to the backing backend, which couples
 * two `IStorageBackend` implementations together and breaks the single-responsibility
 * boundary. The pipeline will hold references to both backends and orchestrate
 * the caching policy.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system | MDN: OPFS}
 * @see {@link IStorageBackend} for the full interface contract.
 * @see {@link OPFSTransaction} for the transaction implementation.
 * @see {@link opfs.helpers} for filesystem utility functions.
 */
export class OPFSBackend implements IStorageBackend<string> {
  /** @inheritdoc */
  readonly kind: BackendKind = 'opfs';
  /**
   * @inheritdoc
   * OPFS provides compensating-strength transactions via WAL.
   * Serializable transactions are not supported.
   */
  readonly transactionStrength: TransactionStrength = 'compensating';
  /**
   * Highest priority (0) in the backend fallback chain - preferred over
   * LocalStorage, SessionStorage, and Memory when available.
   */
  readonly priority: number = 0;

  private _rootDir: FileSystemDirectoryHandle | null = null;
  private _manifest: Manifest = new Map();
  private _factory: IIOAdapterFactory;
  private _initialized: boolean = false;
  private _transactions: Map<string, OPFSTransaction> = new Map();
  /**
   * In-session read-access counter. Incremented on every successful `read()`.
   * Used as the tie-breaker during LFU eviction. Resets to zero on reload
   * and on entry overwrite. Has no effect outside of `evict({ policy: 'lfu' })`.
   *
   * It is the access frequency counter for **LFU (Least Frequently Used)** eviction.
   * Every successful `read()` call increments `_readCount[key]`. When `evict()` is
   * called with `policy: 'lfu'`, the tie-breaking comparator sorts by ascending read
   * count - entries read fewest times are evicted first. It resets to zero on overwrite
   * (a rewritten entry is treated as new). It is in-memory only and resets on page
   * reload, which means LFU is a within-session heuristic. Both backends track it for
   * the same reason; Memory just happens to be the only backend where LFU is cheap and
   * reliable since all reads are guaranteed to go through the same process.
   */
  private _readCount: Map<CanonicalKey, number> = new Map();

  private readonly _rootDirName: string;

  constructor(config: OPFSBackendConfig = {}) {
    this._rootDirName = config.rootDirName ?? 'storage';
    const lockTimeoutMs = config.lockTimeoutMs ?? 5_000;

    if (config.context === 'worker') {
      this._factory = new SyncIOAdapterFactory(lockTimeoutMs);
    } else if (config.context === 'main-thread') {
      this._factory = new AsyncIOAdapterFactory();
    } else {
      this._factory = detectIOAdapterFactory(lockTimeoutMs);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Perform a write/read/delete smoke test to confirm OPFS is usable.
   *
   * @remarks
   * Creates a temporary file in the OPFS origin root (not the backend's
   * root directory), writes a known value, reads it back, verifies the
   * round-trip, and deletes the file. Returns `{ available: false }` if any
   * step throws or the read-back value does not match.
   *
   * Called once by the strategy registry at boot time. Does not require
   * `initialize()` to have been called first.
   */
  async probe(): Promise<CapabilityResult> {
    const start = performance.now();
    try {
      if (typeof navigator === 'undefined' || !('storage' in navigator)) {
        return { available: false, reason: 'navigator.storage not available' };
      }

      const root = await navigator.storage.getDirectory();
      const testName = `__opfs_probe_${Date.now()}__`;
      const testHandle = await root.getFileHandle(testName, { create: true });
      const adapter = await this._factory.open(testHandle);
      await adapter.writeAll(encodeString('probe'));
      const readBack = await adapter.readAll();
      await adapter.close();
      await root.removeEntry(testName);

      if (decodeBytes(readBack) !== 'probe') {
        return { available: false, reason: 'OPFS read/write smoke test failed' };
      }

      return { available: true, latency: performance.now() - start };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Open the OPFS root directory, replay any pending WAL, and load the manifest.
   *
   * @remarks
   * Boot sequence:
   * 1. `navigator.storage.getDirectory()` -> OPFS origin root
   * 2. `getDirectoryHandle(rootDirName, { create: true })` -> backend root dir
   * 3. {@link _replayWALIfPresent} - reads WAL, replays ops if non-empty
   * 4. {@link readManifest} -> populate `_manifest`
   * 5. Set `_initialized = true`
   *
   * `signal` is checked between steps. If aborted (e.g., key-fetch timeout
   * in the lifecycle manager), initialization is halted cleanly.
   *
   * @param signal - Optional abort signal for cancellation.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    const root = await navigator.storage.getDirectory();
    this._rootDir = await root.getDirectoryHandle(this._rootDirName, { create: true });

    signal?.throwIfAborted();

    // Replay WAL before loading manifest (crash recovery)
    await this._replayWALIfPresent(signal);

    signal?.throwIfAborted();

    this._manifest = await readManifest(this._rootDir, this._factory);
    this._initialized = true;
  }

  /**
   * Roll back all pending transactions and release in-memory state.
   *
   * @remarks
   * Does not delete any OPFS files - the stored data remains on disk.
   * A subsequent `initialize()` will restore the backend from the manifest.
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
    this._manifest.clear();
    this._readCount.clear();
    this._rootDir = null;
    this._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * Write an envelope to OPFS.
   *
   * @remarks
   * `envelope.payload` must be an already-encrypted, already-serialized
   * string. The backend encodes it to UTF-8 bytes and writes those bytes
   * verbatim to the data file. No encryption or serialization occurs here.
   *
   * If `options.transactionId` is set, the op is buffered inside the named
   * transaction and no filesystem changes occur until `commit()`.
   */
  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    options?: WriteOptions,
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const filePath = keyToFilePath(key);
    const payloadBytes = encodeString(envelope.payload);
    const meta: ManifestEntry = {
      schema_version: envelope.schema_version,
      written_at: envelope.written_at,
      expires_at: envelope.expires_at,
      weight: envelope.weight,
      backend: envelope.backend,
      filePath,
      byteLength: payloadBytes.byteLength,
    };

    if (options?.transactionId) {
      const payloadB64 = bytesToBase64(payloadBytes);
      const tx = this._getTransaction(options.transactionId);
      tx.bufferWrite(key, filePath, payloadB64, meta);
      return;
    }

    await this._applyWriteBytes(key, filePath, payloadBytes, meta);
    await writeManifest(this._rootDir!, this._factory, this._manifest);
  }

  /**
   * Read a raw envelope from OPFS.
   *
   * @remarks
   * Returns `null` if the key is not in the manifest, or if the entry has
   * expired (lazy TTL eviction - the expired entry is deleted as a side
   * effect). Returns `null` if the data file is missing despite being in
   * the manifest (stale manifest entry is cleaned up).
   *
   * The returned `payload` is the raw encrypted string - the pipeline is
   * responsible for decryption, deserialization, and validation.
   *
   * Increments `_readCount[key]` on every successful read for LFU tracking.
   *
   * **Note:** `options.transactionId` is intentionally ignored. Reads always
   * reflect committed state. Read-your-own-writes is a pipeline concern.
   */
  async read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<string> | null> {
    this._assertInitialized();

    const meta = this._manifest.get(key);
    if (!meta) return null;

    const respectTtl = options?.respectTtl ?? true;
    if (respectTtl && this._isExpired(meta)) {
      await this._applyDelete(key, meta.filePath);
      await writeManifest(this._rootDir!, this._factory, this._manifest);
      return null;
    }

    let payload: string;
    try {
      const fileHandle = await openDataFile(this._rootDir!, meta.filePath);
      const adapter = await this._factory.open(fileHandle);
      const bytes = await adapter.readAll();
      await adapter.close();
      payload = decodeBytes(bytes);
    } catch {
      this._manifest.delete(key);
      await writeManifest(this._rootDir!, this._factory, this._manifest);
      return null;
    }

    this._readCount.set(key, (this._readCount.get(key) ?? 0) + 1);

    return {
      payload,
      schema_version: meta.schema_version,
      written_at: meta.written_at,
      expires_at: meta.expires_at,
      weight: meta.weight,
      backend: meta.backend,
    };
  }

  /**
   * Delete a single entry from OPFS.
   *
   * @remarks
   * Idempotent - resolves without error if the key is not in the manifest.
   * If `options.transactionId` is set, the op is buffered.
   */
  async delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const meta = this._manifest.get(key);
    if (!meta) return;

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferDelete(key, meta.filePath);
      return;
    }

    await this._applyDelete(key, meta.filePath);
    await writeManifest(this._rootDir!, this._factory, this._manifest);
  }

  /**
   * Delete all entries whose canonical key starts with `prefix`.
   *
   * @remarks
   * If `prefix` is omitted, all entries are deleted (full clear).
   * The manifest is rewritten once after all deletes, not per-delete.
   * `signal` is checked between each delete.
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

    const toDelete: Array<{ key: CanonicalKey; filePath: string }> = [];

    for (const [key, meta] of this._manifest) {
      options?.signal?.throwIfAborted();
      if (!prefix || key.startsWith(prefix)) {
        toDelete.push({ key, filePath: meta.filePath });
      }
    }

    for (const { key, filePath } of toDelete) {
      options?.signal?.throwIfAborted();
      await this._applyDelete(key, filePath);
    }

    if (toDelete.length > 0) {
      await writeManifest(this._rootDir!, this._factory, this._manifest);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Return all raw envelopes matching the query criteria.
   *
   * @remarks
   * Prefix filtering and schema-version filtering use the in-memory manifest
   * (O(n) scan, no file I/O). Payload reads are performed only for matching,
   * non-expired entries. Expired or unreadable entries are lazily deleted
   * and the manifest is rewritten once at the end of the scan if any were
   * found.
   *
   * Results are sliced by `q.offset` and `q.limit` after all matching
   * entries are collected. For large stores with many matches, prefer
   * paginated queries.
   */
  async query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
    this._assertInitialized();

    const excludeExpired = q.excludeExpired ?? true;
    const results: Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }> = [];
    const toDelete: Array<{ key: CanonicalKey; filePath: string }> = [];

    for (const [key, meta] of this._manifest) {
      options?.signal?.throwIfAborted();
      if (q.prefix && !key.startsWith(q.prefix)) continue;
      if (q.schema_version !== undefined && meta.schema_version !== q.schema_version) continue;
      if (excludeExpired && this._isExpired(meta)) {
        toDelete.push({ key, filePath: meta.filePath });
        continue;
      }

      try {
        const fileHandle = await openDataFile(this._rootDir!, meta.filePath);
        const adapter = await this._factory.open(fileHandle);
        const bytes = await adapter.readAll();
        await adapter.close();
        results.push({
          key,
          envelope: {
            payload: decodeBytes(bytes),
            schema_version: meta.schema_version,
            written_at: meta.written_at,
            expires_at: meta.expires_at,
            weight: meta.weight,
            backend: meta.backend,
          },
        });
      } catch {
        toDelete.push({ key, filePath: meta.filePath });
      }
    }

    if (toDelete.length > 0) {
      for (const { key, filePath } of toDelete) await this._applyDelete(key, filePath);
      await writeManifest(this._rootDir!, this._factory, this._manifest);
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * Return the count of entries matching the optional key prefix.
   * Uses the in-memory manifest - no file I/O.
   */
  async count(prefix?: string): Promise<number> {
    this._assertInitialized();
    if (!prefix) return this._manifest.size;
    let n = 0;
    for (const key of this._manifest.keys()) {
      if (key.startsWith(prefix)) n++;
    }
    return n;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * Open a new compensating transaction.
   *
   * @remarks
   * Ops performed with `{ transactionId: tx.id }` are buffered until
   * `tx.commit()` or discarded on `tx.rollback()`. See the class-level
   * docblock for the full commit sequence and crash-recovery guarantees.
   *
   * @param strength - Must be `'compensating'` or `'best-effort'` (or omitted).
   *   Passing `'serializable'` throws immediately.
   * @throws {Error} If `strength === 'serializable'`.
   */
  async beginTransaction(strength?: TransactionStrength): Promise<OPFSTransaction> {
    this._assertInitialized();

    if (strength === 'serializable') {
      throw new Error(
        '[OPFSBackend] "serializable" transactions are not supported. ' +
          'OPFS provides "compensating" strength. Use IndexedDB for serializable transactions.',
      );
    }

    const tx: OPFSTransaction = new OPFSTransaction(
      (txId: string, ops: WALOp[]) => this._commitTransaction(txId, ops),
      (id: string) => this._transactions.delete(id),
    );
    this._transactions.set(tx.id, tx);
    return tx;
  }

  isTransactionActive(txId?: string) {
    try {
      const tx = txId ? this._getTransaction(txId) : this._transactions.values().next()?.value;
      return tx !== undefined && tx !== null;
    } catch {
      return false;
    }
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  /**
   * Estimate storage usage for the OPFS origin.
   *
   * @remarks
   * Prefers `navigator.storage.estimate()` which gives the true quota and
   * usage for the entire origin (shared with IndexedDB and other OPFS stores).
   * Falls back to summing `byteLength` from the in-memory manifest if the
   * Quota API is unavailable, using a 500 MB soft cap.
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();
    let manifestUsed = 0;
    for (const meta of this._manifest.values()) manifestUsed += meta.byteLength;

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
      const softCap = 500 * 1024 * 1024;
      return {
        used: manifestUsed,
        available: Math.max(0, softCap - manifestUsed),
        ratio: Math.min(1, manifestUsed / softCap),
      };
    }
  }

  /**
   * Evict entries to reclaim storage space.
   *
   * @remarks
   * ### Phase 1 - Free TTL sweep
   * All expired entries are deleted first. If this alone satisfies
   * `targetBytes`, no further eviction occurs.
   *
   * ### Phase 2 - Weighted eviction
   * Remaining entries are sorted ascending by `weight` (lower weight =
   * evicted first). Ties are broken by `policy`:
   * - `lru` / `fifo` - oldest `written_at` first.
   * - `lfu` - lowest `_readCount` first (in-session only; resets on reload).
   * - `user` - `comparator` function (receives stub envelopes with `payload: ''`).
   *
   * Returns the total number of bytes freed (approximated from manifest
   * `byteLength` values).
   *
   * @param targetBytes - Stop evicting once this many bytes have been freed.
   * @param policy      - Tie-breaking eviction policy.
   * @param comparator  - Custom comparator, used only when `policy === 'user'`.
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

    let freed = 0;
    const stale: Array<{ key: CanonicalKey; filePath: string; bytes: number }> = [];
    for (const [key, meta] of this._manifest) {
      if (this._isExpired(meta))
        stale.push({ key, filePath: meta.filePath, bytes: meta.byteLength });
    }
    for (const { key, filePath, bytes } of stale) {
      await this._applyDelete(key, filePath);
      freed += bytes;
    }
    if (stale.length > 0) {
      await writeManifest(this._rootDir!, this._factory, this._manifest);
      if (freed >= targetBytes) return freed;
    }

    const candidates = [...this._manifest.entries()].map(([key, meta]) => ({ key, meta }));
    candidates.sort((a, b) => {
      const weightDiff = a.meta.weight - b.meta.weight;
      if (weightDiff !== 0) return weightDiff;
      if (policy === 'user' && comparator) {
        const stub = (
          key: CanonicalKey,
          meta: ManifestEntry,
        ): { key: CanonicalKey; envelope: StorageEnvelope<string> } => ({
          key,
          envelope: {
            payload: '',
            schema_version: meta.schema_version,
            written_at: meta.written_at,
            expires_at: meta.expires_at,
            weight: meta.weight,
            backend: meta.backend,
          },
        });
        return comparator(stub(a.key, a.meta), stub(b.key, b.meta));
      }
      return this._defaultTieBreak(a.key, a.meta, b.key, b.meta, policy);
    });

    for (const { key, meta } of candidates) {
      if (freed >= targetBytes) break;
      freed += meta.byteLength;
      await this._applyDelete(key, meta.filePath);
    }
    await writeManifest(this._rootDir!, this._factory, this._manifest);
    return freed;
  }

  // ── Private: atomic op primitives ─────────────────────────────────────────

  /**
   * Write payload bytes to the data file and update the in-memory manifest.
   * Does NOT flush the manifest to disk - caller is responsible.
   */
  private async _applyWrite(
    key: CanonicalKey,
    filePath: string,
    payloadB64: string,
    meta: ManifestEntry,
  ): Promise<void> {
    await this._applyWriteBytes(key, filePath, base64ToBytes(payloadB64), meta);
  }

  private async _applyWriteBytes(
    key: CanonicalKey,
    filePath: string,
    payloadBytes: Uint8Array,
    meta: ManifestEntry,
  ) {
    const fileHandle = await openDataFile(this._rootDir!, filePath, true);
    const adapter = await this._factory.open(fileHandle);
    await adapter.writeAll(payloadBytes);
    await adapter.close();
    // Update manifest after IO succeeds - an IO failure leaves manifest consistent
    this._manifest.set(key, { ...meta, byteLength: payloadBytes.byteLength });
    this._readCount.delete(key); // Reset LFU counter on overwrite
  }

  /**
   * Delete the data file and remove the key from the in-memory manifest.
   * Does NOT flush the manifest to disk - caller is responsible.
   */
  private async _applyDelete(key: CanonicalKey, filePath: string): Promise<void> {
    await deleteDataFile(this._rootDir!, filePath);
    this._manifest.delete(key);
    this._readCount.delete(key);
  }

  /**
   * Delete all entries matching an optional prefix.
   * Does NOT flush the manifest to disk - caller is responsible.
   */
  private async _applyClear(prefix?: string): Promise<void> {
    const toDelete: Array<{ key: CanonicalKey; filePath: string }> = [];
    for (const [key, meta] of this._manifest) {
      if (!prefix || key.startsWith(prefix)) toDelete.push({ key, filePath: meta.filePath });
    }
    for (const { key, filePath } of toDelete) await this._applyDelete(key, filePath);
  }

  // ── Private: transaction commit ───────────────────────────────────────────

  /**
   * Execute the WAL-backed commit sequence for a transaction.
   *
   * Steps (see class-level docblock for crash-recovery analysis):
   * 1. Write WAL to disk.
   * 2. Apply ops to OPFS files and in-memory manifest.
   * 3. Rewrite manifest to disk.
   * 4. Clear WAL.
   * 5. Remove transaction from registry.
   *
   * If any step throws, the WAL is preserved for recovery. The error is
   * re-thrown so the caller's `try/catch` can respond appropriately.
   */
  private async _commitTransaction(txId: string, ops: WALOp[]): Promise<void> {
    if (ops.length === 0) {
      this._transactions.delete(txId);
      return;
    }

    await writeWAL(this._rootDir!, this._factory, { transactionId: txId, ops });

    try {
      await this._applyWALOps(ops);
      await writeManifest(this._rootDir!, this._factory, this._manifest);
      await clearWAL(this._rootDir!, this._factory);
    } catch (err) {
      throw new Error(
        `[OPFSBackend] Transaction ${txId} failed mid-commit. ` +
          `WAL preserved for crash recovery. Cause: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      this._transactions.delete(txId);
    }
  }

  /**
   * Apply a list of WAL ops sequentially.
   * Used by both `_commitTransaction` (live) and `_replayWALIfPresent`
   * (crash recovery). All ops are idempotent.
   */
  private async _applyWALOps(ops: WALOp[]): Promise<void> {
    for (const op of ops) {
      switch (op.kind) {
        case 'write':
          await this._applyWrite(op.key, op.filePath, op.payloadB64, op.meta);
          break;
        case 'delete':
          await this._applyDelete(op.key, op.filePath);
          break;
        case 'clear':
          await this._applyClear(op.prefix);
          break;
      }
    }
  }

  /**
   * On `initialize()`, check for a non-empty WAL from a previous crashed
   * session and replay it to restore consistency.
   *
   * @remarks
   * WAL replay runs **before** the manifest is loaded so that if the crash
   * occurred after ops were applied but before the manifest was rewritten,
   * we can re-derive the correct manifest by replaying into a freshly-read
   * (possibly stale) copy.
   *
   * After replay, `_manifest` is cleared so `initialize()` will read the
   * now-correct version from disk.
   */
  private async _replayWALIfPresent(signal?: AbortSignal): Promise<void> {
    const wal = await readWAL(this._rootDir!, this._factory);
    if (!wal || (wal.ops?.length ?? 0) === 0) return;

    signal?.throwIfAborted();
    console.warn(
      `[OPFSBackend] Non-empty WAL found (txId: ${wal.transactionId}). ` +
        `Replaying ${wal.ops.length} op(s) for crash recovery.`,
    );

    this._manifest = await readManifest(this._rootDir!, this._factory);
    await this._applyWALOps(wal.ops);
    await writeManifest(this._rootDir!, this._factory, this._manifest);
    await clearWAL(this._rootDir!, this._factory);
    this._manifest.clear(); // Re-read by initialize() after this returns
  }

  // ── Private: guards and helpers ───────────────────────────────────────────

  private _assertInitialized(): void {
    if (!this._initialized || !this._rootDir) {
      throw new Error('[OPFSBackend] Backend not initialized. Call initialize() first.');
    }
  }

  private _isExpired(meta: ManifestEntry): boolean {
    return meta.expires_at !== null && meta.expires_at < Date.now();
  }

  private _getTransaction(id: string): OPFSTransaction {
    const tx = this._transactions.get(id);
    if (!tx) throw new Error(`[OPFSBackend] No active transaction with id "${id}".`);
    return tx;
  }

  private _defaultTieBreak(
    aKey: CanonicalKey,
    aMeta: ManifestEntry,
    bKey: CanonicalKey,
    bMeta: ManifestEntry,
    policy: EvictionPolicy,
  ): number {
    switch (policy) {
      case 'lru':
      case 'fifo':
        return aMeta.written_at - bMeta.written_at;
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
