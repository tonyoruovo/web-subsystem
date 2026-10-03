# Examples: the Web Storage backends

`LocalStorageBackend` and `SessionStorageBackend` keep envelopes as JSON text in `localStorage` and `sessionStorage`. They exist only on the main thread, so the Storage coordinator uses them after a failover from the worker. Their transactions are `compensating`: a failed commit restores a snapshot.

## Keep data for one tab

<!-- example id="storage/session-storage" runtime="browser" -->

A checkout form keeps its progress for the current tab only. `sessionStorage` forgets it when the tab closes. The key prefix keeps the entries apart from other code on the page.

```ts file=main.ts
import { SessionStorageBackend, buildCanonicalKey } from '@platform/storage';

const backend = new SessionStorageBackend({ keyPrefix: 'shop:' });
await backend.initialize();
const key = buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'checkout', actualKey: 'step' });

await backend.write(key, { payload: '"address"', schema_version: 1, written_at: 1, expires_at: null, weight: 1, backend: 'sessionstorage' });
console.log('step:', JSON.parse((await backend.read(key))!.payload));
console.log('raw key in sessionStorage:', sessionStorage.key(0));
await backend.close();
```

```text output
step: address
raw key in sessionStorage: shop:shop:browser:1:checkout:step
```

## Roll back part of a transaction

<!-- example id="storage/local-storage-transaction" runtime="browser" -->

A settings import buffers several writes, then drops the ones that the user did not confirm. `rollback(predicate)` removes the matching operations and keeps the transaction open.

```ts file=main.ts
import { LocalStorageBackend, buildCanonicalKey } from '@platform/storage';

const backend = new LocalStorageBackend({ keyPrefix: 'app:' });
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'app', platform: 'browser', platformVersion: 1, callingModule: 'settings', actualKey: name });
const setting = (value: string) => ({
  payload: JSON.stringify(value),
  schema_version: 1,
  written_at: 1,
  expires_at: null,
  weight: 1,
  backend: 'localstorage' as const,
});

const tx = await backend.beginTransaction('compensating');
await backend.write(key('theme'), setting('dark'), { transactionId: tx.id });
await backend.write(key('language'), setting('fr'), { transactionId: tx.id });
const removed = await tx.rollback((op) => op.key === key('language'));
await tx.commit();

console.log('removed:', removed.length);
console.log('theme:', (await backend.read(key('theme')))?.payload);
console.log('language:', await backend.read(key('language')));
await backend.close();
```

```text output
removed: 1
theme: "dark"
language: null
```
