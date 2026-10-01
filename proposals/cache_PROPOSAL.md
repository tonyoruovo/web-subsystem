# Cache Backend

**Location:** `src/composables/managers/storage/backends/cache`

The CacheStorage storage backend. Tertiary persistent backend in the fallback chain (priority 2), positioned after IndexedDB (0) and OPFS (1). Uses the browser's Cache API to store `StorageEnvelope<string>` values as JSON-bodied synthetic Response objects. Provides best-effort buffered transactions.

---

## Files

| File | Purpose |
|---|---|
| `cache.types.ts` | All cache-specific types: `CacheBackendConfig`, `CacheBufferedOp`, `ICacheTransaction`, `CACHE_KEY_NAMESPACE` |
| `cache.ts` | `CacheBackend` class — implements `IStorageBackend<string>` |
| `cache.transaction.ts` | `CacheTransaction` — best-effort buffered transaction |
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
CacheBackend  (this module)
  │
  ├─ _cache: Cache                        <- open Cache API bucket
  ├─ _index: Map<CanonicalKey, CacheIndexEntry>  <- in-memory metadata mirror
  ├─ _readCount: Map<CanonicalKey, number>       <- LFU counter
  ├─ _transactions: Map<string, CacheTransaction> <- active tx registry
  │
  ├─ NON-TRANSACTIONAL
  │    write()   -> canonicalKeyToURL -> JSON.stringify -> cache.put -> _index.set
  │    read()    -> _index.get -> TTL check -> cache.match -> JSON.parse
  │    delete()  -> cache.delete -> _index.delete
  │    clear()   -> prefix scan -> delete* -> _index sweep
  │    query()   -> _index scan -> cache.match per match -> lazy TTL cleanup
  │    evict()   -> Phase 1: TTL sweep -> Phase 2: weight sort -> delete*
  │
  └─ TRANSACTIONAL
       beginTransaction() -> new CacheTransaction(_applyCommit, _transactions.delete)
       write/delete/clear with { transactionId }
         -> tx.bufferWrite / bufferDelete / bufferClear
         -> ops[] grows, zero Cache API activity
       tx.commit()
         -> CacheBackend._applyCommit(txId, ops)
         -> for each op: cache.put / cache.delete / prefix scan + delete
         -> _transactions.delete(txId)
       tx.rollback()
         -> ops[] = [] (discard buffer, zero Cache API changes)
         -> _transactions.delete(txId)
```

---

## The adaptation problem

The Cache API was designed for HTTP response caching. Its keys are `Request` objects (or URL strings); its values are `Response` objects. Neither maps naturally to the `CanonicalKey → StorageEnvelope` model. `CacheBackend` bridges this with two thin adaptation layers:

### Key adaptation

```
'myapp:chrome:130:auth:user-session'         (CanonicalKey)
                ↓  canonicalKeyToURL()
'https://storage.internal/myapp%3Achrome%3A130%3Aauth%3Auser-session'
```

The canonical key is `encodeURIComponent`-escaped and appended as the path of the `https://storage.internal` origin. The scheme and origin are the `CACHE_KEY_NAMESPACE` constant. Entries stored by this backend are distinguishable from genuine network responses by their namespace prefix.

### Value adaptation

```
StorageEnvelope<string>  ->  JSON.stringify  ->  new Response(json, { headers: {...} })
```

On write, the entire `StorageEnvelope<string>` is JSON-serialized and stored as the text body of a synthetic `Response` with `Content-Type: application/json`. On read, `response.text()` followed by `JSON.parse` reconstructs the envelope. The pipeline layer is responsible for encryption/decryption; by the time the envelope reaches this backend, `payload` is already an opaque encrypted string.

---

## In-memory index

```
_index: Map<CanonicalKey, CacheIndexEntry>
```

The Cache API provides no way to inspect entry metadata without fetching the full Response body. This makes prefix-filtered queries, TTL checks, `count()`, and eviction candidate sorting prohibitively expensive if done naively.

`CacheBackend` solves this by maintaining an in-memory index that mirrors lightweight metadata for every stored entry:

```ts
interface CacheIndexEntry {
  schema_version: number
  written_at:     number
  expires_at:     number | null
  weight:         number
  backend:        BackendKind
}
```

**Invariant**: the index mirrors the live cache on every mutation. `write()` calls `_index.set`; `delete()` and `clear()` call `_index.delete`. If a cache entry disappears without an index update (browser-initiated eviction), the next `read()` or `query()` that hits the stale index entry will find a `null` from `cache.match()` and self-heal by removing the orphaned index entry.

### Index at boot

`initialize()` rebuilds the index by iterating `cache.keys()` and fetching each Response body once. This is O(n) over the number of stored entries and is the only time a full scan is required.

---

## Transaction model: best-effort

Unlike OPFS (which writes a WAL before applying ops), `CacheBackend` uses simple op buffering:

```
beginTransaction()
    │
   ▼
CacheTransaction created (ops = [])
    │
write/delete/clear called with transactionId
    │
   ▼
bufferWrite / bufferDelete / bufferClear
-> ops[] grows; zero Cache API activity
    │
    ├── commit() ─────────────────────────────────────────────────────┐
    │        │                                                        │
    │       ▼                                                         │
    │   _applyCommit(txId, ops)                                       │
    │        │  for each op:                                          │
    │        │    'write'  -> cache.put + _index.set                  │
    │        │    'delete' -> cache.delete + _index.delete            │
    │        │    'clear'  -> prefix scan + delete* + _index.delete*  │
    │        │  _transactions.delete(txId)                            │
    │                                                                 │
    └── rollback() ──────────────────────────────────────────────── ──┘
             │
            ▼
         ops.length = 0  (discard buffer; nothing to undo)
         _transactions.delete(txId)
```

**There is no WAL.** If the process dies mid-commit (after some ops have been applied to the cache but before others), the cache is left in a partially applied state. On next `initialize()`, the index is rebuilt from whatever entries the cache still holds — a self-healing but non-atomic recovery approach. This is the honest definition of `'best-effort'` strength.

`beginTransaction('serializable')` and `beginTransaction('compensating')` both throw immediately. Use IndexedDB for serializable guarantees or OPFS for WAL-backed compensating transactions.

---

## What happens when the browser evicts entries

CacheStorage buckets can be evicted under origin-level storage pressure in some browsers, though explicit named caches are given lower eviction priority than opaque cross-origin caches in Chromium. When entries disappear without `delete()` being called:

1. `_index` still holds the stale entry.
2. The next `read()` or `query()` for that key calls `cache.match()`, which returns `null`.
3. The stale index entry is removed; the method returns `null` to the caller.

This is the same self-healing behavior described above. The cache is the source of truth; the index is a derived view.

---

## Private browsing

CacheStorage is unavailable in Firefox private mode (throws `SecurityError` on `caches.open()`). `probe()` catches this and returns `{ available: false, reason: '...' }`, causing the strategy registry to skip this backend and fall through to the next option in the fallback chain.

---

## maxEntries

The `maxEntries` config option provides an application-level entry count limit. The Cache API itself enforces no such limit. When a `write()` or transaction commit pushes the entry count over `maxEntries`:

1. Expired entries are swept first (free eviction pass).
2. If still over the limit, entries are sorted by `written_at` ascending (LRU) and deleted until the count is back at or below `maxEntries`.

This is a convenience feature for bounded caches (e.g., a "last 100 API responses" store). For quota-pressure eviction, the eviction manager calls `evict(targetBytes, policy)` directly.

---

## Lifecycle

```
new CacheBackend(config?)
  └── stores config; no I/O

probe()
  -> open a temp probe cache, put/match/delete a test entry
  -> { available: true, latency: Nms } or { available: false, reason: '...' }

initialize(signal?)
  1. caches.open(cacheName) -> _cache
  2. _cache.keys() -> iterate all Request objects
  3. cache.match + JSON.parse each -> populate _index
  4. _initialized = true

close()
  -> rollback all pending transactions
  -> clear _index, _readCount, _transactions
  -> _cache = null, _initialized = false
  (cache bucket and its entries are NOT deleted)
```

---

## Usage example

```ts
import { CacheBackend } from './backends/cache'

const backend = new CacheBackend({ cacheName: 'app-storage', maxEntries: 500 })

const probe = await backend.probe()
if (!probe.available) throw new Error(probe.reason)

await backend.initialize()

// Direct write (payload is already an encrypted string from the pipeline)
const key = 'myapp:chrome:130:auth:session' as CanonicalKey
await backend.write(key, {
  payload:        'AES-GCM-ENCRYPTED-STRING',
  schema_version: 1,
  written_at:     Date.now(),
  expires_at:     Date.now() + 3_600_000,
  weight:         5,
  backend:        'cache',
})

// Read
const envelope = await backend.read(key)
// envelope.payload === 'AES-GCM-ENCRYPTED-STRING'

// Transactional write
const tx = await backend.beginTransaction()
try {
  await backend.write(keyA, envelopeA, { transactionId: tx.id })
  await backend.delete(keyB,           { transactionId: tx.id })
  await tx.commit()  // ops applied sequentially to the cache
} catch {
  await tx.rollback()  // buffer discarded, zero cache changes
}

await backend.close()
```

---

## What this module does NOT do

- **Decrypt or deserialize** — payloads arrive already encrypted and leave still encrypted. The pipeline handles both directions.
- **Validate with Zod** — validation is a pipeline concern.
- **Emit BroadcastChannel change events** — that is a pipeline/facade concern.
- **Select the backend** — the strategy registry in the SharedWorker scheduler makes that decision based on `probe()` results and priority.
- **Orchestrate caching with Memory** — when Memory acts as a cache above this backend, the pipeline layer makes that decision and calls both backends in the right order. This backend knows nothing about the existence of other backends.
- **Crash recovery** — there is no WAL; the index is rebuilt from the cache at next `initialize()`.