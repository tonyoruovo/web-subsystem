# Examples: `@platform/hub`

Window scope: broadcasts that reach every tab of a site, across its subdomains. The package has the hub page for the apex, the client that each tab runs, and the `window` transport subsystem that connects the client to the kernel.

## Sync a setting across the tabs of one origin

<!-- example id="hub/single-origin-tabs" runtime="any" -->

A single-origin app needs no hub page. Without `hubUrl`, the Window transport uses a `BroadcastChannel` on the origin of the app. A theme change in one tab reaches the other tab. This example runs two kernels in one page as two tabs.

```ts file=main.ts
import { Kernel, defineSubsystem, type PacketPort } from '@platform/core';
import { WINDOW_TRANSPORT_ID, createWindowTransport, type WindowTransportControl } from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

async function openTab(name: string) {
  let port: PacketPort | undefined;
  const theme = defineSubsystem({
    id: 'theme',
    scope: 'window', // its broadcasts reach every tab
    kind: 'featurized',
    subscribes: ['theme:changed'],
    state: { initial: {} },
    init: (ctx) => void (port = ctx.port),
    receive: (packet) => console.log(`${name} applies theme ${String(packet.take())}`),
    control: () => ({ commands: {}, views: {} }),
  });
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createWindowTransport({ origin: 'https://app.example', channel: 'hub-demo' }),
      theme,
    ],
    { router: queue.router },
  );
  await kernel.start();
  const transport = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
  while (transport.views.state.getSnapshot().connection !== 'connected') {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { kernel, transport, setTheme: (value: string) => port!.send({ eventId: 'theme:changed', payload: value }) };
}

const a = await openTab('tab A');
const b = await openTab('tab B');
const { mode, reach } = a.transport.views.state.getSnapshot();
console.log(`mode: ${mode}, reach: ${reach}`);

await a.setTheme('dark');
await new Promise((resolve) => setTimeout(resolve, 50));
await a.kernel.stop();
await b.kernel.stop();
```

```text output
mode: single-origin, reach: site
tab B applies theme dark
```

## Connect the tabs of several subdomains

<!-- example id="hub/subdomains" runtime="none" -->

On `shop.example.com` and `blog.example.com`, the transport frames the hub page from the apex. It reports whether the browser shares the hub. Safari and iOS partition it, so the app gives a relay (the Global transport, from M8) to reach every subdomain there. This example needs several origins, so the doc page does not run it.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { WINDOW_TRANSPORT_ID, createWindowTransport, type WindowRelay, type WindowTransportControl } from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

declare const globalRelay: WindowRelay | undefined; // from the Global transport, when configured

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel(
  [
    queue.subsystem,
    notification.subsystem,
    createWindowTransport({ hubUrl: 'https://example.com/__platform/hub.html', relay: globalRelay }),
  ],
  { router: queue.router },
);
await kernel.start();

const { views } = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
views.state.subscribe(() => {
  const { connection, hub, reach } = views.state.getSnapshot();
  console.log(`hub ${connection}, partition ${hub}, Window broadcasts reach: ${reach}`);
  if (reach === 'origin') console.warn('This browser partitions the hub: other subdomains are not reached.');
});
```

## Build the hub page for the apex

<!-- example id="hub/render-hub-page" runtime="any" -->

A build step renders the hub page and the `Content-Security-Policy` header to serve it with. The header allows only the inline script, by its hash, and only the site may frame the page.

```ts file=main.ts
import { renderHubPage } from '@platform/hub';

const page = await renderHubPage({
  allowedOrigins: ['https://example.com', 'https://*.example.com'],
});

// Write page.html to /__platform/hub.html and serve it with this header:
const [defaultSrc, scriptSrc, frameAncestors] = page.csp.split('; ');
console.log(defaultSrc);
console.log('script allowed by hash:', scriptSrc.startsWith("script-src 'sha256-"));
console.log(frameAncestors);
console.log('one inline script:', page.html.split('<script>').length - 1);
```

```text output
default-src 'none'
script allowed by hash: true
frame-ancestors https://example.com https://*.example.com
one inline script: 1
```

## Check which origins may use the hub

<!-- example id="hub/origin-allowlist" runtime="any" -->

The hub and the client accept messages only from the origins of the site. A wildcard covers the subdomains at any depth, but not look-alike domains.

```ts file=main.ts
import { originAllowed } from '@platform/hub';

const site = ['https://example.com', 'https://*.example.com'];
for (const origin of [
  'https://example.com',
  'https://shop.example.com',
  'https://eu.shop.example.com',
  'http://shop.example.com',
  'https://example.com.evil.test',
]) {
  console.log(originAllowed(origin, site) ? 'allowed' : 'refused', origin);
}
```

```text output
allowed https://example.com
allowed https://shop.example.com
allowed https://eu.shop.example.com
refused http://shop.example.com
refused https://example.com.evil.test
```
