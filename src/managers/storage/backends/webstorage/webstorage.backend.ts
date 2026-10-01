/**
 * @fileoverview Shared WebStorage backend implementation.
 *
 * ## Overview
 * `WebStorageBackend` is the abstract base class shared by `LocalStorageBackend`
 * and `SessionStorageBackend`. It implements the full `IStorageBackend<string>`
 * contract against any `Storage` object injected at construction time. The two
 * concrete subclasses differ only in which `Storage` handle they inject and
 * what `BackendKind` label they carry.
 *
 * ## Why a shared abstraction
 * `localStorage` and `sessionStorage` expose an identical synchronous API
 * (`setItem`, `getItem`, `removeItem`, `key`, `length`). Every behaviour this
 * backend needs — CRUD, prefix-filtered queries, compensating transactions,
 * quota estimation, eviction — is expressible against the `Storage` interface
 * without knowing which concrete object lies beneath it. Separating the two
 * into independent implementations would duplicate several hundred lines of
 * non-trivial logic (snapshot rollback, `QuotaExceededError` recovery, etc.)
 * for zero behavioural benefit.
 *
 * ## Key-space layout
 * Every canonical key is stored under a prefixed storage key:
 *
 * ```
 * storage key = `${keyPrefix}${canonicalKey}`
 * e.g.  '__storage__myapp:chrome:130:auth:user-session'
 * ```
 *
 * The prefix ensures this backend's entries do not collide with other code that
 * writes directly to `localStorage` on the same origin. All operations that
 * scan the `Storage` object (`query`, `count`, `clear`, `evict`) iterate only
 * keys that start with the prefix, making co-existence with other consumers safe.
 *
 * ## Data format
 * Values are stored as `JSON.stringify(StorageEnvelope<string>)`. The envelope
 * `payload` field is an already-encrypted, already-serialized string supplied
 * by the pipeline layer — this backend never sees or needs to understand the
 * payload's content.
 *
 * ```
 * pipeline: validate -> serialize -> encrypt -> StorageEnvelope<string>
 *                                                      │
 *                                              JSON.stringify
 *                                                      │
 *                                             storage.setItem(key, json)
 * ```
 *
 * ## QuotaExceededError recovery
 * `localStorage` is typically capped at 5–10 MB per origin. `setItem` throws
 * `QuotaExceededError` when the limit is reached. The backend optionally
 * handles this with a single recovery pass:
 *
 * ```
 * setItem throws QuotaExceededError
 *   │
 *   ├─ if policy === 'none'  →  rethrow immediately
 *   │
 *   └─ if policy === 'ttl-then-lru':
 *        1. Sweep all expired own entries (removeItem each)
 *        2. Retry setItem
 *        3. Still fails? Sort non-expired entries by weight asc, written_at asc (LRU)
 *        4. Remove entries until estimated bytes freed >= payload size
 *        5. Retry setItem once more
 *        6. Still fails? Rethrow
 * ```
 *
 * Recovery is only attempted for `QuotaExceededError`. All other errors from
 * `setItem` propagate immediately. The recovery pass targets only this backend's
 * own keys (those starting with the prefix), so it never disturbs other consumers
 * of `localStorage`.
 *
 * ## Transaction model: compensating
 * ```
 * beginTransaction()
 *   -> WebStorageTransaction created (ops = [], snapshot = Map{})
 *
 * backend.write(key, env, { transactionId })
 *   -> tx.snapshotKey(storageKey, storage.getItem(storageKey))  // lazy, first-write-wins
 *   -> tx.bufferWrite(key, JSON.stringify(env))                 // no storage mutation
 *
 * tx.commit()
 *   -> _applyCommit(txId, ops)
 *   -> for each op: setItem / removeItem / prefix scan + removeItem
 *   -> _transactions.delete(txId)
 *
 * tx.rollback()
 *   -> for each (storageKey, priorValue) in snapshot:
 *        priorValue !== null -> setItem(storageKey, priorValue)
 *        priorValue === null -> removeItem(storageKey)
 *   -> ops.length = 0, _transactions.delete(txId)
 * ```
 *
 * There is no WAL. If the process dies mid-commit, some ops will have been
 * applied and others will not. On next `initialize()`, the storage is read as-is
 * with no recovery pass. This is the standard limitation of Web Storage and is
 * why `transactionStrength` is `'compensating'` rather than `'serializable'`.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API | MDN: Web Storage API}
 * @see {@link IStorageBackend} for the full interface contract.
 * @see {@link WebStorageTransaction} for the transaction implementation.
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
import { WebStorageTransaction } from './webstorage.transaction';
import type {
  IWebStorageTransaction,
  WebStorageBufferedOp,
  WebStorageConfig,
  WebStorageKind,
} from './webstorage.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default key prefix applied to every storage key written by this backend. */
const DEFAULT_PREFIX = '__storage__';

/**
 * Approximate byte overhead per entry beyond the payload itself.
 * Accounts for the envelope JSON structure (metadata fields).
 * Used as a minimum floor when estimating bytes to free during recovery.
 */
const ENTRY_OVERHEAD_BYTES = 256;

// ─────────────────────────────────────────────────────────────────────────────
// WebStorageBackend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Abstract shared backend for `localStorage` and `sessionStorage`.
 *
 * @description
 * `WebStorageBackend` implements `IStorageBackend<string>` against any `Storage`
 * object. Concrete subclasses (`LocalStorageBackend`, `SessionStorageBackend`)
 * inject the appropriate `Storage` handle and `BackendKind` label via `super()`.
 * No other code differs between the two concrete backends.
 *
 * **When to use**: positioned as the tertiary or quaternary persistent backend
 * in the fallback chain, after IndexedDB, OPFS, and CacheStorage. All three
 * offer larger quotas and richer APIs, but `localStorage` / `sessionStorage`
 * are universally available (subject to private-browsing restrictions on some
 * browsers for `localStorage`) and require no async initialization beyond the
 * smoke-test `probe()`.
 *
 * **Limitations**:
 * - Shared 5–10 MB quota with all other `localStorage` consumers on the origin.
 * - Synchronous API can block the main thread for large reads; always run inside
 *   the SharedWorker scheduler to avoid UI jank.
 * - `sessionStorage` is tab-isolated and ephemeral (cleared on tab close).
 * - `localStorage` is unavailable in Firefox private mode.
 * - Transaction strength is `'compensating'` (no WAL, no crash recovery).
 *
 * @example Concrete usage via subclass (do not instantiate directly)
 * ```ts
 * import { LocalStorageBackend }   from './localstorage.backend'
 * import { SessionStorageBackend } from './sessionstorage.backend'
 *
 * const ls = new LocalStorageBackend({ keyPrefix: 'myapp', quotaRecoveryPolicy: 'ttl-then-lru' })
 * const ss = new SessionStorageBackend()
 * ```
 *
 * @see {@link LocalStorageBackend}
 * @see {@link SessionStorageBackend}
 * @see {@link WebStorageTransaction}
 */
export abstract class WebStorageBackend implements IStorageBackend<string> {
  // ── IStorageBackend identity ──────────────────────────────────────────────

  /** @inheritdoc set by the concrete subclass via constructor. */
  readonly kind: BackendKind;

  /**
   * @inheritdoc
   * Snapshot-based compensating transactions: ops buffered, Storage restored
   * on rollback. No WAL, no crash recovery.
   */
  readonly transactionStrength: TransactionStrength = 'compensating';

  /** Priority set by the concrete subclass. */
  abstract readonly priority: number;

  // ── Config ────────────────────────────────────────────────────────────────

  protected readonly _storage: Storage;
  protected readonly _prefix: string;
  protected readonly _recovery: 'ttl-then-lru' | 'none';

  // ── Runtime state ─────────────────────────────────────────────────────────

  private _initialized: boolean = false;
  private _transactions: Map<string, WebStorageTransaction> = new Map();

  /**
   * In-session read-access counter. Incremented on every successful `read()`.
   * Used as tie-breaker during LFU eviction. Resets on page reload and on
   * entry overwrite.
   */
  private _readCount: Map<CanonicalKey, number> = new Map();

  /**
   * @param storage    - The underlying `Storage` object to delegate to.
   * @param storageKind - `'localstorage'` or `'sessionstorage'`, used as the
   *   `BackendKind` label on every written envelope.
   * @param config     - Optional configuration overrides.
   */
  protected constructor(
    storage: Storage,
    storageKind: WebStorageKind,
    config: WebStorageConfig = {},
  ) {
    this._storage = storage;
    this._prefix = config.keyPrefix ?? DEFAULT_PREFIX;
    this._recovery = config.quotaRecoveryPolicy ?? 'ttl-then-lru';
    this.kind = storageKind;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @summary Perform a write/read/delete smoke test to confirm the underlying
   * `Storage` object is accessible.
   *
   * @description
   * Writes a synthetic entry under a temporary key, reads it back, verifies
   * the round-trip, and removes the entry. All three steps run synchronously
   * within a single `try` block so the probe always cleans up after itself.
   *
   * Known failure scenarios caught by this probe:
   * - `localStorage` in Firefox private mode throws `SecurityError`.
   * - `Storage` full (`QuotaExceededError`) causes `setItem` to throw even for
   *   the probe key. The probe surfaces this as `available: false` with an
   *   informative reason string.
   * - Sandbox `iframe` without `allow-same-origin` throws `SecurityError`.
   *
   * @returns `{ available: true, latency }` or `{ available: false, reason }`.
   */
  async probe(): Promise<CapabilityResult> {
    const start = performance.now();
    const probeKey = `${this._prefix}__probe__`;

    try {
      this._storage.setItem(probeKey, 'probe');
      const readBack = this._storage.getItem(probeKey);
      this._storage.removeItem(probeKey);

      if (readBack !== 'probe') {
        return { available: false, reason: `${this.kind} probe: read-back value mismatch` };
      }
      return { available: true, latency: performance.now() - start };
    } catch (err) {
      // Ensure the probe key is removed even if removeItem itself throws.
      try {
        this._storage.removeItem(probeKey);
      } catch {
        /* best-effort */
      }
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @summary Mark the backend as initialized.
   *
   * @description
   * Web Storage requires no async initialization (no connection to open, no
   * manifest to load). `initialize()` is a no-op beyond setting the
   * `_initialized` flag. The `signal` is checked once before the flag is set
   * to respect lifecycle abort signals from the SharedWorker.
   *
   * @param signal - Optional abort signal.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this._initialized = true;
  }

  /**
   * @summary Roll back pending transactions, clear in-memory state, and
   * mark the backend as uninitialized.
   *
   * @description
   * Does not remove any entries from the `Storage` object — stored data
   * persists across `close()` / `initialize()` cycles. Pending transactions
   * are rolled back (their snapshots are used to restore any Storage changes
   * that may have already been applied via partial commits).
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
    this._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * @summary Write a `StorageEnvelope<string>` under `key`.
   *
   * @description
   * Serializes the envelope to JSON and calls `storage.setItem(prefixedKey, json)`.
   * If the call throws `QuotaExceededError` and the configured recovery policy
   * is `'ttl-then-lru'`, a recovery pass is attempted before retrying once.
   *
   * If `options.transactionId` is set, the write is buffered inside the named
   * transaction: the pre-write storage value is snapshotted (for rollback) and
   * the op is staged without touching `Storage`.
   *
   * @param key      - The canonical key to write under.
   * @param envelope - The already-encrypted, already-serialized envelope.
   * @param options  - Optional write options (transactionId, signal).
   *
   * @throws {Error} If not initialized.
   * @throws {DOMException} If `QuotaExceededError` persists after recovery.
   */
  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    options?: WriteOptions,
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const storageKey = this._toStorageKey(key);
    const json = JSON.stringify(envelope);

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.snapshotKey(storageKey, this._storage.getItem(storageKey));
      tx.bufferWrite(key, json);
      return;
    }

    this._setItem(storageKey, json);
    this._readCount.delete(key); // Reset LFU counter on overwrite
  }

  /**
   * @summary Read the raw `StorageEnvelope<string>` stored under `key`.
   *
   * @description
   * Looks up the prefixed storage key via `storage.getItem`. Returns `null`
   * if the key is absent or the stored JSON is unparseable (silently removes
   * corrupt entries — idempotent cleanup).
   *
   * If TTL checking is enabled (default) and the entry is expired, it is lazily
   * deleted from `Storage` before returning `null`.
   *
   * Increments `_readCount[key]` on every successful read for LFU tracking.
   *
   * @param key     - The canonical key to read.
   * @param options - Optional read options.
   * @returns The raw envelope, or `null` if absent, expired, or corrupt.
   *
   * @throws {Error} If not initialized.
   */
  async read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<string> | null> {
    this._assertInitialized();

    const storageKey = this._toStorageKey(key);
    const raw = this._storage.getItem(storageKey);
    if (raw === null) return null;

    let envelope: StorageEnvelope<string>;
    try {
      envelope = JSON.parse(raw) as StorageEnvelope<string>;
    } catch {
      // Corrupt entry — remove silently and return null.
      this._storage.removeItem(storageKey);
      return null;
    }

    const respectTtl = options?.respectTtl ?? true;
    if (respectTtl && this._isExpired(envelope)) {
      this._storage.removeItem(storageKey);
      this._readCount.delete(key);
      return null;
    }

    this._readCount.set(key, (this._readCount.get(key) ?? 0) + 1);
    return envelope;
  }

  /**
   * @summary Delete the entry at `key`.
   *
   * @description
   * Idempotent — resolves without error if the key is absent. If a
   * `transactionId` is provided, the pre-delete value is snapshotted and the
   * op is buffered.
   *
   * @param key     - The canonical key to delete.
   * @param options - Optional `{ transactionId?, signal? }`.
   *
   * @throws {Error} If not initialized.
   */
  async delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    const storageKey = this._toStorageKey(key);

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.snapshotKey(storageKey, this._storage.getItem(storageKey));
      tx.bufferDelete(key);
      return;
    }

    this._storage.removeItem(storageKey);
    this._readCount.delete(key);
  }

  /**
   * @summary Delete all entries whose canonical key starts with `prefix`.
   *
   * @description
   * If `prefix` is omitted, all entries under this backend's key namespace
   * (those sharing `_prefix`) are deleted. Iterates `Storage.key(i)` to find
   * matching entries — see `_ownKeys()` for the scan logic.
   *
   * `signal` is checked between each removal. If `options.transactionId` is
   * provided, the current value of every matching key is snapshotted before the
   * op is buffered.
   *
   * @param prefix  - Optional canonical key prefix. Omit to clear all own entries.
   * @param options - Optional `{ signal?, transactionId? }`.
   *
   * @throws {Error} If not initialized.
   */
  async clear(
    prefix?: string,
    options?: { signal?: AbortSignal; transactionId?: string },
  ): Promise<void> {
    this._assertInitialized();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      // Snapshot every key that will be affected before buffering the clear op.
      for (const { storageKey } of this._ownKeys(prefix)) {
        options?.signal?.throwIfAborted();
        tx.snapshotKey(storageKey, this._storage.getItem(storageKey));
      }
      tx.bufferClear(prefix);
      return;
    }

    for (const { canonicalKey, storageKey } of this._ownKeys(prefix)) {
      options?.signal?.throwIfAborted();
      this._storage.removeItem(storageKey);
      this._readCount.delete(canonicalKey);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * @summary Return all raw envelopes matching the query criteria.
   *
   * @description
   * Iterates all own storage keys (those starting with `_prefix`), parses each
   * JSON envelope, and applies the query filters. Expired or corrupt entries are
   * lazily removed during the scan. The signal is checked between each key.
   *
   * Filters are applied in order:
   * 1. Canonical key prefix (`q.prefix`).
   * 2. Schema version (`q.schema_version`).
   * 3. TTL expiry (`q.excludeExpired`, default `true`).
   *
   * Results are collected in storage-iteration order (not insertion order),
   * then sliced by `q.offset` / `q.limit`.
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
    const results: Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }> = [];

    for (const { canonicalKey, storageKey } of this._ownKeys(q.prefix)) {
      options?.signal?.throwIfAborted();

      const raw = this._storage.getItem(storageKey);
      if (raw === null) continue;

      let envelope: StorageEnvelope<string>;
      try {
        envelope = JSON.parse(raw) as StorageEnvelope<string>;
      } catch {
        this._storage.removeItem(storageKey);
        this._readCount.delete(canonicalKey);
        continue;
      }

      if (excludeExpired && this._isExpired(envelope)) {
        this._storage.removeItem(storageKey);
        this._readCount.delete(canonicalKey);
        continue;
      }

      if (q.schema_version !== undefined && envelope.schema_version !== q.schema_version) continue;

      results.push({ key: canonicalKey, envelope });
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * @summary Return the count of own entries matching the optional prefix.
   *
   * @description
   * Iterates own storage keys without parsing values. Faster than `query`
   * when only the count is needed.
   *
   * @param prefix - Optional canonical key prefix.
   * @returns Integer count of matching entries.
   *
   * @throws {Error} If not initialized.
   */
  async count(prefix?: string): Promise<number> {
    this._assertInitialized();
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _ of this._ownKeys(prefix)) n++;
    return n;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * @summary Open a new compensating transaction.
   *
   * @description
   * Returns a `WebStorageTransaction` whose ops are applied sequentially to
   * the `Storage` object on `commit()` and whose snapshot is used to restore
   * the prior state on `rollback()`.
   *
   * `'serializable'` strength is rejected immediately — Web Storage cannot
   * provide ACID isolation. Use IndexedDB for serializable transactions.
   * `'best-effort'` is accepted; the returned transaction will still use the
   * snapshot-restore mechanism (the strength label describes the guarantee,
   * not the mechanism).
   *
   * @param strength - `'compensating'` or `'best-effort'` (or omitted). Rejects
   *   `'serializable'`.
   * @returns A `WebStorageTransaction` typed as `ITransaction`.
   *
   * @throws {Error} If `strength === 'serializable'`.
   * @throws {Error} If not initialized.
   */
  async beginTransaction(strength?: TransactionStrength): Promise<WebStorageTransaction> {
    this._assertInitialized();

    if (strength === 'serializable') {
      throw new Error(
        `[${this.kind}] "serializable" transactions are not supported. ` +
          `Web Storage provides "compensating" strength. Use IndexedDB for serializable transactions.`,
      );
    }

    const tx = new WebStorageTransaction(
      this._storage,
      (txId: string, ops: WebStorageBufferedOp[]) => this._applyCommit(txId, ops),
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
   * @summary Estimate storage usage for this backend's own key namespace.
   *
   * @description
   * Iterates all own storage keys and sums the byte lengths of their keys and
   * values (treating each character as 2 bytes — UTF-16 representation used by
   * the `Storage` API internally).
   *
   * The "available" figure is the difference between a 5 MB soft cap (a
   * conservative estimate of the typical `localStorage` quota) and the current
   * measured usage. Actual browser quotas vary (5–10 MB) and are not
   * programmatically queryable; `navigator.storage.estimate()` does not include
   * `localStorage` usage in its figures.
   *
   * @returns `{ used, available, ratio }` where `used` is in bytes.
   *
   * @throws {Error} If not initialized.
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();

    let used = 0;
    for (const { storageKey } of this._ownKeys()) {
      const raw = this._storage.getItem(storageKey);
      if (raw !== null) {
        // 2 bytes per character (UTF-16) for both key and value
        used += (storageKey.length + raw.length) * 2;
      }
    }

    // Conservative 5 MB cap. Browsers typically allow 5–10 MB total for
    // localStorage; we cannot query the true limit programmatically.
    const softCap = 5 * 1024 * 1024;
    return {
      used,
      available: Math.max(0, softCap - used),
      ratio: Math.min(1, used / softCap),
    };
  }

  /**
   * @summary Evict entries to reclaim storage space.
   *
   * @description
   * ### Phase 1 — Free TTL sweep
   * All expired entries are removed first. If the bytes freed in this phase
   * satisfy `targetBytes`, eviction stops here.
   *
   * ### Phase 2 — Weighted eviction
   * Remaining entries are sorted ascending by `weight`. Ties are broken by
   * `policy`:
   * - `'lru'` / `'fifo'` — oldest `written_at` first.
   * - `'lfu'` — lowest `_readCount` first (in-session only).
   * - `'user'` — custom `comparator` function. Receives envelopes with
   *   the full payload string (unlike OPFS/Cache, WebStorage has no separate
   *   payload file — the full JSON is already parsed for iteration).
   *
   * Byte estimation uses the same UTF-16 character-count heuristic as
   * `estimateQuota()`.
   *
   * Returns the approximate number of bytes freed.
   *
   * @param targetBytes - Stop evicting once this many bytes have been freed.
   * @param policy      - Tie-breaking eviction policy.
   * @param comparator  - Custom comparator; only used when `policy === 'user'`.
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

    // ── Phase 1: sweep expired entries ──────────────────────────────────────
    let freed = 0;
    const stale: Array<{ canonicalKey: CanonicalKey; storageKey: string; bytes: number }> = [];

    for (const { canonicalKey, storageKey } of this._ownKeys()) {
      const raw = this._storage.getItem(storageKey);
      if (raw === null) continue;
      try {
        const envelope = JSON.parse(raw) as StorageEnvelope<string>;
        if (this._isExpired(envelope)) {
          stale.push({
            canonicalKey,
            storageKey,
            bytes: (storageKey.length + raw.length) * 2,
          });
        }
      } catch {
        // Corrupt entry: count it as freed without measuring.
        stale.push({ canonicalKey, storageKey, bytes: ENTRY_OVERHEAD_BYTES });
      }
    }

    for (const { canonicalKey, storageKey, bytes } of stale) {
      this._storage.removeItem(storageKey);
      this._readCount.delete(canonicalKey);
      freed += bytes;
    }

    if (freed >= targetBytes) return freed;

    // ── Phase 2: weighted eviction ────────────────────────────────────────
    const candidates: Array<{
      canonicalKey: CanonicalKey;
      storageKey: string;
      envelope: StorageEnvelope<string>;
      bytes: number;
    }> = [];

    for (const { canonicalKey, storageKey } of this._ownKeys()) {
      const raw = this._storage.getItem(storageKey);
      if (raw === null) continue;
      try {
        const envelope = JSON.parse(raw) as StorageEnvelope<string>;
        candidates.push({
          canonicalKey,
          storageKey,
          envelope,
          bytes: (storageKey.length + raw.length) * 2,
        });
      } catch {
        // Corrupt — treat as zero-weight candidate
        candidates.push({
          canonicalKey,
          storageKey,
          envelope: {
            payload: '',
            schema_version: 0,
            written_at: 0,
            expires_at: null,
            weight: 0,
            backend: this.kind,
          },
          bytes: ENTRY_OVERHEAD_BYTES,
        });
      }
    }

    candidates.sort((a, b) => {
      const weightDiff = a.envelope.weight - b.envelope.weight;
      if (weightDiff !== 0) return weightDiff;
      if (policy === 'user' && comparator) {
        return comparator(
          { key: a.canonicalKey, envelope: a.envelope },
          { key: b.canonicalKey, envelope: b.envelope },
        );
      }
      return this._defaultTieBreak(a.canonicalKey, a.envelope, b.canonicalKey, b.envelope, policy);
    });

    for (const { canonicalKey, storageKey, bytes } of candidates) {
      if (freed >= targetBytes) break;
      this._storage.removeItem(storageKey);
      this._readCount.delete(canonicalKey);
      freed += bytes;
    }

    return freed;
  }

  // ── Private: transaction commit ───────────────────────────────────────────

  /**
   * Apply a batch of buffered ops to the `Storage` object.
   *
   * Called by `WebStorageTransaction.commit()`. Processes ops in order. Any
   * `setItem` call that throws `QuotaExceededError` is handled via the
   * configured recovery policy before retrying once.
   *
   * If any op still fails after recovery, the error propagates and
   * `_transactions.delete(txId)` is called in a `finally` block to remove
   * the settled transaction regardless.
   */
  private async _applyCommit(txId: string, ops: WebStorageBufferedOp[]): Promise<void> {
    try {
      for (const op of ops) {
        switch (op.kind) {
          case 'write':
            this._setItem(this._toStorageKey(op.key), op.json);
            this._readCount.delete(op.key);
            break;
          case 'delete':
            this._storage.removeItem(this._toStorageKey(op.key));
            this._readCount.delete(op.key);
            break;
          case 'clear':
            for (const { canonicalKey, storageKey } of this._ownKeys(op.prefix)) {
              this._storage.removeItem(storageKey);
              this._readCount.delete(canonicalKey);
            }
            break;
        }
      }
    } finally {
      this._transactions.delete(txId);
    }
  }

  // ── Private: QuotaExceededError recovery ─────────────────────────────────

  /**
   * Wrapper around `storage.setItem` that implements `QuotaExceededError`
   * recovery when the policy is `'ttl-then-lru'`.
   *
   * Attempt sequence:
   * 1. `setItem` — happy path.
   * 2. If `QuotaExceededError` and policy is `'ttl-then-lru'`:
   *    a. Sweep all expired own entries.
   *    b. Retry `setItem`.
   * 3. If still failing:
   *    a. Evict by LRU until estimated freed bytes >= value byte size.
   *    b. Final retry `setItem`.
   * 4. If still failing: rethrow.
   *
   * All other errors from `setItem` propagate immediately without recovery.
   */
  private _setItem(storageKey: string, json: string): void {
    try {
      this._storage.setItem(storageKey, json);
    } catch (err) {
      if (!this._isQuotaError(err) || this._recovery === 'none') throw err;

      // ── Recovery pass 1: sweep expired entries ───────────────────────────
      this._sweepExpiredSync();

      try {
        this._storage.setItem(storageKey, json);
        return; // Recovery pass 1 succeeded
      } catch (retryErr) {
        if (!this._isQuotaError(retryErr)) throw retryErr;
      }

      // ── Recovery pass 2: LRU eviction until estimated room ───────────────
      const needed = (storageKey.length + json.length) * 2;
      this._evictLRUSync(needed);

      // Final attempt — let it propagate if it still fails.
      this._storage.setItem(storageKey, json);
    }
  }

  /**
   * Synchronous TTL sweep of all own entries. Removes every expired entry from
   * `Storage` and clears its `_readCount` entry. Called during quota recovery.
   */
  private _sweepExpiredSync(): void {
    for (const { canonicalKey, storageKey } of this._ownKeys()) {
      const raw = this._storage.getItem(storageKey);
      if (raw === null) continue;
      try {
        const envelope = JSON.parse(raw) as StorageEnvelope<string>;
        if (this._isExpired(envelope)) {
          this._storage.removeItem(storageKey);
          this._readCount.delete(canonicalKey);
        }
      } catch {
        // Corrupt entry — remove it as part of the cleanup.
        this._storage.removeItem(storageKey);
        this._readCount.delete(canonicalKey);
      }
    }
  }

  /**
   * Synchronous LRU eviction pass. Removes entries sorted by `written_at`
   * ascending (oldest first) until the estimated freed bytes reach `targetBytes`.
   * Called during quota recovery as a second-pass strategy after TTL sweep
   * alone was insufficient.
   */
  private _evictLRUSync(targetBytes: number): void {
    const candidates: Array<{
      canonicalKey: CanonicalKey;
      storageKey: string;
      written_at: number;
      bytes: number;
    }> = [];

    for (const { canonicalKey, storageKey } of this._ownKeys()) {
      const raw = this._storage.getItem(storageKey);
      if (raw === null) continue;
      try {
        const envelope = JSON.parse(raw) as StorageEnvelope<string>;
        candidates.push({
          canonicalKey,
          storageKey,
          written_at: envelope.written_at,
          bytes: (storageKey.length + raw.length) * 2,
        });
      } catch {
        candidates.push({
          canonicalKey,
          storageKey,
          written_at: 0,
          bytes: ENTRY_OVERHEAD_BYTES,
        });
      }
    }

    // Oldest first: lowest written_at = evicted first.
    candidates.sort((a, b) => a.written_at - b.written_at);

    let freed = 0;
    for (const { canonicalKey, storageKey, bytes } of candidates) {
      if (freed >= targetBytes) break;
      this._storage.removeItem(storageKey);
      this._readCount.delete(canonicalKey);
      freed += bytes;
    }
  }

  // ── Private: key helpers ──────────────────────────────────────────────────

  /**
   * Convert a canonical key to a prefixed storage key.
   *
   * ```
   * 'myapp:chrome:130:auth:session'
   *               ↓
   * '__storage__myapp:chrome:130:auth:session'
   * ```
   */
  private _toStorageKey(canonicalKey: CanonicalKey): string {
    return `${this._prefix}${canonicalKey}`;
  }

  /**
   * Extract the canonical key from a prefixed storage key.
   * Returns `null` if the storage key does not start with the prefix.
   */
  private _fromStorageKey(storageKey: string): CanonicalKey | null {
    if (!storageKey.startsWith(this._prefix)) return null;
    return storageKey.slice(this._prefix.length) as CanonicalKey;
  }

  /**
   * Iterate all own storage keys (those starting with `_prefix`), optionally
   * filtered to those whose canonical key starts with `canonicalPrefix`.
   *
   * Returns an iterable of `{ canonicalKey, storageKey }` pairs. A snapshot
   * of keys is taken before iteration to guard against mutations during the
   * loop (e.g., lazy TTL removals inside `query()`).
   *
   * Web Storage does not expose a prefix-scan API; the only enumeration
   * primitive is `storage.key(i)` for `i in [0, storage.length)`. The full
   * length scan is O(totalStorageEntries) including entries from other
   * consumers, but the filtered result set is bounded by this backend's own
   * entry count.
   */
  private *_ownKeys(
    canonicalPrefix?: string,
  ): Iterable<{ canonicalKey: CanonicalKey; storageKey: string }> &
    Iterator<{ canonicalKey: CanonicalKey; storageKey: string }> {
    // Snapshot the key list to avoid concurrent-modification issues during
    // lazy deletion inside query/evict loops.
    const snapshot: string[] = [];
    for (let i = 0; i < this._storage.length; i++) {
      const k = this._storage.key(i);
      if (k !== null) snapshot.push(k);
    }

    for (const storageKey of snapshot) {
      const canonicalKey = this._fromStorageKey(storageKey);
      if (canonicalKey === null) continue;
      if (canonicalPrefix && !canonicalKey.startsWith(canonicalPrefix)) continue;
      yield { canonicalKey, storageKey };
    }
  }

  // ── Private: guards and helpers ───────────────────────────────────────────

  private _assertInitialized(): void {
    if (!this._initialized) {
      throw new Error(`[${this.kind}] Backend not initialized. Call initialize() first.`);
    }
  }

  private _isExpired(envelope: StorageEnvelope<string>): boolean {
    return envelope.expires_at !== null && envelope.expires_at < Date.now();
  }

  private _getTransaction(id: string): IWebStorageTransaction {
    const tx = this._transactions.get(id);
    if (!tx) throw new Error(`[${this.kind}] No active transaction with id "${id}".`);
    return tx;
  }

  private _isQuotaError(err: unknown): boolean {
    if (!(err instanceof DOMException)) return false;
    // Covers both 'QuotaExceededError' (standard) and 'NS_ERROR_DOM_QUOTA_REACHED' (Firefox)
    return err.name === 'QuotaExceededError' || err.code === 22;
  }

  private _defaultTieBreak(
    aKey: CanonicalKey,
    aEnv: StorageEnvelope<string>,
    bKey: CanonicalKey,
    bEnv: StorageEnvelope<string>,
    policy: EvictionPolicy,
  ): number {
    switch (policy) {
      case 'lru':
      case 'fifo':
        return aEnv.written_at - bEnv.written_at;
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
