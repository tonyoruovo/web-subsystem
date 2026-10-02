# @platform/queue

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Queue**: the platform's packet router. It is a centralized subsystem (id `queue`, Tab scope), and its `router` replaces the kernel's direct router, so every packet a subsystem sends goes through it. The Queue owns **scheduling**:

- **admission**: asks Global State (`@platform/global-state`) whether the packet's importance is accepted now, and registers it as pending work until it settles;
- **priorities**: `CRITICAL` > `HIGH` > `MEDIUM` > `LOW`, first in first out within a tier; `CRITICAL` packets are dispatched at once and never refused for depth;
- **ordering**: packets that share an `orderingKey` are delivered one at a time, in order;
- **retries**: a packet whose target is not running (waiting, starting, suspended or failed) is retried with backoff;
- **dead letters**: packets that run out of retries or expire are kept, written to a sink you bind later (Storage, from M6), and can be replayed;
- **trails**: every settled packet is recorded with its full fingerprint trail.

The kernel owns delivery, and the Notification Center (`@platform/notification`) owns broadcast fan-out. Design: [ARCHITECTURE §10.1](../../docs/ARCHITECTURE.md#101-how-the-three-centralized-subsystems-fit-together-m3) and the amended [Queue proposal](../../proposals/queue_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/queue": "workspace:*"
  }
}
```

## Entry points

| Import            | Contents                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@platform/queue` | `createQueue`, `QUEUE_ID`, `QueueRejectedError`, and the types `QueueOptions`, `QueueControl`, `SettledPacket`, `DeadLetter`, … |

## Usage

```ts
import { Kernel } from '@platform/core';
import { createGlobalState } from '@platform/global-state';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });

const kernel = new Kernel(
  [createGlobalState(), queue.subsystem, notification.subsystem, ...subsystems],
  { router: queue.router },
);
await kernel.start();
```

Subsystems do not talk to the Queue directly; they use their port, and the packet's fields steer scheduling:

```ts
await ctx.port.send({
  eventId: 'chat:message',
  payload,
  target: 'sync',
  importance: 'HIGH',
  orderingKey: `conversation:${id}`, // keeps one conversation's messages in order
  ttl: 10_000, // dead-lettered if not delivered within 10 s
});
```

Application code watches and steers it through the control interface:

```ts
import type { QueueControl } from '@platform/queue';

const { commands, views } = kernel.unit<QueueControl>('queue').control!;
views.state.subscribe(() => console.log(views.state.getSnapshot())); // depth, inFlight, ...
await commands.bindDeadLetterSink((letter) => storage.commands.append('dead-letters', letter));
commands.replay(messageId);

// `views.trails` keeps the last `trailHistory` packets; observe to see every one (the Logger does).
const stop = commands.observe((settled) => archive(settled));
```

## Behaviour

| Situation                                             | Result                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| A broadcast outside its sender's scope                | `QueueRejectedError` (`scope`)                                            |
| Global State does not admit the importance            | `QueueRejectedError` (`admission`)                                        |
| `maxDepth` packets are waiting (not for `CRITICAL`)   | `QueueRejectedError` (`overflow`)                                         |
| The target is waiting, starting, suspended or failed  | Retried with backoff (`retry-scheduled`, WARN); a dead letter at the end  |
| The target is destroyed                               | A dead letter                                                             |
| The packet's `ttl` has passed                         | A dead letter (`expired`)                                                 |
| The target throws                                     | `failed` (ERROR); the error goes back to the sender; not retried          |
| The target is unknown, a feature, or has no `receive` | `failed`; not retried                                                     |
| The Queue is suspended                                | Packets wait; nothing is dispatched until it resumes                      |
| The Queue is destroyed                                | Waiting packets, and any sent later, get `QueueRejectedError` (`stopped`) |

A completed request's trail reads `sent`, `enqueued`, `dispatched`, `delivered` (by the target), then whatever the target stamped, then `completed`. A broadcast's deliveries are recorded by the Notification Center.

Without Global State in the kernel, every packet is admitted. Without a `fanOut`, broadcasts go to the kernel's direct broadcast.

## Options

| Option               | Default              | Purpose                                               |
| -------------------- | -------------------- | ----------------------------------------------------- |
| `fanOut`             | `kernel.broadcast`   | Where broadcasts go (the Notification Center's).      |
| `maxRetries`         | `3`                  | Retries of a packet whose target is not running.      |
| `retryBaseMs`        | `100`                | The first retry's base wait.                          |
| `retryStrategy`      | `exponential-jitter` | The backoff formula (see `computeBackoff` in core).   |
| `maxDepth`           | `1000`               | Waiting packets before non-critical ones are refused. |
| `maxActive`          | `8`                  | Packets dispatched at the same time.                  |
| `deadLetterCapacity` | `100`                | Dead letters kept in memory and buffered.             |
| `trailHistory`       | `50`                 | Settled packets kept in `views.trails`.               |
| `scheduler`          | `createScheduler()`  | Runs non-critical dispatches.                         |
| `now`, `random`      | `Date.now`, crypto   | Clock and jitter source.                              |

## Testing

```bash
pnpm exec vitest run --project node packages/queue
```
