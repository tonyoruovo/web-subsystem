# @platform/hub

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

**Window scope**: broadcasts that reach every tab of a site, across its subdomains, in one browser session. `BroadcastChannel` and IndexedDB stop at the origin, and `a.example.com` and `b.example.com` are different origins, so Window scope needs:

- a **hub page** on the apex (`https://example.com/__platform/hub.html`), which every subdomain tab frames, and whose `BroadcastChannel` they share;
- a **relay** where the browser partitions that hub. **WebKit (Safari, and every browser on iOS) does**: its framed hubs are keyed by the top-level origin, so `a.` and `b.` never meet through it ([spike](../../spikes/m5-hub/FINDINGS.md)). The relay is the Global transport (M8); until one is configured, Window scope on WebKit reaches the tabs of one origin, and the client says so.

The client detects which case it is in, uses the relay only when needed, and delivers each broadcast once. Design: [ARCHITECTURE §11.3](../../docs/ARCHITECTURE.md#113-window-scope-the-hub-and-the-relay) (amendment A11).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/hub": "workspace:*"
  }
}
```

## Entry points

| Import          | Contents                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@platform/hub` | `createWindowTransport`, `createWindowClient`, `renderHubPage`, `iframeLink`, `channelLink`, the window cookie, `originAllowed`, types |

## Usage

Register the Window transport with the kernel, next to the Queue and the NotificationCenter. Subsystems with `scope: 'window'` then broadcast to every tab:

```ts
import { createWindowTransport } from '@platform/hub';

const kernel = new Kernel(
  [
    createGlobalState(),
    queue.subsystem,
    notification.subsystem,
    createWindowTransport({ hubUrl: 'https://example.com/__platform/hub.html' }),
    createConsent(), // Window scope: decisions are shared by every tab
    ...subsystems,
  ],
  { router: queue.router },
);
```

| Where the app runs        | Option               | Mode                                 |
| ------------------------- | -------------------- | ------------------------------------ |
| On subdomains of one site | `hubUrl` on the apex | `iframe`                             |
| On the apex itself        | the same `hubUrl`    | `direct` (no iframe)                 |
| On a single origin        | no `hubUrl`          | `single-origin` (no hub page needed) |

Reading the state:

```ts
import type { WindowTransportControl } from '@platform/hub';

const { views } = kernel.unit<WindowTransportControl>('window').control!;
views.state.getSnapshot();
// { mode: 'iframe', connection: 'connected', hub: 'shared', relay: 'none', reach: 'site', ... }
```

`reach` is `site` when every tab of the site is reached (the hub is shared, the relay is connected, or the app has one origin), `origin` when only this origin's tabs are (a partitioned hub and no relay), and `unknown` until a second origin has connected.

## Deploying the hub page on the apex

1. **Render the page at build time** and publish it on the apex:

   ```ts
   import { writeFile } from 'node:fs/promises';
   import { renderHubPage } from '@platform/hub';

   const page = await renderHubPage({
     allowedOrigins: ['https://example.com', 'https://*.example.com'],
   });
   await writeFile('public/__platform/hub.html', page.html);
   console.log(page.csp); // the header value for step 2
   ```

   `allowedOrigins` lists who may frame the hub and talk to it: exact origins, or `https://*.example.com` for every subdomain.

2. **Serve it with these headers**, on that path only:

   ```text
   Content-Security-Policy: default-src 'none'; script-src 'sha256-…'; frame-ancestors https://example.com https://*.example.com
   ```

   Use `page.csp` as is: it holds the hash of the page's one inline script, so re-render (and update the header) whenever the package or the allowlist changes.

3. **Do not send `X-Frame-Options`** on that path. `SAMEORIGIN` would block every subdomain, because subdomains are different origins; `frame-ancestors` does the job instead.

4. **Keep the path stable** (default `/__platform/hub.html`) and give every client the same `hubUrl` and `channel`.

The client also writes one session cookie, `__platform_window`, for the apex domain (`Domain=example.com; Path=/; SameSite=Lax; Secure`). It holds a random window id and the hub's partition state, nothing personal; it is strictly necessary for Window scope.

## Behaviour

| Situation                                                | Result                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A Window broadcast from this tab                         | Sent through the hub; also through the relay while the hub is not known to be `shared`         |
| The same broadcast arrives through the hub and the relay | Delivered once (deduplicated by `messageId`)                                                   |
| A broadcast from another tab                             | Handed to the Queue's `ingest`, then fanned out here, even to a subsystem with the sender's id |
| The hub does not answer (missing page, blocked framing)  | `connection: 'disconnected'`; reconnects with backoff; failure reported                        |
| The hub stops answering heartbeats                       | Reconnects with backoff                                                                        |
| A message from an origin outside the allowlist           | Ignored by the hub; the client accepts messages only from its own hub frame                    |
| Broadcasts sent while connecting                         | Buffered (`bufferSize`), sent once connected                                                   |
| No Queue running                                         | Arrivals are counted as `dropped`                                                              |

## Options (`createWindowTransport`, `createWindowClient`)

| Option        | Default             | Purpose                                                             |
| ------------- | ------------------- | ------------------------------------------------------------------- |
| `hubUrl`      | none                | The hub page on the apex. Leave it out for a single-origin app.     |
| `channel`     | `__platform_window` | The `BroadcastChannel` name; must match `renderHubPage`'s.          |
| `relay`       | none                | The relay for partitioned browsers (the Global transport, from M8). |
| `timeoutMs`   | `5000`              | Wait for the hub's `welcome` and for each `pong`.                   |
| `heartbeatMs` | `10000`             | How often the hub is pinged.                                        |
| `retryBaseMs` | `500`               | Reconnection backoff base.                                          |
| `bufferSize`  | `100`               | Broadcasts held while connecting.                                   |

## Testing

```bash
pnpm exec vitest run --project node packages/hub
BROWSERS=chrome,webkit pnpm test:e2e     # real browsers, several origins
```
