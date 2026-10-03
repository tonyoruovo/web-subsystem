# Examples: `@platform/notification`

The Notification Center routes broadcasts. It keeps a registry of events with access control, delivers each broadcast to its subscribers, stops calling a subscriber that keeps failing, and records a history with one trail for each broadcast.

## Let only one subsystem announce an event

<!-- example id="notification/publisher-access-control" runtime="any" -->

Only Auth may announce `auth:login`. When another subsystem tries, the broadcast is refused and recorded, and the real subscribers never see it.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import {
  BroadcastRejectedError,
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
} from '@platform/notification';
import { createQueue } from '@platform/queue';

const ports: Record<string, PacketPort> = {};
const sender = (id: string) =>
  defineSubsystem({
    id,
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    init: (ctx) => void (ports[id] = ctx.port),
    control: () => NO_CONTROL,
  });
const welcome = defineSubsystem({
  id: 'welcome',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['auth:login'],
  receive: (packet) => console.log('welcome back,', (packet.take() as { name: string }).name),
  control: () => NO_CONTROL,
});

const notification = createNotificationCenter({
  events: [{ eventId: 'auth:login', publishers: ['auth'] }],
});
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel(
  [queue.subsystem, notification.subsystem, sender('auth'), sender('ads'), welcome],
  { router: queue.router },
);
await kernel.start();

await ports.auth.send({ eventId: 'auth:login', payload: { name: 'Ada' } });
try {
  await ports.ads.send({ eventId: 'auth:login', payload: { name: 'Mallory' } });
} catch (error) {
  if (error instanceof BroadcastRejectedError) console.log('refused:', error.message);
}

const history = kernel.unit<NotificationControl>(NOTIFICATION_ID).control!.views.history;
console.log('history:', JSON.stringify(history.getSnapshot().map((r) => `${r.source}:${r.outcome}`)));
await kernel.stop();
```

```text output
welcome back, Ada
refused: Broadcast of "auth:login" refused: "ads" may not publish it
history: ["auth:fanned-out","ads:rejected"]
```

## Listen to an event from UI code

<!-- example id="notification/ui-subscription" runtime="any" -->

A toast component listens to `sync:done` without being a subsystem. The filter skips empty syncs, and `maxExecutions` removes the subscription after the first toast.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import {
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
} from '@platform/notification';
import { createQueue } from '@platform/queue';

let syncPort: PacketPort | undefined;
const sync = defineSubsystem({
  id: 'sync',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (syncPort = ctx.port),
  control: () => NO_CONTROL,
});

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel([queue.subsystem, notification.subsystem, sync], { router: queue.router });
await kernel.start();

const { commands } = kernel.unit<NotificationControl>(NOTIFICATION_ID).control!;
commands.subscribe(
  'sync:done',
  (payload) => console.log(`toast: ${(payload as { changes: number }).changes} changes synced`),
  {
    subscriber: 'toast',
    filter: (payload) => (payload as { changes: number }).changes > 0,
    maxExecutions: 1,
  },
);

for (const changes of [0, 3, 5]) await syncPort!.send({ eventId: 'sync:done', payload: { changes } });
await kernel.stop();
```

```text output
toast: 3 changes synced
```

## Stop calling a subscriber that keeps failing

<!-- example id="notification/circuit-breaker" runtime="any" -->

A chat widget throws while its server is down. After two failures in a row, its circuit opens and the center skips it, so each broadcast does not wait for a broken subscriber. After the reset time, the center tries it again.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import {
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
} from '@platform/notification';
import { createQueue } from '@platform/queue';

let now = 0;
let serverDown = true;
let presencePort: PacketPort | undefined;
const presence = defineSubsystem({
  id: 'presence',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (presencePort = ctx.port),
  control: () => NO_CONTROL,
});

const notification = createNotificationCenter({
  failureThreshold: 2,
  resetTimeoutMs: 30_000,
  now: () => now,
});
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel([queue.subsystem, notification.subsystem, presence], {
  router: queue.router,
});
await kernel.start();
const { commands, views } = kernel.unit<NotificationControl>(NOTIFICATION_ID).control!;

commands.subscribe(
  'presence:changed',
  () => {
    if (serverDown) throw new Error('chat server unreachable');
  },
  { subscriber: 'chat-widget' },
);

const announce = () => presencePort!.send({ eventId: 'presence:changed', payload: { online: 12 } });
await announce();
await announce();
await announce(); // the circuit is open: skipped
now += 30_000;
serverDown = false;
await announce(); // a trial delivery succeeds and closes the circuit

for (const record of views.history.getSnapshot()) {
  const [delivery] = record.deliveries;
  console.log(delivery.outcome, delivery.reason ?? '');
}
await kernel.stop();
```

```text output
failed chat server unreachable
failed chat server unreachable
skipped circuit open
delivered
```
