# Examples: Storage backends

A backend stores envelopes under canonical keys. All five backends (IndexedDB, OPFS, Cache, Web Storage and memory) implement one contract, `IStorageBackend`, so code can use any of them. In an app, the Storage coordinator chooses and uses the backend for you. Use a backend directly for tools, tests and special cases.

## Choose the first backend that works

<!-- example id="storage/choose-a-backend" runtime="browser" -->

The coordinator probes a chain of backends and uses the first one that works. This is the same idea, for a tool that runs outside the platform.

```ts file=main.ts
import {
  IDBBackend,
  MemoryBackend,
  OPFSBackend,
  type IStorageBackend,
} from '@platform/storage';

async function firstAvailable(chain: IStorageBackend<unknown>[]) {
  for (const backend of chain) {
    const probe = await backend.probe();
    console.log('probe', backend.kind + ':', probe.available);
    if (!probe.available) continue;
    await backend.initialize();
    return backend;
  }
  throw new Error('No backend works here.');
}

const backend = await firstAvailable([
  new IDBBackend({ dbName: 'tool' }) as IStorageBackend<unknown>,
  new OPFSBackend({ rootDirName: 'tool' }) as IStorageBackend<unknown>,
  new MemoryBackend(),
]);
console.log('using:', backend.kind, 'strength:', backend.transactionStrength);
await backend.close();
```

```text output
probe indexeddb: true
using: indexeddb strength: serializable
```

## Copy a module from one backend to another

<!-- example id="storage/copy-a-module" runtime="browser" -->

A support tool moves the data of one module from `localStorage` to IndexedDB. The function works with any two backends, because it uses only the contract.

```ts file=main.ts
import {
  IDBBackend,
  LocalStorageBackend,
  buildCanonicalKey,
  type IStorageBackend,
} from '@platform/storage';

async function copyModule(from: IStorageBackend, to: IStorageBackend, prefix: string) {
  const rows = await from.query({ prefix });
  const tx = await to.beginTransaction();
  for (const { key, envelope } of rows) {
    await to.write(key, { ...envelope, backend: to.kind }, { transactionId: tx.id });
  }
  await tx.commit();
  return rows.length;
}

const local = new LocalStorageBackend({ keyPrefix: 'tool:' });
const idb = new IDBBackend({ dbName: 'tool' });
await local.initialize();
await idb.initialize();

const key = (name: string) =>
  buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'cart', actualKey: name });
const envelope = (payload: string) => ({
  payload,
  schema_version: 1,
  written_at: 1,
  expires_at: null,
  weight: 1,
  backend: 'localstorage' as const,
});
await local.write(key('items'), envelope('["tea"]'));
await local.write(key('coupon'), envelope('"SPRING"'));

console.log('copied:', await copyModule(local, idb, 'shop:browser:1:cart:'));
console.log('in IndexedDB:', (await idb.read(key('items')))?.payload);
await local.close();
await idb.close();
```

```text output
copied: 2
in IndexedDB: ["tea"]
```
