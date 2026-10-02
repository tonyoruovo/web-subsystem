# @platform/logger

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Logger** subsystem (id `logger`, featurized, Tab scope). It keeps:

- **log entries**: level-filtered (globally and per subsystem), with their context **sanitized** so secrets never reach the log;
- **packet trails**: every packet the Queue settles and every broadcast the Notification Center fans out, with its full fingerprint trail;

and joins both by **`traceId`**, so one call shows everything that happened for one user action. It has no required dependency: it runs from the start of boot and follows the Queue and the Notification Center as they come and go. Entries can go to a **sink** (Storage, from M6); until one is bound they are buffered.

Design: [ARCHITECTURE §7.2 and §13](../../docs/ARCHITECTURE.md#72-late-binding-for-centralized-subsystems) and the amended [Logger proposal](../../proposals/logger_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/logger": "workspace:*"
  }
}
```

## Entry points

| Import             | Contents                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@platform/logger` | `createLogger`, `formatEntry`, `LEVEL_RANK`, `LOGGER_ID`, `sanitize`, `DEFAULT_SENSITIVE_PATTERNS`, `REDACTED`, types |

## Usage

```ts
import { createLogger } from '@platform/logger';

const kernel = new Kernel(
  [createGlobalState(), queue.subsystem, notification.subsystem, createLogger(), ...subsystems],
  { router: queue.router, persistence },
);
```

A subsystem logs through an optional dependency, so it also runs without a Logger:

```ts
import type { LoggerControl } from '@platform/logger';

defineSubsystem({
  id: 'storage',
  requires: [{ target: 'logger', kind: 'optional' }],
  init(ctx) {
    const logger = ctx.dependency<LoggerControl>('logger');
    logger?.commands.log('WARN', 'Quota low', {
      subsystemId: ctx.id,
      componentId: 'idb',
      context: { used, available },
    });
  },
  // ...
});
```

Reading the log:

```ts
const { commands, views } = kernel.unit<LoggerControl>('logger').control!;

commands.query({ levels: ['ERROR', 'FATAL'], limit: 20 });
commands.trace(traceId); // { records: [trails], entries: [log entries] }
commands.export('text', { since: Date.now() - 600_000 }); // a diagnostic bundle
views.entries.subscribe(() => render(views.entries.getSnapshot()));
```

Thresholds are persisted:

```ts
commands.setLevel('WARN'); // everyone
commands.setLevel('DEBUG', 'sync'); // except Sync
commands.resetLevel('sync');
```

## Behaviour

| Situation                                               | Result                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| An entry below the threshold                            | Not kept; `log` returns `null`. Check `isEnabled` before costly context.                   |
| A context key containing a sensitive pattern            | Its value becomes `'[REDACTED]'`, at any depth                                             |
| A context value that cannot be cloned                   | Described: errors as `{ name, message }`, functions as `'[Function]'`, ...                 |
| The Queue settles a packet                              | A `packet` trace record; `failed` and `dead-lettered` also log an ERROR, `rejected` a WARN |
| The Notification Center fans out a broadcast            | A `broadcast` trace record; each failed delivery logs a WARN                               |
| The Queue or Notification Center stops, then runs again | The Logger stops observing it, then observes it again                                      |
| The ring is full                                        | The oldest entry is evicted; `state.dropped` counts them                                   |
| No sink is bound                                        | Entries are buffered (`sinkCapacity`), and written in order on `bindSink`                  |
| The sink throws or rejects                              | Reported to the kernel's `onError`; logging carries on                                     |

## Options

| Option         | Default                   | Purpose                                                |
| -------------- | ------------------------- | ------------------------------------------------------ |
| `minLevel`     | `INFO`                    | The threshold until `setLevel` changes it (persisted). |
| `maxEntries`   | `1000`                    | Entries kept.                                          |
| `maxTraces`    | `200`                     | Trace records kept.                                    |
| `sinkCapacity` | `500`                     | Entries buffered until a sink is bound.                |
| `console`      | `false`                   | Mirror entries at or above this level to the console.  |
| `sanitize`     | default patterns, depth 6 | Extra sensitive patterns, or a different depth.        |
| `sessionId`    | `crypto.randomUUID()`     | Identifies this run in every entry.                    |
| `now`          | `Date.now`                | Clock.                                                 |

## Testing

```bash
pnpm exec vitest run --project node packages/logger
```
