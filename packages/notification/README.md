# @platform/notification

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Notification Center**: the platform's broadcast router. It is a centralized subsystem (id `notification`, Tab scope) that owns **routing only** (amendment A10):

- the **event registry**, with access control: who may publish an event, who may receive it;
- **subscriptions**: subsystems that list an event in `subscribes`, plus programmatic subscriptions for adapters and UI code;
- a **circuit breaker** per subscriber, so one that keeps failing stops slowing every broadcast down;
- **history**: the last broadcasts, each with its deliveries and one full fingerprint trail.

It has no queue and no retries: the Queue (`@platform/queue`) schedules every packet and hands broadcasts to `fanOut`. Design: [ARCHITECTURE §10.1](../../docs/ARCHITECTURE.md#101-how-the-three-centralized-subsystems-fit-together-m3) and the amended [Notification proposal](../../proposals/notification_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/notification": "workspace:*"
  }
}
```

## Usage

```ts
import { Kernel } from '@platform/core';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

const notification = createNotificationCenter({
  events: [
    { eventId: 'auth:login', publishers: ['auth'] },
    { eventId: 'ui:page-view', subscribers: ['analytics'] },
  ],
});
const queue = createQueue({ fanOut: notification.fanOut });

const kernel = new Kernel([queue.subsystem, notification.subsystem, ...subsystems], {
  router: queue.router,
});
```

A subsystem receives a broadcast by listing it and handling it in `receive`; each subscriber gets its own copy of the payload:

```ts
defineSubsystem({
  id: 'audit',
  subscribes: ['auth:login'],
  receive: (packet) => record(packet.take()),
  // ...
});
```

Application code subscribes through the control interface:

```ts
import type { NotificationControl } from '@platform/notification';

const { commands, views } = kernel.unit<NotificationControl>('notification').control!;
const stop = commands.subscribe('auth:login', (payload) => showWelcome(payload), {
  subscriber: 'ui',
  maxExecutions: 1,
});
views.history.subscribe(() => console.table(views.history.getSnapshot()));
```

## Behaviour

| Situation                                        | Result                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| The source is not in the event's `publishers`    | `BroadcastRejectedError`; recorded as `rejected`                                 |
| `strict: true` and the event is not registered   | `BroadcastRejectedError`                                                         |
| A subscriber is not in the event's `subscribers` | Not delivered                                                                    |
| A subscriber throws                              | Recorded as `failed`; the broadcast and the sender are unaffected                |
| `failureThreshold` failures in a row             | The subscriber's circuit opens and it is `skipped` until `resetTimeoutMs` passes |
| The sender subscribes to its own event           | It does not receive its own broadcast                                            |

Each history record's trail is the sender's fingerprints, then `fanned-out`, then one entry per delivery (`delivered`, `failed` or `skipped`, with the subscriber as `componentId`).

## Options

| Option             | Default    | Purpose                                    |
| ------------------ | ---------- | ------------------------------------------ |
| `events`           | `[]`       | Events to register up front.               |
| `strict`           | `false`    | Refuse broadcasts of unregistered events.  |
| `historySize`      | `100`      | Broadcasts kept in the history.            |
| `failureThreshold` | `3`        | Failures that open a subscriber's circuit. |
| `resetTimeoutMs`   | `30000`    | How long a circuit stays open.             |
| `now`              | `Date.now` | Clock.                                     |

## Testing

```bash
pnpm exec vitest run --project node packages/notification
```
