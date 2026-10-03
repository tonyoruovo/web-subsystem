# Week 40 report: 2026-09-28 to 2026-10-04

**Branch:** `staging` on [tonyoruovo/web-subsystem](https://github.com/tonyoruovo/web-subsystem). **Version:** `0.0.2` (pre-alpha, not published).

This report brings you up to date on the work of this week. The work started on 2026-10-01 and has 71 commits. This version of the report includes milestone M6 and the runnable examples (updated 2026-10-03). Read the summary first, then the sections that apply to your work.

## Summary

- We agreed an architecture and a plan before we wrote code. The documents are `docs/ARCHITECTURE.md` and `docs/PLAN.md`.
- We completed milestones M0 to M6 of eleven (M0 to M10). Each milestone has a gate test, and every gate passes.
- The kernel (`@platform/core`) and eight subsystem packages are built: Global State, Queue, Notification Center, Logger, Consent, the Window-scope hub, Crypto and Storage.
- M6 added the data foundation. Crypto keeps non-extractable keys in IndexedDB. Storage keeps data in collections, through one coordinator in a shared worker. The details are in [Crypto and Storage (M6)](#crypto-and-storage-m6).
- Functions can now cross worker boundaries as portable functions, so a migration or a filter can run in the worker.
- Every source folder has an `EXAMPLES.md` with runnable examples (67 examples in 16 files). A doc compiler can turn them into code sandboxes. A script runs each one and compares its output.
- A spike found that Safari and all iOS browsers partition the cross-subdomain hub. We changed the design (amendment A11). The details are in [Window scope across subdomains](#window-scope-across-subdomains).
- Every public member of every interface and class now has its own TSDoc block. A script enforces this rule.
- All prose now uses ASD-STE100 Simplified Technical English (STE). This report also uses it.

## Where to start reading

| Read this | To learn |
|---|---|
| [`README.md`](../../../README.md) | The purpose of the project, the packages and the status |
| [`proposals/README.md`](../../../proposals/README.md) | The original definitions. This document has precedence over all others. |
| [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) | The design. §15 lists amendments A1 to A11. §17 is the M4 retrospective. §8.7, §8.8 and §18 are the M6 design. |
| [`docs/PLAN.md`](../../PLAN.md) | The milestones, their gates, and the working principles |
| `packages/<name>/README.md` | How to use each package |
| `packages/<name>/src/**/EXAMPLES.md` | Runnable examples for each source folder |
| [`docs/EXAMPLES-FORMAT.md`](../../EXAMPLES-FORMAT.md) | The format of the examples, for authors and for the doc compiler |
| [`spikes/m5-hub/FINDINGS.md`](../../../spikes/m5-hub/FINDINGS.md) | The browser test that changed Window scope |

## Decisions made this week

| Topic | Decision |
|---|---|
| Send rule | Scope limits apply to broadcasts only. A 1-to-1 request can go to any scope, and its reply always returns. (A1) |
| Window scope | It spans the subdomains of one site, through a hub page on the apex domain. Where a browser partitions the hub, the Global transport relays. (A2, A11) |
| Global scope | It is server-backed. The project ships only the wire protocol, not a server. (A3) |
| Tracing | Tabs and devices join trails by `traceId`. Receivers do not send fingerprints back. (A4) |
| Unit model and lifecycle | Subsystems and features share one `Unit` model and one lifecycle. The lifecycle includes `DEGRADED` and `SUSPENDED`. (A5 to A9) |
| Queue | All packets enter through the Queue. The Notification Center routes broadcasts and holds no queue. (A10) |
| Platforms | Desktop browsers, and Android and iOS browsers. In-app WebViews are out of scope. Minimum versions are in ARCHITECTURE §1.1. |
| Frameworks | The core is framework-agnostic. A Vue adapter comes first (M10). A React adapter comes later. |
| Package scope | `@platform` is a placeholder until M9. |
| Version | The version stays `0.0.2`. Milestone gates do not change it. A release comes only after M10 and an alpha test in real React, Vue, Svelte and Astro projects. |
| CI | GitHub Actions is deferred. Run `pnpm check` on your machine before you push. |
| Documentation | Every package has a README. Every source folder has an `EXAMPLES.md`. Every public member has its own TSDoc block. All prose uses STE. |
| Functions across workers | A processor can get functions from its caller as portable functions (source text, rebuilt in the worker). They must be self-contained. Under a strict CSP, the worker refuses and the work runs on the main thread. |
| Storage pipeline | The Storage coordinator runs the full pipeline (serialize, compress, encrypt, migrate). The caller validates with the full schema in its own realm. |
| Storage hosts | Shared worker, then main thread. No dedicated worker, because it would add a writer for no gain. |
| Crypto and Storage keys | Storage opens the key store of Crypto itself. Both use the same keys and the same token format, with no message between them. |

## Milestones

| Milestone | Content | Gate |
|---|---|---|
| M0 | Tooling: pnpm workspace, TypeScript 7 with TypeScript 6 for lint, ESLint 10, Vitest 4, Playwright browser matrix | Type-check, lint and tests pass |
| M1 | The kernel: units, lifecycle, state, views, dependencies, packets, scopes, wire protocol, test platform | 100% coverage of the lifecycle and the dependency graph |
| M2 | Processors and hosts: shared worker, dedicated worker and main thread, with failover | One processor runs on all three hosts in real browsers. Each failover trigger is tested. |
| M3 | Global State, Queue and Notification Center | The 1-to-1 and 1-to-many flows run end to end with complete fingerprint trails |
| M4 | Pilot subsystems: Logger and Consent, and a retrospective | Both are ported, the old classes are deleted, and the kernel changes are merged |
| M5 | Window scope: the hub, the client and the transport. Consent moves to Window scope. | A broadcast from `a.<site>` reaches `b.<site>` in real browsers, and a foreign origin is refused |
| M6 | Crypto and Storage. Processor configuration and portable functions in the kernel. Dead letters and log entries persist. | The shared worker dies during a write, and no data is lost |

The next milestones are M7 (Network, Auth, Sync, Realtime), M8 (Global scope), M9 (Translation, Settings, Analytics, Design System) and M10 (orchestrator, Vue adapter, scaffolder).

## The packages

All packages are in `packages/`. Each one has a README and tests.

| Package | What it does |
|---|---|
| `@platform/core` | The kernel. It runs the lifecycle of each unit, checks dependencies, moves packets, and runs processors in workers or on the main thread. It also has `@platform/core/testing` and `@platform/core/worker`. |
| `@platform/global-state` | Finds the platform status (`INITIALIZING`, `IDLE`, `BUSY`, `DEGRADED`) from the lifecycles of all units. It tracks pending work, admission, the online and visible states, and the tab identity. |
| `@platform/queue` | The packet router of the kernel. It does admission, priorities, ordering keys, retries with backoff, dead letters, and the intake of broadcasts from other tabs. |
| `@platform/notification` | Routes broadcasts. It has an event registry with access control, subscriptions, a circuit breaker for each subscriber, a history, and scope relays. |
| `@platform/logger` | Keeps log entries with sanitized context and level filters. It records every packet trail, and joins trails and entries by `traceId`. |
| `@platform/consent` | Records consent decisions for each category under a policy version, and gates telemetry. It fails closed. All tabs of a site share the decisions. |
| `@platform/hub` | Window scope: the hub page for the apex, the client in each tab, partition detection, and the `window` transport subsystem. |
| `@platform/crypto` | Keys and the operations that use them: AES-GCM encryption, HMAC tags, ECDSA signatures, digests, rotation and crypto-shredding. Keys persist in IndexedDB and cannot be read. |
| `@platform/storage` | Collections over IndexedDB, OPFS, Cache, Web Storage and memory. Validation, encryption, compression, migrations, batches, change events in every tab, a quota monitor, and the kernel persistence adapter. |

The old code in `src/managers` stays until each subsystem is ported. The old Logger, Consent, Crypto and Storage code is deleted. The old Global State, Queue and Notification managers are still in `src/managers`.

## How a packet moves

```text
  subsystem: ctx.port.send(...) or ctx.port.request(...)
     |
     v
  Queue (router)        send rule, admission (Global State), depth limit,
     |                  priority tiers, ordering keys, retries, dead letters
     |
     +-- request -----> kernel.deliver --> target receive() --> reply
     |
     +-- broadcast ---> Notification Center fan-out --> each subscriber
                             |
                             +-- Window scope --> scope relay --> hub (and the Global relay where needed)
                                                                    |
  other tab: hub --> Window transport --> Queue.ingest --> fan-out in that tab
```

Every step adds a fingerprint to the trail of the packet. The Queue and the Notification Center push each record to observers, and the Logger keeps them.

## Window scope across subdomains

Window scope must reach all tabs of one site, for example `a.example.com` and `b.example.com`. These are different origins, so the design puts a hub page on the apex (`example.com`) and frames it from each subdomain.

The plan required a spike before we built the hub. The spike tested real browsers with Playwright:

- Chrome, Edge and Chromium give all framed copies of the hub one partition. The design works.
- WebKit partitions the `BroadcastChannel`, IndexedDB and `SharedWorker` of the hub by the top-level origin. Safari and every iOS browser use WebKit. On these browsers, the hub cannot join `a.` and `b.`.
- Firefox did not run on the development machine. Firefox keys partitions by site, so we expect it to behave like Chrome. This is not verified.

The product owner chose the "hub plus server fallback" design (amendment A11):

1. The client finds out if the hub is shared. It compares a random partition id through a session cookie on the apex domain.
2. While the hub is not known to be shared, the client also sends Window broadcasts through a relay. The relay is the Global transport, which comes in M8.
3. Receivers drop repeats by `messageId`.
4. The client reports its reach: `site`, `origin` or `unknown`.

Until M8 delivers the relay, Window scope on Safari and iOS reaches only the tabs of one origin. The apex must serve the hub page with the CSP header that `renderHubPage` gives, and without `X-Frame-Options`. The `@platform/hub` README has the deployment steps.

## Crypto and Storage (M6)

```text
  tab (main thread)                     Storage coordinator (shared worker, else the main thread)
  collection.set(key, value)            one writer for the origin, one request at a time
    validate (full schema)              backends: indexeddb --> opfs --> cache (--> localstorage --> sessionstorage --> memory)
    --> value + portable functions -->  serialize --> gzip? --> AES-GCM + HMAC? --> backend
  collection.get(key) <-- value ------  backend --> verify --> decrypt --> gunzip --> parse --> migrate (and write back)
  change --> BroadcastChannel --> every tab --> 'storage:changed'
```

- **Crypto** runs in a shared worker, then a dedicated worker, then the main thread. Keys are non-extractable `CryptoKey` objects in IndexedDB, so every tab, worker and session uses the same keys. `rotate` keeps old keys. `forget` deletes them, so old data can never be read again.
- **Storage** chooses its backend in `setup`. A worker without a persistent backend, or a worker that cannot run portable functions or open the keys, refuses. The runner then moves the coordinator to the main thread.
- **Portable functions** (core): `toPortable` turns functions into source text, and `fromPortable` rebuilds them in the worker. In the same realm, the original function comes back. Migrations, serializers, `where` filters and eviction comparators use this.
- **Processor configuration** (core): a processor definition can carry a `config`. Each host gives it to `setup`. Crypto and Storage get their key source and database this way.
- **Late binding.** The Queue keeps its dead letters, and the Logger its entries, in Storage collections when Storage runs. Both survive a reload. Neither package imports `@platform/storage`: they use small structural interfaces and `ctx.watch`.
- **Kernel persistence.** `createStatePersistence()` is the kernel's `persistence` option. It uses IndexedDB directly, because the kernel loads state before Storage runs.

What the tests found:

| Finding | Result |
|---|---|
| WebKit cannot store a `CryptoKey` in IndexedDB from a shared worker ("The object can not be cloned") | Crypto runs in a dedicated worker there. Storage runs its coordinator on the main thread there. |
| The IndexedDB and OPFS backends dropped `envelope.integrity` | Every encrypted entry read as corrupt. Both backends keep it now (see their `FIXES.md`). |
| The scheduler's `MessageChannel` port did not keep Node alive while tasks waited | Found by the examples checker. The port now holds a reference while tasks wait. |
| A Consent example waited 50 ms for another tab | Too short on a slow machine. It waits 500 ms now. |

## Runnable examples

Every source folder of a package has an `EXAMPLES.md`. Each example is a small real-world case with its expected output. `docs/EXAMPLES-FORMAT.md` is the contract for the doc compiler.

- `runtime="any"` examples run in Node and in Chrome. `runtime="browser"` examples run in Chrome. `runtime="none"` examples are shown but not run.
- `pnpm check:examples` type-checks every example, runs it, and compares the output. It is part of `pnpm check`.
- Examples import only `@platform/*` packages, so a sandbox needs nothing else.

## Kernel changes from the M4 retrospective

The pilot subsystems showed some problems in the unit contract. We changed the kernel:

| Problem | Change |
|---|---|
| A unit could not see when a dependency started later | `ctx.watch(target, listener)` |
| Recovered errors had nowhere to go but the console | `ctx.report(error)` sends them to the `onError` option of the kernel |
| Views are snapshots, so a log built on them lost records | `observe` commands on the Queue and the Notification Center push each record |
| Bounded lists copied the full array on each change | `createRingBuffer` makes the snapshot only when it is read |

## Tools and commands

Run these from the root of the repository:

| Command | What it does |
|---|---|
| `pnpm install` | Installs the workspace |
| `pnpm check` | Type-check, lint, format check, `check:docs`, `check:examples`, and all tests. Run it before you push. |
| `pnpm verify` | Type-check, lint, format check and `check:docs`. Run it before each commit. |
| `pnpm test:node` | Node tests (1082 tests) |
| `pnpm test:browser` | Browser tests, one project for each installed browser |
| `pnpm test:e2e` | Multi-origin tests with Playwright, for example the Window-scope gate |
| `pnpm check:docs` | Lists public members whose TSDoc block is missing or incomplete |
| `pnpm check:examples` | Runs every example and compares its output. `--only=<id prefix>` runs some of them. |
| `pnpm check:browsers` | Starts each browser installation and reports which ones work |
| `node spikes/m5-hub/spike.ts` | Runs the partition spike again |

`playwright.config.ts` lists each browser installation with its path. Use `BROWSERS=chrome,webkit` to run a subset. On the development machine, use `BROWSERS=chrome,system-chromium,edge,webkit,mobile-webkit`.

## Conventions

- **Documentation before code.** We agree the architecture and the plan before we build a milestone.
- **Commit as you go.** Work happens on `staging`. Commits are small and have a clear message.
- **`FIXES.md`.** When you fix a bug in old code, add a `FIXES.md` to the folder of the fixed files. We delete these files when the pull request merges.
- **TSDoc.** Every file starts with a `@fileoverview`. Every declaration and every public member has its own block with a `@summary`. Methods also have `@param`, `@returns`, `@throws` and an `@example`.
- **Prose.** Use STE: active voice, short sentences, no semicolons, no contractions, and plain words.
- **Markdown in `docs/` and `proposals/`.** These files are formatted by hand. Do not run Prettier on them.
- **Examples.** Every source folder has an `EXAMPLES.md`. Print only strings, numbers and booleans, and use `JSON.stringify` for objects.
- **Checks before a commit.** Read the exit code of each check. A pipe such as `| tail` hides a failure.

## Known problems and open items

1. Playwright's own Chromium and Firefox builds do not start on the development machine (`spawn UNKNOWN`). The installed Chrome, Edge, Chromium and WebKit work. Firefox is not tested yet.
2. Real Safari is not tested. Playwright's WebKit is the closest available proxy on Windows.
3. CI is deferred. A GitHub Actions workflow exists but is not on.
4. On Safari and iOS, Window scope reaches one origin until the Global relay arrives in M8.
5. The iframe link and the hub page run only in real browsers, so the Node coverage of `@platform/hub` is about 70%. The e2e gate tests them.
6. Some older methods, mainly on `Kernel`, have no `@example` yet. Older prose is not yet in STE.
7. The old managers in `src/managers` stay until their milestones port them.
8. On WebKit, Storage runs its coordinator on the main thread, because a shared worker there cannot store keys. Two tabs then have two writers. IndexedDB keeps the data consistent, but writes from two tabs are not in one order.
9. Encryption in Storage needs the same key source as `createCrypto`. Nothing checks that the two options match.
10. Storage has no query indexes yet. A `where` filter reads the whole collection.

## Next steps

M7 ports Network, Auth, Sync and Realtime onto the kernel. Sync and the offline replay will use Storage collections. Auth will use Crypto for tokens. The M7 gate is an offline-to-online test: all queued work completes once, and the pending work that the user sees matches the real state.
