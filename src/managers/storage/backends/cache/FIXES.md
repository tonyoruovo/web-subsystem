# Fixes: Cache backend

> Temporary record of M0 fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `cache.ts` | Error wording differed from the tested contract ("is not defined", "only offers"). | "is not available in this context"; "supports only \"best-effort\" transactions". |
| `cache.transaction.ts` | `rollback(index)` returned `[]` for an out-of-range index; `ITransaction` requires a one-element tuple. | Returns `[op]` or `[undefined]`. |
