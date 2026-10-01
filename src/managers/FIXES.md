# Fixes: managers

> Temporary record of M0 fixes. Delete when the PR is merged.
> Storage backend fixes are listed in each backend's own `FIXES.md`.

| File | Problem | Fix |
|---|---|---|
| `network/network.manager.ts` | The `warn` option was accepted and stored but never used (TS6133). A `network-first` request that failed and served stale cached data did so silently. | Serving a cached response after a network failure now warns through the sink. |
| `platform.ts` | The platform did not give the Network manager the Logger, unlike Storage. | `NetworkManager` warns through `logger.log('WARN', …)`. |
| `translation/translation.manager.ts` | The `makeId` option was accepted but never used (TS6133); nothing in the manager needs an id yet. | Option, field and helper removed. Packet ids come from the kernel when Translation is ported (M9). |
