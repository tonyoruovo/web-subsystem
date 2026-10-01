# Fixes: IndexedDB backend

> Temporary record of M0 fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `idb.backend.ts` | Without the StorageManager API (`navigator.storage`), `estimateQuota()` reported `used: 0` no matter how much was stored, so any eviction target derived from it was 0 and nothing was evicted. | The fallback measures this store's own records. |
| `idb.transaction.ts` | `rollback(index)` returned `[]` for an out-of-range index; `ITransaction` requires a one-element tuple. | Returns `[op]` or `[undefined]`. |
