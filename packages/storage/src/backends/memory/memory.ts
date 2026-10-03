import type {
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
import { sizeOf } from '../../util';

import { useMemoryStore, type MemoryStore } from './memory.store';
import { MemoryTransaction, type BufferedOp } from './memory.transaction';

/**
 * @summary The memory backend: a `Map` of envelopes, with no durability.
 *
 * @description
 * It is the last backend of the chain on the main thread. Data is lost when the
 * page reloads, by design. All instances share one store in the module
 * ({@linkcode useMemoryStore}).
 *
 * ```text
 *   write(key, envelope) -------------------> store.set
 *   write(key, envelope, { transactionId }) -> tx buffer --commit---> store (all ops in one step)
 *                                                        --rollback-> buffer dropped
 *   read(key) --> expiry check --> store.get --> read count + 1 (for 'lfu')
 *   evict     --> expired entries, then the lowest weight, then the policy
 *   ```
 *
 * Transactions are `best-effort`: the commit is atomic in the one JavaScript
 * thread, and a rollback only drops the buffer.
 *
 * @example
 * Example 1: Write and read
 * ```ts
 * const backend = new MemoryBackend();
 * await backend.initialize();
 * await backend.write(key, envelope);
 * await backend.read(key); // envelope
 * ```
 *
 * @example
 * Example 2: An atomic batch
 * ```ts
 * const tx = await backend.beginTransaction();
 * await backend.write(key, envelope, { transactionId: tx.id });
 * await tx.commit();
 * ```
 *
 * @public
 */
export class MemoryBackend implements IStorageBackend<unknown> {
  private store: MemoryStore;

  /**
   * @summary Makes a memory backend on the shared store of the module.
   */
  constructor() {
    this.store = useMemoryStore();
  }

  /**
   * @summary The kind of the backend: `memory`.
   * @returns The kind of the backend.
   */
  get kind() {
    return this.store.kind;
  }

  /**
   * @summary The strongest transaction of the backend: `best-effort`.
   * @returns The strongest transaction strength.
   */
  get transactionStrength() {
    return this.store.transactionStrength;
  }

  /**
   * @summary The place of the backend in the old priority order. A lower number comes first.
   * @returns The priority number.
   */
  get priority() {
    return this.store.priority;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @summary Tests the backend. Memory is always available.
   * @example
   * Probing
   * ```ts
   * await backend.probe(); // { available: true, latency: 0.01 }
   * ```
   * @returns {Promise<CapabilityResult>} `available: true` and the latency of the test.
   */
  async probe(): Promise<CapabilityResult> {
    const start = performance.now();
    const testKey = '__probe__' as CanonicalKey;
    this.store._store.set(testKey, {
      payload: 'ok',
      schema_version: 0,
      written_at: Date.now(),
      expires_at: null,
      weight: 0,
      backend: 'memory',
    });
    this.store._store.delete(testKey);
    return { available: true, latency: performance.now() - start };
  }

  /**
   * @summary Marks the backend as ready.
   * @example
   * Initializing
   * ```ts
   * await backend.initialize();
   * ```
   * @returns {Promise<void>} Resolves at once.
   */
  async initialize(): Promise<void> {
    this.store._initialized = true;
  }

  /**
   * @summary Rolls back the open transactions and empties the store.
   * @example
   * Closing
   * ```ts
   * await backend.close();
   * ```
   * @returns {Promise<void>} Resolves when the store is empty.
   */
  async close(): Promise<void> {
    // A commit has nowhere to go, so open transactions roll back.
    for (const tx of this.store._transactions.values()) {
      await tx.rollback();
    }
    this.store._transactions.clear();
    this.store._store.clear();
    this.store._readCount.clear();
    this.store._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * @summary Writes an envelope, or buffers it in a transaction.
   * @example
   * Writing
   * ```ts
   * await backend.write(key, envelope);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {StorageEnvelope<unknown>} envelope The envelope.
   * @param {WriteOptions} [options] The transaction of the write.
   * @returns {Promise<void>} Resolves when the write is done or buffered.
   * @throws {Error} When the backend is not initialized, or the transaction is not open.
   */
  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<unknown>,
    options?: WriteOptions,
  ): Promise<void> {
    this._assertInitialized();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferWrite(key, envelope);
      return;
    }

    this.store._store.set(key, envelope);
    // A new value has not been read yet (LFU).
    this.store._readCount.delete(key);
  }

  /**
   * @summary Reads an envelope and counts the read for the `lfu` policy.
   * @example
   * Reading
   * ```ts
   * const envelope = await backend.read(key);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {ReadOptions} [options] Expiry handling.
   * @returns {Promise<StorageEnvelope<unknown> | null>} The envelope, or `null` when it is missing or expired.
   * @throws {Error} When the backend is not initialized.
   */
  async read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<unknown> | null> {
    this._assertInitialized();

    const entry = this.store._store.get(key) ?? null;
    if (entry === null) return null;

    const respectTtl = options?.respectTtl ?? true;
    if (respectTtl && this._isExpired(entry)) {
      this.store._store.delete(key);
      this.store._readCount.delete(key);
      return null;
    }

    this.store._readCount.set(key, (this.store._readCount.get(key) ?? 0) + 1);

    return entry;
  }

  /**
   * @summary Deletes an entry, or buffers the delete in a transaction.
   * @example
   * Deleting
   * ```ts
   * await backend.delete(key);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {object} [options] The transaction of the delete.
   * @returns {Promise<void>} Resolves when the delete is done or buffered.
   * @throws {Error} When the backend is not initialized, or the transaction is not open.
   */
  async delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferDelete(key);
      return;
    }

    this.store._store.delete(key);
    this.store._readCount.delete(key);
  }

  /**
   * @summary Deletes the entries under a prefix, or all entries.
   * @example
   * Clearing a module
   * ```ts
   * await backend.clear('shop:browser:1:cart:');
   * ```
   * @param {string} [prefix] The prefix. Without it, the store is emptied.
   * @param {object} [options] The transaction and the signal of the clear.
   * @returns {Promise<void>} Resolves when the entries are deleted or the clear is buffered.
   * @throws {Error} When the backend is not initialized, or the signal aborts.
   */
  async clear(
    prefix?: string,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();
    options?.signal?.throwIfAborted();

    if (options?.transactionId) {
      const tx = this._getTransaction(options.transactionId);
      tx.bufferClear(prefix);
      return;
    }

    if (!prefix) {
      this.store._store.clear();
      this.store._readCount.clear();
      return;
    }

    for (const key of this.store._store.keys()) {
      if (key.startsWith(prefix)) {
        this.store._store.delete(key);
        this.store._readCount.delete(key);
      }
      options?.signal?.throwIfAborted();
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * @summary Returns the entries that match a query. Expired entries found on the way are deleted.
   * @example
   * The first page of a module
   * ```ts
   * await backend.query({ prefix: 'shop:browser:1:orders:', limit: 20 });
   * ```
   * @param {StorageQuery} q The criteria.
   * @param {object} [options] The signal of the query.
   * @returns {Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<unknown> }>>} The matching entries, in insertion order.
   * @throws {Error} When the backend is not initialized, or the signal aborts.
   */
  async query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<unknown> }>> {
    this._assertInitialized();

    const excludeExpired = q.excludeExpired ?? true;
    const results: Array<{ key: CanonicalKey; envelope: StorageEnvelope<unknown> }> = [];

    for (const [key, envelope] of this.store._store) {
      options?.signal?.throwIfAborted();

      if (q.prefix && !key.startsWith(q.prefix)) continue;
      if (excludeExpired && this._isExpired(envelope)) {
        this.store._store.delete(key);
        this.store._readCount.delete(key);
        continue;
      }
      if (q.schema_version !== undefined && envelope.schema_version !== q.schema_version) continue;

      results.push({ key, envelope });
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;

    return results.slice(offset, offset + limit);
  }

  /**
   * @summary Counts the entries, or the entries under a prefix.
   * @example
   * Counting
   * ```ts
   * await backend.count('shop:browser:1:cart:');
   * ```
   * @param {string} [prefix] The prefix. Without it, all entries count.
   * @returns {Promise<number>} The number of entries.
   * @throws {Error} When the backend is not initialized.
   */
  async count(prefix?: string): Promise<number> {
    this._assertInitialized();
    if (!prefix) return this.store._store.size;
    let n = 0;
    for (const key of this.store._store.keys()) {
      if (key.startsWith(prefix)) n++;
    }
    return n;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * @summary Opens a `best-effort` transaction.
   * @example
   * Opening
   * ```ts
   * const tx = await backend.beginTransaction();
   * ```
   * @param {TransactionStrength} [strength] The strength to ask for. Only `best-effort` is possible.
   * @returns {Promise<MemoryTransaction<any>>} The transaction.
   * @throws {Error} When the backend is not initialized, or a stronger transaction is asked for.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async beginTransaction(strength?: TransactionStrength): Promise<MemoryTransaction<any>> {
    this._assertInitialized();

    if (strength && strength !== 'best-effort') {
      throw new Error(
        `[MemoryBackend] Requested transaction strength "${strength}" but ` +
          `this backend only supports "${this.transactionStrength}". Use IndexedDB for stronger guarantees.`,
      );
    }

    const tx = new MemoryTransaction<unknown>(
      (txId: string, ops: BufferedOp<unknown>[]) => this._applyOps(txId, ops),
      (txId: string) => this.store._transactions.delete(txId),
    );
    this.store._transactions.set(tx.id, tx);
    return tx;
  }

  /**
   * @summary Tells if a transaction is open, or if one specific transaction is open.
   * @example
   * Checking
   * ```ts
   * backend.isTransactionActive(tx.id); // true until commit or rollback
   * ```
   * @param {string} [txId] The id of the transaction.
   * @returns {boolean} `true` when the transaction (or any transaction) is open.
   */
  isTransactionActive(txId?: string) {
    try {
      const tx = txId
        ? this._getTransaction(txId)
        : this.store._transactions.values().next()?.value;
      return tx !== undefined && tx !== null;
    } catch {
      return false;
    }
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  /**
   * @summary Estimates the use of the store against a soft limit of 50 MB.
   * @description The size is the JSON length of each entry, times 2 for UTF-16.
   * @example
   * Estimating
   * ```ts
   * const { used, ratio } = await backend.estimateQuota();
   * ```
   * @returns {Promise<QuotaEstimate>} The estimate.
   * @throws {Error} When the backend is not initialized.
   */
  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();

    let used = 0;
    for (const [key, envelope] of this.store._store) {
      try {
        used += key.length * 2;
        used += JSON.stringify(envelope).length * 2;
      } catch {
        // A value that is not serializable gets a fixed estimate.
        used += 256;
      }
    }

    // The heap size is not measurable in browsers, so a soft limit stands in for a quota.
    const available = 50 * 1024 * 1024;

    return {
      used,
      available: Math.max(0, available - used),
      ratio: Math.min(1, used / available),
    };
  }

  /**
   * @summary Deletes entries until about `targetBytes` are free.
   * @description Expired entries go first. Then the lowest weight goes first,
   * and the policy breaks ties: `lru` and `fifo` by `written_at`, `lfu` by the
   * read count, `user` by the comparator.
   * @example
   * Freeing 1 MB
   * ```ts
   * await backend.evict(1024 * 1024, 'lfu');
   * ```
   * @param {number} targetBytes The bytes to free.
   * @param {EvictionPolicy} policy The tie-break between entries of the same weight.
   * @param {Function} [comparator] The order for the `user` policy.
   * @returns {Promise<number>} The bytes freed (an estimate from {@linkcode sizeOf}).
   * @throws {Error} When the backend is not initialized.
   */
  async evict(
    targetBytes: number,
    policy: EvictionPolicy,
    comparator?: (
      a: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
      b: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    ) => number,
  ): Promise<number> {
    this._assertInitialized();

    // Step 1: expired entries cost nothing to remove.
    let freed = 0;
    for (const [key, envelope] of this.store._store) {
      if (this._isExpired(envelope)) {
        this.store._store.delete(key);
        this.store._readCount.delete(key);
        freed += sizeOf(envelope);
      }
    }

    if (freed >= targetBytes) return freed;

    // Step 2: the lowest weight first, then the policy.
    const candidates = [...this.store._store.entries()].map(([key, envelope]) => ({
      key,
      envelope,
    }));

    candidates.sort((a, b) => {
      const weightDiff = a.envelope.weight - b.envelope.weight;
      if (weightDiff !== 0) return weightDiff;
      if (policy === 'user' && comparator) {
        return comparator(a, b);
      }
      return this._defaultTieBreak(a, b, policy);
    });

    // Step 3: delete until the target is met.
    for (const { key, envelope } of candidates) {
      if (freed >= targetBytes) break;
      this.store._store.delete(key);
      this.store._readCount.delete(key);
      freed += sizeOf(envelope);
    }

    return freed;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _assertInitialized() {
    if (!this.store._initialized) {
      throw new Error('[MemoryBackend] Backend not initialized. Call initialize() first.');
    }
  }

  private _isExpired(envelope: StorageEnvelope<unknown>): boolean {
    return envelope.expires_at !== null && envelope.expires_at < Date.now();
  }

  private _getTransaction(id: string): MemoryTransaction<unknown> {
    const tx = this.store._transactions.get(id);
    if (!tx) {
      throw new Error(`[MemoryBackend] No active transaction with id "${id}".`);
    }
    return tx as MemoryTransaction<unknown>;
  }

  /** Applies a committed batch in one step. One JavaScript thread makes it atomic. */
  private _applyOps(txId: string, ops: BufferedOp<unknown>[]): void {
    for (const op of ops) {
      switch (op.kind) {
        case 'write':
          this.store._store.set(op.key!, op.envelope!);
          this.store._readCount.delete(op.key!);
          break;
        case 'delete':
          this.store._store.delete(op.key!);
          this.store._readCount.delete(op.key!);
          break;
        case 'clear':
          if (!op.prefix) {
            this.store._store.clear();
            this.store._readCount.clear();
          } else {
            for (const key of this.store._store.keys()) {
              if (key.startsWith(op.prefix)) {
                this.store._store.delete(key);
                this.store._readCount.delete(key);
              }
            }
          }
          break;
      }
    }
    this.store._transactions.delete(txId);
  }

  private _defaultTieBreak(
    a: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    b: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    policy: EvictionPolicy,
  ): number {
    switch (policy) {
      case 'lru':
      case 'fifo':
        return a.envelope.written_at - b.envelope.written_at;
      case 'lfu': {
        const aReads = this.store._readCount.get(a.key) ?? 0;
        const bReads = this.store._readCount.get(b.key) ?? 0;
        return aReads - bReads;
      }
      default:
        return 0;
    }
  }
}
