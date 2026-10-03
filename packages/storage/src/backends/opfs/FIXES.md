# Fixes: OPFS backend

> Temporary record of M0 fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `opfs.transaction.ts` | `if (!token)` treated `rollback(0)` as a **full** rollback, because `0` is falsy: it settled the transaction and discarded every op. | `token === undefined` decides a full rollback. |
| `opfs.transaction.ts` | Partial rollback spliced indices in ascending order, removing the wrong ops. | Splice in reverse order. |
| `opfs.transaction.ts` | `rollback(index)` did not return the one-element tuple `ITransaction` requires. | Returns `[op]` or `[undefined]`. |
| `opfs.ts`, `opfs.io.ts` | `lockTimeoutMs` was documented ("prevents indefinite blocking") but never used (TS6133): opening a locked file waited forever. | `SyncIOAdapterFactory` takes the timeout and rejects with a `TimeoutError` `DOMException`. A handle that arrives after the timeout is closed, so the lock is not leaked. `detectIOAdapterFactory()` passes it through. |
| `opfs.ts` | A failed mid-commit rethrow dropped the original error. | Rethrown with `cause`. |
| `opfs.ts`, `opfs.types.ts` | (M6) A write copied only the fixed envelope fields into the manifest entry, so `envelope.integrity` (the HMAC tag of an encrypted entry) was lost, and every encrypted entry read as corrupt. Found by `packages/storage/test/storage.spec.ts`. | The manifest entry keeps `integrity`, and a read and a query return it. |
