# Fixes: tests

> Temporary record of M0 fixes. Delete when the PR is merged.

Tests that were wrong, as opposed to the code they test.

| File | Problem | Fix |
|---|---|---|
| `utils.test.ts` | Typeahead test awaited `Promise.all` before advancing fake timers, a deadlock (5 s timeout). | Advances timers, then awaits; asserts only `react` reaches the API. |
| `utils.test.ts` | 21 deliberately rejected promises were left unhandled, which fails the Vitest run. | The tests handle the rejections they cause. |
