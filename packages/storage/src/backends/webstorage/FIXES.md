# Fixes: Web Storage backend

> Temporary record of M0 fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `webstorage.transaction.ts` | `rollback(index)` returned `[]` for an out-of-range index; `ITransaction` requires a one-element tuple. | Returns `[op]` or `[undefined]`. |
