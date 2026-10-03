# Fixes: `@platform/consent`

> Temporary record of fixes. Delete when the PR is merged.

| File | Problem | Fix |
|---|---|---|
| `EXAMPLES.md` | `consent/share-between-tabs` waited 50 ms for a decision to reach the other tab. In Node on a slow machine, the window transport needed longer, so the example printed `false` (found in M6; it failed at the commit that added it too). | The example waits 500 ms. |
