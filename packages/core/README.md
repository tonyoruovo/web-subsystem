# @platform/core

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The kernel of the platform. Every other `@platform/*` package is built on it.

`@platform/core` defines what a **subsystem** is, runs every subsystem's **lifecycle**, enforces the **dependencies** between them, carries **packets** between them, and runs their **processors** on the main thread or in workers. It has no framework dependency and no subsystem of its own: Storage, Auth, the Queue and the rest are separate packages that register with the kernel.

- [What is in the package](#what-is-in-the-package)
- [Installation](#installation)
- [Entry points](#entry-points)
- [Quick start](#quick-start)
- [Guide](#guide)
- [Errors](#errors)
- [Development](#development)

## What is in the package

| Area                   | Exports                                                                                 | Design reference                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Units and the kernel   | `defineSubsystem`, `defineUnit`, `Kernel`, `UnitHandle`, `UnitContext`                  | [ARCHITECTURE §3](../../docs/ARCHITECTURE.md#3-the-unit-model)                               |
| Lifecycle              | `Lifecycle`, `UnitStatus`, `TRANSITIONS`, `canTransition`                               | [§4](../../docs/ARCHITECTURE.md#4-lifecycle)                                                 |
| State                  | `createStateCell`, `StateCell`, `StateDefinition`                                       | [§5](../../docs/ARCHITECTURE.md#5-state)                                                     |
| Views                  | `View`, `createStore`, `deriveView`, `createRingBuffer`                                 | [§6.1](../../docs/ARCHITECTURE.md#61-observable-views)                                       |
| Dependencies           | `DependencyGraph`, `LateBinding`, `Dependency`                                          | [§7](../../docs/ARCHITECTURE.md#7-dependencies)                                              |
| Processors and workers | `ProcessorDef`, `defineProcessor`, `ProcessorRunner`, `WorkerBudget`, `createScheduler` | [§8](../../docs/ARCHITECTURE.md#8-processors-and-workers)                                    |
| Packets                | `Packet`, `PacketEnvelope`, `createEnvelope`, `CorrelationRegistry`                     | [§9](../../docs/ARCHITECTURE.md#9-packets)                                                   |
| Routing and retries    | `PacketRouter`, `directRouter`, `computeBackoff`, `BackoffStrategy`                     | [§10.1](../../docs/ARCHITECTURE.md#101-how-the-three-centralized-subsystems-fit-together-m3) |
| Transports             | `Transport`, `createChannelTransportPair`, `createInRealmTransportPair`, `RpcEndpoint`  | [§10](../../docs/ARCHITECTURE.md#10-messaging-topology)                                      |
| Scopes and routes      | `Scope`, `reaches`, `assertSendAllowed`, `RouteSource`                                  | [§11](../../docs/ARCHITECTURE.md#11-scopes)                                                  |
| Global wire protocol   | `encodeWire`, `decodeWire`, `WireEnvelopeSchema`                                        | [§11.4](../../docs/ARCHITECTURE.md#114-global-scope-the-server)                              |

## Installation

Inside this monorepo, depend on the workspace package:

```json
{
  "peerDependencies": { "@platform/core": "workspace:*" }
}
```

| Peer dependency | Why                                 |
| --------------- | ----------------------------------- |
| `zod` `^4`      | Validates the Global wire protocol. |

Runs in the supported browsers (see the [root README](../../README.md#supported-platforms)) and in Node 24 for tests. Worker hosts need a bundler that understands `new Worker(new URL(..., import.meta.url))`, such as Vite, webpack 5 or Rollup.

## Entry points

| Import                   | Use it for                                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| `@platform/core`         | Everything an app or a subsystem package needs.                                   |
| `@platform/core/testing` | `createTestPlatform` and helpers: boot real units in tests, without browser APIs. |
| `@platform/core/worker`  | `serveProcessor`: the one call a worker entry file makes.                         |

## Quick start

Define two subsystems, one depending on the other, and boot them:

```ts
import { Kernel, defineSubsystem } from '@platform/core';

const counter = defineSubsystem({
  id: 'counter',
  scope: 'tab',
  kind: 'featurized',
  state: {
    initial: { count: 0 },
    policy: { count: { readable: true, persisted: true } },
  },
  control: (ctx) => ({
    commands: {
      increment: () => ctx.state.update((s) => void s.count++),
    },
    views: { state: ctx.state.readable },
  }),
});

const greeter = defineSubsystem({
  id: 'greeter',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'counter' }], // starts only once counter is running
  state: { initial: {} },
  control: () => ({ commands: {}, views: {} }),
});

const kernel = new Kernel([greeter, counter]);
await kernel.start(); // counter first, then greeter

const control = kernel.unit<ReturnType<typeof counter.control>>('counter').control!;
control.commands.increment();
control.views.state.getSnapshot(); // { count: 1 }

await kernel.stop();
```

## Guide

### Subsystems and features

A subsystem and a feature share one shape, the **unit**. A subsystem also has a `scope`, a `kind`, and a packet port. A feature belongs to a subsystem: it can fail without failing its parent, which then reports `DEGRADED`.

```ts
import { defineSubsystem, defineUnit } from '@platform/core';

const idb = defineUnit({
  id: 'idb',
  state: { initial: {} },
  init: async (ctx) => {
    const db = await openDatabase();
    return () => db.close(); // the disposer: runs on teardown
  },
  control: () => ({ commands: {}, views: {} }),
});

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  features: [idb],
  control: () => ({ commands: {}, views: {} }),
});
```

If `openDatabase()` throws, `storage/idb` is `FAILED` and `storage` is `DEGRADED` with `offFeatures: ['idb']`. Restarting the feature (`kernel.unit('storage/idb').restart()`) brings the parent back to `READY`.

### Lifecycle

Every unit follows one state machine:

```text
  UNINITIALIZED --> INITIALIZING --> READY <--> BUSY
                         |             |  ^
                         v             v  |  resume
                       FAILED <---- SUSPENDED
  READY/BUSY --> DEGRADED --> READY          any --> DESTROYING --> DESTROYED
```

Watch a unit through its lifecycle view:

```ts
const handle = kernel.unit('storage');
handle.lifecycle.subscribe(() => {
  const { status, reason, waitingFor, offFeatures } = handle.lifecycle.getSnapshot();
  console.log(status, reason, waitingFor, offFeatures);
});
```

`kernel.statuses` holds every unit's snapshot in one view. Units read the same view as `ctx.statuses` (Global State derives the platform status from it).

### Dependencies

`requires` lists what a unit needs. A missing **required** dependency keeps the unit `UNINITIALIZED`, with `waitingFor` naming it, and the unit starts as soon as the dependency runs. A dependency that stops later suspends its dependents, and they resume when it recovers. **Optional** dependencies only order the boot.

```ts
requires: [
  { target: 'storage' }, // required, must be READY
  { target: 'consent', kind: 'optional' }, // runs without it
  { target: 'network/interceptor' }, // a feature of another subsystem
];
```

A unit reads a declared dependency's control interface with `ctx.dependency('storage')`, which is `undefined` while the dependency is not running. Cycles of required dependencies are rejected when the kernel is constructed.

A unit that starts before something it uses (the Logger before Storage) declares it `optional` and follows it with `ctx.watch`, which calls back at once and whenever the dependency starts, stops or restarts. Writes made meanwhile wait in a `LateBinding` buffer:

```ts
const sink = new LateBinding<LogEntry>({ capacity: 500 });

init(ctx) {
  ctx.watch<StorageControl>('storage', (storage) => {
    if (storage) void sink.bind((entry) => storage.commands.append('logs', entry));
    else sink.unbind();
  });
}
```

`ctx.report(error)` sends an error the unit recovered from (a failed write, a refused broadcast) to the kernel's `onError`, without changing its lifecycle.

### State and views

`ctx.state` is the unit's own state. Only the unit can update it, through a draft. Every update is checked with `structuredClone`, so functions and symbols are rejected.

```ts
state: {
  initial: { user: null as string | null, token: '' },
  policy: { user: { readable: true, persisted: true } }, // token stays private
  version: 2, // persisted state from another version is ignored
},
```

- `ctx.state.readable` is a **view** of the readable keys, safe to put in a control interface.
- Pass `persistence` to the kernel to restore persisted keys on start and save them on destroy.

Bounded lists (logs, histories) use `createRingBuffer(capacity)`: it appends in place and builds the frozen snapshot only when it is read after a change. A view is a snapshot, not a stream: a consumer that needs every item should be pushed each one (as the Queue's and the Notification Center's `observe` commands do).

A view is an external store: `getSnapshot()` returns the same frozen object until the value changes, and `subscribe()` notifies once per task. Framework bindings need no adapter:

```ts
// React
const state = useSyncExternalStore(view.subscribe, view.getSnapshot);

// Vue
const state = shallowRef(view.getSnapshot());
const stop = view.subscribe(() => (state.value = view.getSnapshot()));
onScopeDispose(stop);
```

### Packets

Every subsystem has a packet port, `ctx.port`. Features share their parent's port and send under its identity.

```ts
// 1-to-1 request: resolves with the target's reply
const user = await ctx.port.request({ eventId: 'auth:whoami', payload: null, target: 'auth' });

// Broadcast: delivered to running subsystems that subscribe to the event
await ctx.port.send({ eventId: 'storage:changed', payload: { key: 'theme' } });
```

The receiving subsystem handles packets in `receive`. A payload can be read **once** per delivery:

```ts
defineSubsystem({
  id: 'auth',
  subscribes: ['storage:changed'],
  receive: (packet, ctx) => {
    const payload = packet.take(); // a second take() throws PayloadConsumedError
    return { user: ctx.state.get().user };
  },
  // ...
});
```

The kernel fills in ids, source, scope, timestamps and trace ids, and stamps `sent` and `delivered` fingerprints. Pass `causedBy: packet.header` to continue a trace. A broadcast may not leave its sender's scope.

### Routers

Every packet a port produces goes through the kernel's **router**, a `PacketRouter` with one method, `route(envelope, expectReply)`. The default, `directRouter`, hands requests to `kernel.deliver` and broadcasts to `kernel.broadcast`, in the same realm, at once. In an application the Queue (`@platform/queue`) replaces it, adding admission, priorities, ordering, retries and dead letters:

```ts
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel([queue.subsystem, notification.subsystem, ...subsystems], {
  router: queue.router,
});
```

A router builds on these kernel methods:

| Method                                         | Does                                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliver(envelope, { to?, clone?, onTrail? })` | Delivers to `metadata.target` (or `to`), stamps `delivered`, resolves with the reply. `onTrail` receives the final trail. Throws `UnitUnavailableError` or `PacketExpiredError`. |
| `broadcast(envelope)`                          | Delivers a copy to every running subscriber except the sender.                                                                                                                   |
| `subscribers(eventId)`                         | The running subsystems that receive an event.                                                                                                                                    |
| `scopeOf(id)`                                  | A subsystem's scope, to check the send rule.                                                                                                                                     |

`computeBackoff({ base, attempts, strategy })` computes retry waits (`exponential`, `exponential-jitter`, `decorrelated-jitter`, `linear`, `multiplicative-exponential`).

**Centralized** subsystems (`kind: 'centralized'`: Global State, the Queue, the Notification Center) boot before every featurized one, and only the platform destroys them.

### Processors and workers

A processor is one message-handler module that runs on any host: a shared worker, a dedicated worker, or the main thread (`virtual`). The host list must end with `virtual`, the fallback.

```ts
// sync.processor.ts
import { defineProcessor } from '@platform/core';

export const syncProcessor = defineProcessor<{ items: number[] }, number>({
  async handle({ items }, scope) {
    let total = 0;
    for (const item of items) {
      total += item;
      if (scope.shouldYield()) await scope.yield(); // stay within the slice budget
    }
    return total;
  },
});
```

```ts
// sync.worker.ts: the worker entry file
import { serveProcessor } from '@platform/core/worker';
import { syncProcessor } from './sync.processor';

serveProcessor(syncProcessor);
```

```ts
// the subsystem: write the worker factory literally, so the bundler finds it
defineSubsystem({
  id: 'sync',
  processors: [
    {
      id: 'sum',
      job: 'sink',
      hosts: ['dedicated', 'virtual'],
      load: () => import('./sync.processor').then((m) => m.syncProcessor),
      dedicated: () => new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' }),
    },
  ],
  init: async (ctx) => {
    const total = await ctx
      .processor<{ items: number[] }, number>('sum')
      .call({ items: [1, 2, 3] });
  },
  // ...
});
```

If the worker is unavailable, errors, does not answer the handshake, or stops answering heartbeats, the processor moves to the next host. A call that was in flight is re-run there. `ctx.processor('sum').status` shows the current host and every failover. The number of workers is capped by a `WorkerBudget` sized from the device's cores.

### Transports

Transports move envelopes between realms. The Queue (M3) and the Window hub (M5) build on them.

```ts
import { createChannelTransportPair, createEnvelope } from '@platform/core';

const [main, worker] = createChannelTransportPair();
worker.onEnvelope((envelope) => ({ ok: true, from: envelope.metadata.source }));

const envelope = createEnvelope(
  { eventId: 'sync:pull', payload: null, target: 'sync' },
  { source: 'ui', scope: 'tab' },
);
await main.request(envelope); // { ok: true, from: 'ui' }
```

### Routes (Page scope)

Page scope ends when the path changes. `createBrowserRouteSource()` reports path changes through the Navigation API, or the History API as a fallback. A router adapter can supply its own `RouteSource`.

### Testing

`@platform/core/testing` boots real units in Node, with deterministic ids, a controllable clock, captured errors and a recording router:

```ts
import { createTestPlatform, createMemoryPersistence } from '@platform/core/testing';

const platform = createTestPlatform([storage, auth], { persistence: createMemoryPersistence() });
await platform.start();

expect(platform.status('auth')).toBe('READY');
expect(platform.routed).toHaveLength(0);
expect(platform.errors).toEqual([]);

await platform.stop();
```

## Errors

| Error                                              | Thrown when                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `IllegalTransitionError`                           | A lifecycle transition is not allowed.                                     |
| `DependencyCycleError`                             | Required dependencies form a cycle (at kernel construction).               |
| `StateSerializationError`                          | State would stop being structured-cloneable.                               |
| `UnitUnavailableError`                             | A packet targets an unknown, non-running or feature unit.                  |
| `PacketExpiredError`                               | A packet's `ttl` passed before delivery.                                   |
| `PayloadConsumedError`                             | A packet's payload is read twice.                                          |
| `ScopeViolationError`                              | A broadcast is sent outside its sender's scope.                            |
| `HostFailureError`                                 | A processor host failed; its `trigger` says why.                           |
| `ProcessorStartError`                              | No host, not even `virtual`, could start a processor.                      |
| `WireProtocolError`                                | Data is not a valid Global wire envelope.                                  |
| `RpcTimeoutError`, `RpcClosedError`, `RemoteError` | A request over a port timed out, was cut off, or failed on the other side. |

## Development

From the repository root:

```bash
pnpm exec vitest run --project node packages/core
```

```bash
pnpm test:coverage
```

```bash
BROWSERS=chrome,edge,webkit pnpm test:browser
```

The coverage run enforces 100% on `lifecycle.ts` and `dependency.ts`. Browser tests in `test/*.browser.spec.ts` run real workers on every browser installation listed in the root `playwright.config.ts`.
