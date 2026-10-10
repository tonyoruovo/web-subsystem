# @webkrnl/network

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/network) and [JSR](https://jsr.io/@webkrnl/network).

The **Network** subsystem (id `network`, featurized, Tab scope, no required dependency). It sends the HTTP requests of every subsystem and of the app:

- **Timeouts**: each request has one (default 30 s). A timeout is a `NetworkTimeoutError`.
- **Retries**: network errors and `408`, `425`, `429`, `5xx` retry with backoff, and `Retry-After` is honoured. Only idempotent methods retry, or a request with an `idempotencyKey` (sent as `Idempotency-Key`).
- **One fetch for identical requests**: identical `GET` requests in flight share one fetch.
- **Priorities**: at most `maxConcurrent` requests run; the others wait by importance.
- **Cache**: `network-first`, `cache-first` and `cache-only`, with a time to live and `ETag` revalidation. When Storage runs, the cache is also kept there: **encrypted by default**, compressed on request (`persistCache`, or `cachePersist` for one request).
- **Offline**: a request fails at once with `OfflineError`, unless the cache answers. Sync keeps work for later.
- **Circuit breaker**: after repeated failures to one origin, requests to it fail at once for a cool-down.
- **Interceptors**: other subsystems add request and response interceptors. Auth adds its token this way.
- **Pending work**: each request shows in Global State while it runs, unless it is `background`.

It runs on the main thread: a response body is a stream that callers need in their own realm. Design: [ARCHITECTURE §19.1](../../docs/ARCHITECTURE.md#191-network) and the amended [Network proposal](../../docs/proposals/network_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/network": "workspace:*"
  }
}
```

## Entry points

| Import             | Contents                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| `@webkrnl/network` | `createNetwork`, the errors, `ResponseCache`, `Breakers`, and the types |

## Usage

```ts
import { createNetwork, HttpError, type NetworkControl } from '@webkrnl/network';

const kernel = new Kernel(
  [...centralized, createNetwork({ baseUrl: 'https://api.shop.example/' })],
  {
    router: queue.router,
  },
);
await kernel.start();

const { commands } = kernel.unit<NetworkControl>('network').control!;
const { data } = await commands.get<Product[]>('/products', { cache: 'network-first' });
await commands.post('/orders', order, { idempotencyKey: order.id });

try {
  await commands.get('/missing');
} catch (error) {
  if (error instanceof HttpError) console.warn(error.status, error.response.data);
}
```

From another subsystem, declare `{ target: 'network' }` in `requires` and use `ctx.dependency<NetworkControl>('network')`.

## Recommended flow

**Tokens and transport**

1. Use HTTPS only. Let Auth add the token: it adds `Authorization: Bearer` only for its `protectedOrigins`, and refreshes once on a `401`. Do not add tokens in your own interceptors or in query strings.
2. Keep `credentials: 'same-origin'` (the default). Your API takes the Bearer token, not cookies, so it needs no CSRF protection. Only the auth endpoints of the server use the session cookie (see the Auth README).

**Retries**

3. Give every request that changes data an `idempotencyKey` (Sync does this for you), and keep the keys on the server at least as long as a client can retry: for offline work, days, not minutes. Then a retry never applies a change twice.
4. Send `Retry-After` with `429` and `503`. The Network waits that long.

**Caching**

5. Cache only `GET` responses that are safe to show again: `network-first` for data that should be fresh but must work offline, `cache-first` for data that changes rarely. Send an `ETag`, so a stale entry costs a `304` and no body.
6. Keep the default `persistCache: { encrypt: true }` for anything about the user. Turn encryption off (`cachePersist: { encrypt: false }`) only for public data, and turn compression on for large text responses. Use `cachePersist: false` for data that must not survive a reload.
7. The Network does not read `Cache-Control`: the call site decides. Do not set a cache strategy on responses that the server marks `no-store`.
8. On sign-out, the Network wipes the cached responses of the user and aborts the requests in flight by itself (ARCHITECTURE §5.1). Declare Auth in the kernel; nothing else is needed.

## Behaviour

| Situation                                                                    | Result                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Sign-out, or another user signs in (ARCHITECTURE §5.1)                       | The requests in flight are aborted, and every cached response is wiped, in memory and in Storage |
| A status that is not 2xx                                                     | `HttpError` with the parsed response, or the response with `allowErrorStatus: true`              |
| A retryable failure of an idempotent request                                 | Retried up to `retries` times with backoff                                                       |
| A `POST` or `PATCH` without `idempotencyKey` fails                           | Not retried                                                                                      |
| Offline, `network-only`                                                      | `OfflineError` at once                                                                           |
| Offline, `network-first` or `cache-first`                                    | The cached answer, even when it is stale                                                         |
| A stale `cache-first` entry with an `ETag`                                   | A conditional request; a `304` reuses the body (`revalidated: true`)                             |
| `threshold` failures in a row to one origin                                  | `CircuitOpenError` at once until the cool-down ends; then one trial request                      |
| A response interceptor returns `'retry'`                                     | The request goes out one more time                                                               |
| `abort(id)`, `abortAll()` or the caller's signal                             | `RequestAbortedError`                                                                            |
| The Network stops                                                            | Every running request is aborted                                                                 |
| A cached response with `cachePersist: { encrypt: true }` and no Storage keys | Kept in memory only, never in plain text                                                         |
| `cachePersist: false`                                                        | Kept in memory only                                                                              |

## Options

| Option          | Default                                | Purpose                                                                                            |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `baseUrl`       | `location.href`                        | The base of relative URLs.                                                                         |
| `timeoutMs`     | `30_000`                               | The default timeout.                                                                               |
| `retries`       | `3`                                    | The default number of retries.                                                                     |
| `retryBaseMs`   | `300`                                  | The base wait of the backoff.                                                                      |
| `maxConcurrent` | `6`                                    | Requests at the same time.                                                                         |
| `cacheTtlMs`    | `300_000`                              | How long a cached response stays fresh.                                                            |
| `cacheEntries`  | `200`                                  | Cached responses in memory.                                                                        |
| `persistCache`  | `{ encrypt: true, compress: false }`   | How cached responses are kept in Storage, or `false`. A request can change it with `cachePersist`. |
| `breaker`       | `{ threshold: 5, cooldownMs: 30_000 }` | The circuit breaker, or `false`.                                                                   |
| `fetch`         | the global `fetch`                     | The fetch function (tests give a fake).                                                            |

## Testing

```bash
pnpm exec vitest run --project node packages/network
```
