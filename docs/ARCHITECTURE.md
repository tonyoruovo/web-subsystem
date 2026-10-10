# Architecture

> **Status:** Agreed — 2026-10-01
> **Precedence:** [`proposals/README.md`](proposals/README.md) > this document > the per-subsystem proposals in [`proposals/`](proposals).
> Where this document changes `proposals/README.md`, the change is listed in [§15 Amendments](#15-amendments-to-proposalsreadmemd). Amendments A1–A10 were merged into the README on 2026-10-01.

---

## 1. Purpose

**WebKrnl** (`@webkrnl/*`) is a **platform runtime** for browser applications. An app boots it once and hands it the work that must not fail. It is shipped as a monorepo of npm packages, one package per subsystem, plus a scaffolder.

It gives three guarantees:

| Guarantee                             | Meaning                                                                                                                    | Carried mainly by                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Resilience**                        | Loss of connection, low storage, or an in-app error does not halt critical operations.                                     | Queue, Storage, Sync, Network, feature isolation                                              |
| **Efficiency**                        | Data is not fetched, stored, or sent more than needed.                                                                     | Network (dedupe, cache), Storage (compression, eviction), Sync (deltas), Analytics (sampling) |
| **Visible, non-blocking remote work** | Remote operations (HTTP, WebSocket, webhooks, RPC) run off the critical path, and the user can always see what is pending. | Workers, Queue scheduling, GlobalState pending work                                           |

### 1.1 Supported platforms

| In scope                           | Out of scope                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Desktop browsers                   | In-app WebViews (Android `WebView`, iOS `WKWebView` inside native apps)                  |
| Mobile browsers on Android and iOS | Server-side rendering runtimes (the packages must _import_ safely there, but do not run) |

- On iOS, every browser uses WebKit. The test matrix therefore needs **mobile WebKit** and **Chromium on Android**, as well as the desktop engines.
- Minimum versions: desktop browsers and Chrome for Android, the last two major versions; iOS and iPadOS (every browser), 16.4 or later. No API may be assumed present without a fallback, so the virtual host (§8.2) is always available.

### 1.2 Framework neutrality

The packages are **framework-agnostic**: no package except an adapter imports Vue, React, or a router. Vue is the first consumer, so its integration points are designed for first, but only through framework-neutral contracts (§6.1, §11.1). Adapter packages (§14.1) add only what a framework can do better.

---

## 2. Glossary

| Term                               | Definition                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Subsystem** (synonym: _manager_) | A unit with an identity, a scope, and a packet port. The only thing other subsystems can address.    |
| **Feature**                        | A unit inside a subsystem. Uses its parent's identity. Can fail without failing its parent.          |
| **Unit**                           | The common shape of subsystems and features (§3).                                                    |
| **Centralized subsystem**          | GlobalState, Queue, NotificationCenter. Infrastructure for the others. Cannot be shut down manually. |
| **Featurized subsystem**           | Every other subsystem. Can be initialized, suspended, and destroyed independently.                   |
| **Processor**                      | The code that does a unit's work. Runs on a physical, virtual, or hybrid worker.                     |
| **Job**                            | What a processor does with packets: _Sink_, _Scheduler_, or _Notifier_ (§8.4).                       |
| **Packet**                         | A message between subsystems: a serializable **envelope** plus local **callbacks**.                  |
| **Fingerprint**                    | One recorded action in a packet's history.                                                           |
| **Trace**                          | All fingerprints of one causal chain, joined by `traceId`, possibly across tabs.                     |
| **Scope**                          | The boundary a subsystem lives in and broadcasts within: Page, Tab, Window, Global.                  |
| **Control interface**              | The public commands and read-only views of a unit.                                                   |

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
  readonly scope: Scope; // §11
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

The kernel (`@webkrnl/core`) registers subsystem definitions, validates the dependency graph, and runs every unit's lifecycle. It delivers packets through a pluggable **packet router**: a direct in-realm router by default, the Queue in an application (§10.1).

- A unit whose required dependency is not met stays `UNINITIALIZED` and reports what it is `waitingFor`. It starts as soon as the dependency is met (§7.1).
- A unit with `features` reports `DEGRADED` while any feature is not running.
- `@webkrnl/core/testing` provides an in-memory platform with an in-memory router, for tests that boot real units without browser APIs.

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
- **Renew** (M10, §22.1): a running or suspended Page-scope unit goes back to `INITIALIZING` when the path changes. It is torn down first, and its state starts again from the initial value.
- Centralized subsystems never enter `DESTROYING` on request. Only platform shutdown destroys them.
- The platform status (`PlatformStatus` in GlobalState) is derived from the unit states. It is never set by hand.

---

## 5. State

- **Owned:** only the owning unit mutates its state. No other code path writes it.
- **Serializable:** state must survive `structuredClone`. No functions, symbols, DOM nodes, or class instances that lose their prototype.
- **Exposure policy:** each state key is declared `private`, `readable` (through the control interface), or `persisted` (the kernel saves the persisted keys after each change of them, once for the changes of one task, and again at destroy). A key can be both `readable` and `persisted`.
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

### 5.1 Data of the signed-in user: each subsystem wipes its own

**Every subsystem is responsible for wiping the data of the signed-in user that it keeps.** Auth ends the session and announces it. Auth does not wipe the data of other subsystems, and the app does not wipe it for them. A subsystem knows what it keeps, so it is the only unit that can wipe all of it.

- **User data** is any value that came from, or describes, the signed-in user: profile fields, documents, messages, orders, cached private responses, queued changes, payloads, log context, tokens. Data of the device or the browser (a theme, the tab id, consent decisions of the browser) is not user data. Each subsystem decides for each state key and each collection, and documents the decision.
- **When.** A subsystem wipes when the user signs out (Auth leaves `AUTHENTICATED` and `EXPIRED` for `UNAUTHENTICATED`), and when a **different** user signs in (`user.id` changes). A refresh of the same user is not a sign-out.
- **The signal.** `auth:changed` is a Window broadcast, and a Tab-scoped unit cannot subscribe to it (§11.2). So a subsystem watches the state of Auth: `watchSignOut(ctx, listener)` of `@webkrnl/core` does it, with `auth` declared as an optional dependency. Auth adopts a sign-out from every tab of the site, so this one signal is enough in every tab. Views notify in batches, so a sign-out followed at once by the sign-in of another user arrives as `user-changed`, which wipes too.
- **What to wipe**, all of it, in the same step:
  1. the **state** keys with user data, back to their initial values;
  2. the **persisted state** (the kernel's persistence, `persisted` keys): the wiped state is persisted at once, so a reload cannot bring the old values back;
  3. the **Storage collections** with user data: `clear()`;
  4. **memory** outside state: caches, buffers, maps, secrets;
  5. the data in the subsystem's **processors** (workers): through a request to the processor.
- **Before the next user.** The wipe ends before the subsystem serves the next sign-in. A subsystem that cannot finish at once refuses work for the new user until it has finished.
- **Account deletion** is a sign-out plus `crypto.forget()` (§18.1), which also makes encrypted copies in backups unreadable.
- **Documentation.** Each package README states what the subsystem wipes, in a **Sign-out** row of its behaviour table, and what it keeps on purpose.

Conformance of the subsystems that exist now:

| Subsystem                                                                    | User data that it keeps                                                             | Wipes on sign-out                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| Auth                                                                         | The session, tokens, elevations                                                     | Yes                                                |
| Network                                                                      | Cached responses (memory and `network.cache*`)                                      | Yes (also aborts the requests in flight)           |
| Sync                                                                         | The outbox (`sync.outbox.*`), the pull cursors                                      | Yes                                                |
| Realtime                                                                     | Presence, the publish buffer, the Global outbox; the socket of the user             | Yes (the listeners stay: they belong to the app)   |
| Queue                                                                        | Dead letters (payloads, `queue.dead-letters`)                                       | Yes                                                |
| Logger                                                                       | Log entries with context (`logger.entries`), traces                                 | Yes                                                |
| Settings                                                                     | The `user` settings (for example `locale`); the `device` settings are not user data | Yes (the `user` settings return to their defaults) |
| Analytics                                                                    | The buffer and the waiting batches (`analytics.outbox`), the session id             | Yes (a new session starts)                         |
| Storage                                                                      | Only what other subsystems and the app put in it                                    | Not applicable: each owner clears its collections  |
| Crypto, Consent, Global State, Notification, hub, Translation, Design System | No user data (keys, decisions, catalogs, the theme and state of the device)         | Not applicable                                     |

Each of them uses `watchSignOut` of `@webkrnl/core`, which turns the state of Auth into the two reasons (`sign-out`, `user-changed`). Tests use `createTestAuth` of `@webkrnl/core/testing`. (Done in M8, §20.4.)

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
- A view is a **snapshot**, not a stream: a listener sees the latest value, not every intermediate one, and bounded lists drop old items between notifications. A consumer that needs every item (the Logger) uses an `observe` command, which pushes each one (§17).
- Bounded lists (logs, histories, trails) use `createRingBuffer`, which builds the frozen snapshot only when it is read after a change.

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

1. The resolver builds a graph of **features**. A cycle between subsystems is allowed when no cycle exists between their features. For example, Auth needs Network's transport and Network's interceptor feature needs Auth. Network's core does not need Auth, so the graph has no cycle. (M7 removes even this case: Auth adds its interceptor to Network, so Network does not depend on Auth, §19.1.)
2. A missing required dependency turns off **only the unit that declares it**. That unit's parent becomes `DEGRADED`.
3. A dependency that becomes `READY` later turns the waiting unit on. A dependency that leaves `READY` suspends the units that need it.
4. **Crypto must not depend on Network.** Key material comes from a bootstrap fetch or from injected config. Otherwise boot deadlocks.

### 7.2 Late binding for centralized subsystems

Some units start before the subsystems they eventually use. Examples: the Logger needs the NotificationCenter and Storage, the Queue's dead-letter store needs Storage, and GlobalState restore needs Storage. Such a unit declares the dependency as `optional` and binds to it **late**:

- Before the target is `READY`, writes go to a bounded in-memory buffer (`LateBinding`).
- When the target becomes `READY`, the buffer drains in order.
- On overflow, the oldest entries are dropped and counted.
- `ctx.watch(target, listener)` tells the unit when the target starts, stops, or restarts with a new control interface, so it can bind and unbind itself (added in M4, §17). A sink can also be bound from outside with a `bindSink`-style command.

This one mechanism covers the Logger's sink, dead-letter persistence, and GlobalState restore.

### 7.3 Mapping to npm

| Runtime dependency                          | `package.json`                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| required, by a subsystem's core             | `peerDependencies`                                                                                                         |
| optional, or only required by some features | `peerDependencies` + `peerDependenciesMeta.<pkg>.optional: true`, and a runtime presence check that turns the features off |
| `@webkrnl/core`                             | `peerDependencies` (every package)                                                                                         |

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
  readonly dedicated?: () => Worker; // new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })
  readonly shared?: () => SharedWorker; // new SharedWorker(new URL(...), { type: 'module', name })
}

type HostKind = 'shared' | 'dedicated' | 'virtual';
```

- The worker entry file calls `serveProcessor(module)` from `@webkrnl/core/worker`. It answers the handshake, calls, and heartbeats.
- Bundlers (Vite, webpack, Rollup) only detect `new Worker(new URL(..., import.meta.url))` written literally. That is why the definition, not the library, creates the worker.
- Hosts talk to workers over a small request/response protocol (handshake, call, ping, one-way post). The same protocol carries envelopes over `MessageChannel` transports.
- A unit's processors start before its `init` and stop during teardown. The context exposes them as `ctx.processor(id)`.

### 8.2 Hosts

| Host          | Implementation                                                                                                                                                                 | Use for                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **shared**    | `SharedWorker` (same origin, shared by all its tabs)                                                                                                                           | Origin-wide coordinators: the Storage writer, Crypto keys                                   |
| **dedicated** | `Worker` (`type: 'module'`)                                                                                                                                                    | CPU or I/O work for one tab: Sync, Realtime, Analytics aggregation, Translation compilation |
| **virtual**   | Main-thread scheduler: `scheduler.postTask` → `MessageChannel` macrotask → `setTimeout(0)`. Yields with `scheduler.yield()` when present. Idle jobs use `requestIdleCallback`. | Light coordination and the fallback for every physical processor                            |

`queueMicrotask` is used only for coordination steps that are very small. A microtask does not yield to the browser. `navigator.scheduling.isInputPending` is a hint about when to yield. It is not a host.

### 8.3 Hybrid failover

Every processor's host list must end with `virtual` (README: "should also define a virtual one"). The runtime moves a processor to the next host when one of these happens:

1. The host does not exist in this environment.
2. The worker fires an `error` or `messageerror` event.
3. The handshake does not complete before a timeout.
4. A shared-worker heartbeat is missed.

Work in progress at failover is re-run once on the next host. From M3, the Queue re-queues it instead. The host change and its cause are recorded on the processor's view. A failed physical host is not retried until the unit restarts.

The heartbeat (trigger 4) is on by default for shared hosts and off for dedicated hosts; both are configurable.

The handshake timeout (trigger 3) is 5 s by default. A processor definition can set its own `handshakeTimeoutMs`. The kernel option `processors.handshakeTimeoutMs` sets the timeout for each processor that does not set its own. The order is: the definition, then the kernel option, then 5 s. `createTestPlatform` sets the kernel option to 30 s, because the dev server can take more than 5 s to transform a worker module the first time, when many browsers run tests at the same time. A test that checks the `handshake-timeout` failover sets a short timeout on its definition.

### 8.4 Jobs

| Job           | Behavior                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| **Sink**      | Consumes a packet and updates internal state. Emits nothing.                                                 |
| **Scheduler** | Orders internal work and outgoing packets. Point-to-point (1-to-1). _Called "Queue" in the README. See §15._ |
| **Notifier**  | Emits broadcast packets through the formal protocol.                                                         |

### 8.5 Worker budget

The runtime limits physical workers to `clamp(navigator.hardwareConcurrency - 1, 1, maxWorkers)`. When the budget is used up, more processors fall back to their next host. Shared workers count once per origin.

### 8.6 Slice budget

A virtual processor yields within a configurable slice. The default is 5 ms. Work that regularly takes longer must declare a physical host first.

### 8.7 Processor configuration (M6)

A processor definition can carry a `config`: a structured-cloneable value. Every host gives it to `setup(scope, config)`. A worker host sends it in the `hello` handshake. A shared worker runs `setup` one time, with the config of the first tab that connects.

When `setup` throws, the host does not start and the runner fails over to the next host. A processor uses this to refuse a host that cannot do its job. For example, the Storage coordinator refuses a worker that has no persistent backend (§18.2).

### 8.8 Portable functions (M6)

Structured clone, `postMessage` and IndexedDB refuse functions, but a processor often needs code from its caller: a migration, a serializer, a query predicate, an eviction comparator. Function boundaries must not limit the design, so `@webkrnl/core` makes functions portable:

```text
  toPortable(value)    each function --> { __portable: 'function', id, source }   (the realm keeps id --> function)
  fromPortable(value)  same realm:  the original function, with its closure (no eval)
                       other realm: new Function(source)  (the function must be self-contained)
```

- A portable function must be **self-contained**: it uses only its parameters and the globals of the runtime. Closure variables, `this` and imports do not cross into another realm.
- Rebuilding needs `eval`. Under a Content Security Policy without `'unsafe-eval'`, `canEvaluate()` is `false`. A processor that runs portable functions checks it in `setup` and refuses the host (§8.7), so the runner fails over to the main thread, where the original functions come back from the registry.
- Zod schemas do not travel as functions. The caller's realm validates with the real schema, so refinements and transforms are never lost.

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

This keeps the split of the old `src/managers/packet.dto.ts` (ported to `@webkrnl/core`; the old code was deleted in M9). The `BasePacket` in `global_PROPOSAL.md` (with `eventId: symbol` and inline callbacks) is replaced by it.

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

|           | Queue                                                                              | NotificationCenter                                         |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Owns      | Scheduling: priority, admission, ordering keys, retry, back-pressure, dead letters | Routing: event registry, subscriptions, ACL, event history |
| Delivery  | 1-to-1, at least once, request/response                                            | 1-to-N, fire and forget per subscriber                     |
| Transport | `MessageChannel`, in-realm calls                                                   | In-realm dispatch + scope transports                       |

Queue admission reads GlobalState. When the platform is `BUSY`, only `CRITICAL` packets are admitted. `CRITICAL` packets go to the NotificationCenter synchronously. Other packets go in the next task.

### 10.1 How the three centralized subsystems fit together (M3)

Each is its own package (`@webkrnl/global-state`, `@webkrnl/queue`, `@webkrnl/notification`) and exports a factory. The Queue and the NotificationCenter also return a piece that plugs into the kernel or into each other, so no package imports another:

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
- 1-to-1: delivers through the kernel. A target that exists but is not running is retried with backoff (the backoff library moves to `@webkrnl/core`). After the last retry, or when the TTL passes, the packet becomes a dead letter and the request rejects. A target's own error (its `receive` threw) goes straight back to the requester: it is not retried, because retrying could repeat side effects.
- 1-to-N: hands the envelope to `fanOut` (the NotificationCenter), or to the kernel's direct broadcast when there is none.
- Dead letters are kept in memory and written through a `LateBinding` that Storage binds in M6.
- Records each settled packet's final fingerprint trail (`sent`, `enqueued`, `dispatched`, `delivered`, `completed` or `failed`).

**NotificationCenter** (`notification`)

- Routing only: the event registry, subscriptions, access control and history. No queue, no retries (A10).
- Subscribers are subsystems that list the event in `subscribes`, plus programmatic subscriptions (for adapters and UI code).
- Access control per event: which subsystems may publish it, and which may receive it.
- A circuit breaker per subscriber stops calling one that keeps failing, and retries it after a timeout.
- History: the last N broadcasts with one trail each, covering every delivery.
- In-realm subscribers are on the same page and tab, so Page and Tab broadcasts reach them all. Window (M5) and Global (M8) broadcasts also go to the **scope relay** attached for their scope (§11.3); envelopes from other tabs come back through the Queue.

**Kernel additions**

- `ctx.statuses`: every unit's lifecycle, read-only, for every unit.
- Centralized subsystems boot before featurized ones, and may only require other centralized subsystems.
- `kernel.subscribers(eventId)` lists the running subscribers of an event, and `kernel.deliver(envelope, { to, clone })` delivers a broadcast to one of them with its own copy.
- `kernel.scopeOf(id)` returns a subsystem's scope, so routers can check the send rule for envelopes they did not build.

---

## 11. Scopes

### 11.1 Boundaries and transports

| Scope      | Boundary                                                                                                                                                               | Broadcast transport                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Page**   | One document **and** route. Ends when the path changes (router or Navigation API hook) or the document unloads. A page restored from bfcache resumes from `SUSPENDED`. | In-realm dispatch                                                   |
| **Tab**    | One top-level browsing context, across the documents it loads. State moves between documents through `sessionStorage`.                                                 | In-realm dispatch                                                   |
| **Window** | All tabs of the same **site**, across its subdomains, in one browser profile session.                                                                                  | The **hub**, plus the relay where the browser partitions it (§11.3) |
| **Global** | All sessions and devices, through the **server**.                                                                                                                      | The Global transport (§11.4)                                        |

### 11.2 Send rule

- **Broadcasts** are limited to the sender's scope. A broadcast from scope _S_ spreads only within the boundary of _S_. Every subscriber inside that boundary receives it, whatever the subscriber's own scope ("receive from any").
- **1-to-1 requests** may target a subsystem in any reachable scope.
- **Replies** always return to the requester.

The Queue enforces this rule at admission.

### 11.2.1 Route changes for Page scope

Page scope ends on a path change. `core` detects it through a framework-neutral **route source**:

```ts
interface RouteSource {
  current(): string; // the path
  subscribe(listener: (path: string) => void): () => void;
}
```

The default route source uses the Navigation API when it is present, and otherwise falls back to `popstate` plus wrapping `history.pushState` and `history.replaceState`. A router adapter (for example `vue-router`'s `afterEach`) can replace it (§14.1).

### 11.3 Window scope: the hub and the relay

`BroadcastChannel`, `SharedWorker`, and IndexedDB are bound to an **origin**. Subdomains are different origins. Window scope therefore needs a hub, and, where the browser partitions the hub, a relay (amendment A11):

```text
 a.example.com tab                     b.example.com tab
 ┌──────────────┐                      ┌──────────────┐
 │ app          │                      │ app          │
 │  └ iframe ───┼── postMessage ──┐ ┌──┼── iframe     │
 └──────────────┘                 ▼ ▼  └──────────────┘
                      example.com/__platform/hub.html  (hub page, on the apex)
                      BroadcastChannel on the apex origin
        │                                                      │
        └──── relay: the Global transport (§11.4), only ───────┘
              where the hub is partitioned
```

**The hub**

- The `@webkrnl/hub` package ships a static hub page. The app deploys it on the **apex** origin of the site (for example `https://example.com/__platform/hub.html`; the path is configurable).
- The apex must allow its subdomains to frame the hub page: `Content-Security-Policy: frame-ancestors https://example.com https://*.example.com`, and no `X-Frame-Options` header on that path (`SAMEORIGIN` would block subdomains, because they are different origins).
- Tabs on the apex itself are on the hub's origin. They join the hub's `BroadcastChannel` directly, without an iframe.
- The iframe checks `event.origin` against an allowlist of the site's origins, and the hub does the same. Messages are envelopes only.
- **Single-origin apps** use the same interface without an iframe. The hub runs on the app's own origin through `BroadcastChannel`.

**Partitioning (the M5 spike, `spikes/m5-hub/FINDINGS.md`)**

- Chromium-based browsers give every framed copy of the hub one partition: the hub works as designed. Firefox keys partitions by site and is expected to do the same (unverified on the development machine).
- **WebKit (Safari, and every browser on iOS) partitions the hub's `BroadcastChannel`, IndexedDB and `SharedWorker` by the top-level origin.** A hub framed by `a.example.com` never meets one framed by `b.example.com`.

**Detecting it.** Every hub keeps a random **partition id** in its IndexedDB, which is partitioned the same way as its `BroadcastChannel`. The client compares it with a session cookie on the apex domain (`Domain=example.com`, `SameSite=Lax`), which top-level pages on every subdomain share in every browser. The first tab writes its partition id; a tab whose id matches marks the hub `shared`; a tab whose id differs marks it `partitioned`. Until a second origin has connected, the hub is `unknown`. The same cookie carries the **window id**, a random id for this browser session, which the relay uses.

**The relay.** While the hub is not known to be `shared`, the client also sends every Window broadcast to the **relay**: the Global transport (§11.4), which forwards a Window-scope envelope to every connection that presented the same window id. Receivers deduplicate by `messageId`, so a broadcast that arrives through both paths is delivered once. Without a Global transport, Window scope on a partitioned browser reaches only the tabs on the same origin.

**Reach.** The client exposes its reach: `site` (the hub is shared, or the relay is connected), `origin` (the hub is partitioned and there is no relay), or `unknown`. Apps that need cross-subdomain delivery on every browser configure a Global transport.

**In the kernel.** The Window client is a subsystem (`window`). It attaches to the NotificationCenter as a **scope relay**: after a local fan-out, the NotificationCenter hands every locally sent Window broadcast to it. Envelopes from other tabs enter through the Queue (`ingest`), which deduplicates them and fans them out locally; the sender's exclusion applies only to the tab that sent it.

### 11.4 Global scope: the server

Global scope is **server-backed**. Its transport is a feature of Realtime, with Network as the fallback:

- **Online:** envelopes travel over WebSocket or SSE. If neither is available, HTTP long-polling is used.
- **Offline:** the Queue persists outgoing Global packets (through Storage) and replays them on reconnect.
- **Delivery:** at least once. Receivers deduplicate by `messageId`.
- **Window relay:** a Window-scope envelope carries the sender's `window` id. The server forwards it to every other connection that presented the same window id, and nowhere else (§11.3).
- **Wire protocol:** a versioned JSON envelope schema, published in `@webkrnl/core`, which servers implement. This project ships **only the wire protocol**: the schema, its documentation, and conformance fixtures. Servers are built by the app's own backend. The test suite uses a minimal in-memory test double that is never published.

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

| Subsystem          | Kind        | Scope                               | Preferred hosts              | Required deps (core)                                                             | Proposal            |
| ------------------ | ----------- | ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| GlobalState        | centralized | Tab                                 | virtual                      | —                                                                                | `global`            |
| Queue              | centralized | Tab                                 | virtual                      | GlobalState                                                                      | `queue`             |
| NotificationCenter | centralized | Tab                                 | virtual                      | GlobalState, Queue                                                               | `notification`      |
| Logger             | featurized  | Tab                                 | virtual                      | — (late-bound: NotificationCenter, Storage)                                      | `logger`            |
| Crypto             | featurized  | Tab (key cache shared per origin)   | shared → dedicated → virtual | —                                                                                | `crypto`            |
| Storage            | featurized  | Tab (coordinator shared per origin) | shared → virtual             | — (uses the key store of `@webkrnl/crypto`)                                      | `storage`, backends |
| Consent            | featurized  | Window                              | virtual                      | — (grants persist through the kernel's persistence, which Storage backs from M6) | `consent`           |
| Settings           | featurized  | Window                              | virtual                      | Consent (Auth optional, §21.1)                                                   | `settings`          |
| Network            | featurized  | Tab                                 | virtual                      | — (GlobalState optional, §19.1)                                                  | `network`           |
| Auth               | featurized  | Window                              | virtual                      | — (Network optional; Storage and Crypto late-bound, §19.2)                       | `auth`              |
| Sync               | featurized  | Tab                                 | virtual                      | Network (Storage late-bound, §19.3)                                              | `sync`              |
| Realtime           | featurized  | Tab (hosts the Global transport)    | dedicated → virtual          | — (Auth optional, §19.4)                                                         | `realtime`          |
| Translation        | featurized  | Tab                                 | virtual (compile: dedicated) | — (Storage, Network and Settings late-bound, §21.2)                              | `translation`       |
| Analytics          | featurized  | Tab                                 | virtual                      | Consent (Network, Storage and Settings optional, §21.3)                          | `analytics`         |
| Design System      | featurized  | Page                                | virtual                      | — (Settings and Translation optional, §21.4)                                     | `design-system`     |

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
  create/               scaffolder (the npm template), published as @webkrnl/create
                        so that `npm init @webkrnl` runs it
  vue/                  optional adapter (§14.1)
  react/                optional adapter (§14.1), considered later
```

- Scope name: `@webkrnl/*` (the project is **WebKrnl**, decided 2026-10-06). The version stays `0.0.2` until all milestones and the alpha validation are done (docs/PLAN.md §4.1).
- Each package exports `.` (factory, packet types, state types). Worker entries are separate exports (`./worker`, `./shared-worker`). The package spawns them with `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`, so bundlers can find them.
- All packages share one version (fixed versioning).
- `platform` is the only package with hard `dependencies` on other subsystems. Every other package uses peer dependencies (§7.3).

### 14.1 Framework adapters

An adapter exists only where a framework can do something better than the neutral contracts. It never adds behavior that the core lacks.

| Adapter          | Scope of the package                                                                                                                                                                                                                                                      | Priority                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `@webkrnl/vue`   | `useView(view)` → `Readonly<ShallowRef<T>>` (subscribes, and unsubscribes on scope dispose); a Vue plugin that boots `platform` and `provide`s it, read with `usePlatform()`; a `vue-router` route source (§11.2.1); Page-scope units tied to component or route lifetime | First. Built in M10.       |
| `@webkrnl/react` | `useView` on top of `useSyncExternalStore`; a context provider; route sources for common routers                                                                                                                                                                          | To be considered after 1.0 |

`vue`, `vue-router`, `react`, and router packages are **peer dependencies** of their adapter only.

---

## 15. Amendments to `proposals/README.md`

| #   | Amendment                                                                                                                                                                 | Status  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | Scope send restrictions apply to **broadcasts only**. 1-to-1 requests may target any scope, and replies always return.                                                    | Decided |
| A2  | **Window** scope spans subdomains of one site, through a hub (§11.3). "session-bound" is replaced by "window-bound".                                                      | Decided |
| A3  | **Global** scope is server-backed (§11.4).                                                                                                                                | Decided |
| A4  | Cross-boundary tracing uses `traceId` stitching, not returned fingerprints (§9.4).                                                                                        | Decided |
| A5  | Subsystems and features share one `Unit` model. The initializer's token is the disposer (§3).                                                                             | Decided |
| A6  | The "Queue" job is renamed **Scheduler**, to avoid clashing with the Queue subsystem (§8.4).                                                                              | Decided |
| A7  | "Payload accessed once" means once **per delivery** (§9.2).                                                                                                               | Decided |
| A8  | One lifecycle state machine, adding `DEGRADED` and `SUSPENDED` (§4).                                                                                                      | Decided |
| A9  | Control-interface "setters" are commands the unit performs on itself (§6).                                                                                                | Decided |
| A10 | The NotificationCenter holds no queue. All packets enter through the Queue (§10).                                                                                         | Decided |
| A11 | Window scope uses the hub where the browser gives it one partition, and the Global transport as a relay where it does not (WebKit); the client reports its reach (§11.3). | Decided |

## 16. Corrections to the per-subsystem proposals

| Proposal        | Correction                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `global`        | Replace `BasePacket` (`eventId: symbol`, inline callbacks) with the envelope and callback split (§9.1). Derive the platform status (§4).                                                                                               |
| `notification`  | Remove the event queue, retry, and dead-letter logic. Delegate to the Queue (§10).                                                                                                                                                     |
| `queue`         | The NotificationCenter does not poll the Queue. The Queue pushes broadcasts to it (§10). Dead letters are late-bound to Storage (§7.2).                                                                                                |
| `logger`        | No required dependencies. NotificationCenter and Storage are late-bound (§7.2). Trimmed in M4 (see the proposal's amendments).                                                                                                         |
| `consent`       | Grants persist through the kernel's persistence, not a direct Storage dependency. Retention and data-subject requests wait for Storage (M6).                                                                                           |
| `auth`          | Remove `credentialCache.hashedPassword`. Password hashing belongs on the server. Handlers replace endpoints, and tokens are never in unit state (§19.2).                                                                               |
| `network`       | Runs on the main thread only. Offline requests fail at once; Sync keeps work for later. Auth adds its own interceptor, so Network has no dependency on Auth (§19.1).                                                                   |
| `sync`          | Runs on the main thread. An outbox with idempotency keys and a Web Lock replaces the offline change map (§19.3).                                                                                                                       |
| `realtime`      | The protocol is pluggable. Network is not a dependency: the backoff comes from core (§19.4).                                                                                                                                           |
| `crypto`        | Keep the rule that Crypto has no Network dependency (§7.1). Keys persist in IndexedDB as non-extractable `CryptoKey` objects (§18.1).                                                                                                  |
| `storage`       | The backends run inside the coordinator processor, not as kernel features. Interactive transactions become atomic batches. The coordinator runs the pipeline with portable functions, and the caller validates with zod (§8.8, §18.2). |
| `design-system` | The proposal was empty. It is written in M9: tokens and theme only (§21.4).                                                                                                                                                            |
| `settings`      | Settings are definitions with defaults and validation, `device` or `user`; built-in and app settings share one store. Optional `load` and `save` handlers keep the user settings on the server (§21.1).                                |
| `translation`   | ICU MessageFormat only, parsed by the package; the `plurals` map is dropped. Storage, Network and Settings are optional. Catalogs refresh with `ETag` through Network, not Sync (§21.2).                                               |
| `analytics`     | The main thread only, because the `pagehide` beacon needs the payload at once. Sampling is for each session. Batches carry an `Idempotency-Key` (§21.3).                                                                               |
| `tab-count`     | A feature of Global State, with Web Locks and a `BroadcastChannel` fallback. The `SharedWorker` and `localStorage` strategies are dropped (§21.5).                                                                                     |

---

## 17. Pilot retrospective (M4)

Porting the Logger and Consent onto the kernel tested the unit contract on real subsystems. What caused friction, and what changed:

| Friction                                                                                                                                                      | Change                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A late-bound unit had a buffer (`LateBinding`) but no way to notice its target start or stop, so something outside had to bind it.                            | `ctx.watch(target, listener)`: called at once and whenever the target's control interface changes; stops on teardown (§7.2).               |
| Errors a unit recovers from (a failed sink write, a refused broadcast) had nowhere to go but `console`.                                                       | `ctx.report(error)`: sends it to the kernel's `onError` without changing the lifecycle.                                                    |
| Views are snapshots: between notifications, the Queue's `trails` and the Notification Center's `history` can drop records, so a log built on them loses some. | `observe(observer)` on the Queue and the Notification Center pushes every record (§6.1).                                                   |
| A bounded list in `createStore` copied and froze the whole array on every append.                                                                             | `createRingBuffer` in core; the Queue's trails, the Notification Center's history and the Logger's rings use it.                           |
| What `init` builds (the Logger's `log` function, which needs the context) is not reachable from `control` except through a closure variable.                  | No change yet. The closure is simple and local; revisit if more subsystems need it.                                                        |
| The catalogue made Consent require Storage, which does not exist until M6.                                                                                    | Persisted state already goes through the kernel's `persistence`; Storage will back that adapter. Consent has no required dependency (§13). |

The unit shape itself (state with a policy, views, commands, optional dependencies, `receive` and `subscribes`) needed no change.

---

## 18. Crypto and Storage (M6)

This section is the design of milestone M6. It amends the `crypto` and `storage` proposals, and the proposals of the five backends.

### 18.1 Crypto

`@webkrnl/crypto` gives the subsystem `crypto` (featurized, Tab scope, no required dependency). Its work runs in the processor `crypto`, on the hosts `shared`, then `dedicated`, then `virtual`.

```text
  caller --> crypto.commands.encrypt(text) --> processor 'crypto' (shared worker, or fallback)
                                                 key registry: non-extractable CryptoKey objects
                                                 IndexedDB '__platform_crypto' (the same on every host)
            <-- 'v1.<keyId>.<iv>.<ciphertext>' --+
```

- **Keys are non-extractable.** The platform can use a key but cannot read its bytes.
- **Keys persist in IndexedDB** as `CryptoKey` objects. IndexedDB stores them by structured clone and does not expose the key material. Every host and every session therefore uses the same keys, and data that Storage encrypted yesterday decrypts today. Without IndexedDB, keys stay in memory and Crypto reports that encrypted data does not survive a reload.
- **Key sources.** `device` (the default) makes the keys on first use and persists them. `material` imports raw key material that the app injects. `fetch` gets the material from a URL at boot with a plain `fetch`, without the Network subsystem (§7.1, rule 4).
- **Operations.** AES-GCM 256 encryption with the key id in the token, HMAC-SHA-256 tags, ECDSA P-256 signatures with an exportable public key, and SHA-256, SHA-384 and SHA-512 digests.
- **Rotation.** `rotate(purpose)` makes a new active key. The old keys stay, so old data still decrypts and old tags still verify.
- **Forgetting.** `forget()` deletes the persisted keys. The data that they encrypted can then never be read again (crypto-shredding). Consent and Auth can use it for an erase request.
- **WebKit:** a shared worker cannot store a `CryptoKey` in IndexedDB ("The object can not be cloned"). Setup then throws, and the runner fails over to a dedicated worker, which can. The keys are still shared through IndexedDB (found in the M6 browser tests).
- **Teardown** clears the keys from memory.
- Dropped for now: key derivation (PBKDF2, HKDF), a rotation timer, and the expiry of old keys.

### 18.2 Storage

`@webkrnl/storage` gives the subsystem `storage` (featurized, Tab scope, no required dependency). It uses the key store of `@webkrnl/crypto` for encryption.

```text
  tab (main thread)                     coordinator processor (shared worker --> virtual)
  collection.set(key, value)            one writer for the origin, operations in order
    validate (zod, full schema)         backend chain chosen in setup():
    --> value + portable definition -->   worker:  indexeddb --> opfs --> cache
                                          virtual: indexeddb --> opfs --> cache --> localstorage --> sessionstorage --> memory
                                        write: serialize --> compress? --> encrypt + HMAC? --> envelope --> backend
                                        read:  backend --> verify --> decrypt --> decompress --> parse
                                               --> migrate (and write back) --> query predicate
  collection.get(key) <-- value ------
    validate (zod, full schema)
  change --> BroadcastChannel --> every tab --> 'storage:changed' (Tab broadcast) and collection listeners
```

- **The backends are modules inside the coordinator**, not kernel features. They run in the worker, so they cannot be units of the main-thread kernel. The state of the subsystem reports the active backend and the probe result of each backend.
- **Backend selection.** The coordinator probes the chain in `setup` (§8.7). A worker host with no persistent backend refuses to start, so the runner fails over to the virtual host. There, `localStorage` and `sessionStorage` exist, and `memory` is the last fallback.
- **Collections.** Callers use `commands.collection(definition)`. A definition names the calling module and can give a schema (zod, or any object with `safeParse`; the package has no dependency on zod), a schema version with migrations, a time to live, an eviction weight, encryption, compression and a maximum number of entries. Keys are canonical: `<domain>:<platform>:<platformVersion>:<module>:<key>`.
- **Payload format.** A payload is `<flags>:<data>`. The flag `z` means gzip and `e` means AES-GCM. A read undoes what the flags say, so a collection can turn on compression or encryption later. The HMAC tag of an encrypted entry is `envelope.integrity`. (The M6 tests found that the IndexedDB and OPFS backends dropped `integrity`; they keep it now.)
- **Pipeline in the coordinator.** The coordinator runs the pipeline, as the proposal intended: serialization, compression, encryption and the HMAC tag on a write, and the reverse with migration on a read. The functions of a collection (serializers, migrations, query predicates, eviction comparators) travel to the worker as portable functions (§8.8). The caller validates with the zod schema before a write and after a read, in its own realm, so the full schema applies.
- **Encryption without a second hop.** The coordinator opens the key store of `@webkrnl/crypto` itself. It reads the same IndexedDB keys as the Crypto subsystem, so Storage and Crypto use the same keys, and a write needs no message to another worker. Storage reloads the keys when Crypto broadcasts `crypto:keys-changed`.
- **Strict CSP.** A worker that cannot evaluate portable functions refuses to start, so the coordinator runs on the main thread.
- **Keys in setup.** The coordinator opens the key store in `setup`. A worker that cannot open it refuses to start. WebKit cannot store a `CryptoKey` in IndexedDB from a shared worker (§18.1), so there the coordinator runs on the main thread. On the main thread, a failure to open the keys does not stop Storage: the key store opens again at the first encrypted operation. Give `createStorage` the same key source as `createCrypto`.
- **Hosts.** The default hosts are `shared`, then `virtual`. A dedicated worker per tab would add a second writer for no gain, because IndexedDB is the same on both hosts.
- **Batches instead of interactive transactions.** A transaction that stays open across messages to a worker would hold locks across tasks. `batch(operations)` sends all writes and deletes together, and the coordinator runs them in one backend transaction.
- **Writes are idempotent.** When a host dies during a write, the runner runs the write again on the next host. Both hosts use the same database, so no data is lost.
- **Migrations.** A read migrates an old entry and writes it back. `migrate()` migrates a whole collection in one batch.
- **Integrity.** With Crypto, an encrypted collection stores an HMAC tag. A wrong tag returns no value, broadcasts `storage:corrupt` and reports the error.
- **Quota.** The subsystem checks the quota on an interval. At the warning level it broadcasts `storage:quota`. At the critical level it also evicts expired entries first, then the entries with the lowest weight.
- **Kernel persistence.** `createStatePersistence()` gives the kernel's `persistence` option. It uses IndexedDB (or `localStorage`, then memory) on the main thread directly, because the kernel loads state before Storage runs.
- **Late binding.** The Queue keeps its dead letters, and the Logger its entries, in collections when Storage runs (`ctx.watch`). Dead letters survive a reload.
- **Order.** The coordinator handles one request at a time, so the writes of all tabs apply in order. `maxEntries` trims the oldest entries of a collection after a write. When more than one coordinator runs, a Web Lock keeps the order (§18.3).
- Dropped for now: range queries on indexes, compaction, backups, an in-memory read cache, field-level encryption, and the WebSQL and cookie fallbacks of the proposal.

### 18.3 Storage: the open items of M6

The week 40 report listed three open items after M6. This section closes them, before M7.

**1. Storage and Crypto use the same keys (key check).** Storage and Crypto take their key source separately, and nothing checked that they match. When they do not match, `crypto.forget()` does not erase the data of Storage, so crypto-shredding fails without a sign.

- A key id is not secret, and the same source always gives the same ids: device keys come from the same database, and the id of injected material is a digest of the material. So Storage compares the ids of its active encryption and HMAC keys with the ids in the state of Crypto.
- Storage checks when Crypto starts (`ctx.watch`), and again after it reloads its keys on `crypto:keys-changed`.
- The state of Storage shows the result: `keyCheck` is `match`, `mismatch` or `unchecked` (no Crypto, or no encryption).
- On `mismatch`, Storage reports a `KeyMismatchError` and refuses encrypted writes (fail closed). Reads still work, so the app can move its data.
- Storage does not read the key source of Crypto: a material source holds secret key bytes, and state is readable by every unit.

**2. Query indexes.** A `where` filter decodes every entry of a collection. A collection can now declare indexes:

```text
  commands.collection({ name: 'orders', indexes: { status: (order) => order.status, tag: (order) => order.tags } })
  orders.lookup('status', 'open')          equality only; an array value makes one index entry per item
```

- An index function is a portable function. It runs in the coordinator on the value of each write.
- Index entries live in a reserved module of the namespace, `<collection>~index`, in the same backend. The `~` is not valid in a collection name, so no collection can use it.
- An index entry key is `<index>:<value>:<key>`, with the value and the key URI-encoded. A lookup is one prefix query, then a read of each matching entry.
- A reverse entry (`@:<key>`) lists the index values of each entry, so a write or a delete removes the old index entries without decoding the old value.
- **Encrypted collections** do not store index values in plain text. The value part is an HMAC of the value with the active HMAC key. A lookup tries every HMAC key of the store, so a rotation does not hide old entries.
- Expired or deleted entries can leave stale index entries. A lookup removes the stale entries that it finds.
- After a change to the index functions, `collection.reindex()` builds all index entries again. `clear()` clears the index module too.
- Dropped for now: range queries and sorting by an index.

**3. Two coordinators.** On WebKit, every tab runs its own coordinator on the main thread (§18.2). A tab after a failover does the same. Two coordinators can interleave their writes.

- Each request of the coordinator runs inside a Web Lock (`navigator.locks`), named after the database. Reads take the lock in `shared` mode. Writes, batches, migrations and evictions take it in `exclusive` mode.
- The lock queue is first-in, first-out for the origin, so the writes of all tabs apply in one order on every host.
- Without the Web Locks API (WebKit before 15.4), the coordinator runs as before, and its status says `locks: false`.

---

## 19. Connectivity: Network, Auth, Sync and Realtime (M7)

This section is the design of milestone M7. It amends the proposals `network`, `auth`, `sync` and `realtime`.

```text
  app / subsystems
     |  network.request()            auth.login() / hasPermission()     sync.entity('todos').save()     realtime.subscribe('chat')
     v                                    |                                  |                                |
  Network  <-- interceptor (Auth) ---------+                                  |                                |
  retries, timeouts, dedup, cache,        token, refresh, 401 retry           outbox (Storage), push/pull,     socket in a dedicated worker,
  circuit breaker, offline check          status to every tab (Window)        conflicts, one replayer (lock)   reconnect, heartbeat, topics
     |                                                                         |
     +---------------------- fetch -------------------- server <---------------+ (through Network)
```

Every package depends on `@webkrnl/core`. Global State is optional everywhere: without it, the online and visible states come from `navigator.onLine` and `document.visibilityState`.

### 19.1 Network

`@webkrnl/network` gives the subsystem `network` (featurized, Tab scope, no required dependency). It runs on the main thread (virtual host only): a `Response` body is a stream, and callers need it in their own realm.

- **Requests.** `commands.request(config)` and the shorthands `get`, `post`, `put`, `patch` and `delete`. The result is a `NetworkResponse` with `status`, `headers`, `data` (parsed by content type), `fromCache` and `attempts`. Each request has an id, and `abort(id)` and `abortAll()` cancel requests.
- **Timeouts.** Each request has a timeout (default 30 s). A timeout is a `NetworkTimeoutError`, not a network error.
- **Retries.** A network error or a retryable status (408, 425, 429, 500, 502, 503, 504) retries with `computeBackoff` (§8, core). The Network honours `Retry-After`. Only idempotent methods retry, or a request that carries an `idempotencyKey` (sent as the `Idempotency-Key` header).
- **Deduplication.** Identical in-flight `GET` requests share one fetch.
- **Concurrency.** At most `maxConcurrent` requests (default 6) run at the same time. The others wait in priority order.
- **Cache.** Strategies `network-only` (default), `network-first`, `cache-first` and `cache-only`, with a time to live. A cached entry with an `ETag` makes the next request conditional (`If-None-Match`), and a `304` reuses the cached body. The cache is in memory. When Storage runs, it is also kept in Storage (late binding, §7.2). The option `persistCache: { encrypt, compress }` (and `cachePersist` on one request) decides how: encrypted by default, compressed on request, or `false` for memory only. A call site can turn either off to save the time of that step. Storage sets encryption and compression for each collection, so each choice has its own collection (`network.cache`, `network.cache.e`, `network.cache.z`, `network.cache.ez`). When an encrypted write is not possible (no keys, or a key mismatch, §18.3), the response stays in memory only: it is never stored in plain text instead. (Added after M7, from item 11 of the week 40 report.)
- **Offline.** When the platform is offline, a request fails at once with `OfflineError`, unless the cache can answer. Sync, not Network, keeps work for later.
- **Circuit breaker.** After `breaker.threshold` consecutive failures (default 5) to one origin, the breaker opens for `breaker.cooldownMs` (default 30 s). Requests then fail at once with `CircuitOpenError`. One trial request closes it again.
- **Interceptors.** `commands.intercept({ request?, response? })` adds an interceptor and returns the function that removes it. A request interceptor can change the request. A response interceptor can ask the Network to send the request one more time (for example, after a token refresh). Auth uses this.
- **Pending work.** Each request that is not `background` registers as pending work in Global State while it runs.
- **State.** `online`, `inFlight`, `waiting`, the breaker of each origin, and counters (requests, failures, cache hits and misses).
- Dropped for now: request batching, request compression, rate limits per endpoint (except `Retry-After`), progress events, and a worker host.

### 19.2 Auth

`@webkrnl/auth` gives the subsystem `auth` (featurized, **Window** scope). Network is optional. Storage and Crypto are optional and late-bound.

- **Handlers, not endpoints.** The app gives the functions that talk to its server: `login(credentials, tools)`, `refresh(session, tools)`, and optionally `logout`, `elevate` and `restore`. `tools` has the Network (when it runs) and `fetch`. Auth does not know the shape of the credentials, so MFA, OAuth and passkeys stay in the app's handlers.
- **Tokens.** A session has an access token, a refresh token, their expiry times, and the user (`id`, `roles`, `permissions`, `level`). Auth refreshes the access token `refreshBeforeMs` before it expires (default 60 s). One refresh runs at a time. A failed refresh retries with backoff, then sets the status to `EXPIRED`.
- **Token storage.** When Storage runs, the session is kept in the encrypted collection `auth.session`, so a reload keeps the user signed in. Without Storage, the session is in memory only. Tokens are never in the unit state, which every unit can read.
- **Every tab.** Auth broadcasts `auth:changed` in **Window** scope with the status and the user id, never a token. A tab of the same origin then loads the session from Storage. `logout()` broadcasts too, so every tab of the site signs out.
- **Other subdomains: `restore`.** Storage is per origin, so a tab on another subdomain gets the status, not the tokens, and tokens never travel through the hub or the Window channel. Instead, the server keeps the session in an `HttpOnly; Secure; SameSite=Lax` cookie on the apex domain, which every subdomain sends and no script can read. The optional handler `restore(tools)` asks the server for a session for this origin, and the cookie proves the user. Auth calls it at start when no session is stored, and when another tab announces a sign-in that this tab cannot load from Storage. One restore runs at a time, it does not count as a failed login, and `null` means that the server has no session. The `logout` handler must also clear the cookie on the server. (Added after M7, from item 12 of the week 40 report.)
- **Network interceptor.** When Network runs, Auth adds an interceptor. It sends `Authorization: Bearer <token>` only to the origins in `protectedOrigins` (default: the page origin), so a token never goes to a third party. A `401` refreshes the token one time and sends the request again.
- **Permissions.** `hasPermission`, `hasRole` and `check({ permissions, roles, level })` read the user of the session. Elevations (`elevate(permissions, durationMs, reason)`) come from the app's `elevate` handler. They live in memory and expire.
- **Lockout.** After `lockout.maxAttempts` failed logins (default 5), `login` fails at once with `AuthLockedError` for `lockout.durationMs`. The server stays the authority.
- **Status.** `UNAUTHENTICATED`, `AUTHENTICATING`, `AUTHENTICATED`, `EXPIRED` or `ERROR`.
- Removed: `credentialCache` with `hashedPassword` (§16), the cookie manager, and password policies (server work).
- Dropped for now: session listing, password change, protected route and element registries (adapter work, M10), and device fingerprints.

### 19.3 Sync

`@webkrnl/sync` gives the subsystem `sync` (featurized, Tab scope). Network is **required**. Storage is optional and late-bound.

- **Virtual host.** The work of Sync is requests through Network, which runs on the main thread, so a dedicated worker gives no gain. The catalogue row changes to `virtual`.
- **Entities.** `commands.entity(definition)` declares an entity type: its `push` handler, and optionally `pull`, `apply`, `merge` and a conflict strategy. Like Storage collections, it returns a handle: `save(id, data)`, `remove(id)`, and `pending()`.
- **Outbox.** Each change goes to an outbox: `{ id, entity, entityId, op, data, createdAt, attempts }`. When Storage runs, the outbox is the collection `sync.outbox`, so changes survive a reload. Without Storage it is in memory, and `state.persistent` is `false`.
- **No duplicates.** Each change has a stable `id`. The push handler gets it and sends it as the `Idempotency-Key`, so a retried change is applied once by the server. A change leaves the outbox only after the server confirms it. Two changes to the same entity that wait together become one (the last data wins, a delete wins over an update, and a delete after a create removes both), but only when the waiting change was never sent: a sent change may be applied already, so its key must keep its data. The outbox runs its operations in one queue, so a reload of the collection never drops a new change. After a transient failure, later changes to the same entity wait, so they keep their order.
- **One replayer.** The outbox is shared by every tab of the origin. A replay runs inside the Web Lock `platform-sync:<database>`, so two tabs never push the same change at the same time.
- **When it syncs.** On `syncNow()`, after each change when online, when the platform comes back online, on an interval (default 5 minutes, only while visible), and at start.
- **Failures.** A transient failure (offline, timeout, `5xx`, `429`) keeps the change and retries with backoff. A permanent failure (another `4xx`) moves the change to `failed`, reports it, and broadcasts `sync:failed`. `retryFailed()` puts failed changes back.
- **Conflicts.** A push handler returns `{ conflict: remote }` for a `409`. The strategy decides: `server-wins` (drop the change, `apply` the remote data), `client-wins` (push again with `force`), `merge` (the entity's `merge(local, remote)`), or `manual` (keep it in `conflicts` until `resolve(id, choice)`).
- **Pull.** A `pull(cursor)` handler returns changes and a new cursor. Sync gives each change to `apply`, then keeps the cursor (in Storage when it runs).
- **Pending work.** The outbox is pending work in Global State until the server confirms each change: one entry for each entity type, with the count in its label ("3 changes to todos waiting"). One entry for each change would make a long offline outbox look like a busy platform, and `BUSY` refuses work (§4). The entry changes in the same step as the outbox, so what the user sees always matches it. Each tab reads the outbox again when another tab changes it (`storage:changed`).
- **Status.** `IDLE`, `SYNCING`, `OFFLINE`, `PAUSED` or `ERROR`, with `pending`, `failed`, `conflicts` and `lastSyncAt`. Broadcasts: `sync:completed` and `sync:failed`.
- Dropped for now: delta computation and checksums (the server's pull gives deltas), compression, and bandwidth modes.

### 19.4 Realtime

`@webkrnl/realtime` gives the subsystem `realtime` (featurized, Tab scope, no required dependency). Auth is optional.

- **Socket in a worker.** The processor `socket` owns the `WebSocket`, on the hosts `dedicated`, then `virtual`. A worker keeps heartbeats on time when the main thread is busy. The processor posts each incoming message and each status change to the unit (`scope.post`, §8).
- **Protocol.** The default protocol is JSON frames: `{ type: 'subscribe' | 'unsubscribe' | 'publish' | 'message' | 'ping' | 'pong' | 'presence', topic?, data? }`. An app with another protocol gives `protocol: { encode, decode }` as portable functions (§8.8).
- **Reconnect.** A dropped socket reconnects with `computeBackoff`, while the platform is online and `maxAttempts` is not reached. Going online reconnects at once.
- **Heartbeat.** A `ping` every `heartbeatMs` (default 25 s). No `pong` within `heartbeatTimeoutMs` (default 10 s) closes the socket and reconnects.
- **Topics.** Many topics share one socket. `subscribe(topic, listener)` returns the function that unsubscribes. Every topic subscribes again after a reconnect. Messages to a topic go to its listeners and, with `broadcast: true`, as the Tab broadcast `realtime:message`.
- **Publish.** `publish(topic, data)` sends at once when open. Otherwise it waits in a bounded buffer (default 100) and goes out after the next open.
- **Presence.** `presence` frames update a map of peers (`online`, `away`, `offline`, `lastSeen`). A peer with no news for `presenceTimeoutMs` becomes `offline`.
- **Auth.** With `auth: 'query'`, the access token of Auth goes in the URL (`?access_token=`). With `auth: 'message'`, it goes in the first frame. The socket reconnects when the token changes. Prefer `message`: a URL can end up in the logs of servers and proxies, and a frame does not.
- **Status.** `connecting`, `open`, `closing`, `closed` or `reconnecting`, with `attempts` and `lastError`. Broadcast: `realtime:connection-changed`.
- The Global transport is a feature of Realtime in M8 (§11.4), not M7.

### 19.5 The gate

The M7 gate is an offline-to-online test in Node, with the real Global State, Queue, Notification Center, Storage, Network and Sync, and a fake server:

1. The platform goes offline. The app saves changes, some of them to the same entity. Nothing is sent. The counts in the pending work of Sync in Global State always equal the outbox.
2. The platform goes online. Sync replays the outbox. The fake server fails some pushes in two ways: a `503`, and a dropped response after the change was applied.
3. Every change is applied by the server exactly once (counted by idempotency key), the outbox is empty, and the pending work is zero. At every step of the test, the pending work equals the real state of the outbox.

---

## 20. Global scope (M8)

This section is the design of milestone M8. It makes §11.4 concrete, gives WebKit browsers the Window relay of §11.3, and applies the sign-out rule (§5.1) to the subsystems that did not follow it yet.

```text
  device A                                   server                                   device B
  unit (scope 'global') --broadcast-->                                                 Queue.ingest (dedupe by messageId)
    Notification Center --global relay-->   'platform:global'                           --> local fan-out
      Realtime feature 'global'              forwards to the other connections         ^
        outbox (Storage) until 'ack' ------> of the same audience, and acks ----------+
        socket open?  yes: socket frames
                      no, online: HTTP through Network (POST publish, GET poll)
                      offline: wait in the outbox (it survives a reload)
```

### 20.1 The Global transport

- **A feature of Realtime.** `createRealtime({ url, global: { ... } })` adds the feature `global` to Realtime. It uses the Realtime socket, so it shares the connection, the reconnects, the heartbeats and the Auth token. When the feature fails, Realtime is `DEGRADED`, not `FAILED`.
- **Reserved topics.** Global envelopes travel on the topic `platform:global`, and Window envelopes of the relay on `platform:window:<windowId>`. The frames are the Realtime frames (§19.4) with one addition: the server answers each accepted `publish` on a reserved topic with `{ "type": "ack", "data": "<messageId>" }`.
- **The envelope.** The `data` of a frame is a wire envelope, version 1 (`encodeWire` and `decodeWire` of `@webkrnl/core`). A receiver drops an envelope that does not decode, and reports it.
- **Sending.** The feature attaches to the Notification Center as the scope relay of `global` (§11.3, the same mechanism as Window). Each local Global broadcast goes into the **outbox**, then out.
- **The outbox.** An envelope stays in the outbox until the server acknowledges it. Without an acknowledgement, it is sent again after a reconnect, or after `ackTimeoutMs` (default 10 s). When Storage runs, the outbox is the collection `realtime.global-outbox`, so it survives a reload. An envelope whose `ttl` has passed is dropped. The outbox is bounded (`maxOutbox`, default 500): the oldest envelope goes first, and is counted.
- **Receiving.** An envelope from the server goes to `Queue.ingest`, which drops repeats by `messageId` and fans it out in this tab. The feature also drops the envelopes that its own tab sent, when they come back: a long poll cannot leave out the sender, and the Queue only knows the envelopes that it ingested. (Found by the HTTP fallback test.)
- **Exactly once for each receiver** is at least once (the outbox, the acknowledgement, sending again) plus deduplication by `messageId` (the Queue, and the window client for the relay).
- **The audience** is the decision of the server. The usual audience is every connection of the same user (the Auth token of the socket), so a broadcast reaches every device and session of the user. The wire protocol document states the rule.
- **HTTP fallback.** While the socket is not open and the platform is online, the feature uses Network, if it runs and `global.http` is set: `POST <http>/publish` sends an envelope (`{ "channel", "envelope" }`, answered with `{ "ack": "<messageId>" }`), and `GET <http>/poll?channels=…&cursor=…` is a long poll that returns `{ "envelopes": [...], "cursor": "…" }`. When the socket opens, polling stops. The same envelope can arrive by both paths; deduplication handles it.
- **State.** `transport` (`socket`, `http` or `none`), `outbox` (the count), `sent`, `received`, `dropped`.
- Dropped for now: Server-Sent Events, Global 1-to-1 requests (only broadcasts cross the server), and compression of frames.

### 20.2 The Window relay

- The feature gives a `WindowRelay` (§11.3): `publish(windowId, envelope)` sends on `platform:window:<windowId>`, `subscribe(windowId, listener)` receives from it, and `connected` is `true` while the socket is open or HTTP polling runs.
- The server forwards an envelope on `platform:window:<id>` only to the other connections that subscribed to the same window id (§11.4). The window id comes from the session cookie on the apex domain, so only the tabs of one browser session share it.
- `@webkrnl/hub` binds the relay late: the window transport watches Realtime (`ctx.watch('realtime')`) and gives the relay of its `global` feature to the window client (`setRelay`). The client uses the relay only while the hub is not known to be `shared`, as before.

### 20.3 The wire protocol and conformance

- **`docs/WIRE-PROTOCOL.md`** is the contract for backend teams: the envelope (v1) and its rules, the socket frames and the reserved topics, the acknowledgement, the HTTP endpoints, the audience and the Window rule, and what the server must not do (for example, add fingerprints, §9.4).
- **Fixtures.** `@webkrnl/core` ships valid and invalid wire envelopes as JSON (`fixtures/wire`), with the reason that each invalid one fails.
- **A conformance runner.** `@webkrnl/realtime/conformance` exports `runConformance({ url, http?, token? })`. It connects two or three clients to a server and checks the rules: ping and pong, subscribe and forward, acknowledgements, no echo of Window envelopes to other window ids, invalid envelopes refused, and the HTTP endpoints when `http` is given. It returns one result for each rule, so a backend team can run it in its own CI.
- **The test double.** An in-memory server (`packages/realtime/test/global-server.ts`) implements the protocol for the tests of this repository. It is never published. The browser tests use the WebSocket test server (`scripts/test-ws-server.ts`), which also implements the reserved topics, so the conformance runner runs against it.

### 20.4 Sign-out in the other subsystems (§5.1)

| Subsystem | Wipes on sign-out or a change of user                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network   | Every cached response, in memory and in Storage                                                                                                                     |
| Sync      | The outbox (waiting, failed and conflicting changes) and the pull cursors                                                                                           |
| Realtime  | The publish buffer, presence and the Global outbox. The topic listeners stay, because they belong to the app. The socket opens again with the new token, or closes. |
| Queue     | The dead letters, in memory and in Storage                                                                                                                          |
| Logger    | The log entries, in memory and in Storage                                                                                                                           |

### 20.5 The gate

The M8 gate is a Node test with three devices (kernels), the in-memory server, and Storage:

1. Device A is offline. A unit with Global scope broadcasts. The envelope waits in the outbox. A reloads (a new kernel on the same Storage), and the envelope is still there.
2. A goes online. The server drops the first acknowledgement, so A sends the envelope again, and the server delivers it twice to B.
3. Each subscriber on B and C receives the broadcast exactly once, and A's outbox is empty.

## 21. Product subsystems (M9)

This section is the design of milestone M9. It amends the proposals `settings`, `translation`, `analytics` and `tab-count`, and it starts the proposal `design-system`. The decisions of 2026-10-05: Translation parses its own ICU subset, the design system is tokens and theme only, the tab count moves into Global State, and the old "portal" is dropped. The final package name is decided before the alpha (M10).

```text
  Settings (Window) ---- settings:changed ----> Translation: the locale
     |  persisted state, newer key wins           Design System: appearance
     |  optional save/load handlers (server)      Analytics: data saver
     +-- analytics on/off --> Consent <---------- Analytics: collects only with the grant
  Translation: t() on the main thread; catalogs from options, a loader, or a URL (Network), cached in Storage
  Analytics: buffer --> batches --> Network (Idempotency-Key); offline: Storage; pagehide: sendBeacon
  Global State: tabs (Web Locks), and the tab id as before
```

### 21.1 Settings

`@webkrnl/settings` gives the subsystem `settings` (featurized, **Window** scope, requires Consent). It runs on the main thread.

- **Definitions.** A setting has a key, a default, an optional `validate(value)`, and a kind: `device` (the default) or `user`. The built-in settings are `syncInterval` (300 000 ms), `bandwidthMode` (`FULL`, `CONSERVATIVE` or `MINIMAL`), `dataSaver` (`false`) and `locale` (`null`: the device decides). The app and other packages add their own (`createSettings({ definitions })`). The design system exports the definitions of its appearance settings (§21.4).
- **Reading and writing.** `commands.get(key)`, `commands.set(key, value)`, `commands.reset(key?)`, and one view of all values. A value that fails `validate` is a `RangeError`. A change applies at once: no reload.
- **Persistence and tabs.** The values are persisted state (the kernel's persistence, as Consent). Each key keeps the time of its last change. A change goes to the other tabs of the site as the Window broadcast `settings:changed`, and the newer value of each key wins. A tab that starts asks the open tabs (`settings:sync`), as Consent does.
- **The server (optional).** `handlers: { load?, save? }`. `save(changes)` runs after each local change. When it fails, the change rolls back, and the error goes to `onError`. This is the `optimisticUpdate(apply, commit, rollback)` helper of the proposal, also exported. `load()` runs when a user signs in, so the preferences of the user follow them to each device.
- **Sign-out (§5.1).** The `user` settings return to their defaults. The `device` settings stay: they belong to the device, not to the user.
- **Consent.** `isAnalyticsEnabled()`, `enableAnalytics()` and `disableAnalytics()` read and change the `analytics` grant of Consent. Settings does not keep a copy. Opting out never stops the `necessary` and `functional` work.

### 21.2 Translation

`@webkrnl/translation` gives the subsystem `translation` (featurized, Tab scope). Storage, Network and Settings are optional and late-bound. The processor `compile` runs on `dedicated`, then `virtual`.

- **`t()` is synchronous.** It runs on the main thread, because templates call it while they render. `t(key, params?)` finds the key through the locale chain and formats the compiled message. `views.state` has the locale, the direction, the chain and the loaded namespaces, so an adapter renders again when they change.
- **The message format** is an ICU MessageFormat subset, parsed by the package (no dependency): `{name}` arguments, `plural` and `selectordinal` (with `#`, `=N` and `offset`), `select`, `number`, `date` and `time` with their styles, nested messages, and apostrophe escaping. Plural categories come from `Intl.PluralRules`, and a missing category uses `other`. The separate `plurals` map of the proposal is dropped: ICU plural covers it.
- **Compiling.** A catalog is parsed into plain data (an AST), so a worker can compile it and send it back. The processor `compile` parses a whole catalog. A syntax error in one message is reported, and that message falls back to its key.
- **The locale.** The chain comes from the `locale` setting, then `navigator.languages`, then `defaultLocale`, each matched against `supportedLocales`. For `en-US` the chain is `en-US`, `en`, then the default. The direction comes from `Intl.Locale` text info where it exists, otherwise from a list of right-to-left languages. A change of locale loads the namespaces again and broadcasts `translation:locale-changed` (Tab scope).
- **Catalogs.** A catalog is `{ locale, namespace, messages, version? }`. Sources, in order: catalogs in the options; `load(locale, namespace)`, a function of the app (for example a dynamic `import()`); or `url`, a template such as `/i18n/{locale}/{namespace}.json`, fetched through Network. The namespace `common` loads at start. The others load on `loadNamespace(ns)`, and the least recently used ones leave memory after `maxCatalogs`.
- **Offline.** When Storage runs, fetched catalogs are kept in the collection `translation.catalogs` (not encrypted: catalogs are public). A cached catalog serves at once. When the platform is online, Translation asks the server again with the `ETag`, and a new version replaces the old one. Sync is not used: a catalog is server data that the client only reads.
- **Missing keys.** A missing key returns the key (or throws in `strict` mode), is counted, and is broadcast once for each key and locale as `translation:missing-key` (LOW), for the Logger.
- **Safety.** Parameter values are HTML-escaped by default (`escapeParams: true`), as the proposal says. A framework that escapes text itself (the Vue adapter) turns it off, so that text is not escaped twice.
- **Formatting.** `formatNumber`, `formatCurrency`, `formatDate`, `formatRelativeTime`, `formatList` and `compare` wrap `Intl` with the active locale. Formatters are cached for each locale and set of options.
- **Sign-out.** Translation keeps no user data.

### 21.3 Analytics

`@webkrnl/analytics` gives the subsystem `analytics` (featurized, Tab scope, requires Consent). Network, Storage, Settings, Global State and Auth are optional.

- **The main thread only.** The proposal asks for a dedicated worker. But the last batch goes out with `navigator.sendBeacon` in `pagehide`, and that handler must build the payload at once: it cannot wait for a worker. The aggregation is small, so it stays on the main thread (as Network, §19.1).
- **Collecting.** `increment(name, n?)`, `gauge(name, value)`, `histogram(name, value)` and `track(name, properties?)`. Nothing is collected without the `analytics` grant of Consent. When the grant is revoked, the buffer and the stored batches are deleted.
- **Sampling** is decided once for each session (`sampleRate`), not for each event, so a sampled session is complete and funnels stay correct.
- **Batches.** A batch has counters, gauges, histogram summaries (count, sum, min, max, p50, p90, p99) and events, with a batch id and a session id. It goes out when `batchSize` events wait or every `flushIntervalMs`, as a `POST` to `endpoint` through Network with the batch id as `Idempotency-Key`, so a retry never counts twice.
- **Offline.** A batch that cannot go out waits in the Storage collection `analytics.outbox` (bounded, oldest out first), and goes out when the platform is online.
- **The data saver.** With `dataSaver` or a `bandwidthMode` that is not `FULL`, batches go out only when full or in `pagehide`.
- **Sign-out (§5.1).** The buffer and the stored batches are deleted, and a new session id starts.
- Dropped for now: automatic Web Vitals and platform health metrics. An app can record them with `gauge` and `histogram`.

### 21.4 Design System

`@webkrnl/design-system` gives the subsystem `design-system` (featurized, **Page** scope, no required dependency; Settings and Translation are optional). It has tokens and a theme, and no components. The proposal (`docs/proposals/design-system_PROPOSAL.md`) was agreed on 2026-10-06.

- **Tokens** are CSS custom properties, set on `document.documentElement` (or another root): color, space, size, radius, type, shadow, motion and z-index.
- **The theme** comes from the appearance settings (color scheme, contrast, density, font scale, reduced motion) and the user agent (`prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion`). The direction comes from Translation (`dir` and `lang` on the root).

### 21.5 The tab count (Global State)

- Global State adds `tabs` to its state: the number of open tabs of this origin with the platform.
- Each tab holds the Web Lock `platform:tab:<tabId>` while its page is shown. It releases the lock in `pagehide` (a page in the back-forward cache does not count) and takes it again in `pageshow`. The count is the number of these locks in `navigator.locks.query()`. The browser releases the lock of a tab that crashes, so the count never keeps a dead tab. A tab that changes the count tells the others on a `BroadcastChannel`, and they count again.
- Without Web Locks, the tabs count each other with `hello` and `bye` messages on the `BroadcastChannel`.
- The count is for one origin. A count for the whole site (all subdomains) is not supported.
- The old "portal" (a stack of referrer paths and a busy flag) is dropped. The history of navigation belongs to the router, and Global State already reports `BUSY`.

### 21.6 The gate

1. Every subsystem of the catalogue (§13) is a package, and `src/managers/` is deleted. The code that it still has (the old Global State, Queue, Notification Center, bus and packets, already ported in M1 to M3) goes with it.
2. A Node test boots the whole catalogue in one kernel, and a browser test boots it in two tabs: a setting changed in one tab changes the locale of Translation and the theme of the design system in the other, and Analytics sends nothing until the `analytics` grant.

## 22. Platform, adapter, scaffolder and release (M10)

This section is the design of milestone M10. The monorepo is named **WebKrnl**, and every package is `@webkrnl/*` (decided 2026-10-06). The whole project is formatted with Prettier, Markdown included (decided 2026-10-06).

```text
  npm init @webkrnl my-app --template vue
    --> a Vite app: src/platform.ts (createPlatform), src/main.ts, generated tests
  createPlatform({ ...options })                       @webkrnl/platform
    --> the centralized subsystems, then the chosen featurized ones, a Storage-backed persistence
    --> platform.start() / platform.unit('settings') / platform.stop()
  app.use(createWebKrnl(platform, { router }))          @webkrnl/vue
    --> useView(view), usePlatform(), useUnit(id), useT(), the vue-router route source
```

### 22.1 Page scope and route changes (kernel)

- The kernel takes a route source: `new Kernel(units, { routes })` (§11.2.1). Without one, it uses `createBrowserRouteSource()` in a browser and nothing elsewhere.
- **When the path changes**, every running Page-scope root unit restarts as a new page: the kernel stops it (its disposers run), sets its state back to the initial value (persisted keys are restored again), and starts it. A unit that has `pageChange(path)` in its definition keeps running and gets the call instead, when a restart costs more than it gives (the Design System: its theme does not depend on the path).
- The lifecycle snapshot of a restarted unit has the reason `route`.
- Page-scope broadcasts that are still in the Queue at the change go to the units of the new page. Packets have no page id; this is accepted for now.

### 22.2 The orchestrator: `@webkrnl/platform`

- `createPlatform(options)` returns a **Platform**: `kernel`, `start()`, `stop()`, `unit(id)` (typed for the ids of the catalogue), and `ready` (a promise that resolves after `start`).
- It always has the centralized subsystems (Global State, Queue, Notification Center) and the Logger. Each other subsystem is an option: `true` or its options turns it on, `false` turns it off. The default is on for Window transport (single origin unless `hub.hubUrl`), Crypto, Storage, Consent, Settings, Network, Sync, Translation and the Design System; Auth, Realtime and Analytics are on only with their required options (handlers, a URL, an endpoint or `send`).
- It wires what the packages leave to the app: the kernel persistence (`createStatePersistence({ database: '<appName>-state' })`), `APPEARANCE_SETTINGS` in Settings when the Design System is on, the Queue router, `onError` (to the Logger), and the route source.
- `units` adds the units of the app. Ids that clash with the catalogue are an error.
- `@webkrnl/platform` is the only package with hard `dependencies` on the subsystems (§14).

### 22.3 The Vue adapter: `@webkrnl/vue`

- `useView(view)` returns a `Readonly<ShallowRef<T>>` that follows the view, and unsubscribes when the effect scope ends.
- `createWebKrnl(platform, { router? })` is a Vue plugin. `app.use` provides the platform and starts it if it does not run. With a router, each `afterEach` calls `kernel.changePage(path)`, so Page scope follows vue-router (give the platform `routes: null` then). `usePlatform()` and `useUnit(id)` read it in components.
- `useT()` returns `t`, bound to the `revision` and `locale` of Translation, so a template renders again when catalogs or the locale change. Vue escapes text itself, so an app with Vue turns Translation's `escapeParams` off (the Vue template of the scaffolder does), and text is not escaped twice.
- `createVueRouterRouteSource(router)` follows `router.afterEach` (§11.2.1).
- `vue` and `vue-router` are peer dependencies of the adapter only. The adapter adds no behaviour that the core lacks (§14.1).

### 22.4 The scaffolder: `@webkrnl/create`

- `npm init @webkrnl <dir> [--template vue|vanilla] [--local <path>]` writes a Vite app. Templates: **vue** (Vue 3, `vue-router`, the adapter) and **vanilla** (TypeScript only, which proves that the core needs no framework).
- Each app has `src/platform.ts` (one `createPlatform` call with the common options and comments), `src/main.ts`, a page that shows the platform status, online state, pending work, a setting, a translated message and the theme, a `public/i18n` catalog, `vite.config.ts`, `tsconfig.json`, and **generated tests**: a Node test that boots the platform, goes offline, queues a change, goes online, and checks that the change reached a fake server.
- `--local <path>` links the packages of a local checkout of this monorepo (`link:`), for the gate and for development before the first release. Without it, the app depends on `@webkrnl/*` from the registry, at the version of the scaffolder.
- The scaffolder has no dependencies. It copies template files and replaces `{{name}}` and `{{version}}`.

### 22.5 Build and release

- **Build.** `pnpm build` makes `dist/` in each package: ES modules (rolldown) and declarations (`tsc --emitDeclarationOnly`). Worker URLs (`./x.worker.ts`) are rewritten to `./x.worker.js`. In the workspace, packages still export their TypeScript sources; `publishConfig` points `exports` at `dist/` for the registry.
- **Fixed versions.** `pnpm release:check` checks that every package has the same version, that `pnpm pack` contains `dist/` and no test files, and that every internal dependency names that version. `pnpm release:version <x.y.z>` sets it everywhere. Publish with pnpm (`pnpm -r publish`): it applies `publishConfig` and replaces `workspace:*` with the version; npm does neither. The first release candidate, `0.1.0-rc.1`, published to GitHub Packages and JSR under the `rc` tag; a full `0.1.0` (and the alpha, §4.1 of the plan) waits on feedback from it.
- **GitHub Packages and JSR.** Every package's `publishConfig` points at GitHub Packages (`npm.pkg.github.com`, `access: public`) instead of the public npm registry, since publishing there is still pre-alpha. `node scripts/jsr.ts sync` also writes a `jsr.json` next to each `package.json`, generated from that package's own `exports` - JSR publishes TypeScript source directly, not `dist/`. `node scripts/jsr.ts check` runs `jsr publish --dry-run` across every package (or the ones named); `node scripts/jsr.ts publish` does the real thing. Both need auth that isn't configured in CI yet: a GitHub token with `write:packages`, and a one-time interactive JSR login.
- **Changelog.** `CHANGELOG.md` at the root, one section for each version, with the milestones of `0.0.2` under "Unreleased".
- **Documentation site.** `pnpm docs:site` (`pnpm docs` is a command of pnpm itself) runs TypeDoc over every package (`entryPointStrategy: packages`) into `docs-site/` (not committed). The TSDoc blocks (`check:docs`) are its content.

### 22.6 The gate

1. `create` scaffolds the **vue** app and the **vanilla** app into temporary folders with `--local`, and installs them.
2. Each app's generated tests pass.
3. Each app is built with Vite and opened in real browsers (Playwright). The page reaches `IDLE`; the test sets the context offline, makes a change that waits in the Sync outbox, sets it online again, and the page shows that nothing waits.
