# Examples: the Cache backend

The Cache backend keeps each envelope as a response in the Cache API. It works in windows and workers, and it is the last persistent backend of the worker chain.

## Keep API responses for offline use

<!-- example id="storage/cache-offline" runtime="browser" -->

A news reader keeps the last articles, so it can show them offline. Expired entries read as `null`.

```ts file=main.ts
import { CacheBackend, buildCanonicalKey } from '@platform/storage';

const backend = new CacheBackend({ cacheName: 'news' });
console.log('available:', (await backend.probe()).available);
await backend.initialize();

const key = (name: string) =>
  buildCanonicalKey({ domain: 'news', platform: 'browser', platformVersion: 1, callingModule: 'articles', actualKey: name });
const now = Date.now();
await backend.write(key('today'), { payload: '{"title":"Rain at noon"}', schema_version: 1, written_at: now, expires_at: null, weight: 1, backend: 'cache' });
await backend.write(key('old'), { payload: '{"title":"Snow"}', schema_version: 1, written_at: now, expires_at: now - 1, weight: 1, backend: 'cache' });

console.log('today:', JSON.parse((await backend.read(key('today')))!.payload).title);
console.log('old:', await backend.read(key('old')));
await backend.close();
```

```text output
available: true
today: Rain at noon
old: null
```

## Free space by weight

<!-- example id="storage/cache-evict" runtime="browser" -->

The reader keeps saved articles longer than recent ones. A higher weight is evicted later, so an eviction removes the recent articles first.

```ts file=main.ts
import { CacheBackend, buildCanonicalKey } from '@platform/storage';

const backend = new CacheBackend({ cacheName: 'reader' });
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'news', platform: 'browser', platformVersion: 1, callingModule: 'articles', actualKey: name });
const article = (weight: number) => ({
  payload: 'text '.repeat(200),
  schema_version: 1,
  written_at: Date.now(),
  expires_at: null,
  weight,
  backend: 'cache' as const,
});

await backend.write(key('recent'), article(1));
await backend.write(key('saved'), article(10));
await backend.evict(1, 'lru');
console.log('recent kept:', (await backend.read(key('recent'))) !== null);
console.log('saved kept:', (await backend.read(key('saved'))) !== null);
await backend.close();
```

```text output
recent kept: false
saved kept: true
```
