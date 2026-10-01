# Architecture

> **Status:** Agreed — 2026-10-01
> **Precedence:** [`proposals/README.md`](../proposals/README.md) > this document > the per-subsystem proposals in [`proposals/`](../proposals).
> Where this document changes `proposals/README.md`, the change is listed in [§15 Amendments](#15-amendments-to-proposalsreadmemd). Amendments A1–A10 were merged into the README on 2026-10-01.

---

## 1. Purpose

`@platform` is a **platform runtime** for browser applications. An app boots it once and hands it the work that must not fail. It is shipped as a monorepo of npm packages, one package per subsystem, plus a scaffolder.

It gives three guarantees:

| Guarantee | Meaning | Carried mainly by |
|---|---|---|
| **Resilience** | Loss of connection, low storage, or an in-app error does not halt critical operations. | Queue, Storage, Sync, Network, feature isolation |
| **Efficiency** | Data is not fetched, stored, or sent more than needed. | Network (dedupe, cache), Storage (compression, eviction), Sync (deltas), Analytics (sampling) |
| **Visible, non-blocking remote work** | Remote operations (HTTP, WebSocket, webhooks, RPC) run off the critical path, and the user can always see what is pending. | Workers, Queue scheduling, GlobalState pending work |

### 1.1 Supported platforms

| In scope | Out of scope |
|---|---|
| Desktop browsers | In-app WebViews (Android `WebView`, iOS `WKWebView` inside native apps) |
| Mobile browsers on Android and iOS | Server-side rendering runtimes (the packages must *import* safely there, but do not run) |

- On iOS, every browser uses WebKit. The test matrix therefore needs **mobile WebKit** and **Chromium on Android**, as well as the desktop engines.
- Minimum versions: desktop browsers and Chrome for Android, the last two major versions; iOS and iPadOS (every browser), 16.4 or later. No API may be assumed present without a fallback, so the virtual host (§8.2) is always available.

### 1.2 Framework neutrality

The packages are **framework-agnostic**: no package except an adapter imports Vue, React, or a router. Vue is the first consumer, so its integration points are designed for first, but only through framework-neutral contracts (§6.1, §11.1). Adapter packages (§14.1) add only what a framework can do better.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Subsystem** (synonym: *manager*) | A unit with an identity, a scope, and a packet port. The only thing other subsystems can address. |
| **Feature** | A unit inside a subsystem. Uses its parent's identity. Can fail without failing its parent. |
| **Unit** | The common shape of subsystems and features (§3). |
| **Centralized subsystem** | GlobalState, Queue, NotificationCenter. Infrastructure for the others. Cannot be shut down manually. |
| **Featurized subsystem** | Every other subsystem. Can be initialized, suspended, and destroyed independently. |
| **Processor** | The code that does a unit's work. Runs on a physical, virtual, or hybrid worker. |
| **Job** | What a processor does with packets: *Sink*, *Scheduler*, or *Notifier* (§8.4). |
| **Packet** | A message between subsystems: a serializable **envelope** plus local **callbacks**. |
| **Fingerprint** | One recorded action in a packet's history. |
| **Trace** | All fingerprints of one causal chain, joined by `traceId`, possibly across tabs. |
| **Scope** | The boundary a subsystem lives in and broadcasts within: Page, Tab, Window, Global. |
| **Control interface** | The public commands and read-only views of a unit. |

---

## 3. The Unit model

A subsystem and a feature have the same anatomy (state, initializer, processors, destructor, control). The architecture therefore has **one recursive abstraction**, the `Unit`. A subsystem is a unit that also has a scope and a packet port.

```text
Subsystem  = Unit + identity + scope + packet port
Feature    = Unit (uses the parent's identity; talks to siblings directly)
```

```ts
interface Unit<S> {
  /** Stable id. For features: unique inside the parent. */
  readonly id: string;
  /** What must be present for this unit to turn on (§7). */
  readonly requires: readonly Dependency[];
  /** Serializable state with an exposure policy (§5). */
  readonly state: StateCell<S>;
  /** The "on" switch. Returns the disposer: the "off" switch (§4). */
  init(ctx: UnitContext): Promise<Disposer>;
  /** Work done by this unit (§8). */
  readonly processors?: readonly ProcessorDef[];
  /** Child units (§3.1). */
  readonly features?: readonly Unit<unknown>[];
  /** Commands and read-only views (§6). */
  readonly control: ControlInterface;
}

interface Subsystem<S> extends Unit<S> {
  readonly scope: Scope;               // §11
  readonly kind: 'centralized' | 'featurized';
  readonly port: PacketPort;           // §9, §10
}
```

### 3.1 Feature rules

- Features inside one subsystem call each other directly, by identity, with no packets.
- To reach another subsystem, a feature sends packets through its parent's port, under the parent's identity.
- External subsystems cannot address a feature.
- A failed feature moves its parent to `DEGRADED`, not `FAILED` (§4). The parent's control interface reports which features are off and why.

### 3.2 The initializer token

The README says an initializer "pushes the token used to initialize it". In this architecture, **the token is the disposer** that `init` returns. Destruction calls the disposers in reverse order of initialization. This ties the "on" switch to its matching "off" switch.

---

## 4. Lifecycle

One state machine applies to every unit. It replaces `PlatformManagerExecutionState`, `SubsystemStatusType`, and the per-unit use of `PlatformStatus`.

```text
                 init()                    all required deps READY
 UNINITIALIZED ---------> INITIALIZING ---------------------------> READY <---> BUSY
                               |                                    |  ^
                               | required dep missing / init throws |  | resume (pageshow, visible)
                               v                                    v  |
                            FAILED <------ unrecoverable ------- SUSPENDED
                               ^                                    |
                               |                                    | (bfcache, hidden, platform BUSY)
            feature fails      |
 READY/BUSY -----------------> DEGRADED --- feature recovers ---> READY
                               |
   destroy() from any state    v
 ---------------------------> DESTROYING ---> DESTROYED
```

- **DEGRADED** means "serving, with some features off". It is the normal result of a feature failure.
- **SUSPENDED** covers bfcache (`pagehide` with `persisted`), hidden tabs, and platform back-pressure. Processors stop taking work. State is kept.
- Centralized subsystems never enter `DESTROYING` on request. Only platform shutdown destroys them.
- The platform status (`PlatformStatus` in GlobalState) is derived from the unit states. It is never set by hand.

---

## 5. State

- **Owned:** only the owning unit mutates its state. No other code path writes it.
- **Serializable:** state must survive `structuredClone`. No functions, symbols, DOM nodes, or class instances that lose their prototype.
- **Exposure policy:** each state key is declared `private`, `readable` (through the control interface), or `persisted` (written by the destructor or by a persistence feature). A key can be both `readable` and `persisted`.
- **Restoration:** initializers fill state from defaults, then from persisted state when a compatible schema version exists. Volatile keys (pending work, status, timestamps) are never restored.

```ts
interface StateCell<S> {
  get(): Readonly<S>;
  /** Only callable from inside the owning unit. */
  update(fn: (draft: S) => void): void;
  readonly policy: { [K in keyof S]: Exposure };
  readonly version: number;
}
```

---

## 6. Control interface

The control interface has two parts:

- **Commands:** requests the unit performs on itself, such as `init`, `suspend`, `resume`, `destroy`, or domain commands like `storage.put`. A "setter" is a command. The unit validates it and updates its own state.
- **Views:** read-only projections of `readable` state.

Callers never receive a mutable reference to state.

### 6.1 Observable views

Every view is an **external store**, so any framework can bind to it without an adapter:

```ts
interface View<T> {
  /** Returns the current snapshot. Same reference until the value changes. */
  getSnapshot(): Readonly<T>;
  /** Calls `listener` after each change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
```

- Snapshots are immutable, and their identity is stable while the value is unchanged. React's `useSyncExternalStore` needs exactly this, and Vue can wrap it in a `shallowRef` updated by `subscribe`.
- Notifications are batched per task, so a burst of state changes causes one re-render.
- Subscribing never starts work. Unsubscribing never stops work that a command started.

---

## 7. Dependencies

A dependency is "the catalyst for turning a unit, or parts of it, on or off". Dependencies are declared **per unit, which means per feature**, not only per subsystem.

```ts
interface Dependency {
  /** A subsystem id, or `subsystem/feature`. */
  readonly target: string;
  /** `required`: this unit stays off without it. `optional`: this unit runs with reduced behavior. */
  readonly kind: 'required' | 'optional';
  /** The state the target must reach. Default `READY`. */
  readonly when?: 'READY' | 'INITIALIZING';
}
```

### 7.1 Rules

1. The resolver builds a graph of **features**. A cycle between subsystems is allowed when no cycle exists between their features. For example, Auth needs Network's transport and Network's interceptor feature needs Auth. Network's core does not need Auth, so the graph has no cycle.
2. A missing required dependency turns off **only the unit that declares it**. That unit's parent becomes `DEGRADED`.
3. A dependency that becomes `READY` later turns the waiting unit on. A dependency that leaves `READY` suspends the units that need it.
4. **Crypto must not depend on Network.** Key material comes from a bootstrap fetch or from injected config. Otherwise boot deadlocks.

### 7.2 Late binding for centralized subsystems

Centralized subsystems start before the subsystems they eventually use. Examples: the Logger needs the NotificationCenter, the Queue's dead-letter store needs Storage, and GlobalState restore needs Storage. A centralized unit declares such a dependency as **late-bound**:

- Before the target is `READY`, writes go to a bounded in-memory buffer.
- When the target becomes `READY`, the buffer drains in order.
- On overflow, the oldest entries are dropped and a fingerprint records the drop count.

This one mechanism covers the Logger ring buffer, dead-letter persistence, and GlobalState restore.

### 7.3 Mapping to npm

| Runtime dependency | `package.json` |
|---|---|
| required, by a subsystem's core | `peerDependencies` |
| optional, or only required by some features | `peerDependencies` + `peerDependenciesMeta.<pkg>.optional: true`, and a runtime presence check that turns the features off |
| `@platform/core` | `peerDependencies` (every package) |

---

## 8. Processors and workers

### 8.1 Location transparency

A processor is a **pure message-handler module**. It does not know which thread it runs on. A physical host (a worker entry file) and a virtual host (on the main thread) load the **same module**.

```ts
interface ProcessorDef {
  readonly id: string;
  readonly job: 'sink' | 'scheduler' | 'notifier';
  /** Loads the handler module. The same module runs on every host. */
  readonly load: () => Promise<ProcessorModule>;
  /** Hosts in order of preference. The last entry must be virtual. */
  readonly hosts: readonly HostKind[]; // e.g. ['shared', 'dedicated', 'virtual']
}

type HostKind = 'shared' | 'dedicated' | 'virtual';
```

### 8.2 Hosts

| Host | Implementation | Use for |
|---|---|---|
| **shared** | `SharedWorker` (same origin, shared by all its tabs) | Origin-wide coordinators: the Storage writer, Crypto keys |
| **dedicated** | `Worker` (`type: 'module'`) | CPU or I/O work for one tab: Sync, Realtime, Analytics aggregation, Translation compilation |
| **virtual** | Main-thread scheduler: `scheduler.postTask` → `MessageChannel` macrotask → `setTimeout(0)`. Yields with `scheduler.yield()` when present. Idle jobs use `requestIdleCallback`. | Light coordination and the fallback for every physical processor |

`queueMicrotask` is used only for coordination steps that are very small. A microtask does not yield to the browser. `navigator.scheduling.isInputPending` is a hint about when to yield. It is not a host.

### 8.3 Hybrid failover

Every processor's host list must end with `virtual` (README: "should also define a virtual one"). The runtime moves a processor to the next host when one of these happens:

1. The host does not exist in this environment.
2. The worker fires an `error` or `messageerror` event.
3. The handshake does not complete before a timeout.
4. A shared-worker heartbeat is missed.

Work in progress at failover is re-queued through the Queue. Its fingerprints record the host change. A failed physical host is not retried until the unit restarts.

### 8.4 Jobs

| Job | Behavior |
|---|---|
| **Sink** | Consumes a packet and updates internal state. Emits nothing. |
| **Scheduler** | Orders internal work and outgoing packets. Point-to-point (1-to-1). *Called "Queue" in the README. See §15.* |
| **Notifier** | Emits broadcast packets through the formal protocol. |

### 8.5 Worker budget

The runtime limits physical workers to `clamp(navigator.hardwareConcurrency - 1, 1, maxWorkers)`. When the budget is used up, more processors fall back to their next host. Shared workers count once per origin.

### 8.6 Slice budget

A virtual processor yields within a configurable slice. The default is 5 ms. Work that regularly takes longer must declare a physical host first.

---

## 9. Packets

### 9.1 Shape

```text
Packet
 ├─ envelope    serializable; crosses MessageChannel, BroadcastChannel, postMessage, and the network
 │   ├─ eventId        string (never a symbol)
 │   ├─ actionName
 │   ├─ payload        read once per delivery (§9.2)
 │   ├─ importance     CRITICAL | HIGH | MEDIUM | LOW
 │   ├─ metadata       messageId, source, target | null, scope, timestamp, ttl,
 │   │                 correlationId, traceId, spanId, parentSpanId, orderingKey, authToken?
 │   └─ fingerprints   bounded trail (§9.3)
 └─ callbacks   local only, kept in the CorrelationRegistry
     ├─ onComplete
     ├─ onError
     └─ onLog          called on completion AND on error
```

This keeps the split already implemented in `src/managers/packet.dto.ts`. The `BasePacket` in `global_PROPOSAL.md` (with `eventId: symbol` and inline callbacks) is replaced by it.

### 9.2 Read-once payload

"A payload can only be accessed once" means **once per delivery**.

- The payload is read with `packet.take()`. A second call throws `PayloadConsumedError`.
- **1-to-1 across threads:** transferable payload parts are transferred, not copied.
- **Broadcast in the same realm:** each subscriber gets its own packet view. `take()` clones lazily, so a subscriber that never reads the payload costs nothing.
- **Broadcast across tabs or origins:** each receiver deserializes its own copy.

### 9.3 Fingerprints

- Each subsystem appends a fingerprint at every lifecycle point it handles. Features add their id as `componentId`.
- The trail is bounded: the first `head` entries (default 16) and the last `tail` entries (default 48) are kept, together with a `dropped` count. The origin and the outcome are therefore never lost.
- `onLog` receives the trail on completion **and** on error.

### 9.4 Traces across boundaries

A receiver in another tab, origin, or device cannot append to the sender's trail. It starts its own trail with the same `traceId`, with `parentSpanId` set to the sender's `spanId`. The Logger joins trails by `traceId`. No acknowledgement is sent back for tracing.

---

## 10. Messaging topology

The Queue is the **single entry point** for every packet. The NotificationCenter fans packets out. It holds no queue, no retry logic, and no dead-letter store.

```text
                        ┌──────────────────────────── Queue (centralized) ───────────────────────────┐
 subsystem.port.send ──►│ validate ─► admission (GlobalState) ─► priority schedule ─► retry / DLQ    │
                        └───────┬──────────────────────────────────────────────┬─────────────────────┘
                                │ 1-to-1 (target set)                          │ 1-to-N (target null)
                                ▼                                              ▼
                     MessageChannel / in-realm call                  NotificationCenter (centralized)
                                │                                     routing, subscriber registry, ACL
                                ▼                                              │
                         target subsystem                    ┌─────────────────┼─────────────────────┐
                         (reply returns through Queue)       ▼                 ▼                     ▼
                                                        in-realm         Tab/Window transport   Global transport
                                                        subscribers      (§11)                  (§11)
```

| | Queue | NotificationCenter |
|---|---|---|
| Owns | Scheduling: priority, admission, ordering keys, retry, back-pressure, dead letters | Routing: event registry, subscriptions, ACL, event history |
| Delivery | 1-to-1, at least once, request/response | 1-to-N, fire and forget per subscriber |
| Transport | `MessageChannel`, in-realm calls | In-realm dispatch + scope transports |

Queue admission reads GlobalState. When the platform is `BUSY`, only `CRITICAL` packets are admitted. `CRITICAL` packets go to the NotificationCenter synchronously. Other packets go in the next task.

---

## 11. Scopes

### 11.1 Boundaries and transports

| Scope | Boundary | Broadcast transport |
|---|---|---|
| **Page** | One document **and** route. Ends when the path changes (router or Navigation API hook) or the document unloads. A page restored from bfcache resumes from `SUSPENDED`. | In-realm dispatch |
| **Tab** | One top-level browsing context, across the documents it loads. State moves between documents through `sessionStorage`. | In-realm dispatch |
| **Window** | All tabs of the same **site**, across its subdomains, in one browser profile session. | The **hub** (§11.3) |
| **Global** | All sessions and devices, through the **server**. | The Global transport (§11.4) |

### 11.2 Send rule

- **Broadcasts** are limited to the sender's scope. A broadcast from scope *S* spreads only within the boundary of *S*. Every subscriber inside that boundary receives it, whatever the subscriber's own scope ("receive from any").
- **1-to-1 requests** may target a subsystem in any reachable scope.
- **Replies** always return to the requester.

The Queue enforces this rule at admission.

### 11.2.1 Route changes for Page scope

Page scope ends on a path change. `core` detects it through a framework-neutral **route source**:

```ts
interface RouteSource {
  current(): string;                                  // the path
  subscribe(listener: (path: string) => void): () => void;
}
```

The default route source uses the Navigation API when it is present, and otherwise falls back to `popstate` plus wrapping `history.pushState` and `history.replaceState`. A router adapter (for example `vue-router`'s `afterEach`) can replace it (§14.1).

### 11.3 Window scope: the hub

`BroadcastChannel`, `SharedWorker`, and IndexedDB are bound to an **origin**. Subdomains are different origins. Window scope therefore needs a hub:

```text
 a.example.com tab                     b.example.com tab
 ┌──────────────┐                      ┌──────────────┐
 │ app          │                      │ app          │
 │  └ iframe ───┼── postMessage ──┐ ┌──┼── iframe     │
 └──────────────┘                 ▼ ▼  └──────────────┘
                      hub.example.com (hub page, same site)
                      BroadcastChannel / SharedWorker on the hub origin
```

- The `@platform/hub` package ships a static hub page. The app deploys it on the **apex** origin of the site (for example `https://example.com/__platform/hub.html`; the path is configurable).
- The apex must allow its subdomains to frame the hub page: `Content-Security-Policy: frame-ancestors https://example.com https://*.example.com`, and no `X-Frame-Options` header on that path (`SAMEORIGIN` would block subdomains, because they are different origins).
- Tabs on the apex itself are on the hub's origin. They join the hub's `BroadcastChannel` directly, without an iframe.
- The iframe checks `event.origin` against an allowlist of the site's origins, and the hub does the same. Messages are envelopes only.
- **Single-origin apps** use the same interface without an iframe. The hub runs on the app's own origin through `BroadcastChannel`/`SharedWorker`.
- **Risk:** browsers partition storage for third-party contexts. The hub is same-site, so it is expected to share one partition across subdomains. Milestone M5 starts with a spike that verifies this in each supported browser.

### 11.4 Global scope: the server

Global scope is **server-backed**. Its transport is a feature of Realtime, with Network as the fallback:

- **Online:** envelopes travel over WebSocket or SSE. If neither is available, HTTP long-polling is used.
- **Offline:** the Queue persists outgoing Global packets (through Storage) and replays them on reconnect.
- **Delivery:** at least once. Receivers deduplicate by `messageId`.
- **Wire protocol:** a versioned JSON envelope schema, published in `@platform/core`, which servers implement. This project ships **only the wire protocol**: the schema, its documentation, and conformance fixtures. Servers are built by the app's own backend. The test suite uses a minimal in-memory test double that is never published.

---

## 12. Boot sequence

```text
1. core runtime        resolver, hosts, worker budget
2. GlobalState         environment detection, platform status = INITIALIZING
3. Queue               late-bound: Storage (dead letters, offline Global packets)
4. NotificationCenter  in-realm first; scope transports attach as they become READY
5. Logger              late-bound: NotificationCenter, Storage (ring buffer)
6. featurized subsystems, in dependency-graph order, in parallel where independent
7. GlobalState         platform status derived → IDLE
```

Shutdown runs disposers in reverse order. Persisting state is part of each unit's disposer.

---

## 13. Subsystem catalogue

| Subsystem | Kind | Scope | Preferred hosts | Required deps (core) | Proposal |
|---|---|---|---|---|---|
| GlobalState | centralized | Tab | virtual | — | `global` |
| Queue | centralized | Tab | virtual | GlobalState | `queue` |
| NotificationCenter | centralized | Tab | virtual | GlobalState, Queue | `notification` |
| Logger | featurized | Tab | virtual | — (late-bound: NotificationCenter, Storage) | `logger` |
| Crypto | featurized | Tab (key cache shared per origin) | shared → dedicated → virtual | — | `crypto` |
| Storage | featurized | Tab (coordinator shared per origin) | shared → virtual | — (optional: Crypto) | `storage`, backends |
| Consent | featurized | Window | virtual | Storage | `consent` |
| Settings | featurized | Window | virtual | Consent | `settings` |
| Network | featurized | Tab | virtual | GlobalState | `network` |
| Auth | featurized | Window | virtual (crypto delegated) | Storage, Network | `auth` |
| Sync | featurized | Tab | dedicated → virtual | Network, Storage | `sync` |
| Realtime | featurized | Tab (hosts the Global transport) | dedicated → virtual | Network | `realtime` |
| Translation | featurized | Tab | virtual (compile: dedicated) | Storage, Network | `translation` |
| Analytics | featurized | Tab | dedicated → virtual | Consent, Network | `analytics` |
| Design System | featurized | Page | virtual | — | `design-system` (empty) |

The scopes here are proposals. They are confirmed when each subsystem's proposal is amended in its milestone.

---

## 14. Packaging

```text
packages/
  core/                 Unit, lifecycle, resolver, StateCell, packets, fingerprints,
                        scopes, hosts, in-realm + MessageChannel transports, wire schema
  global-state/  queue/  notification/          centralized
  logger/  crypto/  storage/  consent/  settings/  network/  auth/
  sync/  realtime/  translation/  analytics/  design-system/
  hub/                  Window-scope hub page + client
  platform/             orchestrator: boots a chosen set of subsystems
  create/               scaffolder (the npm template), published as @platform/create
                        so that `npm init @platform` runs it
  vue/                  optional adapter (§14.1)
  react/                optional adapter (§14.1), considered later
```

- Scope name: `@platform/*`. It is a **placeholder until version 0.9**, when the final name is chosen. The current version is `0.0.1`.
- Each package exports `.` (factory, packet types, state types). Worker entries are separate exports (`./worker`, `./shared-worker`). The package spawns them with `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`, so bundlers can find them.
- All packages share one version (fixed versioning).
- `platform` is the only package with hard `dependencies` on other subsystems. Every other package uses peer dependencies (§7.3).

### 14.1 Framework adapters

An adapter exists only where a framework can do something better than the neutral contracts. It never adds behavior that the core lacks.

| Adapter | Scope of the package | Priority |
|---|---|---|
| `@platform/vue` | `useView(view)` → `Readonly<ShallowRef<T>>` (subscribes, and unsubscribes on scope dispose); a Vue plugin that boots `platform` and `provide`s it, read with `usePlatform()`; a `vue-router` route source (§11.2.1); Page-scope units tied to component or route lifetime | First. Built in M10. |
| `@platform/react` | `useView` on top of `useSyncExternalStore`; a context provider; route sources for common routers | To be considered after 1.0 |

`vue`, `vue-router`, `react`, and router packages are **peer dependencies** of their adapter only.

---

## 15. Amendments to `proposals/README.md`

| # | Amendment | Status |
|---|---|---|
| A1 | Scope send restrictions apply to **broadcasts only**. 1-to-1 requests may target any scope, and replies always return. | Decided |
| A2 | **Window** scope spans subdomains of one site, through a hub (§11.3). "session-bound" is replaced by "window-bound". | Decided |
| A3 | **Global** scope is server-backed (§11.4). | Decided |
| A4 | Cross-boundary tracing uses `traceId` stitching, not returned fingerprints (§9.4). | Decided |
| A5 | Subsystems and features share one `Unit` model. The initializer's token is the disposer (§3). | Decided |
| A6 | The "Queue" job is renamed **Scheduler**, to avoid clashing with the Queue subsystem (§8.4). | Decided |
| A7 | "Payload accessed once" means once **per delivery** (§9.2). | Decided |
| A8 | One lifecycle state machine, adding `DEGRADED` and `SUSPENDED` (§4). | Decided |
| A9 | Control-interface "setters" are commands the unit performs on itself (§6). | Decided |
| A10 | The NotificationCenter holds no queue. All packets enter through the Queue (§10). | Decided |

## 16. Corrections to the per-subsystem proposals

| Proposal | Correction |
|---|---|
| `global` | Replace `BasePacket` (`eventId: symbol`, inline callbacks) with the envelope and callback split (§9.1). Derive the platform status (§4). |
| `notification` | Remove the event queue, retry, and dead-letter logic. Delegate to the Queue (§10). |
| `queue` | The NotificationCenter does not poll the Queue. The Queue pushes broadcasts to it (§10). Dead letters are late-bound to Storage (§7.2). |
| `logger` | No required dependencies. NotificationCenter and Storage are late-bound (§7.2). |
| `auth` | Remove `credentialCache.hashedPassword`. Password hashing belongs on the server. |
| `crypto` | Keep the rule that Crypto has no Network dependency (§7.1). |
| `design-system` | The proposal is empty and must be written before its milestone. |
