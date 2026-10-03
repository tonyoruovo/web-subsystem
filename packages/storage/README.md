# @platform/storage

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Storage** subsystem (id `storage`, featurized, Tab scope, no required dependency). It keeps the data of an app in **collections**, and one **coordinator** writes for every tab of the origin:

- **Backends**: IndexedDB, then OPFS, then the Cache API in a worker. On the main thread, also `localStorage`, `sessionStorage` and memory. The coordinator uses the first backend that works.
- **Pipeline**: serialize, gzip, encrypt (AES-GCM) and an HMAC tag on a write. On a read, the reverse, then migration with write-back. Encryption uses the keys of [`@platform/crypto`](../crypto/README.md).
- **Validation**: each collection can have a schema (zod, or anything with `safeParse`). The caller's realm validates before a write and after a read, so the full schema always applies.
- **Collections**: canonical keys (`<domain>:<platform>:<platformVersion>:<module>:<key>`), time to live, eviction weight, a maximum number of entries, and filters that run where the data is.
- **Batches**: writes and deletes on several collections in one backend transaction.
- **Events**: changes reach every tab (`BroadcastChannel`). A quota monitor warns and evicts. Corrupt entries are reported.

The coordinator runs in a **shared worker**, then on the main thread (failover). Functions of a collection (migrations, serializers, filters) cross to the worker as **portable functions**. Design: [ARCHITECTURE §18.2](../../docs/ARCHITECTURE.md#182-storage) and the amended [Storage proposal](../../proposals/storage_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/crypto": "workspace:*",
    "@platform/storage": "workspace:*"
  }
}
```

`zod` is an optional peer dependency. The package starts its worker with `new SharedWorker(new URL('./coordinator.worker.ts', import.meta.url), { type: 'module' })`. Vite, webpack 5 and Rollup find the worker file from this expression.

## Entry points

| Import                     | Contents                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@platform/storage`        | `createStorage`, `Collection`, `Batch`, `createCoordinator`, `encode`/`decode`, `createStatePersistence`, the backends, canonical keys |
| `@platform/storage/worker` | The worker entry. It serves the coordinator. You do not import it yourself.                                |

## Usage

```ts
import { createCrypto } from '@platform/crypto';
import { createStatePersistence, createStorage, type StorageControl } from '@platform/storage';
import { z } from 'zod';

const kernel = new Kernel([...centralized, createCrypto(), createStorage({ domain: 'shop' })], {
  router: queue.router,
  persistence: createStatePersistence(),
});
await kernel.start();

const { commands } = kernel.unit<StorageControl>('storage').control!;
const cart = commands.collection({ name: 'cart', schema: z.array(z.string()), ttl: 7 * 86_400_000 });
await cart.set('items', ['tea']);
await cart.get('items'); // ['tea']
cart.subscribe((change) => renderBadge()); // changes from every tab

const vault = commands.collection({ name: 'vault', schema: z.string(), encrypt: true });
await commands.batch((batch) => batch.delete(cart, 'items').set(orders, id, order));
```

From another subsystem, declare `{ target: 'storage', kind: 'optional' }` in `requires` and use `ctx.watch<StorageControl>('storage', ...)`. The Queue and the Logger do this to keep their dead letters and log entries.

### Collection options

| Option        | Default          | Purpose                                                                       |
| ------------- | ---------------- | ----------------------------------------------------------------------------- |
| `name`        | (required)       | The module segment of the keys. Letters, digits, `_`, `.` and `-`.            |
| `schema`      | none             | Validates each value before a write and after a read.                        |
| `version`     | `1`              | The schema version of new entries.                                            |
| `migrations`  | none             | `{ 2: (v1) => v2, ... }`. They must be self-contained functions.              |
| `ttl`         | no expiry        | The time to live of each entry, in milliseconds.                              |
| `weight`      | `1`              | A higher weight is evicted later.                                             |
| `encrypt`     | `false`          | AES-GCM and an HMAC tag, with the keys of `@platform/crypto`.                 |
| `compress`    | `false`          | gzip, for large text values.                                                  |
| `maxEntries`  | no limit         | A write deletes the oldest entries above the limit.                          |
| `serialize`, `deserialize` | JSON | Custom text form. They must be self-contained functions.               |

## Behaviour

| Situation                                              | Result                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A value fails the schema on `set`                      | `StorageValidationError`. Nothing is written.                                                               |
| A stored value fails the schema on `get`               | `undefined`, a `storage:corrupt` broadcast, and an error report                                             |
| A wrong HMAC tag, or an entry that does not decode     | The entry is deleted. `undefined`, `storage:corrupt` and an error report.                                   |
| An entry has an older schema version                   | The read migrates it and writes it back. `migrate()` migrates the whole collection.                         |
| The shared worker dies during a write                  | The runner runs the write again on the main thread. Both use the same database, so no data is lost.         |
| A worker has no persistent backend, or a strict CSP    | The worker refuses, and the coordinator runs on the main thread                                             |
| WebKit: a shared worker cannot store a `CryptoKey`     | The worker refuses, and the coordinator runs on the main thread                                             |
| No persistent backend at all (some private windows)    | Memory. `state.persistent` is `false`.                                                                      |
| Crypto rotates or forgets keys (`crypto:keys-changed`) | The coordinator opens the key store again                                                                  |
| Use reaches the warning level (80 %)                   | `storage:quota` with `level: 'warning'`                                                                     |
| Use reaches the critical level (95 %)                  | Eviction (expired entries, then the lowest weight), then `storage:quota` with `level: 'critical'`          |

## Options

| Option            | Default                         | Purpose                                                              |
| ----------------- | ------------------------------- | -------------------------------------------------------------------- |
| `domain`          | `location.hostname`, or `app`   | The first segment of every key.                                      |
| `platform`        | `browser`                       | The platform segment.                                                |
| `platformVersion` | `1`                             | Increase it to start with a new namespace.                          |
| `hosts`           | `['shared', 'virtual']`         | The hosts of the coordinator, in order.                              |
| `backends`        | depends on the host             | The backend chain.                                                   |
| `database`        | `__platform_storage`            | The IndexedDB database, the OPFS folder and the cache.               |
| `keys`            | `{ source: { kind: 'device' } }` | The key store of `@platform/crypto`, or `null` for no encryption. Use the source of `createCrypto`. |
| `quota`           | every 60 s, 0.8 and 0.95        | `{ intervalMs, warning, critical }`, or `false`.                     |

## Events

| Event             | Payload         | When                                    |
| ----------------- | --------------- | --------------------------------------- |
| `storage:changed` | `StorageChange` | After each change, in this tab or another tab |
| `storage:quota`   | `QuotaAlert`    | At the warning and the critical level   |
| `storage:corrupt` | `CorruptEntry`  | When an entry cannot be read            |

## Kernel persistence

`createStatePersistence()` is the kernel's `persistence` option. The kernel loads state before any subsystem runs, so the adapter talks to IndexedDB directly, then falls back to `localStorage`, then to memory.

## Testing

```bash
pnpm exec vitest run --project node packages/storage
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/storage
```

The browser tests include the M6 gate: the shared worker dies during a write, and no data is lost.
