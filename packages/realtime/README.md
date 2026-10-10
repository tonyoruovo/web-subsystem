# @webkrnl/realtime

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/realtime) and [JSR](https://jsr.io/@webkrnl/realtime).

The **Realtime** subsystem (id `realtime`, featurized, Tab scope, no required dependency). It keeps one WebSocket for many topics:

- **A worker socket**: the processor `socket` owns the WebSocket in a **dedicated worker**, then on the main thread (failover). Heartbeats stay on time when the page is busy.
- **Reconnects**: a dropped socket reconnects with backoff while the platform is online. Going online reconnects at once. `maxAttempts` limits the attempts.
- **Heartbeats**: a `ping` every `heartbeatMs`; no `pong` in time closes the socket and reconnects.
- **Topics**: many topics share one socket. Every topic subscribes again after a reconnect.
- **Publish buffer**: messages published while disconnected go out after the next open (bounded).
- **Presence**: `presence` frames keep a map of peers; peers without news become `offline`.
- **Auth**: with `auth: 'message'` (recommended) or `'query'`, the access token of Auth reaches the server, and a new token reconnects.
- **Pluggable protocol**: JSON frames by default; `protocol: { encode, decode }` for another server (portable functions).
- **The Global transport** (option `global`): Global broadcasts reach the other devices and sessions of the user through your server, and the Window relay carries Window broadcasts where the browser partitions the hub. See [The Global transport](#the-global-transport).

Design: [ARCHITECTURE §19.4](../../docs/ARCHITECTURE.md#194-realtime) and the amended [Realtime proposal](../../docs/proposals/realtime_PROPOSAL.md). The Global transport: [ARCHITECTURE §20](../../docs/ARCHITECTURE.md#20-global-scope-m8) and the [wire protocol](../../docs/WIRE-PROTOCOL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/realtime": "workspace:*"
  }
}
```

The package starts its worker with `new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' })`. Vite, webpack 5 and Rollup find the worker file from this expression.

## Entry points

| Import                          | Contents                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@webkrnl/realtime`             | `createRealtime`, `createSocketProcessor`, `JSON_PROTOCOL`, and the types                      |
| `@webkrnl/realtime/worker`      | The worker entry. It serves the socket processor. You do not import it yourself.               |
| `@webkrnl/realtime/conformance` | `runConformance`: checks your server against the [wire protocol](../../docs/WIRE-PROTOCOL.md). |

## Usage

```ts
import { createRealtime, type RealtimeControl } from '@webkrnl/realtime';

const kernel = new Kernel(
  [
    ...centralized,
    createAuth({ handlers }),
    createRealtime({ url: 'wss://rt.shop.example/socket', auth: 'message' }),
  ],
  {
    router: queue.router,
  },
);
await kernel.start();

const { commands, views } = kernel.unit<RealtimeControl>('realtime').control!;
const stop = commands.subscribe('orders:u1', (data) => refreshOrders(data));
await commands.publish('chat:42', { text: 'hi' });
commands.presence('u2')?.status; // 'online'
```

## The default protocol

```text
  client --> server   {"type":"subscribe","topic":"chat"}   {"type":"unsubscribe","topic":"chat"}
                      {"type":"publish","topic":"chat","data":...}   {"type":"ping"}   {"type":"auth","data":"<token>"}
  server --> client   {"type":"message","topic":"chat","data":...}   {"type":"pong"}   {"type":"ping"}
                      {"type":"presence","data":{"peer":"u2","status":"away"}}
```

## The Global transport

With the option `global`, Realtime adds the feature `realtime/global`. It uses the same socket and two reserved topics: `platform:global` and `platform:window:<windowId>`. Your server forwards them by the rules of [docs/WIRE-PROTOCOL.md](../../docs/WIRE-PROTOCOL.md).

```ts
const realtime = createRealtime({
  url: 'wss://rt.shop.example/socket',
  auth: 'message',
  global: { http: 'https://rt.shop.example/global' }, // the HTTP fallback is optional
});
const kernel = new Kernel(
  [
    ...centralized,
    createAuth({ handlers }),
    createNetwork(),
    realtime,
    createWindowTransport({ hubUrl }),
  ],
  {
    router: queue.router,
  },
);

// A Global broadcast now reaches every device of the user.
await port.send({ eventId: 'settings:changed', payload: { theme: 'dark' } });
```

- **Send**: each Global broadcast goes into an outbox (memory, and Storage `realtime.global-outbox` when Storage runs). It leaves the outbox when the server acknowledges it. Without an ack within `ackTimeoutMs`, or after a reconnect, it goes again.
- **Receive**: each envelope is checked (`decodeWire`) and handed to the Queue's `ingest`, which drops repeats. The envelopes of this tab are dropped.
- **HTTP fallback**: while the socket cannot open, the transport publishes and long-polls through Network (`POST <http>/publish`, `GET <http>/poll`).
- **The Window relay**: the window transport of `@webkrnl/hub` takes `commands.windowRelay()` from Realtime by itself, and uses it where the hub is partitioned (Safari and iOS).

Check your server with the conformance runner:

```ts
import { runConformance } from '@webkrnl/realtime/conformance';

const results = await runConformance({ url: 'wss://staging.shop.example/socket', token });
```

## Recommended flow

1. **Use `wss://` only.**
2. **Authenticate with `auth: 'message'`.** The access token goes in the first frame, `{ "type": "auth", "data": "<token>" }`. With `'query'`, the token is in the URL, and URLs end up in the logs of servers and proxies. The server closes a socket that sends no valid `auth` frame within a few seconds.
3. **Let the token rotate.** When Auth refreshes the token, Realtime opens the socket again with the new one. The server should also close sockets whose token expired, and Realtime reconnects.
4. **Check the topic on the server.** A subscription is a request: the server allows only the topics that the user may read (for example, `orders:<own id>`).
5. **Do not cache socket messages.** Use them to refresh data through Network or Sync, which apply the cache and persistence rules.
6. **Keep the defaults for heartbeats** (25 s, with a 10 s timeout). Mobile networks drop idle sockets without a close frame.

## Behaviour

| Situation                                              | Result                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-out, or another user signs in (ARCHITECTURE §5.1) | The buffered publishes, the presence and the Global outbox (memory and Storage) are wiped. The listeners stay (they belong to the app). The socket opens again with the new token |
| The socket drops                                       | `reconnecting`, backoff, then `open`; every topic subscribes again                                                                                                                |
| No `pong` within `heartbeatTimeoutMs`                  | The socket closes and reconnects                                                                                                                                                  |
| The platform goes offline                              | The socket closes; no reconnect attempts until online                                                                                                                             |
| `publish` while disconnected                           | Buffered; the oldest is dropped when full (`state.dropped`)                                                                                                                       |
| `maxAttempts` reached                                  | `closed`, `lastError: 'Gave up after N attempts.'` until `connect()`                                                                                                              |
| The Auth token changes                                 | The socket opens again with the new token                                                                                                                                         |
| No `Worker` (or it fails)                              | The socket runs on the main thread                                                                                                                                                |
| Global: no ack in time, or a reconnect                 | The envelope goes again; receivers drop repeats                                                                                                                                   |
| Global: an envelope expires (`ttl`)                    | Dropped from the outbox (`dropped`)                                                                                                                                               |
| Global: the outbox is full (`maxOutbox`)               | The oldest envelope is dropped (`dropped`)                                                                                                                                        |
| Global: an invalid envelope arrives                    | Dropped (`dropped`), never delivered                                                                                                                                              |
| Global: the socket cannot open                         | The HTTP fallback, when `global.http` is set                                                                                                                                      |

## Options

| Option               | Default                    | Purpose                                                                                                     |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `url`                | (required)                 | The socket server.                                                                                          |
| `hosts`              | `['dedicated', 'virtual']` | The hosts of the socket processor.                                                                          |
| `socket`             | `WebSocket`                | A socket factory on the main thread (tests).                                                                |
| `protocol`           | JSON frames                | `{ encode, decode }`, self-contained functions.                                                             |
| `auth`               | `false`                    | `'query'` or `'message'` sends the token of Auth.                                                           |
| `autoConnect`        | `true`                     | Connect at start.                                                                                           |
| `heartbeatMs`        | `25_000`                   | The time between pings.                                                                                     |
| `heartbeatTimeoutMs` | `10_000`                   | The wait for a pong.                                                                                        |
| `maxAttempts`        | no limit                   | Reconnect attempts before giving up.                                                                        |
| `retryBaseMs`        | `500`                      | The base wait of the reconnect backoff.                                                                     |
| `publishBuffer`      | `100`                      | Messages kept while disconnected.                                                                           |
| `presenceTimeoutMs`  | `60_000`                   | When a silent peer becomes `offline`.                                                                       |
| `global`             | none                       | Turns on the Global transport: `{ http?, ackTimeoutMs = 10_000, maxOutbox = 500, pollTimeoutMs = 25_000 }`. |

## Testing

```bash
pnpm exec vitest run --project node packages/realtime
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/realtime
```

The browser tests run the socket in a real dedicated worker against `scripts/test-ws-server.ts`, and run `runConformance` against that server. In Node, `test/global-server.ts` is an in-memory Global server with faults (dropped acks, repeats, refused sockets).
