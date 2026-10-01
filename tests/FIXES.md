# Fixes: tests

> Temporary record of M0 fixes. Delete when the PR is merged.

Tests that were wrong, as opposed to the code they test.

| File | Problem | Fix |
|---|---|---|
| `memory.spec.ts` | Mocked a stale path (`@/composables/...`), so the mock never applied and every test shared the real singleton store. | Mocks `@/managers/storage/backends/memory/memory.store`. |
| `memory.spec.ts` | The phase-1 eviction test asserted on a key it never wrote. | Writes the expired entry under that key. |
| `stress.spec.ts` | `vi.doMock` without `vi.resetModules()`: later suites reused the first suite's store (100 leftover entries). | `vi.resetModules()` before each `doMock`. |
| `stress.spec.ts` | The OPFS mock's `getDirectoryHandle()` returned a handle with no methods, so nested paths crashed. | Nesting directory handles. |
| `stress.spec.ts` | The rollback test counted files before and after but never compared them. | Asserts the count is unchanged. |
| `opfs.spec.ts` | The mock's `readAll()` returned a string; `IFileIOAdapter.readAll()` returns bytes. | Returns `Uint8Array`. |
| `opfs.spec.ts` | The mock OPFS origin root was named like the backend's folder, nesting paths as `storage/storage/…`. | Origin root returns the backend root at an empty path. |
| `opfs.spec.ts` | The mock's `truncate()` deleted the file instead of emptying it. | Leaves an empty file. |
| `opfs.spec.ts` | The abort test aborted in a `setTimeout` that ran after every mocked step had finished. | Aborts during the first step; the backend checks between steps. |
| `cache.spec.ts` | Expected `clear()` to delete and reopen the whole cache; `proposals/cache_PROPOSAL.md` specifies prefix scan + per-entry delete. | Asserts every entry is gone. |
| `idb.backend.spec.ts` | Expected a weight-100 entry to survive a 10 MB eviction target; higher weight means evicted **last**, not never. | Target is half the usage, so both phases run but not the whole store. |
| `idb.transaction.spec.ts` | Out-of-range `rollback(index)` tests asserted `[]` (one titled "returns a tuple with undefined"), against `ITransaction`. | Assert `[undefined]`. |
| `transaction.spec.ts` | Constructed `MemoryTransaction` with the removed store argument. | Updated constructor call. |
| `webstorage.spec.ts` | Assigned `DOMException.code`, which is read-only in Node 24 (a `QuotaExceededError` already reports 22). | Assignment removed. |
| `utils.test.ts` | Typeahead test awaited `Promise.all` before advancing fake timers, a deadlock (5 s timeout). | Advances timers, then awaits; asserts only `react` reaches the API. |
| `utils.test.ts` | 21 deliberately rejected promises were left unhandled, which fails the Vitest run. | The tests handle the rejections they cause. |
