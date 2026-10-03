/**
 * @fileoverview
 * ### Memory architecture as a workflow
 * ```
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                        CALLER (any framework)                        ║
 * ║                                                                      ║
 * ║   storage.set(key, value, schema)      storage.transaction(block)    ║
 * ║   storage.get(key, schema)             storage.delete(key)           ║
 * ╚══════════════════════════════════════╤═══════════════════════════════╝
 *                                        |  IStorageFacade
 *                                        ▼
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                         FACADE  [NOT YET BUILT]                      ║
 * ║                                                                      ║
 * ║  • Resolves actualKey -> CanonicalKey via buildCanonicalKey()         ║
 * ║  • Resolves actualKey -> CanonicalKey via buildCanonicalKey()         ║
 * ║  • For transaction(): calls beginTransaction(), injects tx.id into   ║
 * ║    every op in the block, then commit() or rollback() on exit        ║
 * ║  • Forwards all ops to the pipeline                                  ║
 * ╚══════════════════════════════════════╤═══════════════════════════════╝
 *                                        |  IStoragePipeline
 *                                        ▼
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                      PIPELINE  [NOT YET BUILT]                       ║
 * ║                                                                      ║
 * ║  WRITE path                          READ path                       ║
 * ║  ─────────────────────               ──────────────────────          ║
 * ║  1. zod.parse(value)                 1. backend.read(key)            ║
 * ║  2. schema.serialize(value)          2. TTL check -> null if expired  ║
 * ║  2. schema.serialize(value)          2. TTL check -> null if expired  ║
 * ║     (skipped for memory)             3. encryption.decrypt(payload)  ║
 * ║  3. encryption.encrypt(str)             (skipped for memory)         ║
 * ║     (skipped for memory)             4. MigrationRunner.migrate()    ║
 * ║  4. wrap in StorageEnvelope             if schema_version stale      ║
 * ║  5. backend.write(key, envelope)     5. schema.deserialize(str)      ║
 * ║                                         (skipped for memory)         ║
 * ║                                      6. zod.parse(result)            ║
 * ║                                      7. return typed value           ║
 * ╚══════════════════════════════════════╤═══════════════════════════════╝
 *                                        |  IStorageBackend
 *                                        ▼
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                         MemoryBackend                                ║
 * ║                                                                      ║
 * ║  ┌──────────────────────────────────────────────────────────────┐    ║
 * ║  |                 MemoryStore (plain singleton)                |    ║
 * ║  |                                                              |    ║
 * ║  |  _store: Map<CanonicalKey, StorageEnvelope>                  |    ║
 * ║  |  _transactions: Map<string, MemoryTransaction>               |    ║
 * ║  |  _readCount: Map<CanonicalKey, number>        (LFU support)  |    ║
 * ║  |  _initialized: boolean                                       |    ║
 * ║  └──────────────────────────────────────────────────────────────┘    ║
 * ║                                                                      ║
 * ║  NON-TRANSACTIONAL PATH          TRANSACTIONAL PATH                  ║
 * ║  ──────────────────────          ────────────────────                ║
 * ║                                                                      ║
 * ║  write(key, envelope)            beginTransaction()                  ║
 * ║  |                               |                                   ║
 * ║  └─► _store.set(key, envelope)   └─► new MemoryTransaction(          ║
 * ║                                           _store,   <- unused bug     ║
 * ║  read(key)                                _applyOps <- the callback   ║
 * ║  |                                |    )                             ║
 * ║  ├─► TTL check (_isExpired)       |    stored in _transactions[id]   ║
 * ║  ├─► _store.get(key)              |                                  ║
 * ║  └─► _readCount[key]++            |    write(key, env, {txId})       ║
 * ║                                   |    |                             ║
 * ║  delete(key)                      |    └─► tx.bufferWrite(key, env)  ║
 * ║  └─► _store.delete(key)           |        ops[] grows               ║
 * ║      _readCount.delete(key)       |                                  ║
 * ║                                   |    tx.commit()                   ║
 * ║  evict(targetBytes, policy)       |    |                             ║
 * ║  |                                |    └─► _onCommit(ops)            ║
 * ║  ├─► Phase 1: TTL sweep           |        |                         ║
 * ║  |   delete all expired           |        └─► _applyOps(ops)        ║
 * ║  |                                |            |                     ║
 * ║  └─► Phase 2: weighted sort       |            ├─► write -> _store    ║
 * ║      |                            |            ├─► delete -> _store   ║
 * ║      ├─► sort by weight asc       |            └─► clear -> _store    ║
 * ║  └─► Phase 2: weighted sort       |            ├─► write -> _store    ║
 * ║      |                            |            ├─► delete -> _store   ║
 * ║      ├─► sort by weight asc       |            └─► clear -> _store    ║
 * ║      ├─► tie-break by policy      |                                  ║
 * ║      |   lru/fifo -> written_at    |   (!) tx NOT removed from        ║
 * ║      |   lfu -> _readCount         |     _transactions after commit   ║
 * ║      |   user -> comparator fn     |     <- BUG: leaks forever         ║
 * ║      └─► delete until freed       |                                  ║
 * ║          >= targetBytes           |    tx.rollback()                 ║
 * ║                                   |    └─► ops[] = []  (discard)     ║
 * ║  estimateQuota()                  |        nothing was written       ║
 * ║  └─► JSON.stringify each entry    |        so no undo needed         ║
 * ║      × 2 (UTF-16) as byte proxy   |                                  ║
 * ║      vs 50 MB soft cap            |                                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *                                        |
 *                           (future)     |  BroadcastChannel
 *                                        ▼
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
 * @module memory
 * @file index.ts
 * @version 0.0.1
 */
export * from './memory';
export * from './memory.store';
export * from './memory.transaction';
