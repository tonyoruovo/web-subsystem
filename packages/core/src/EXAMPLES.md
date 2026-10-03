# Examples: `@platform/core`

The kernel of the platform. These examples show how to define subsystems, start them, connect them with dependencies and packets, keep their state, and run work in processors.

## Boot two subsystems that depend on each other

<!-- example id="core/boot-with-a-dependency" runtime="any" -->

A settings subsystem needs storage before it can load the saved theme. The kernel starts `storage` first, then `settings`, and the application changes the theme through a command.

```ts file=main.ts
import { Kernel, defineSubsystem } from '@platform/core';

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: { items: { theme: 'dark' } as Record<string, string> } },
  control: (ctx) => ({
    commands: {
      get: (key: string) => ctx.state.get().items[key],
      put: (key: string, value: string) => ctx.state.update((s) => void (s.items[key] = value)),
    },
    views: {},
  }),
});
type StorageControl = ReturnType<typeof storage.control>;

const settings = defineSubsystem({
  id: 'settings',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'storage' }],
  state: { initial: { theme: 'light' }, policy: { theme: { readable: true } } },
  init: (ctx) => {
    const saved = ctx.dependency<StorageControl>('storage')?.commands.get('theme');
    if (saved) ctx.state.update((s) => void (s.theme = saved));
  },
  control: (ctx) => ({
    commands: {
      setTheme(theme: string) {
        ctx.state.update((s) => void (s.theme = theme));
        ctx.dependency<StorageControl>('storage')?.commands.put('theme', theme);
      },
    },
    views: { state: ctx.state.readable },
  }),
});

const kernel = new Kernel([settings, storage]); // the order does not matter
await kernel.start();

const control = kernel.unit<ReturnType<typeof settings.control>>('settings').control!;
console.log('loaded theme:', control.views.state.getSnapshot().theme);
control.commands.setTheme('light');
console.log('new theme:', control.views.state.getSnapshot().theme);
console.log('storage status:', kernel.unit('storage').lifecycle.getSnapshot().status);
await kernel.stop();
```

```text output
loaded theme: dark
new theme: light
storage status: READY
```

## Keep a subsystem running when one feature fails

<!-- example id="core/degraded-feature" runtime="any" -->

Storage has two backends as features. When IndexedDB is blocked, only that feature fails: the subsystem is `DEGRADED` and still works. A restart brings the feature back.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, defineUnit } from '@platform/core';

let indexedDbBlocked = true;

const memory = defineUnit({ id: 'memory', state: { initial: {} }, control: () => NO_CONTROL });
const idb = defineUnit({
  id: 'idb',
  state: { initial: {} },
  init: () => {
    if (indexedDbBlocked) throw new Error('IndexedDB is blocked in private mode.');
  },
  control: () => NO_CONTROL,
});

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  features: [memory, idb],
  control: () => NO_CONTROL,
});

const kernel = new Kernel([storage], { onError: () => {} });
await kernel.start();

const show = () => {
  const { status, offFeatures } = kernel.unit('storage').lifecycle.getSnapshot();
  console.log(`storage: ${status}, off: [${offFeatures.join(', ')}]`);
};
show();
console.log('idb reason:', kernel.unit('storage/idb').lifecycle.getSnapshot().reason);

indexedDbBlocked = false;
await kernel.unit('storage/idb').restart();
show();
await kernel.stop();
```

```text output
storage: DEGRADED, off: [idb]
idb reason: IndexedDB is blocked in private mode.
storage: READY, off: []
```

## Ask another subsystem for data, and announce a change

<!-- example id="core/request-and-broadcast" runtime="any" -->

Subsystems talk through packets. `request` sends a 1-to-1 packet and returns the reply. `send` without a target is a broadcast to every subscriber.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';

let authPort: PacketPort | undefined;

const users = defineSubsystem({
  id: 'users',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: (packet) => {
    const { id } = packet.take() as { id: string };
    return { id, name: id === 'u1' ? 'Ada' : 'Unknown' };
  },
  control: () => NO_CONTROL,
});

const auth = defineSubsystem({
  id: 'auth',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (authPort = ctx.port),
  control: () => NO_CONTROL,
});

const audit = defineSubsystem({
  id: 'audit',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['auth:login'],
  receive: (packet) =>
    console.log('audit heard:', packet.header.eventId, JSON.stringify(packet.take())),
  control: () => NO_CONTROL,
});

const kernel = new Kernel([users, auth, audit]);
await kernel.start();

const user = await authPort!.request<{ name: string }>({
  eventId: 'users:get',
  payload: { id: 'u1' },
  target: 'users',
});
console.log('reply:', user.name);
await authPort!.send({ eventId: 'auth:login', payload: { user: user.name } });
await kernel.stop();
```

```text output
reply: Ada
audit heard: auth:login {"user":"Ada"}
```

## Render a view in any framework

<!-- example id="core/views" runtime="any" -->

A view is an external store: `getSnapshot` and `subscribe`. Listeners run one time for each task, after all changes of that task. `deriveView` computes a value from another view.

```ts file=main.ts
import { createStore, deriveView } from '@platform/core';

const cart = createStore({ items: [{ name: 'Tea', price: 4 }] });
const total = deriveView(cart.view, (snapshot) =>
  snapshot.items.reduce((sum, item) => sum + item.price, 0),
);

total.subscribe(() => console.log('render total:', total.getSnapshot()));

// Two changes in one task cause one render.
cart.set({ items: [...cart.view.getSnapshot().items, { name: 'Cake', price: 6 }] });
cart.set({ items: [...cart.view.getSnapshot().items, { name: 'Milk', price: 2 }] });
await Promise.resolve();

console.log('snapshots are frozen:', Object.isFrozen(cart.view.getSnapshot()));
```

```text output
render total: 12
snapshots are frozen: true
```

## Keep state across reloads

<!-- example id="core/persisted-state" runtime="any" -->

The kernel saves the persisted keys of each unit at teardown and loads them at the next start. This example uses a `Map` in place of `localStorage`. Only the `draft` key is persisted. The `typing` key stays private.

```ts file=main.ts
import { Kernel, defineSubsystem, type PersistedState, type StatePersistence } from '@platform/core';

const disk = new Map<string, PersistedState<object>>();
const persistence: StatePersistence = {
  load: (unitId) => disk.get(unitId),
  save: (unitId, state) => void disk.set(unitId, state),
};

const editor = defineSubsystem({
  id: 'editor',
  scope: 'tab',
  kind: 'featurized',
  state: {
    initial: { draft: '', typing: false },
    policy: { draft: { readable: true, persisted: true } },
  },
  control: (ctx) => ({
    commands: { type: (text: string) => ctx.state.update((s) => void (s.draft = text)) },
    views: { state: ctx.state.readable },
  }),
});
type EditorControl = ReturnType<typeof editor.control>;

const first = new Kernel([editor], { persistence });
await first.start();
first.unit<EditorControl>('editor').control!.commands.type('Hello');
await first.stop(); // the page unloads
console.log('saved:', JSON.stringify(disk.get('editor')));

const second = new Kernel([editor], { persistence });
await second.start(); // the page loads again
console.log('restored:', second.unit<EditorControl>('editor').control!.views.state.getSnapshot().draft);
await second.stop();
```

```text output
saved: {"version":1,"data":{"draft":"Hello"}}
restored: Hello
```

## Run heavy work in a processor

<!-- example id="core/processor" runtime="any" -->

A processor is one module that runs in a shared worker, a dedicated worker, or on the main thread. This example uses the main thread (`virtual`), which is always available, and yields between items so the page stays responsive.

```ts file=main.ts
import { Kernel, defineProcessor, defineSubsystem, type ProcessorDef } from '@platform/core';

const thumbnailer = defineProcessor<{ sizes: number[] }, string[]>({
  async handle({ sizes }, scope) {
    const done: string[] = [];
    for (const size of sizes) {
      done.push(`${size}x${size}`);
      if (scope.shouldYield()) await scope.yield();
    }
    return done;
  },
});

const processor: ProcessorDef<{ sizes: number[] }, string[]> = {
  id: 'thumbnails',
  job: 'scheduler',
  hosts: ['virtual'], // add 'dedicated' or 'shared' before it to use a worker
  load: async () => thumbnailer,
};

const gallery = defineSubsystem({
  id: 'gallery',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  processors: [processor],
  control: (ctx) => ({
    commands: {
      makeThumbnails: (sizes: number[]) =>
        ctx.processor<{ sizes: number[] }, string[]>('thumbnails').call({ sizes }),
    },
    views: {},
  }),
});

const kernel = new Kernel([gallery]);
await kernel.start();
const control = kernel.unit<ReturnType<typeof gallery.control>>('gallery').control!;
console.log('thumbnails:', JSON.stringify(await control.commands.makeThumbnails([64, 128, 256])));
await kernel.stop();
```

```text output
thumbnails: ["64x64","128x128","256x256"]
```

## Bind to a subsystem that starts later

<!-- example id="core/late-binding" runtime="any" -->

An audit log starts before the storage it writes to. It buffers entries in a `LateBinding`, and `ctx.watch` binds the buffer when storage starts.

```ts file=main.ts
import { Kernel, LateBinding, defineSubsystem } from '@platform/core';

const written: string[] = [];
const buffer = new LateBinding<string>({ capacity: 100 });

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  control: () => ({ commands: { append: (line: string) => void written.push(line) }, views: {} }),
});
type StorageControl = ReturnType<typeof storage.control>;

const audit = defineSubsystem({
  id: 'audit',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'storage', kind: 'optional' }],
  state: { initial: {} },
  init: (ctx) => {
    ctx.watch<StorageControl>('storage', (storage) => {
      if (storage) void buffer.bind((line) => storage.commands.append(line));
      else buffer.unbind();
    });
  },
  control: () => ({ commands: { record: (line: string) => void buffer.write(line) }, views: {} }),
});
type AuditControl = ReturnType<typeof audit.control>;

const kernel = new Kernel([audit, storage]);
await kernel.start();
await kernel.unit('storage').suspend(); // storage stops for a moment

const log = kernel.unit<AuditControl>('audit').control!;
log.commands.record('user signed in');
console.log('written while storage is suspended:', written.length);

await kernel.unit('storage').resume();
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('written after it resumed:', JSON.stringify(written));
await kernel.stop();
```

```text output
written while storage is suspended: 0
written after it resumed: ["user signed in"]
```

## Retry a failed call with backoff

<!-- example id="core/backoff" runtime="any" -->

`computeBackoff` gives the wait before each retry. Use a jitter strategy in production. This example uses `exponential`, which has no randomness.

```ts file=main.ts
import { computeBackoff } from '@platform/core';

let calls = 0;
async function flakyUpload(): Promise<string> {
  calls += 1;
  if (calls < 3) throw new Error('HTTP 503');
  return 'uploaded';
}

for (let attempts = 1; ; attempts++) {
  try {
    console.log(await flakyUpload(), 'after', attempts, 'attempts');
    break;
  } catch (error) {
    const wait = computeBackoff({ base: 10, attempts, strategy: 'exponential' });
    console.log(`attempt ${attempts} failed (${(error as Error).message}), waiting ${wait} ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
```

```text output
attempt 1 failed (HTTP 503), waiting 20 ms
attempt 2 failed (HTTP 503), waiting 40 ms
uploaded after 3 attempts
```

## Keep a bounded history and drop repeats

<!-- example id="core/ring-and-dedupe" runtime="any" -->

A notification panel shows the last three messages, and a message that arrives two times shows one time only.

```ts file=main.ts
import { createDeduplicator, createRingBuffer } from '@platform/core';

const recent = createRingBuffer<string>(3);
const dedupe = createDeduplicator(1000);

const arrivals = [
  { id: 'm1', text: 'Build started' },
  { id: 'm2', text: 'Tests passed' },
  { id: 'm2', text: 'Tests passed' }, // the same message, from a second channel
  { id: 'm3', text: 'Deployed to staging' },
  { id: 'm4', text: 'Deployed to production' },
];

for (const message of arrivals) {
  if (dedupe.seen(message.id)) continue;
  recent.push(message.text);
}

console.log(JSON.stringify(recent.view.getSnapshot()));
console.log('dropped from the panel:', recent.dropped);
```

```text output
["Tests passed","Deployed to staging","Deployed to production"]
dropped from the panel: 1
```

## Send a packet to a server

<!-- example id="core/wire-protocol" runtime="any" -->

Global packets travel as JSON in the versioned wire format. `encodeWire` checks an envelope before it leaves, and `decodeWire` checks what arrives.

```ts file=main.ts
import { WireProtocolError, createEnvelope, decodeWire, encodeWire } from '@platform/core';

let n = 0;
const envelope = createEnvelope(
  { eventId: 'chat:message', payload: { text: 'Hello' }, target: 'chat' },
  { source: 'app', scope: 'global', ids: () => `id-${++n}`, now: () => 1_700_000_000_000 },
);

const json = encodeWire(envelope);
console.log('wire version:', JSON.parse(json).v);

const received = decodeWire(json);
console.log('received:', received.eventId, JSON.stringify(received.payload));

try {
  decodeWire('{"v":2}');
} catch (error) {
  if (error instanceof WireProtocolError) console.log('refused:', error.message);
}
```

```text output
wire version: 1
received: chat:message {"text":"Hello"}
refused: Unsupported wire protocol version: 2.
```

## Talk to another realm over a MessageChannel

<!-- example id="core/transport" runtime="any" -->

A transport carries envelopes between two realms, for example a page and a worker. Each side sets a handler, and a request resolves with the reply of the other side.

```ts file=main.ts
import { createChannelTransportPair, createEnvelope } from '@platform/core';

const [page, worker] = createChannelTransportPair();

worker.onEnvelope((envelope) => {
  const { a, b } = envelope.payload as { a: number; b: number };
  return { sum: a + b };
});

const envelope = createEnvelope(
  { eventId: 'math:add', payload: { a: 2, b: 3 }, target: 'math' },
  { source: 'app', scope: 'tab' },
);
console.log('reply:', JSON.stringify(await page.request(envelope)));

page.close();
worker.close();
```

```text output
reply: {"sum":5}
```

## Follow the route for Page scope

<!-- example id="core/route-source" runtime="browser" -->

Page scope ends when the path changes. The browser route source reports each completed navigation, from the Navigation API or the History API. A navigation that a newer one interrupts is not reported.

```ts file=main.ts
import { createBrowserRouteSource } from '@platform/core';

const routes = createBrowserRouteSource();
console.log('start:', routes.current());

const stop = routes.subscribe((path) => console.log('page changed to', path));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
history.pushState(null, '', '/settings');
await settle();
history.pushState(null, '', '/settings/profile');
await settle();
stop();
```

```text output
start: /
page changed to /settings
page changed to /settings/profile
```
