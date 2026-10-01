# WebStorage Backends

**Location:** `src/composables/managers/storage/backends/webstorage`

Two concrete storage backends — `LocalStorageBackend` and `SessionStorageBackend` — sharing a single abstract implementation (`WebStorageBackend`). Both implement `IStorageBackend<string>` against the browser's synchronous Web Storage API (`localStorage` / `sessionStorage`). They are tertiary and quaternary fallbacks in the chain, used when IndexedDB, OPFS, and CacheStorage are all unavailable.

---

## Files

| File | Purpose |
|---|---|
| `webstorage.types.ts` | Shared types: `WebStorageKind`, `WebStorageConfig`, `WebStorageBufferedOp`, `WebStorageSnapshot`, `IWebStorageTransaction` |
| `webstorage.backend.ts` | `WebStorageBackend` abstract class — full implementation of `IStorageBackend<string>` |
| `webstorage.transaction.ts` | `WebStorageTransaction` — snapshot-backed compensating transaction |
| `localstorage.backend.ts` | `LocalStorageBackend` — injects `window.localStorage` |
| `sessionstorage.backend.ts` | `SessionStorageBackend` — injects `window.sessionStorage` |
| `index.ts` | Barrel export |

---

## Why one abstraction for two backends

`localStorage` and `sessionStorage` expose an identical synchronous API: `setItem`, `getItem`, `removeItem`, `key(index)`, `length`. Every behaviour this module needs — CRUD, prefix-filtered queries, compensating transactions with snapshot rollback, `QuotaExceededError` recovery, eviction — is expressible against the generic `Storage` interface without knowing which concrete object lies beneath it.

```
WebStorageBackend (abstract)
  │  constructor(storage: Storage, kind: WebStorageKind, config)
  │  all methods delegate to this._storage
  │
  ├── LocalStorageBackend
  │     super(window.localStorage,  'localstorage',  config)
  │     priority = 3
  │
  └── SessionStorageBackend
        super(window.sessionStorage, 'sessionstorage', config)
        priority = 4
```

The only code in each concrete subclass is the constructor and the `priority` field. Every other line of logic is in `WebStorageBackend`.

---

## Architecture

```
CALLER
  │  storage.set / storage.get / storage.transaction
  ▼
FACADE  [pipeline layer — not in this module]
  │  resolves canonical key, validates, serializes, encrypts
  ▼
PIPELINE  [pipeline layer — not in this module]
  │  wraps encrypted string in StorageEnvelope<string>, calls backend
  ▼
WebStorageBackend  (this module)
  │
  ├─ _storage: Storage                               <- localStorage or sessionStorage
  ├─ _prefix:  string                                <- key namespace ('__storage__')
  ├─ _recovery: 'ttl-then-lru' | 'none'             <- QuotaExceededError policy
  ├─ _transactions: Map<string, WebStorageTransaction> <- active tx registry
  ├─ _readCount: Map<CanonicalKey, number>           <- LFU counter
  │
  ├─ NON-TRANSACTIONAL
  │    write()   -> JSON.stringify(envelope) -> _setItem(prefixedKey, json)
  │    read()    -> storage.getItem -> JSON.parse -> TTL check -> return
  │    delete()  -> storage.removeItem(prefixedKey)
  │    clear()   -> _ownKeys(prefix) -> removeItem* per matching key
  │    query()   -> _ownKeys(prefix) -> parse + filter schema_version + TTL
  │    count()   -> _ownKeys(prefix) -> count
  │    evict()   -> Phase 1: TTL sweep -> Phase 2: weight sort -> removeItem*
  │
  └─ TRANSACTIONAL
       beginTransaction() -> new WebStorageTransaction(storage, _applyCommit, _onRollback)
       write/delete/clear with { transactionId }
         -> tx.snapshotKey(storageKey, storage.getItem(storageKey))  // first-write-wins
         -> tx.bufferWrite / bufferDelete / bufferClear              // no Storage mutation
       tx.commit()
         -> _applyCommit(txId, ops)
         -> for each op: setItem / removeItem / prefix scan + removeItem
         -> _transactions.delete(txId)
       tx.rollback()
         -> for each (storageKey, priorValue) in snapshot:
              priorValue !== null -> setItem(storageKey, priorValue)  // restore
              priorValue === null -> removeItem(storageKey)            // was absent
         -> ops.length = 0, _transactions.delete(txId)
```

---

## Key-space layout

Every canonical key is stored under a prefixed storage key:

```
storage key = `${keyPrefix}${canonicalKey}`
e.g.  '__storage__myapp:chrome:130:auth:user-session'
              ↑ prefix ↑   ↑────────── canonical key ──────────↑
```

The prefix ensures co-existence with other code that writes directly to `localStorage` on the same origin. All scanning operations (`query`, `count`, `clear`, `evict`) iterate only keys that begin with the prefix. Entries from other libraries are never touched.

Prefix isolation is per-backend-instance: two `LocalStorageBackend` instances with different `keyPrefix` values are independent namespaces within the same `localStorage` object.

---

## Data format

Values are stored as plain JSON strings:

```
StorageEnvelope<string>  →  JSON.stringify  →  storage.setItem(key, json)
```

The envelope's `payload` field is an already-encrypted, already-serialized string from the pipeline layer. This backend never inspects or transforms it. On read, `JSON.parse` reconstructs the envelope and the payload is returned as-is.

---

## Transaction model: compensating

The Web Storage API has no native transaction primitive. `WebStorageBackend` implements a snapshot-and-restore compensating model:

```
beginTransaction()
    │
   ▼
WebStorageTransaction created   ops = [],  snapshot = Map{}
    │
For each mutating call with transactionId:
  1. tx.snapshotKey(storageKey, storage.getItem(storageKey))
     ← recorded only once per key (first-write-wins for snapshot)
     ← captures the pre-transaction value before any mutation
  2. tx.bufferWrite / bufferDelete / bufferClear
     ← no Storage.setItem / removeItem occurs here
    │
    ├── tx.commit() ──────────────────────────────────────────────────────────┐
    │        │                                                                │
    │       ▼                                                                 │
    │   _applyCommit(txId, ops)                                               │
    │   for each op (in buffer order):                                        │
    │     'write'  -> storage.setItem(prefixedKey, json)                      │
    │     'delete' -> storage.removeItem(prefixedKey)                         │
    │     'clear'  -> iterate _ownKeys(prefix) + removeItem each              │
    │   _transactions.delete(txId)                                            │
    │                                                                         │
    └── tx.rollback() ────────────────────────────────────────────────────────┘
             │
            ▼
         for each (storageKey, priorValue) in snapshot:
           priorValue !== null  →  storage.setItem(storageKey, priorValue)
           priorValue === null  →  storage.removeItem(storageKey)
         ops = [], _transactions.delete(txId)
```

### What "compensating" means here

The snapshot captures the value of each key immediately before the first transaction op touches it. Because all ops are buffered and no Storage mutations happen until `commit()`, the snapshot always reflects the genuine pre-transaction state. On rollback, those prior values are restored synchronously in a single JS turn — no async activity required.

There is no WAL. If the process dies mid-commit (after some `setItem` calls have executed but before others), the Storage object is left in a partially applied state. There is no automatic recovery on the next page load — the data reflects whatever committed before the crash. This is the honest definition of `'compensating'` strength.

`beginTransaction('serializable')` is rejected immediately. Use IndexedDB for serializable guarantees.

### Partial rollback

Both `WebStorageTransaction.rollback(token)` overloads support selective op removal without settling the transaction. Five token forms are available:

| Token | Effect |
|---|---|
| *(none)* | Full rollback — restores snapshot, settles transaction |
| `number` | Removes the op at that zero-based index |
| `CanonicalKey` | Removes all ops whose `key` field equals the argument |
| `ICanonicalKeySegments` | If `actualKey` is set, delegates to key overload; otherwise removes all ops whose key starts with the module prefix |
| `ITxOpPredicate` | Removes all ops for which the predicate returns truthy |

Partial rollbacks do NOT restore the snapshot. They are purely in-memory buffer mutations — no Storage interaction. Because no ops have been committed yet, there is nothing to undo.

---

## QuotaExceededError recovery

`localStorage` is typically capped at 5–10 MB per origin. `setItem` throws `QuotaExceededError` (`DOMException` code 22) when the limit is reached. The backend handles this via a configurable recovery policy:

```
storage.setItem(key, json) throws QuotaExceededError
  │
  ├── policy === 'none'
  │     └── rethrow immediately
  │
  └── policy === 'ttl-then-lru' (default)
        │
        ├── Pass 1: TTL sweep
        │     iterate _ownKeys() → removeItem all expired entries
        │     retry setItem
        │     success → done
        │
        └── Pass 2: LRU eviction
              sort remaining entries by written_at ascending (oldest first)
              removeItem until estimated freed bytes >= value byte size
              final retry setItem
              still fails → rethrow
```

The recovery pass targets only this backend's own keys (prefix-scoped). It never touches entries written by other consumers of `localStorage`.

Recovery is attempted exactly once, with at most two retries of `setItem`. All other errors from `setItem` (not `QuotaExceededError`) propagate immediately without recovery.

---

## Key-scanning: `_ownKeys()`

Web Storage provides no prefix-scan primitive. The only enumeration API is `Storage.key(index)` for `index` in `[0, length)`. `_ownKeys()` takes a snapshot of all keys at the start of iteration (to guard against mutations during the loop) and yields only those that start with the backend's prefix:

```ts
private *_ownKeys(canonicalPrefix?: string): Iterable<{ canonicalKey, storageKey }> {
  // Snapshot keys first to prevent concurrent-modification issues
  const snapshot: string[] = []
  for (let i = 0; i < this._storage.length; i++) {
    const k = this._storage.key(i)
    if (k !== null) snapshot.push(k)
  }
  for (const storageKey of snapshot) {
    const canonicalKey = this._fromStorageKey(storageKey)
    if (canonicalKey === null) continue               // not our prefix
    if (canonicalPrefix && !canonicalKey.startsWith(canonicalPrefix)) continue
    yield { canonicalKey, storageKey }
  }
}
```

This is O(totalStorageEntries) for the outer scan but bounded by this backend's own entry count for filtering. For a well-managed `localStorage` with a few hundred entries the cost is negligible.

---

## Quota estimation

`localStorage` quota is not programmatically queryable. `navigator.storage.estimate()` does not include `localStorage` usage in its figures. The `estimateQuota()` method therefore approximates usage by summing the UTF-16 byte length of all own keys and values:

```
used = Σ (storageKey.length + rawJson.length) × 2   [UTF-16 overhead]
```

A 5 MB soft cap is used as the denominator for the `ratio` field. Actual browser quotas vary (5–10 MB) and are not inspectable. This estimate is directionally correct and sufficient for the quota manager's eviction trigger logic.

---

## Eviction

Eviction runs in two phases, matching the pattern used by every other backend:

### Phase 1 — Free TTL sweep

Iterates all own keys. For each entry whose `expires_at < Date.now()`, calls `removeItem` immediately. If the bytes freed in this phase satisfy `targetBytes`, eviction stops here.

### Phase 2 — Weighted eviction

Collects all remaining (non-expired) entries, parses their JSON envelopes, and sorts ascending by `weight`. Tie-breaking by `policy`:

| Policy | Tie-break logic |
|---|---|
| `lru` | Oldest `written_at` first |
| `fifo` | Oldest `written_at` first (identical to LRU for this backend) |
| `lfu` | Lowest `_readCount` first (in-session only; resets on reload) |
| `user` | Custom `comparator` function |

Unlike OPFS and CacheStorage — which pass stub envelopes with `payload: ''` to the user comparator — `WebStorageBackend` passes the full envelope including the actual payload string. Since JSON parsing is already required to iterate the store, there is no additional I/O cost to include the payload.

Byte estimation uses `(storageKey.length + rawJson.length) × 2` (UTF-16), matching `estimateQuota()`.

---

## localStorage vs. sessionStorage — when to use each

| Property | `LocalStorageBackend` | `SessionStorageBackend` |
|---|---|---|
| Priority | 3 | 4 |
| Persistence | Survives tab/window/browser close | Cleared on tab close |
| Scope | Shared across all tabs (same origin) | Tab-isolated |
| Private browsing | Unavailable in Firefox (SecurityError) | Available everywhere |
| Cross-tab writes | Via `storage` event | Not possible |
| Best for | Persistent preferences, tokens | Ephemeral wizard state, per-tab auth |

`SessionStorageBackend` is preferred over `LocalStorageBackend` in the fallback chain when the stored data should not persist across browser sessions or when tab-isolation is a requirement. It is also the correct fallback when `localStorage` is unavailable in Firefox private browsing mode.

---

## Lifecycle

```
new LocalStorageBackend(config?)
  └── super(window.localStorage, 'localstorage', config)
        ← window.localStorage access happens here
        ← may throw SecurityError in Firefox private mode / sandboxed iframes

probe()
  -> storage.setItem('__prefix____probe__', 'probe')
  -> storage.getItem(probeKey) === 'probe' ?
  -> storage.removeItem(probeKey)
  -> { available: true, latency: Nms } or { available: false, reason: '...' }

initialize(signal?)
  -> signal?.throwIfAborted()
  -> _initialized = true   (no async work)

close()
  -> rollback all pending transactions (snapshot restore + buffer discard)
  -> _readCount.clear()
  -> _initialized = false
  (Storage entries are NOT deleted)
```

`close()` does not delete any stored entries. Data written to `localStorage` persists across `close()` / `initialize()` cycles and across page reloads. Data written to `sessionStorage` persists only until the tab is closed.

---

## Usage example

```ts
import { LocalStorageBackend }   from './backends/webstorage'
import { SessionStorageBackend } from './backends/webstorage'

// localStorage — persists across sessions
const ls = new LocalStorageBackend({ keyPrefix: 'myapp__' })

const probe = await ls.probe()
if (!probe.available) throw new Error(probe.reason)

await ls.initialize()

const key = 'myapp:chrome:130:auth:session' as CanonicalKey
await ls.write(key, {
  payload:        'AES-GCM-ENCRYPTED',
  schema_version: 1,
  written_at:     Date.now(),
  expires_at:     Date.now() + 3_600_000,
  weight:         5,
  backend:        'localstorage',
})

const envelope = await ls.read(key)
// envelope.payload === 'AES-GCM-ENCRYPTED'

// Compensating transaction
const tx = await ls.beginTransaction()
try {
  await ls.write(keyA, envelopeA, { transactionId: tx.id })
  await ls.delete(keyB,           { transactionId: tx.id })
  await tx.commit()  // ops applied; prior values were snapshotted
} catch {
  await tx.rollback()  // snapshot restored; Storage is back to pre-tx state
}

// sessionStorage — tab-isolated, cleared on close
const ss = new SessionStorageBackend()
await ss.initialize()
await ss.write(wizardKey, stepEnvelope)

await ls.close()
await ss.close()
```

---

## What this module does NOT do

- **Decrypt or deserialize** — payloads arrive already encrypted and leave still encrypted. The pipeline handles both directions.
- **Validate with Zod** — validation is a pipeline concern.
- **Emit BroadcastChannel change events** — that is a pipeline/facade concern.
- **Select the backend** — the strategy registry makes that decision based on `probe()` results and priority.
- **Crash recovery** — there is no WAL. Data reflects whatever was committed before any crash. The next `initialize()` reads the storage as-is with no recovery pass.
- **Orchestrate caching with Memory** — the pipeline layer orchestrates read-through / write-through caching. This backend knows nothing about other backends.