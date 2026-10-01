# IndexedDB Backend

**Location:** `src/composables/managers/storage/backends/indexeddb`

The IndexedDB storage backend. Highest-priority persistent backend in the fallback chain (priority 0). The only backend with native `serializable` transaction guarantees, backed by IDB's own `readwrite` transaction lock manager. No WAL needed — IDB's durability model handles crash recovery.

---

## Files

| File | Purpose |
|---|---|
| `idb.types.ts` | All IDB-specific types: `IDBRecord`, `IDBBackendConfig`, `IDBBufferedOp`, `IIDBTransaction` |
| `idb.utils.ts` | IDB Promise wrappers (`idbRequest`, `idbTransactionDone`) and cursor helpers (`cursorCollectPrefix`, `cursorDeleteMatching`, `collectExpired`, `collectByWeight`, `countPrefix`, `openDatabase`) |
| `idb.backend.ts` | `IDBBackend` class — implements `IStorageBackend<string>` |
| `idb.transaction.ts` | `IDBTransaction` — buffer-and-replay serializable transaction |
| `index.ts` | Barrel export |

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
  │  wraps encrypted string in StorageEnvelope<string>, calls backend
  ▼
IDBBackend  (this module)
  │
  ├─ _db: IDBDatabase                              <- open IDB connection
  ├─ _transactions: Map<string, IDBTransaction>    <- active tx registry
  ├─ _readCount: Map<CanonicalKey, number>         <- LFU counter
  │
  ├─ NON-TRANSACTIONAL
  │    write()   -> build IDBRecord -> db.transaction(readwrite) -> store.put -> await done
  │    read()    -> db.transaction(readonly) -> store.get -> TTL check -> reconstruct envelope
  │    delete()  -> db.transaction(readwrite) -> store.delete
  │    clear()   -> db.transaction(readwrite) -> store.delete(range) or store.clear()
  │    query()   -> cursorCollectPrefix -> filter schema_version + TTL -> lazy delete cleanup
  │    count()   -> store.count(range?)   ← native IDB, no cursor needed
  │    evict()   -> Phase 1: collectExpired (by_expires_at index) -> batch delete
  │              -> Phase 2: collectByWeight (by_weight index) -> delete until targetBytes
  │
  └─ TRANSACTIONAL
       beginTransaction() -> new IDBTransaction(_applyCommit, _transactions.delete)
       write/delete/clear with { transactionId }
         -> tx.bufferWrite / bufferDelete / bufferClear
         -> ops[] grows; zero IDB activity
       tx.commit()
         -> IDBBackend._applyCommit(txId, ops)
         -> one native db.transaction(['entries'], 'readwrite')
         -> for each op: store.put / store.delete / store.delete(range) | store.clear
         -> await idbTransactionDone   <- IDB auto-commits when request queue drains
         -> _transactions.delete(txId)
       tx.rollback()
         -> ops[] = [] (discard buffer; nothing was written to IDB)
         -> _transactions.delete(txId)
```

---

## Database schema

```
DB: <dbName>  (default: 'storage')  version: 1
 └── objectStore: 'entries'   keyPath: 'key'   (one record per canonical key)
       ├── index: 'by_expires_at'   keyPath: 'expires_at'   unique: false
       └── index: 'by_weight'       keyPath: 'weight'       unique: false
```

### The `entries` object store

Every canonical key maps to exactly one flat `IDBRecord`:

```ts
interface IDBRecord {
  key:            CanonicalKey  // IDB keyPath — auto-indexed
  payload:        string        // encrypted, opaque to this backend
  schema_version: number
  written_at:     number        // Unix ms
  expires_at:     number | null // null = never expires; null not indexed
  weight:         number
  backend:        BackendKind
}
```

### Why a flat record (not nested)

IDB indexes can only target top-level properties (or multi-entry arrays). Embedding `expires_at` and `weight` directly in the record — rather than inside a nested `metadata` object — makes both fields directly indexable without complex multi-entry index tricks.

### The `by_expires_at` index

Used exclusively by `evict()` Phase 1 and `collectExpired()`:

```
IDBKeyRange.upperBound(Date.now())
  -> cursor over all records where expires_at <= now
  -> never-expiring records (expires_at === null) are invisible to this index
     (IDB does not index null values — correct by design)
```

This eliminates the O(n) full-scan that every other backend uses for TTL sweeps. Only the records that are actually expired are touched.

### The `by_weight` index

Used by `evict()` Phase 2 and `collectByWeight()`:

```
index.openCursor()  -> records in ascending weight order
  -> lowest weight = primary eviction candidates
  -> cursor stops when freed bytes >= targetBytes
```

IDB yields records in index order without a JS-side sort. The secondary tie-break (LRU, LFU, FIFO, user) is applied in JS after the cursor walk.

---

## Transaction model: serializable

```
beginTransaction()
    │
   ▼
IDBTransaction created (ops = [], settled = false)
    │
backend.write / delete / clear called with transactionId
    │
   ▼
tx.bufferWrite / bufferDelete / bufferClear
-> ops[] grows; zero IDB activity
    │
    ├── commit() ────────────────────────────────────────────────────────────┐
    │        │                                                               │
    │       ▼                                                                │
    │   _applyCommit(txId, ops)                                              │
    │        │                                                               │
    │       ▼                                                                │
    │   db.transaction(['entries'], 'readwrite')                             │
    │   for each op (synchronously, no awaits between):                      │
    │     'write'  -> store.put(record)                                      │
    │     'delete' -> store.delete(key)                                      │
    │     'clear'  -> store.delete(IDBKeyRange) or store.clear()             │
    │   await idbTransactionDone(nativeTx)                                   │
    │     <- IDB auto-commits when request queue drains                      │
    │     <- on any request error: IDB aborts atomically                     │
    │        no partial writes survive                                        │
    │   _transactions.delete(txId)                                           │
    │                                                                        │
    └── rollback() ──────────────────────────────────────────────────────────┘
             │
            ▼
         ops[] = []  (discard; zero IDB activity — nothing was written)
         _transactions.delete(txId)
```

### Why ops are issued synchronously inside _applyCommit

Native IDB transactions auto-commit the instant their pending request queue drains. If an `await` appears between two `store.put()` calls, the first `put` may drain the queue and trigger an auto-commit before the second `put` is issued. The only safe pattern for batching multiple ops in one transaction is:

1. Issue all `store.put / store.delete / store.clear` requests synchronously in a loop.
2. Then `await idbTransactionDone(nativeTx)` to wait for IDB to commit the full batch.

`_applyCommit` follows this pattern exactly. The `for (const op of ops)` loop issues all requests in a single synchronous pass; `idbTransactionDone` is only awaited after the loop exits.

### No WAL needed

IDB's storage engine provides its own durability guarantees. A committed `readwrite` transaction is durable across process death without any application-level journaling. Crash recovery is entirely IDB's responsibility. This is the primary advantage of IDB over OPFS for transactional workloads.

---

## Indexes vs. full-scan comparison

| Operation | Without indexes | With `by_expires_at` / `by_weight` |
|---|---|---|
| TTL sweep | Full store scan → check `expires_at` in JS | Index cursor bounded by `upperBound(now)` |
| Eviction sort | Load all records → sort in JS | Index cursor yields records in weight order |
| Prefix query | Full store scan | Key cursor bounded by `[prefix, prefix\uffff]` |
| Count | Full store scan | `store.count(range?)` — native, O(log n) |

---

## Eviction: full payloads available to user comparator

Unlike OPFS and CacheStorage — which supply stub envelopes with `payload: ''` to the user comparator to avoid expensive per-file reads — `IDBBackend` supplies full envelopes including the actual payload string. IDB records are already loaded into memory during the `collectByWeight` cursor walk, so there is no additional I/O cost to include the payload in the comparator arguments.

---

## Lifecycle

```
new IDBBackend(config?)
  └── stores config; no I/O

probe()
  -> open a temporary probe DB, write/read/delete a test record
  -> delete the probe DB
  -> { available: true, latency: Nms } or { available: false, reason: '...' }

initialize(signal?)
  1. openDatabase(dbName, storeName)
     -> indexedDB.open(dbName, 1)
     -> onupgradeneeded: createObjectStore + createIndex (x2)
     -> onsuccess: resolve with IDBDatabase
  2. _initialized = true

close()
  -> rollback all pending transactions (buffer discard, no IDB ops)
  -> _readCount.clear()
  -> _db.close()  <- prevents blocking future version upgrades
  -> _initialized = false
  (database and all stored records are NOT deleted)
```

---

## Usage example

```ts
import { IDBBackend } from './backends/indexeddb'

const backend = new IDBBackend({ dbName: 'app-storage' })

const probe = await backend.probe()
if (!probe.available) throw new Error(probe.reason)

await backend.initialize()

// Direct write (payload already encrypted by pipeline)
const key = 'myapp:chrome:130:auth:session' as CanonicalKey
await backend.write(key, {
  payload:        'AES-GCM-ENCRYPTED',
  schema_version: 1,
  written_at:     Date.now(),
  expires_at:     Date.now() + 3_600_000,
  weight:         5,
  backend:        'indexeddb',
})

// Read
const envelope = await backend.read(key)
// envelope.payload === 'AES-GCM-ENCRYPTED'

// Serializable transaction
const tx = await backend.beginTransaction()
try {
  await backend.write(keyA, envelopeA, { transactionId: tx.id })
  await backend.delete(keyB,           { transactionId: tx.id })
  await tx.commit()
  // Both ops committed atomically. If either fails, IDB rolls back both.
} catch {
  await tx.rollback()
  // Buffer discarded; nothing was written to IDB.
}

await backend.close()
```

---

## What this module does NOT do

- **Decrypt or deserialize** — payloads arrive already encrypted and leave still encrypted. The pipeline handles both directions.
- **Validate with Zod** — validation is a pipeline concern.
- **Emit BroadcastChannel change events** — that is a pipeline/facade concern.
- **Select the backend** — the strategy registry makes that decision based on `probe()` results and priority.
- **Crash recovery** — IDB's own durability model handles this. Unlike OPFS, no WAL is written or replayed.
- **Orchestrate caching with Memory** — the pipeline layer orchestrates read-through / write-through caching. This backend knows nothing about other backends.