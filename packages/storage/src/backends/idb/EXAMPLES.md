# Examples: the IndexedDB backend

The IndexedDB backend is the first choice of the Storage coordinator. It gives real (`serializable`) transactions, works in workers, and keeps large amounts of data.

## Store and list entries

<!-- example id="storage/idb-store-and-list" runtime="browser" -->

An offline mail client keeps its drafts in IndexedDB and lists the drafts of one account by prefix.

```ts file=main.ts
import { IDBBackend, buildCanonicalKey } from '@platform/storage';

const backend = new IDBBackend({ dbName: 'mail' });
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'mail', platform: 'browser', platformVersion: 1, callingModule: 'drafts', actualKey: name });
const draft = (subject: string, written_at: number) => ({
  payload: JSON.stringify({ subject }),
  schema_version: 1,
  written_at,
  expires_at: null,
  weight: 1,
  backend: 'indexeddb' as const,
});

await backend.write(key('d1'), draft('Lunch?', 1));
await backend.write(key('d2'), draft('Report', 2));
const rows = await backend.query({ prefix: 'mail:browser:1:drafts:' });
console.log('drafts:', rows.length);
console.log('first subject:', JSON.parse(rows[0]!.envelope.payload).subject);
await backend.clear('mail:browser:1:drafts:');
console.log('after clear:', await backend.count());
await backend.close();
```

```text output
drafts: 2
first subject: Lunch?
after clear: 0
```

## Commit or roll back

<!-- example id="storage/idb-transaction" runtime="browser" -->

A transfer between two envelopes must apply fully or not at all. IndexedDB applies the buffered operations in one real transaction.

```ts file=main.ts
import { IDBBackend, buildCanonicalKey } from '@platform/storage';

const backend = new IDBBackend({ dbName: 'budget' });
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'budget', platform: 'browser', platformVersion: 1, callingModule: 'pots', actualKey: name });
const pot = (amount: number) => ({
  payload: String(amount),
  schema_version: 1,
  written_at: Date.now(),
  expires_at: null,
  weight: 1,
  backend: 'indexeddb' as const,
});

const failed = await backend.beginTransaction();
await backend.write(key('food'), pot(70), { transactionId: failed.id });
await failed.rollback();
console.log('after rollback:', await backend.read(key('food')));

const ok = await backend.beginTransaction('serializable');
await backend.write(key('food'), pot(70), { transactionId: ok.id });
await backend.write(key('fun'), pot(30), { transactionId: ok.id });
await ok.commit();
console.log('after commit:', (await backend.read(key('food')))?.payload, (await backend.read(key('fun')))?.payload);
await backend.close();
```

```text output
after rollback: null
after commit: 70 30
```
