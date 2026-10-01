# Fixes: libs

> Temporary record of M0 fixes. Delete when the PR is merged.

## `utils.ts`

| Function | Problem | Fix |
|---|---|---|
| `debounce` | After `fn` ran, the timer handle was kept, so `cancel()` returned `true` with nothing pending. | The handle is cleared when the call runs. |
| `debounce`, `throttle` | With a pre-aborted signal, the thrown error did not carry `signal.reason`. | `ReferenceError` has `{ cause: signal.reason }`. |
| `throttle` | `lastRan` started at `0`, contradicting its own comment (`-Infinity`): with a clock at 0 the first call did not fire on the leading edge. `cancel()` reset to `0` too. | Starts and resets at `-Infinity`. |
| `throttle` | A call right after a trailing execution was queued instead of opening a new window. | The leading edge depends on the time since the last **call** (as in lodash), with at most one execution per window. |
| `throttle` | The trailing timer handle was only cleared when trailing args existed. | Always cleared when the timer fires. |

## `duration.ts` (rewritten on `@js-temporal/polyfill`)

Behaviour that was wrong before the rewrite:

| Problem | Fix |
|---|---|
| `isNegative`/`isPositive`/`isZero` used the summed total, against the `IDuration` contract ("any negative field is negative"). | Field-based, via positive/negative Temporal parts. |
| `toISO8601()` (RFC 3339) silently dropped weeks. | Weeks fold into days. |
| A zero duration formatted as `""` despite the "0 seconds" guard. | Formats as "0 seconds" (`secondsDisplay: 'always'`). |
| Month-end arithmetic rolled over (Jan 31 + 1 month = Mar 3). | Constrained by Temporal (Feb 28). |
| Every unit field was an own property set to `undefined`. | Fields are `declare`d; only set fields exist. |
