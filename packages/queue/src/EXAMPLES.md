# Examples: `@platform/queue`

The Queue is the packet router of the kernel. Every packet goes through it. It checks admission, delivers by priority, keeps related packets in order, retries a target that does not run, and keeps the packets that it cannot deliver as dead letters.

## Keep the messages of one conversation in order

<!-- example id="queue/priority-and-ordering" runtime="any" -->

A chat sends messages to a sync subsystem. The messages of one conversation share an `orderingKey`, so they arrive in order. A `HIGH` read receipt goes before the waiting `MEDIUM` messages.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import { createQueue } from '@platform/queue';

let chat: PacketPort | undefined;
const app = defineSubsystem({
  id: 'chat',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (chat = ctx.port),
  control: () => NO_CONTROL,
});
const sync = defineSubsystem({
  id: 'sync',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: async (packet) => {
    console.log('synced:', packet.take());
    await new Promise((resolve) => setTimeout(resolve, 5)); // a network call
  },
  control: () => NO_CONTROL,
});

const queue = createQueue({ maxActive: 1 }); // one delivery at a time, to show the order
const kernel = new Kernel([queue.subsystem, app, sync], { router: queue.router });
await kernel.start();

const message = (text: string) =>
  chat!.send({ eventId: 'chat:message', payload: text, target: 'sync', orderingKey: 'conversation:7' });
await Promise.all([
  message('Hi'),
  message('Are you there?'),
  message('Call me'),
  chat!.send({ eventId: 'chat:read', payload: 'read receipt', target: 'sync', importance: 'HIGH' }),
]);
await kernel.stop();
```

```text output
synced: Hi
synced: read receipt
synced: Are you there?
synced: Call me
```

## Retry a stopped target, then replay a dead letter

<!-- example id="queue/retry-and-dead-letters" runtime="any" -->

The Queue retries a packet while its target is suspended. After the last retry, the packet becomes a dead letter. When the target runs again, the app replays the dead letter.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import { QUEUE_ID, createQueue, type QueueControl } from '@platform/queue';

let app: PacketPort | undefined;
const sender = defineSubsystem({
  id: 'app',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (app = ctx.port),
  control: () => NO_CONTROL,
});
const orders = defineSubsystem({
  id: 'orders',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: (packet) => console.log('order saved:', JSON.stringify(packet.take())),
  control: () => NO_CONTROL,
});

const queue = createQueue({ maxRetries: 2, retryBaseMs: 5, retryStrategy: 'exponential' });
const kernel = new Kernel([queue.subsystem, sender, orders], { router: queue.router });
await kernel.start();
const { commands, views } = kernel.unit<QueueControl>(QUEUE_ID).control!;

await kernel.unit('orders').suspend('Database migration.');
try {
  await app!.send({ eventId: 'orders:save', payload: { id: 'A-17' }, target: 'orders' });
} catch (error) {
  console.log('send failed:', (error as Error).message);
}
const [letter] = views.deadLetters.getSnapshot();
console.log('dead letter:', letter.reason, 'after', letter.attempts, 'attempts');

await kernel.unit('orders').resume();
commands.replay(letter.envelope.metadata.messageId);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log('dead letters left:', views.deadLetters.getSnapshot().length);
await kernel.stop();
```

```text output
send failed: Subsystem "orders" cannot receive packets (SUSPENDED).
dead letter: undeliverable after 3 attempts
order saved: {"id":"A-17"}
dead letters left: 0
```

## Refuse optional work while the platform is busy

<!-- example id="queue/admission" runtime="any" -->

With Global State in the kernel, the Queue asks it about each packet. While the platform is `BUSY`, `LOW` packets such as analytics are refused, and `CRITICAL` packets still pass.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';
import { QueueRejectedError, createQueue } from '@platform/queue';

let app: PacketPort | undefined;
const sender = defineSubsystem({
  id: 'app',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (app = ctx.port),
  control: () => NO_CONTROL,
});
const sink = defineSubsystem({
  id: 'sink',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: (packet) => console.log('delivered:', packet.header.eventId),
  control: () => NO_CONTROL,
});

const queue = createQueue();
const kernel = new Kernel(
  [
    createGlobalState({ busyThreshold: 0, environment: createStaticEnvironment(), tabIdentity: false }),
    queue.subsystem,
    sender,
    sink,
  ],
  { router: queue.router },
);
await kernel.start();

// A long import is in progress: with a threshold of 0, the platform is BUSY.
const global = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
global.commands.beginWork({ id: 'import', subsystemId: 'app', importance: 'CRITICAL' });

for (const [eventId, importance] of [['analytics:track', 'LOW'], ['payment:confirm', 'CRITICAL']] as const) {
  try {
    await app!.send({ eventId, payload: null, target: 'sink', importance });
  } catch (error) {
    if (error instanceof QueueRejectedError) console.log('refused:', eventId, `(${error.reason})`);
  }
}
await kernel.stop();
```

```text output
refused: analytics:track (admission)
delivered: payment:confirm
```
