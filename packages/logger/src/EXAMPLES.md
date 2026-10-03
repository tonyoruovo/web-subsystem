# Examples: `@platform/logger`

The Logger keeps log entries and packet trails. It filters entries by level, removes secrets from their context, joins entries and trails by `traceId`, and sends entries to a sink when one is bound.

## Log without leaking secrets

<!-- example id="logger/levels-and-sanitizing" runtime="any" -->

A request fails and the code logs the request. The Logger removes the token from the context. The global level is `WARN`, but the team wants `DEBUG` entries from Sync during an investigation.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { LOGGER_ID, createLogger, type LoggerControl } from '@platform/logger';

const kernel = new Kernel([createLogger({ sessionId: 'session-1', now: () => 0 })]);
await kernel.start();
const { commands } = kernel.unit<LoggerControl>(LOGGER_ID).control!;

commands.setLevel('WARN');
commands.setLevel('DEBUG', 'sync');

commands.log('ERROR', 'Request failed', {
  subsystemId: 'network',
  context: { url: '/api/orders', headers: { Authorization: 'Bearer abc123' }, status: 503 },
});
commands.log('INFO', 'Cache warmed', { subsystemId: 'network' }); // below WARN: dropped
commands.log('DEBUG', 'Pull started', { subsystemId: 'sync' }); // Sync logs at DEBUG

for (const entry of commands.query()) {
  console.log(entry.level, entry.subsystemId, entry.message, JSON.stringify(entry.context));
}
await kernel.stop();
```

```text output
ERROR network Request failed {"url":"/api/orders","headers":{"Authorization":"[REDACTED]"},"status":503}
DEBUG sync Pull started null
```

## Follow a failed request across subsystems

<!-- example id="logger/trace-a-failure" runtime="any" -->

The Logger observes each packet that the Queue settles. A failed request becomes an `ERROR` entry with the `traceId` of the request, so `trace()` shows the full path of the request and the log entries for it.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@platform/core';
import { LOGGER_ID, createLogger, type LoggerControl } from '@platform/logger';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

let checkout: PacketPort | undefined;
const app = defineSubsystem({
  id: 'checkout',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (checkout = ctx.port),
  control: () => NO_CONTROL,
});
const payments = defineSubsystem({
  id: 'payments',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: () => {
    throw new Error('Card declined');
  },
  control: () => NO_CONTROL,
});

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel(
  [queue.subsystem, notification.subsystem, createLogger(), app, payments],
  { router: queue.router, onError: () => {} },
);
await kernel.start();

await checkout!
  .request({ eventId: 'payments:charge', payload: { amount: 42 }, target: 'payments' })
  .catch(() => undefined);

const logger = kernel.unit<LoggerControl>(LOGGER_ID).control!;
const [failure] = logger.commands.query({ levels: ['ERROR'] });
console.log('log:', failure.message);

const trace = logger.commands.trace(failure.traceId!);
for (const record of trace.records) {
  console.log('path:', record.trail.entries.map((e) => `${e.actionName}:${e.subsystemId}`).join(' > '));
}
await kernel.stop();
```

```text output
log: payments:charge failed: Card declined
path: sent:checkout > enqueued:queue > dispatched:queue > delivered:payments > failed:queue
```

## Keep entries until storage is ready

<!-- example id="logger/sink-and-export" runtime="any" -->

The Logger starts before storage. It buffers entries until a sink is bound, then writes the buffer in order. An export gives a text bundle for a bug report.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { LOGGER_ID, createLogger, type LogEntry, type LoggerControl } from '@platform/logger';

const kernel = new Kernel([createLogger({ now: () => Date.UTC(2026, 9, 3, 9, 30) })]);
await kernel.start();
const { commands } = kernel.unit<LoggerControl>(LOGGER_ID).control!;

commands.log('INFO', 'App started');
commands.log('WARN', 'Quota at 90%', { subsystemId: 'storage', componentId: 'idb' });

// Later, storage is ready and binds a sink.
const stored: LogEntry[] = [];
await commands.bindSink((entry) => void stored.push(entry));
commands.log('INFO', 'User signed in', { subsystemId: 'auth' });
console.log('stored entries:', JSON.stringify(stored.map((e) => e.message)));

console.log(commands.export('text', { levels: ['WARN', 'ERROR'] }));
await kernel.stop();
```

```text output
stored entries: ["App started","Quota at 90%","User signed in"]
2026-10-03T09:30:00.000Z WARN  [storage/idb] Quota at 90%
```

## Clean data before you log it

<!-- example id="logger/sanitize" runtime="any" -->

`sanitize` is the function that the Logger runs on each context. Use it directly before you send data to an error tracker. Add patterns for the secrets of your app.

```ts file=main.ts
import { DEFAULT_SENSITIVE_PATTERNS, sanitize } from '@platform/logger';

const report = sanitize(
  {
    user: { email: 'ada@example.com', apiKey: 'k-123' },
    card: '4111 1111 1111 1111',
    error: new TypeError('Cannot read properties of undefined'),
    retry: () => {},
  },
  { patterns: [...DEFAULT_SENSITIVE_PATTERNS, 'card', 'email'] },
);
console.log(JSON.stringify(report, null, 2));
```

```text output
{
  "user": {
    "email": "[REDACTED]",
    "apiKey": "[REDACTED]"
  },
  "card": "[REDACTED]",
  "error": {
    "name": "TypeError",
    "message": "Cannot read properties of undefined"
  },
  "retry": "[Function]"
}
```

## Read the log of the last session

<!-- example id="logger/history" runtime="browser" -->

A support page shows the errors from before the last reload. With Storage in the kernel, the Logger keeps its entries, and `history()` reads them from every session.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { LOGGER_ID, createLogger, type LoggerControl } from '@platform/logger';
import { createStorage } from '@platform/storage';

async function pageLoad(sessionId: string) {
  const kernel = new Kernel([
    createLogger({ sessionId }),
    createStorage({ domain: 'shop', hosts: ['virtual'], keys: null, quota: false }),
  ]);
  await kernel.start();
  return { kernel, logger: kernel.unit<LoggerControl>(LOGGER_ID).control! };
}

const first = await pageLoad('session-1');
first.logger.commands.log('ERROR', 'Payment failed', { subsystemId: 'billing' });
await new Promise((resolve) => setTimeout(resolve, 100)); // let the write finish
await first.kernel.stop();

const second = await pageLoad('session-2');
second.logger.commands.log('INFO', 'Support page opened');
await new Promise((resolve) => setTimeout(resolve, 100));
for (const entry of await second.logger.commands.history()) {
  console.log(entry.sessionId, entry.level, entry.message);
}
await second.kernel.stop();
```

```text output
session-1 ERROR Payment failed
session-2 INFO Support page opened
```
