# Fixes: memory backend

> Temporary record of M0 fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `memory.ts` | Overwriting a key kept its LFU read count, so a fresh value looked "frequently read". | `write()` (direct and transactional) resets the key's read count. |
| `memory.ts` | `clear()` only checked `signal` inside the key loop, so an already-aborted signal on an empty store was ignored. | Check `signal.throwIfAborted()` before doing any work. |
| `memory.ts` | Eviction phase 2 counted evicted **entries** (`freed++`) while phase 1 counted **bytes**, so `freed` mixed units and the byte target was wrong. | Phase 2 adds `sizeOf(envelope)`, like phase 1. |
| `memory.ts` | The "not initialized" error said "has not been initialized", unlike the other backends. | Same wording as the other backends: `Backend not initialized`. |
| `memory.ts` | The architecture diagram still marked two bugs (unused `_store`, transaction leak) that are fixed. | Diagram updated. |
| `memory.transaction.ts` | The constructor took the store map but never used it (TS6138). | Parameter removed; the commit callback applies ops. |
| `memory.transaction.ts` | A failing commit called `rollback()` on an already-settled transaction, which threw "already settled", lost the original error and never called `onRollback`. | Commit failure discards the buffer and calls `onRollback` directly, then rethrows with `cause`. |
| `memory.transaction.ts` | Partial rollback spliced indices in ascending order, so every splice shifted the rest and the wrong ops were removed. | Splice in reverse order (as the Cache/IDB/WebStorage transactions do). |
| `memory.transaction.ts` | `rollback(index)` returned `[]` for an out-of-range index; `ITransaction` requires a one-element tuple. | Returns `[op]` or `[undefined]`. |
