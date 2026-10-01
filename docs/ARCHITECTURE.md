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

A unit is declared once as a **definition** (plain data plus functions) and run by the kernel. The kernel creates the state cell, the context and the port; the definition never constructs them itself.

```ts
interface UnitDefinition<S, C extends ControlInterface> {
  /** Stable id. For features: unique inside the parent. */
  readonly id: string;
  /** What must be present for this unit to turn on (§7). */
  readonly requires?: readonly Dependency[];
  /** Initial state, exposure policy and schema version (§5). */
  readonly state: StateDefinition<S>;
  /** The "on" switch. May return the disposer: the "off" switch (§4). */
  init?(ctx: UnitContext<S>): Disposer | void | Promise<Disposer | void>;
  /** Work done by this unit (§8, M2). */
  readonly processors?: readonly ProcessorDef[];
  /** Child units (§3.1). */
  readonly features?: readonly UnitDefinition<any, any>[];
  /** Builds the commands and read-only views (§6) from the context. */
  control(ctx: UnitContext<S>): C;
}

interface SubsystemDefinition<S, C> extends UnitDefinition<S, C> {
  readonly scope: Scope;                         // §11
  readonly kind: 'centralized' | 'featurized';
  /** Handles packets addressed to this subsystem; the return value is the reply. */
  receive?(packet: Packet, ctx: UnitContext<S>): unknown;
}
```

The context gives a unit its state cell, an `AbortSignal` that fires on destruction, its siblings' control interfaces (features only, §3.1), the control interfaces of the units it depends on, and the packet port, which features share with their parent.

### 3.1 Feature rules

- Features inside one subsystem call each other directly, by identity, with no packets.
- To reach another subsystem, a feature sends packets through its parent's port, under the parent's identity.
- External subsystems cannot address a feature.
- A failed feature moves its parent to `DEGRADED`, not `FAILED` (§4). The parent's control interface reports which features are off and why.

### 3.2 The initializer token

The README says an initializer "pushes the token used to initialize it". In this architecture, **the token is the disposer** that `init` returns. Destruction calls the disposers in reverse order of initialization. This ties the "on" switch to its matching "off" switch.

### 3.3 Kernel

The kernel (`@platform/core`) registers subsystem definitions, validates the dependency graph, and runs every unit's lifecycle. Until the Queue exists (M3), it delivers packets through a pluggable **packet router**; the Queue becomes the router in M3.

- A unit whose required dependency is not met stays `UNINITIALIZED` and reports what it is `waitingFor`. It starts as soon as the dependency is met (§7.1).
- A unit with `features` reports `DEGRADED` while any feature is not running.
- `@platform/core/testing` provides an in-memory platform with an in-memory router, for tests that boot real units without browser APIs.

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
interface ProcessorModule<In, Out> {
  setup?(scope: ProcessorScope): void | Promise<void>;
  /** Handles one structured-cloneable message and returns the result. */
  handle(message: In, scope: ProcessorScope): Out | Promise<Out>;
  teardown?(): void | Promise<void>;
}

interface ProcessorScope {
  readonly host: HostKind;
  /** True when the current slice is over budget (§8.6). */
  shouldYield(): boolean;
  /** Gives the thread back to the browser, then continues. */
  yield(): Promise<void>;
  /** Sends a one-way message to the owning unit (a Notifier's output). */
  post(message: unknown): void;
}

interface ProcessorDef<In, Out> {
  readonly id: string;
  readonly job: 'sink' | 'scheduler' | 'notifier';
  /** Hosts in order of preference. The last entry must be 'virtual'. */
  readonly hosts: readonly HostKind[];
  /** Loads the module for the virtual host. */
  readonly load: () => Promise<ProcessorModule<In, Out>>;
  /** Create the workers. Written at the definition site, so bundlers can see them. */
  readonly dedicated?: () => Worker;      // new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })
  readonly shared?: () => SharedWorker;   // new SharedWorker(new URL(...), { type: 'module', name })
}

type HostKind = 'shared' | 'dedicated' | 'virtual';
```

- The worker entry file calls `serveProcessor(module)` from `@platform/core/worker`. It answers the handshake, calls, and heartbeats.
- Bundlers (Vite, webpack, Rollup) only detect `new Worker(new URL(..., import.meta.url))` written literally. That is why the definition, not the library, creates the worker.
- Hosts talk to workers over a small request/response protocol (handshake, call, ping, one-way post). The same protocol carries envelopes over `MessageChannel` transports.
- A unit's processors start before its `init` and stop during teardown. The context exposes them as `ctx.processor(id)`.

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

Work in progress at failover is re-run once on the next host. From M3, the Queue re-queues it instead. The host change and its cause are recorded on the processor's view. A failed physical host is not retried until the unit restarts.

The heartbeat (trigger 4) is on by default for shared hosts and off for dedicated hosts; both are configurable.

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

### 10.1 How the three centralized subsystems fit together (M3)

Each is its own package (`@platform/global-state`, `@platform/queue`, `@platform/notification`) and exports a factory. The Queue and the NotificationCenter also return a piece that plugs into the kernel or into each other, so no package imports another:

```ts
const globalState = createGlobalState();
const notification = createNotificationCenter({ events });
const queue = createQueue({ fanOut: notification.fanOut });

const kernel = new Kernel([globalState, queue.subsystem, notification.subsystem, ...featurized], {
  router: queue.router, // every packet now enters through the Queue
});
```

**GlobalState** (`global-state`)
- Derives the platform status from every unit's lifecycle, which the kernel exposes to units as `ctx.statuses`. The status is `INITIALIZING` while any unit initializes, `DEGRADED` while any unit is `FAILED`, `DEGRADED` or waiting for a dependency, `BUSY` while any unit is `BUSY` or pending work exceeds a threshold, and `IDLE` otherwise.
- Tracks pending work (`beginWork` / `endWork`). The Queue registers every in-flight packet, so the user-visible "work in progress" is always accurate (guarantee 3, §1).
- Admission (`canAccept(importance)`): `CRITICAL` always; nothing else while `BUSY`; no `LOW` while `DEGRADED`.
- Environment: online and visibility, observable.
- Tab identity that survives reloads and is unique for duplicated tabs: an id kept in `sessionStorage`, confirmed with a `BroadcastChannel` probe. If another live tab answers with the same id (a duplicated tab copies `sessionStorage`), a new id is minted.

**Queue** (`queue`), the kernel's packet router
- The single entry point. It checks the send rule, then admission through GlobalState (when it runs), then a depth limit. Rejected packets fail with `QueueRejectedError`.
- Holds packets in priority tiers, keeps packets with the same `orderingKey` in order, and runs a bounded number at once. `CRITICAL` packets dispatch at once; others in the next scheduler task.
- 1-to-1: delivers through the kernel. A target that exists but is not running is retried with backoff (the backoff library moves to `@platform/core`). After the last retry, or when the TTL passes, the packet becomes a dead letter and the request rejects. A target's own error (its `receive` threw) goes straight back to the requester: it is not retried, because retrying could repeat side effects.
- 1-to-N: hands the envelope to `fanOut` (the NotificationCenter), or to the kernel's direct broadcast when there is none.
- Dead letters are kept in memory and written through a `LateBinding` that Storage binds in M6.
- Records each settled packet's final fingerprint trail (`sent`, `enqueued`, `dispatched`, `delivered`, `completed` or `failed`).

**NotificationCenter** (`notification`)
- Routing only: the event registry, subscriptions, access control and history. No queue, no retries (A10).
- Subscribers are subsystems that list the event in `subscribes`, plus programmatic subscriptions (for adapters and UI code).
- Access control per event: which subsystems may publish it, and which may receive it.
- A circuit breaker per subscriber stops calling one that keeps failing, and retries it after a timeout.
- History: the last N broadcasts with one trail each, covering every delivery.
- In-realm subscribers are on the same page and tab, so Page and Tab broadcasts reach them all. Window (M5) and Global (M8) relays plug in later.

**Kernel additions**
- `ctx.statuses`: every unit's lifecycle, read-only, for every unit.
- Centralized subsystems boot before featurized ones, and may only require other centralized subsystems.
- `kernel.subscribers(eventId)` lists the running subscribers of an event, and `kernel.deliver(envelope, { to, clone })` delivers a broadcast to one of them with its own copy.
- `kernel.scopeOf(id)` returns a subsystem's scope, so routers can check the send rule for envelopes they did not build.

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

- Scope name: `@platform/*`. It is a **placeholder until M9**, when the final name is chosen. The version stays `0.0.2` until all milestones and the alpha validation are done (docs/PLAN.md §4.1).
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
