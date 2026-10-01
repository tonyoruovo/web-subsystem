# OPFS Backend

**Location:** `src/composables/managers/storage/backends/opfs`

The Origin Private File System (OPFS) storage backend. Preferred persistent backend in the fallback chain (priority 0). Designed to run inside a SharedWorker for maximum throughput, with an automatic async fallback for main-thread execution. Uses a write-ahead log (WAL) to provide crash-safe compensating transactions.

---

## Files

| File | Purpose |
|---|---|
| `opfs.types.ts` | All OPFS-specific types: manifest, WAL ops, IO adapter interfaces, config, transaction interface |
| `opfs.io.ts` | `SyncFileIOAdapter` (Worker) and `AsyncFileIOAdapter` (main thread) + factory detection |
| `opfs.utils.ts` | Pure helpers: manifest R/W, WAL R/W/clear, file path derivation, directory pruning, base64 encoding |
| `opfs.ts` | `OPFSBackend` class - implements `IStorageBackend<string>` |
| `transaction.ts` | `OPFSTransaction` - WAL-backed compensating transaction |
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
OPFSBackend  (this module)
  │
  ├─ _manifest: Map<CanonicalKey, ManifestEntry>   <- in-memory index
  ├─ _readCount: Map<CanonicalKey, number>          <- LFU counter
  ├─ _transactions: Map<string, OPFSTransaction>    <- active tx registry
  ├─ _factory: IIOAdapterFactory                   <- sync or async IO
  │
  ├─ NON-TRANSACTIONAL
  │    write()   -> keyToFilePath -> bytesToBase64 -> _applyWrite -> writeManifest
  │    read()    -> _manifest.get -> TTL check -> openDataFile -> decodeBytes
  │    delete()  -> _applyDelete -> writeManifest
  │    clear()   -> prefix scan -> _applyDelete* -> writeManifest
  │    query()   -> manifest scan -> openDataFile per match -> lazy TTL cleanup
  │    evict()   -> Phase 1: TTL sweep -> Phase 2: weight sort -> _applyDelete*
  │    write()   -> keyToFilePath -> bytesToBase64 -> _applyWrite -> writeManifest
  │    read()    -> _manifest.get -> TTL check -> openDataFile -> decodeBytes
  │    delete()  -> _applyDelete -> writeManifest
  │    clear()   -> prefix scan -> _applyDelete* -> writeManifest
  │    query()   -> manifest scan -> openDataFile per match -> lazy TTL cleanup
  │    evict()   -> Phase 1: TTL sweep -> Phase 2: weight sort -> _applyDelete*
  │
  └─ TRANSACTIONAL
       beginTransaction() -> new OPFSTransaction(_commitTransaction, _transactions.delete)
       beginTransaction() -> new OPFSTransaction(_commitTransaction, _transactions.delete)
       write/delete/clear with { transactionId }
         -> tx.bufferWrite / bufferDelete / bufferClear
         -> ops[] grows, zero filesystem activity
         -> tx.bufferWrite / bufferDelete / bufferClear
         -> ops[] grows, zero filesystem activity
       tx.commit()
         -> OPFSBackend._commitTransaction(txId, ops)
         -> OPFSBackend._commitTransaction(txId, ops)
             1. writeWAL(_wal.json)
             2. _applyWALOps(ops) -> files + manifest
             2. _applyWALOps(ops) -> files + manifest
             3. writeManifest(_manifest.json)
             4. clearWAL(_wal.json)
             5. _transactions.delete(txId)
       tx.rollback()
         -> ops[] = [] (discard buffer, zero filesystem changes)
         -> _transactions.delete(txId)
         -> ops[] = [] (discard buffer, zero filesystem changes)
         -> _transactions.delete(txId)
```

---

## On-disk layout

```
navigator.storage  (OPFS origin root)
  └── <rootDirName>/               default: 'storage'
        ├── _manifest.json         in-memory index, rewritten on every mutation
        ├── _wal.json              write-ahead log, cleared after every commit
        └── <domain>/
              └── <platform>/
                    └── <version>/
                          └── <module>/
                                └── <encodedActualKey>   <- raw payload bytes
```

Canonical key `"myapp:chrome:130:auth:user-session"` maps to the file path `myapp/chrome/130/auth/user-session`. If `actualKey` itself contains colons, they are percent-encoded as `%3A` for filesystem safety.

---

## The manifest

The manifest is a `Map<CanonicalKey, ManifestEntry>` loaded entirely into memory at `initialize()`. It holds envelope metadata for every stored entry - everything except the payload itself.

This separation is the most important performance decision in the backend. Operations that do not need payload content - `count()`, prefix-filtered `query()` metadata scans, TTL sweeps, quota estimates, and the first phase of eviction - run entirely against the in-memory Map with zero file I/O. Data files are only opened when a payload is explicitly needed.

The manifest is serialized as a `ManifestWire` (an array of `[key, entry]` tuples, since `JSON.stringify(Map)` produces `{}`) and written as `_manifest.json` in the backend root directory after every successful mutation.

---

## Write-ahead log and crash recovery

The WAL is the mechanism that makes transactions safe across crashes.

### Commit sequence

```
1. writeWAL(_wal.json)          <- crash here: nothing applied; WAL replayed next boot
2. _applyWALOps(ops)            <- crash here: WAL replayed; reach final state
     for each op:
       'write'  -> _applyWrite (file + manifest)
       'delete' -> _applyDelete (file + manifest)
       'clear'  -> _applyClear (files + manifest entries)
3. writeManifest(_manifest.json)<- crash here: WAL replay -> same result
4. clearWAL(_wal.json)          <- crash here: next boot replays; idempotent
5. _transactions.delete(txId)
```

### Crash recovery (at `initialize()`)

Before the manifest is loaded, `_replayWALIfPresent` checks for a non-empty `_wal.json`:

```
readWAL() -> non-null?
readWAL() -> non-null?
  ├── readManifest() into _manifest   (may be stale; WAL has the truth)
  ├── _applyWALOps(wal.ops)           (idempotent - safe to re-apply)
  ├── writeManifest(_manifest.json)   (persist corrected state)
  └── clearWAL(_wal.json)             (signal recovery complete)
  then initialize() reads the now-correct manifest normally
```

All WAL ops are idempotent: writing the same file twice produces the same result; deleting a non-existent file is silently ignored. This guarantees that replaying an already-partially-applied WAL reaches the same final state as if the ops had all applied cleanly the first time.

---

## IO adapter split

The backend runs in two different contexts with different IO capabilities:

| Context | Adapter | Mechanism | Notes |
|---|---|---|---|
| SharedWorker / DedicatedWorker | `SyncFileIOAdapter` | `FileSystemSyncAccessHandle` | Synchronous, exclusive lock per file |
| Main UI thread | `AsyncFileIOAdapter` | `FileSystemWritableFileStream` | Fully async, no persistent lock |

`detectIOAdapterFactory()` probes `typeof window === 'undefined'` and the presence of `createSyncAccessHandle` on `FileSystemFileHandle.prototype` to select the right factory automatically. This can be overridden via `OPFSBackendConfig.context` for testing.

### The exclusive lock constraint (sync adapter)

A `FileSystemSyncAccessHandle` holds an exclusive lock on the file for its entire lifetime. Every helper in `opfs.utils.ts` opens an adapter, performs its operation, and closes it in a `finally` block. A leaked handle (caused by an exception before `close()` is called) will cause all subsequent sync opens of the same file to queue indefinitely. The `finally` pattern in every helper prevents this.

### `SharedArrayBuffer` guard

`FileSystemSyncAccessHandle.write()` and `FileSystemWritableFileStream.write()` both reject views backed by a `SharedArrayBuffer`. `TextEncoder.encode()` may return a `Uint8Array` sharing memory with the encoder's internal buffer in environments where `crossOriginIsolated` is true. Both adapters defensively copy to a plain `ArrayBuffer` before writing.

---

## Transaction strength: compensating

OPFS provides no native multi-file transaction primitive. The WAL gives crash recovery but not isolation - a concurrent reader (e.g., another tab reading from the same OPFS origin) can observe an intermediate state while ops are being applied between steps 2 and 3 of the commit sequence. This is the definition of "compensating" strength.

`beginTransaction()` throws immediately if `'serializable'` is requested. Use IndexedDB for serializable guarantees.

---

## Key design decisions

### `TRaw = string`

`OPFSBackend` is typed `IStorageBackend<string>`. By the time `write(key, envelope)` is called, `envelope.payload` is already an encrypted, serialized string - the pipeline has already run `validate -> serialize -> encrypt`. The backend stores those bytes verbatim and returns them as-is on read. It never knows what the string contains.
`OPFSBackend` is typed `IStorageBackend<string>`. By the time `write(key, envelope)` is called, `envelope.payload` is already an encrypted, serialized string - the pipeline has already run `validate -> serialize -> encrypt`. The backend stores those bytes verbatim and returns them as-is on read. It never knows what the string contains.

### Why payload is not in the manifest

If payload were in the manifest, the manifest file would grow proportionally with stored data size. Reading the manifest at boot would then be O(total data size) in both time and memory. By keeping payload in separate files, boot cost is O(number of entries × metadata size), which is small even for stores with hundreds of entries and large payloads.

### Directory hierarchy from canonical key

Files are stored under a four-level directory hierarchy (`domain/platform/version/module/`) rather than a flat directory. A flat layout would make prefix-filtered queries O(n) directory traversal. The hierarchy means a query prefix like `"myapp:chrome:130:auth:"` maps directly to the directory `myapp/chrome/130/auth/`, which can be read without scanning siblings.

### Read-your-own-writes is not implemented

`read()` ignores `transactionId` - it always reads from committed state. If you write key `A` inside a transaction and then read key `A` within the same transaction before committing, you will not see your uncommitted value. This is a known gap. The fix belongs in the pipeline layer, which will maintain a per-transaction in-memory read buffer and check it before falling through to the backend.

### User eviction comparator receives stub envelopes

When `policy === 'user'`, the custom comparator receives `StorageEnvelope<string>` objects whose `payload` field is an empty string `''`. Loading all payloads just to sort them for eviction would require opening every data file - prohibitively expensive. If your comparator needs payload content, maintain an external index or choose a different policy.

### `_readCount` and LFU eviction

Every successful `read()` increments a counter for that key in an in-memory `Map`. This counter is the tie-breaker when `evict()` is called with `policy: 'lfu'`. It resets to zero on entry overwrite and on page reload (counts are not persisted). LFU is therefore a within-session heuristic, not a long-term access frequency measurement.

---

## Lifecycle

```
new OPFSBackend(config?)
  └── detectIOAdapterFactory() -> SyncIOAdapterFactory (worker) or AsyncIOAdapterFactory (main thread)
  └── detectIOAdapterFactory() -> SyncIOAdapterFactory (worker) or AsyncIOAdapterFactory (main thread)

probe()
  -> write/read/delete a temp file in the OPFS origin root
  -> { available: true, latency: Nms } or { available: false, reason: '...' }
  -> write/read/delete a temp file in the OPFS origin root
  -> { available: true, latency: Nms } or { available: false, reason: '...' }

initialize(signal?)
  1. navigator.storage.getDirectory() -> origin root
  2. getDirectoryHandle(rootDirName, { create: true }) -> _rootDir
  3. _replayWALIfPresent(signal)  <- crash recovery
  4. readManifest(_rootDir) -> _manifest
  5. _initialized = true

close()
  -> rollback all pending transactions
  -> clear _manifest, _readCount, _transactions
  -> _rootDir = null, _initialized = false
  -> rollback all pending transactions
  -> clear _manifest, _readCount, _transactions
  -> _rootDir = null, _initialized = false
  (OPFS files are NOT deleted)
```

---

## Usage example

```ts
import { OPFSBackend } from './opfs'

// Inside a SharedWorker - sync IO auto-detected
const backend = new OPFSBackend({ rootDirName: 'app-storage' })

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
  backend:        'opfs',
})

// Read
const envelope = await backend.read(key)
// envelope.payload === 'AES-GCM-ENCRYPTED-STRING'

// Transactional write
const tx = await backend.beginTransaction()
try {
  await backend.write(keyA, envelopeA, { transactionId: tx.id })
  await backend.delete(keyB,            { transactionId: tx.id })
  await tx.commit()
  // WAL written -> ops applied -> manifest rewritten -> WAL cleared
  // WAL written -> ops applied -> manifest rewritten -> WAL cleared
} catch {
  await tx.rollback()
  // ops[] discarded, zero filesystem changes
}

await backend.close()
```

---

## What this module does NOT do

- **Decrypt or deserialize** - payloads arrive already encrypted and leave still encrypted. The pipeline handles both directions.
- **Validate with Zod** - validation is a pipeline concern.
- **Emit BroadcastChannel change events** - that is a pipeline/facade concern.
- **Select the backend** - the strategy registry in the SharedWorker scheduler makes that decision based on `probe()` results and priority.
- **Orchestrate caching with Memory** - the pipeline layer holds references to both backends and decides when to read-through or write-through to Memory.