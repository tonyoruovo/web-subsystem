# Memory Backend

**Location:** `src/composables/managers/storage/backends/memory`

The in-process, Map-backed storage backend. Operates entirely in the JavaScript heap - no disk, no encoding, no encryption. Serves two distinct roles in the storage subsystem: last-resort fallback when every disk-backed backend is unavailable, and write-through/read-through cache layer above disk-backed backends (the caching orchestration lives in the pipeline layer, not here).

---

## Files

| File | Purpose |
|---|---|
| `memory.ts` | `MemoryBackend` class - implements `IStorageBackend<unknown>` |
| `memory.store.ts` | Plain singleton store holding all runtime state (Map, transactions, read counts) |
| `transaction.ts` | `MemoryTransaction<TRaw>` - best-effort, buffer-then-apply transaction |
| `index.ts` | Barrel export + architecture diagram |

---

## Architecture

```
CALLER
  │  storage.set / storage.get / storage.transaction
  ▼
FACADE  [pipeline layer - not in this module]
  │  resolves canonical key, validates, serializes, encrypts
  ▼
PIPELINE  [pipeline layer - not in this module]
  │  wraps value in StorageEnvelope, calls backend
  ▼
MemoryBackend  (this module)
  │
  ├─ NON-TRANSACTIONAL
  │    write()   -> _store.set(key, envelope)
  │    read()    -> TTL check -> _store.get(key) -> _readCount[key]++
  │    delete()  -> _store.delete(key)
  │    clear()   -> _store.clear() or prefix scan
  │    query()   -> manifest scan with lazy TTL sweep
  │    evict()   -> Phase 1: TTL sweep -> Phase 2: weight sort + policy tie-break
  │
  └─ TRANSACTIONAL
       beginTransaction() -> new MemoryTransaction(_store, _applyOps)
                            stored in _transactions[id]
       write/delete/clear with { transactionId }
         -> tx.bufferWrite / bufferDelete / bufferClear
         -> ops[] grows, _store untouched
       tx.commit()
         -> _onCommit(txId, ops) -> _applyOps(txId, ops)
         -> ops flushed to _store atomically (single JS thread)
         -> _transactions.delete(txId)
       tx.rollback()
         -> ops[] = [] (discard buffer, nothing to undo)
```

---

## Key design decisions

### `TRaw = unknown`

The Memory backend stores values as-is - `StorageEnvelope<unknown>`. Unlike disk-backed backends, it skips serialization and encryption entirely. The pipeline detects this and omits those steps for memory writes, passing the already-validated, already-typed value directly as the envelope payload.

### State lives in a plain singleton, not in the class

`MemoryBackend` holds no instance state. Everything - the Map, the transaction registry, the read counters - lives in `useMemoryStore()` (a plain singleton object). This makes the backend effectively a singleton accessible from multiple call sites without shared-instance management, and with no framework dependency.

### Best-effort transactions

"Best-effort" is the honest label for what `MemoryTransaction` provides:

- **Atomicity** - real, because JavaScript is single-threaded. `_applyOps` runs synchronously inside a single event-loop turn with no way for anything to interleave.
- **Durability** - none. Data lives only for the current page session. A refresh wipes everything.
- **Rollback cost** - zero. Nothing is written until `commit()`, so discarding the ops buffer is the entirety of rollback.

If the caller requests `'serializable'` or `'compensating'` strength, `beginTransaction()` throws immediately with an informative message directing them to IndexedDB.

### `_readCount` and LFU eviction

Every successful `read()` increments a counter for that key. When `evict()` runs with `policy: 'lfu'`, these counts are the tie-breaker - entries read fewest times in the current session are evicted first. The counter resets to zero on overwrite (a rewritten entry is treated as new) and on page reload (counts are in-memory only). Outside of LFU tie-breaking, `_readCount` has no effect on any other operation.

### `_store` parameter on `MemoryTransaction` is unused

`MemoryTransaction` accepts `_store` in its constructor - a remnant of an earlier design where the transaction would support read-your-own-writes by peeking at the backing store. That feature was never implemented, so `_store` sits unused. The correct place for read-your-own-writes is the pipeline layer, which will maintain a per-transaction read buffer. The `_store` parameter should be removed in a future cleanup.

### The transaction leak bug (now fixed)

The original `_applyOps` had a comment stating it should remove the transaction from `_transactions` after commit but the `delete` call was missing. This caused every committed transaction to leak into the Map indefinitely. The fix passes `txId` through the `_onCommit` callback so `_applyOps` can call `this.store._transactions.delete(txId)` as its last step.

---

## Lifecycle

```
new MemoryBackend()
  └── useMemoryStore()  <- returns a plain singleton store; no Pinia setup required

probe()         -> always returns { available: true }; smoke-tests the Map directly
initialize()    -> sets _initialized = true; no async work needed
close()         -> rolls back all pending transactions, clears _store + _readCount
```

`probe()` is trivially cheap and always succeeds - there is no environment in which an in-process Map is unavailable.

---

## Eviction

Eviction runs in two phases:

**Phase 1 - Free TTL sweep.** All entries whose `expires_at < Date.now()` are deleted. If the bytes freed in this phase satisfy `targetBytes`, eviction stops here.

**Phase 2 - Weighted eviction.** Remaining entries are sorted ascending by `weight` (lower = evicted first). Ties are broken by the chosen policy:

| Policy | Tie-break logic |
|---|---|
| `lru` | Oldest `written_at` first |
| `fifo` | Oldest `written_at` first (same as LRU for this backend) |
| `lfu` | Lowest `_readCount` first |
| `user` | Custom comparator function supplied by the caller |

Entries are deleted in sort order until `freed >= targetBytes` or the store is empty.

---

## Usage example

```ts
import { MemoryBackend } from './memory'

const backend = new MemoryBackend()

await backend.probe()       // { available: true, latency: ~0 }
await backend.initialize()

// Direct write/read
const key = 'myapp:chrome:130:auth:session' as CanonicalKey
await backend.write(key, {
  payload:        { userId: 'abc' },
  schema_version: 1,
  written_at:     Date.now(),
  expires_at:     Date.now() + 60_000,
  weight:         3,
  backend:        'memory',
})
const envelope = await backend.read(key)

// Transactional write
const tx = await backend.beginTransaction()
await backend.write(keyA, envelopeA, { transactionId: tx.id })
await backend.write(keyB, envelopeB, { transactionId: tx.id })
await tx.commit()   // both land atomically, or
await tx.rollback() // both discarded
```

---

## What this module does NOT do

- **Encrypt or serialize** - the pipeline handles this before values reach the backend.
- **Persist across reloads** - intentional. Data loss on refresh is the defined contract for this backend.
- **Orchestrate caching** - when Memory acts as a cache above OPFS or IDB, the pipeline layer makes that decision and calls both backends in the right order. This backend knows nothing about the existence of other backends.
- **Emit change events** - BroadcastChannel `StorageChangeEvent` emission is a pipeline/facade concern, not a backend concern.