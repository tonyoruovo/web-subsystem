# Plan and Milestones

> **Status:** Agreed — 2026-10-01
> **Depends on:** [`ARCHITECTURE.md`](ARCHITECTURE.md). The section numbers below (§) refer to it.

---

## 1. Principles

1. **Intent before code.** Each milestone starts by updating the documents it touches: `proposals/README.md` amendments, the subsystem's proposal, and `ARCHITECTURE.md`. Code follows the documents. A difference between code and documents is a bug in one of them.
2. **Kernel first.** No subsystem is built or ported until the `Unit` contract exists and one pilot subsystem has proved it.
3. **Port, don't rewrite.** The existing classes in `src/managers/` are tested domain logic. They become the processors and features of the new subsystems. The kernel adds identity, lifecycle, packets, and scopes around them.
4. **Every milestone ends green:** type-check, lint, unit tests, and (from M2 on) browser tests all pass, and the documents match the code.
5. **Every package is documented when it is created.**
   - The package has a `README.md` covering its purpose, installation and peer dependencies, entry points, and usage with examples.
   - The code follows the JSDoc conventions: every file, including barrel (`index.ts`) files, opens with a `@fileoverview`. Every declaration (functions, classes, interfaces, type aliases and constants) has a `@summary`, a `@description`, examples where non-trivial, and the relevant `@template`, `@param`, `@returns`, `@throws` and access tags.
   - Every public member has its own TSDoc block. This applies to the properties, methods, accessors and constructors of classes, to constructor parameter properties, and to the members of interfaces and nested object types. A description on the parent does not count. Each block has a `@summary`. A method block also has its `@param`, `@returns` and `@throws` tags, and an `@example` when the use is not obvious. `pnpm check:docs` finds the members that do not follow this rule (decided 2026-10-02).
   - All prose follows ASD-STE100 Simplified Technical English: documentation, READMEs, TSDoc, commit messages and error messages (decided 2026-10-02).

---

## 2. Starting point (2026-10-01)

| Area | State |
|---|---|
| Repository | A single package, not under git. `src/managers/package.json` declares `@platform/managers`. Both `package.json` files are at version `0.0.1`. |
| Code | 13 managers as standalone classes. None of them exchanges packets: they are joined by constructor closures in `platform.ts`. `IPlatformWorker` is not used anywhere. |
| Bus | `MessageQueue`, `NotificationCenter`, `NotificationBridge`, `ChannelTransport`, `CorrelationRegistry`, and the envelope/callback packet split exist and are usable. |
| Tests | 38 of 49 suites fail to load. There is no vitest config, so the `@/` path alias does not resolve, and `dist/` is collected as tests too. |
| Types | 21 `tsc` errors, mostly unused locals or parameters. |
| Proposals | 22 files. `design-system` is empty. |

### 2.1 Mapping existing code to the new structure

| Existing code | Becomes |
|---|---|
| `packet.dto.ts`, `packet.registry.ts` | `core`: packets, correlation |
| `queue/*`, `bus.ts` (parts) | `queue`, `core` (MessageChannel transport) |
| `notification/*` | `notification`, `hub` (cross-tab bridge) |
| `global/global-state.manager.ts`, `global/tab/*` | `global-state` |
| `manager.dto.ts` | Replaced by `core` lifecycle (§4) |
| `libs/*`, `enums/*`, `constants/*`, `types/*` | `core` (shared), or the package that uses them |
| each `<name>/<name>.manager.ts` | The processors and features of package `<name>` |
| `storage/backends/*` | `storage` features (one feature per backend) |
| `platform.ts` | `platform` |

---

## 3. Milestones

Every milestone has a **gate**: the conditions that must hold before the next one starts.

### Before M0 — Intent

1. Agree on `ARCHITECTURE.md` and this plan.
2. Write the project `README.md` from them, and agree on it.

No code is written until both steps are done.

### M0 — Foundation

*Goal: a trustworthy baseline to build on.*

- Initialize git. Add a CI workflow (type-check, lint, test). **Deferred:** the workflow exists, but CI is not run until the repository has a GitHub remote (decided 2026-10-01).
- Add `vitest.config.ts` with the `@/` alias, and exclude `dist/`.
- Fix the 21 `tsc` errors.
- Convert the repo to a pnpm workspace with an empty `packages/` tree. Existing code stays in `src/` until it is ported.
- Add browser tests (Vitest browser mode with Playwright) next to Node tests. Workers, `BroadcastChannel`, and iframes need a real browser. The matrix covers Chromium, Firefox, and WebKit on desktop, and mobile WebKit and Chromium-on-Android profiles (§1.1). Emulated mobile profiles are a first step. Real-device runs are added before 1.0.
- Encode the minimum browser versions (Q6) in a browserslist config and the test matrix.
- Merge amendments A1–A10 (§15) into `proposals/README.md`, after review.

**Gate:** all existing tests pass, `tsc` is clean, `pnpm check` passes locally (CI deferred), and amendments A1–A10 are merged into the README.

### M1 — Kernel (`core`)

*Goal: the contract every subsystem is built on.*

- `Unit`, `Subsystem`, `UnitContext`, `Disposer` (§3)
- The lifecycle state machine, with transition guards and events (§4)
- `StateCell` with exposure policy and versioned persistence hooks (§5)
- The control interface: commands and observable views, with stable snapshots and per-task batching (§6, §6.1)
- The `RouteSource` contract, and its default built on the Navigation API and the History API (§11.2.1)
- The dependency resolver: feature-level graph, cycle detection, required/optional, late binding with bounded buffers (§7)
- Packets: envelope, `take()`, bounded fingerprints, `traceId`/`spanId`, the correlation registry (§9)
- `Scope` types and the send-rule checker (§11.2)
- The Global wire-protocol schema (zod), versioned (§11.4)
- A test harness: an in-memory platform that boots units with fake transports

**Gate:** the kernel runs in Node tests with no browser APIs. 100 % of the lifecycle transitions and resolver cases are covered.

### M2 — Runtime: hosts and transports

*Goal: processors run anywhere and packets move between realms.*

- The processor module contract (§8.1)
- The virtual host, with its scheduler fallback chain and slice budget (§8.2, §8.6)
- Dedicated and shared hosts, with the worker-entry pattern that bundlers can detect (§14)
- Hybrid failover on all four triggers (§8.3)
- The worker budget (§8.5)
- In-realm and `MessageChannel` transports

**Gate:** in browser tests, one processor runs on all three hosts with identical results. Each failover trigger is tested.

### M3 — Centralized subsystems

*Goal: the bus, rebuilt on the kernel.*

- `global-state`: environment detection, derived platform status, tab identity (duplicated-tab safe), pending-work tracking
- `queue`: single entry point, admission, priority scheduling, ordering keys, retry with the existing backoff library, an in-memory dead-letter queue late-bound to Storage, send-rule enforcement
- `notification`: routing, subscriptions, ACL, history. No queue (§10).
- Page and Tab scope broadcast
- Amend the `global`, `queue`, and `notification` proposals (§16)

**Gate:** both flows from the README diagram (1-to-1 and 1-to-many) run end to end in a browser test, with complete fingerprint trails.

### M4 — Pilot: Logger and Consent

*Goal: prove the contract on real subsystems before scaling it.*

- `logger`: no required dependencies, a ring buffer late-bound to NotificationCenter and Storage, trace joining by `traceId`
- `consent`: a small featurized subsystem with persisted state and a control interface
- A retrospective. Change the kernel where the pilot found friction, and update `ARCHITECTURE.md`.

**Gate:** both subsystems are ported, their old classes are deleted, and the kernel changes from the retrospective are merged.

### M5 — Window scope: the hub

*Goal: broadcasts across tabs and subdomains.*

- **Spike first:** confirm that the hub iframe shares one storage and `BroadcastChannel` partition across subdomains in every supported browser. If it doesn't, stop and revise §11.3. _Done 2026-10-02: WebKit partitions the hub by top-level origin (`spikes/m5-hub/FINDINGS.md`); §11.3 revised by amendment A11._
- `hub`: the static hub page served from the apex, the client, origin allowlists, reconnect handling, and the direct mode for tabs on the apex
- Partition detection (partition id and the apex-domain window cookie), the relay interface with deduplication by `messageId`, and the reported reach (§11.3). The relay is tested against an in-memory double; the real one is the Global transport (M8).
- Scope relays in the kernel: the NotificationCenter hands Window broadcasts to the attached relay, and the Queue ingests envelopes from other tabs
- Deployment notes for the apex: the hub path, `frame-ancestors`, and no `X-Frame-Options` on that path
- The single-origin mode without an iframe
- Move consent to Window scope

**Gate:** a broadcast from `a.<site>` reaches subscribers on `b.<site>` in a multi-origin browser test (through the hub where it is shared, through the relay double where it is partitioned), and the origin checks reject a foreign origin.

### M6 — Data foundation: Crypto and Storage

- `crypto`: shared → dedicated → virtual hosts, key delivery without Network
- `storage`: the coordinator on a shared worker, the backends as features (IDB, OPFS, Cache, WebStorage, memory), migrations, quota events, optional Crypto
- Dead letters and Logger buffers now persist through Storage

**Gate:** with the shared worker killed during a write, storage fails over without data loss (browser test).

### M7 — Connectivity: Network, Auth, Sync, Realtime

- `network`: retries, deduplication, cache, and an interceptor feature
- `auth`: tokens, refresh, elevation, and permissions. `hashedPassword` is removed.
- `sync`: subscriptions, intervals, conflict resolution, offline replay
- `realtime`: socket lifecycle, reconnect with backoff

**Gate:** an offline → online scenario completes all queued work with no duplicates, and the user-visible pending work matches the real state throughout.

### M8 — Global scope

- The Global transport as a Realtime feature, with Network fallback (§11.4)
- Persistence and replay of outgoing Global packets while offline
- The Window relay (§11.3): the Global transport forwards Window-scope envelopes between connections with the same window id
- Wire-protocol documentation and conformance fixtures that backend teams can run against their own servers
- An in-memory server test double, used only in this repo's tests and never published

**Gate:** a Global broadcast survives an offline period and is delivered exactly once per receiver (at least once, plus deduplication).

### M9 — Product subsystems

- `translation`, `settings`, `analytics`
- `design-system`: write its proposal first, then build it

**Gate:** all subsystems in the catalogue (§13) are ported, and `src/managers/` is empty.

### M10 — Platform, template, release

- `platform`: an orchestrator that boots a chosen set of subsystems
- `@platform/create`: the scaffolder (workspace, config, worker entries, test harness), with a Vue template first
- `@platform/vue`: `useView`, the Vue plugin, the `vue-router` route source (§14.1)
- Documentation site (typedoc), changelog, fixed-version release

**Gate:** a freshly scaffolded Vue app boots, goes offline, recovers, and passes its generated tests. A plain-TypeScript app does the same without the adapter, which proves the core is framework-agnostic.

---

## 4. Order of work

```text
Intent ─► M0 ─► M1 ─► M2 ─► M3 ─► M4 ─┬─► M5 ───────────────┐
                                      └─► M6 ─► M7 ─► M8 ─┐   │
                                                          ├───┴─► M9 ─► M10
```

M5 (hub) and M6/M7 can run in parallel after the pilot. M8 needs Realtime (M7) and Storage (M6).

### 4.1 Versioning

All packages share one version. **Milestone gates do not change the version** (decided 2026-10-01): it stays `0.0.2` until every milestone is complete **and** the alpha validation (§4.2) has passed. The next version is decided then.

The `@platform` scope is a placeholder until M9, when the final package name is chosen.

### 4.2 Alpha validation

After M10, the packages are installed into real applications built with **React, Vue, Svelte and Astro**. Each app exercises boot, offline and recovery, cross-tab and cross-subdomain broadcasts, and the framework bindings (the Vue adapter, and the plain `View` contract elsewhere). Findings are fixed before the first release.

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Storage partitioning breaks the same-site hub | Window scope cannot work as designed | Spike at the start of M5, before any hub code |
| `SharedWorker` is missing in some environments | Origin-wide coordination is lost | Hybrid failover (§8.3). Every processor has a virtual host. |
| Too many workers on low-end devices | Memory pressure, slow start | Worker budget (§8.5) |
| Kernel contract is wrong | Every port inherits the defect | The pilot (M4) is gated, and a retrospective follows it |
| Wire protocol churn | Server and client fall out of step | The schema is versioned in `core` from M1 |
| Porting changes behavior | Regressions | Existing tests are kept and moved with the code |

---

## 6. Open questions

| # | Question | Needed by | Answer |
|---|---|---|---|
| Q1 | Platforms in scope | M0 | Desktop and mobile (Android, iOS) browsers. In-app WebViews are out. |
| Q2 | The npm scope name | M0 | `@platform`, a placeholder until M9. |
| Q3 | Reference server, or wire protocol only? | M1 | Wire protocol only. |
| Q4 | The hub origin | M5 | The apex domain. |
| Q5 | Framework support | M10 | Framework-agnostic core. A Vue adapter first; React to be considered later. |
| Q6 | Minimum browser versions | M0 | Desktop browsers and Chrome for Android: the last two major versions. iOS and iPadOS (all browsers): 16.4 or later. |
| Q7 | Is the versioning scheme (§4.1) acceptable? | M0 | Revised: no bumps at milestone gates; release after all milestones and alpha validation (§4.2). |
