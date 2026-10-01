import { sizeOf } from '@/libs';
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
} from '../../storage.types';
import { useMemoryStore, type MemoryStore } from './memory.store';

import { MemoryTransaction, type BufferedOp } from './memory.transaction';

/**
 * Memory backend
 *
 * Stores values as-is (no string encoding, no encryption) in a Map.
 * TRaw is `unknown` because the pipeline skips serialization/encryption for
 * this backend and stores the already-typed, already-validated value directly.
 *
 * ### Memory architecture as a workflow
 * ```
 * +----------------------------------------------------------------------+
 * |                        CALLER (any framework)                        |
 * |                                                                      |
 * |   storage.set(key, value, schema)      storage.transaction(block)    |
 * |   storage.get(key, schema)             storage.delete(key)           |
 * +----------------------------------------------------------------------+
 *                                       ||  IStorageFacade
 *                                       \/
 * +----------------------------------------------------------------------+
 * |                         FACADE  [NOT YET BUILT]                      |
 * |                                                                      |
 * |  • Resolves actualKey -> CanonicalKey via buildCanonicalKey()         |
 * |  • Resolves actualKey -> CanonicalKey via buildCanonicalKey()         |
 * |  • For transaction(): calls beginTransaction(), injects tx.id into   |
 * |    every op in the block, then commit() or rollback() on exit        |
 * |  • Forwards all ops to the pipeline                                  |
 * +----------------------------------------------------------------------+
 *                                       ||  IStoragePipeline
 *                                       \/
 * +----------------------------------------------------------------------+
 * |                      PIPELINE  [NOT YET BUILT]                       |
 * |                                                                      |
 * |  WRITE path                          READ path                       |
 * |  ─────────────────────               ──────────────────────          |
 * |  1. zod.parse(value)                 1. backend.read(key)            |
 * |  2. schema.serialize(value)          2. TTL check -> null if expired  |
 * |  2. schema.serialize(value)          2. TTL check -> null if expired  |
 * |     (skipped for memory)             3. encryption.decrypt(payload)  |
 * |  3. encryption.encrypt(str)             (skipped for memory)         |
 * |     (skipped for memory)             4. MigrationRunner.migrate()    |
 * |  4. wrap in StorageEnvelope             if schema_version stale      |
 * |  5. backend.write(key, envelope)     5. schema.deserialize(str)      |
 * |                                         (skipped for memory)         |
 * |                                      6. zod.parse(result)            |
 * |                                      7. return typed value           |
 * +----------------------------------------------------------------------+
 *                                       ||  IStorageBackend
 *                                       \/
 * +----------------------------------------------------------------------+
 * |                         MemoryBackend                                |
 * |                                                                      |
 * |  ┌──────────────────────────────────────────────────────────────┐    |
 * |  |                 MemoryStore (plain singleton)                |    |
 * |  |                                                              |    |
 * |  |  _store: Map<CanonicalKey, StorageEnvelope>                  |    |
 * |  |  _transactions: Map<string, MemoryTransaction>               |    |
 * |  |  _readCount: Map<CanonicalKey, number>        (LFU support)  |    |
 * |  |  _initialized: boolean                                       |    |
 * |  └──────────────────────────────────────────────────────────────┘    |
 * |                                                                      |
 * |  NON-TRANSACTIONAL PATH          TRANSACTIONAL PATH                  |
 * |  ──────────────────────          ────────────────────                |
 * |                                                                      |
 * |  write(key, envelope)            beginTransaction()                  |
 * |  |                               |                                   |
 * |  +-> _store.set(key, envelope)   +-> new MemoryTransaction(          |
 * |                                           _store,   <- unused bug     |
 * |  read(key)                                _applyOps <- the callback   |
 * |  |                                |    )                             |
 * |  |-> TTL check (_isExpired)       |    stored in _transactions[id]   |
 * |  |-> _store.get(key)              |                                  |
 * |  +-> _readCount[key]++            |    write(key, env, {txId})       |
 * |                                   |    |                             |
 * |  delete(key)                      |    +-> tx.bufferWrite(key, env)  |
 * |  +-> _store.delete(key)           |        ops[] grows               |
 * |      _readCount.delete(key)       |                                  |
 * |                                   |    tx.commit()                   |
 * |  evict(targetBytes, policy)       |    |                             |
 * |  |                                |    +-> _onCommit(ops)            |
 * |  |-> Phase 1: TTL sweep           |        |                         |
 * |  |   delete all expired           |        +-> _applyOps(ops)        |
 * |  |                                |            |                     |
 * |  +-> Phase 2: weighted sort       |            |-> write -> _store    |
 * |      |                            |            |-> delete -> _store   |
 * |      |-> sort by weight asc       |            +-> clear -> _store    |
 * |  +-> Phase 2: weighted sort       |            |-> write -> _store    |
 * |      |                            |            |-> delete -> _store   |
 * |      |-> sort by weight asc       |            +-> clear -> _store    |
 * |      |-> tie-break by policy      |                                  |
 * |      |   lru/fifo -> written_at    |   (!) tx NOT removed from        |
 * |      |   lfu -> _readCount         |     _transactions after commit   |
 * |      |   user -> comparator fn     |     <- BUG: leaks forever         |
 * |      +-> delete until freed       |                                  |
 * |          >= targetBytes           |    tx.rollback()                 |
 * |                                   |    +-> ops[] = []  (discard)     |
 * |  estimateQuota()                  |        nothing was written       |
 * |  +-> JSON.stringify each entry    |        so no undo needed         |
 * |      × 2 (UTF-16) as byte proxy   |                                  |
 * |      vs 50 MB soft cap            |                                  |
 * +----------------------------------------------------------------------+
 *                                       ||
 *                           (future)    ||  BroadcastChannel
 *                                       \/
 *                     +-----------------------------------+
 *                     |   All connected tabs / windows    |
 *                     |   StorageChangeEvent { key, op,   |
 *                     |   schema_version, backend, ... }  |
 *                     +-----------------------------------+
 * ```
 *
 * The key insight the diagram makes visible: the non-transactional path writes
 * directly to `_store` and is complete in one step. The transactional path adds
 * a staging layer - `MemoryTransaction._ops[]` acts as a write-ahead buffer that
 * only lands in `_store` when `_onCommit` fires. Rollback is free because the buffer
 * is simply discarded; no compensating writes are needed. This is why "best-effort"
 * is the honest label - the atomicity guarantee only holds within the single JS thread,
 * and there is no durability (no disk, no crash recovery).
 *
 * Lifecycle intent:
 *   - Used as a last-resort fallback when all disk-backed backends fail.
 *   - Also used as a write-through/read-through cache layer above other
 *     backends (that use case is handled at the pipeline layer, not here).
 *   - Data is intentionally lost on page reload - this is by design.
 */
export class MemoryBackend implements IStorageBackend<unknown> {
  private store: MemoryStore;
  constructor() {
    this.store = useMemoryStore();
  }
  get kind() {
    return this.store.kind;
  }
  get transactionStrength() {
    return this.store.transactionStrength;
  }
  get priority() {
    return this.store.priority;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async probe(): Promise<CapabilityResult> {
    // Memory is always available - there's nothing that can go wrong.
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

  async initialize(): Promise<void> {
    this.store._initialized = true;
  }

  async close(): Promise<void> {
    // Flush all pending transactions (rollback - we cannot commit to nowhere).
    for (const tx of this.store._transactions.values()) {
      await tx.rollback();
    }
    this.store._transactions.clear();
    this.store._store.clear();
    this.store._readCount.clear();
    this.store._initialized = false;
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

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
  }

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

    // Track access for LFU eviction
    this.store._readCount.set(key, (this.store._readCount.get(key) ?? 0) + 1);

    return entry;
  }

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

  async clear(
    prefix?: string,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void> {
    this._assertInitialized();

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
        // Lazy TTL sweep
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async beginTransaction(strength?: TransactionStrength): Promise<MemoryTransaction<any>> {
    this._assertInitialized();

    // Memory can only offer best-effort. Reject if the caller demands more.
    if (strength && strength !== 'best-effort') {
      throw new Error(
        `[MemoryBackend] Requested transaction strength "${strength}" but ` +
          `this backend only supports "${this.transactionStrength}". Use IndexedDB for stronger guarantees.`,
      );
    }

    const tx = new MemoryTransaction<unknown>(
      this.store._store,
      (txId: string, ops: BufferedOp<unknown>[]) => this._applyOps(txId, ops),
      (txId: string) => this.store._transactions.delete(txId),
    );
    this.store._transactions.set(tx.id, tx);
    return tx;
  }

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

  async estimateQuota(): Promise<QuotaEstimate> {
    this._assertInitialized();

    // Rough heuristic: JSON-serialize every value and measure the string length
    // as a proxy for bytes. Real byte usage is higher due to V8 object overhead.
    let used = 0;
    for (const [key, envelope] of this.store._store) {
      try {
        used += key.length * 2; // UTF-16 characters
        used += JSON.stringify(envelope).length * 2;
      } catch {
        // Non-serializable value - estimate conservatively
        used += 256;
      }
    }

    // In-memory "quota" is intentionally unconstrained, but we surface a
    // soft cap based on available heap (not precisely measurable in browsers).
    const available = 50 * 1024 * 1024; // 50 MB soft cap

    return {
      used,
      available: Math.max(0, available - used),
      ratio: Math.min(1, used / available),
    };
  }

  async evict(
    targetBytes: number,
    policy: EvictionPolicy,
    comparator?: (
      a: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
      b: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    ) => number,
  ): Promise<number> {
    this._assertInitialized();

    // Step 1: sweep expired entries first (free eviction)
    let freed = 0;
    for (const [key, envelope] of this.store._store) {
      if (this._isExpired(envelope)) {
        this.store._store.delete(key);
        this.store._readCount.delete(key);
        freed += sizeOf(envelope);
      }
    }

    if (freed >= targetBytes) return freed; // Quota satisfied by TTL sweep alone

    // Step 2: sort remaining entries by weight (ascending = candidates first)
    // then apply tie-breaking via the eviction policy
    const candidates = [...this.store._store.entries()].map(([key, envelope]) => ({
      key,
      envelope,
    }));

    candidates.sort((a, b) => {
      // Primary: lower weight = evict first
      const weightDiff = a.envelope.weight - b.envelope.weight;
      if (weightDiff !== 0) return weightDiff;

      // Tie-break
      if (policy === 'user' && comparator) {
        return comparator(a, b);
      }
      return this._defaultTieBreak(a, b, policy);
    });

    // Step 3: evict until target is met or store is empty
    for (const { key } of candidates) {
      if (freed >= targetBytes) break;
      this.store._store.delete(key);
      this.store._readCount.delete(key);
      freed++;
    }

    return freed;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _assertInitialized() {
    if (!this.store._initialized) {
      throw new Error('[MemoryBackend] Backend has not been initialized. Call initialize() first.');
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

  /**
   * Apply a committed batch of buffered ops atomically.
   * Called by MemoryTransaction.commit().
   * Single-threaded JS means this truly is atomic.
   */
  private _applyOps(txId: string, ops: BufferedOp<unknown>[]): void {
    for (const op of ops) {
      switch (op.kind) {
        case 'write':
          this.store._store.set(op.key!, op.envelope!);
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
    // Remove the transaction from the active set after commit
    this.store._transactions.delete(txId);
  }

  private _defaultTieBreak(
    a: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    b: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
    policy: EvictionPolicy,
  ): number {
    switch (policy) {
      case 'lru':
        // Oldest written_at first
        return a.envelope.written_at - b.envelope.written_at;
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
