# Examples: the memory backend

The memory backend keeps envelopes in a `Map`. Data is lost when the page reloads. It is the last fallback of the Storage coordinator on the main thread, and a fast backend for tests.

## Expire short-lived codes

<!-- example id="storage/memory-ttl" runtime="any" -->

A sign-in flow keeps a one-time code for a short time. An expired entry reads as `null`, and the read deletes it.

```ts file=main.ts
import { MemoryBackend, buildCanonicalKey } from '@platform/storage';

const backend = new MemoryBackend();
await backend.initialize();
const key = buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'auth', actualKey: 'otp' });

const now = Date.now();
await backend.write(key, { payload: '481516', schema_version: 1, written_at: now, expires_at: now + 50, weight: 1, backend: 'memory' });
console.log('before expiry:', (await backend.read(key))?.payload);

await new Promise((resolve) => setTimeout(resolve, 80));
console.log('after expiry:', await backend.read(key));
console.log('entries left:', await backend.count());
await backend.close();
```

```text output
before expiry: 481516
after expiry: null
entries left: 0
```

## Evict the entries that are read least

<!-- example id="storage/memory-lfu" runtime="any" -->

A cache of product pages must free space. With the `lfu` policy, the entries read least go first. The weight comes first: a higher weight is evicted later.

```ts file=main.ts
import { MemoryBackend, buildCanonicalKey } from '@platform/storage';

const backend = new MemoryBackend();
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'pages', actualKey: name });
const page = (weight: number) => ({
  payload: 'x'.repeat(100),
  schema_version: 1,
  written_at: 1,
  expires_at: null,
  weight,
  backend: 'memory' as const,
});

await backend.write(key('home'), page(1));
await backend.write(key('tea'), page(1));
await backend.write(key('checkout'), page(10)); // important: evicted last
await backend.read(key('home'));
await backend.read(key('home'));

await backend.evict(1, 'lfu'); // free at least 1 byte: one entry goes
const left = await backend.query({ prefix: 'shop:browser:1:pages:' });
console.log('kept:', left.map((row) => row.key.split(':').at(-1)).join(', '));
await backend.close();
```

```text output
kept: home, checkout
```

## Batch writes in a transaction

<!-- example id="storage/memory-transaction" runtime="any" -->

Writes with a `transactionId` wait in a buffer. `commit` applies them in one step. A partial `rollback` removes some of them first.

```ts file=main.ts
import { MemoryBackend, buildCanonicalKey } from '@platform/storage';

const backend = new MemoryBackend();
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'cart', actualKey: name });
const envelope = { payload: '1', schema_version: 1, written_at: 1, expires_at: null, weight: 1, backend: 'memory' as const };

const tx = await backend.beginTransaction();
await backend.write(key('tea'), envelope, { transactionId: tx.id });
await backend.write(key('cups'), envelope, { transactionId: tx.id });
console.log('buffered:', tx.operations.length, 'stored:', await backend.count());

await tx.rollback(key('cups'));
await tx.commit();
console.log('stored after commit:', await backend.count());
console.log('cups stored:', (await backend.read(key('cups'))) !== null);
await backend.close();
```

```text output
buffered: 2 stored: 0
stored after commit: 1
cups stored: false
```
