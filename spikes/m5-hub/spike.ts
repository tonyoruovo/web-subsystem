/**
 * @fileoverview
 * @summary M5 spike: does a hub iframe on the apex share one partition across subdomains?
 * @description
 * ARCHITECTURE §11.3 puts a hub page on the site's apex and frames it from
 * every subdomain. That only works if each framed copy of the hub sees the
 * same `BroadcastChannel`, Web Storage and IndexedDB as the others (and as
 * a tab on the apex itself). This script checks it in every installed
 * browser of playwright.config.ts.
 *
 * ```text
 *   tab https://a.site.test/   --iframe-->  https://site.test/hub.html  --+
 *   tab https://b.site.test/   --iframe-->  https://site.test/hub.html  --+-- same partition?
 *   tab https://site.test/hub.html (direct, on the apex)                --+
 *   tab https://other.test/    --iframe-->  https://site.test/hub.html  --- control: cross-site, expected partitioned
 *   ```
 *
 * Every response is served by request interception, so the fake origins
 * need no DNS and no certificates.
 *
 * Run: `node spikes/m5-hub/spike.ts` (or `BROWSERS=chrome,webkit node ...`).
 *
 * @author MathAid
 */

import { writeFileSync } from 'node:fs';

import { chromium, firefox, webkit, type BrowserContext, type Frame, type Page } from 'playwright';

import {
  contextOptionsFor,
  launchOptionsFor,
  selectInstallations,
} from '../../playwright.config.ts';

/** The site; `SITE=example.com` rules out quirks of the `.test` name. */
const SITE = process.env.SITE ?? 'site.test';
const HUB = `https://${SITE}/hub.html`;

/** The hub: joins the channel, records what it hears, and exposes storage probes. */
const hubPage = `<!doctype html><meta charset="utf-8"><title>hub</title><script>
  const heard = [];
  let channel = null;
  try {
    channel = new BroadcastChannel('spike');
    channel.onmessage = (e) => heard.push(e.data);
  } catch (e) {}
  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open('spike', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    };
  });
  let worker = null;
  const workerHeard = [];
  window.spike = {
    heard,
    workerHeard,
    hasChannel: () => channel !== null,
    post: (m) => channel.postMessage(m),
    setLocal: (k, v) => localStorage.setItem(k, v),
    getLocal: (k) => localStorage.getItem(k),
    idbPut: (k, v) => idb('readwrite', (s) => s.put(v, k)),
    idbGet: (k) => idb('readonly', (s) => s.get(k)),
    hasSharedWorker: () => typeof SharedWorker === 'function',
    startWorker: () => {
      worker = new SharedWorker('/worker.js');
      worker.port.onmessage = (e) => workerHeard.push(e.data);
      worker.port.start();
    },
    workerPost: (m) => worker.port.postMessage(m),
    storageAccess: () => (document.hasStorageAccess ? document.hasStorageAccess() : 'n/a'),
  };
</script>`;

/** A shared worker that relays every message to every connected port. */
const workerScript = `const ports = [];
onconnect = (e) => {
  const port = e.ports[0];
  ports.push(port);
  port.onmessage = (m) => { for (const p of ports) p.postMessage(m.data); };
  port.start();
};`;

const framing = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><iframe src="${HUB}"></iframe>`;

async function serve(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === SITE && url.pathname === '/hub.html') {
      return route.fulfill({ contentType: 'text/html', body: hubPage });
    }
    if (url.hostname === SITE && url.pathname === '/worker.js') {
      return route.fulfill({ contentType: 'text/javascript', body: workerScript });
    }
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: framing(url.hostname) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

/** Opens a tab and returns the frame running the hub (the iframe, or the page itself on the apex). */
async function open(context: BrowserContext, url: string): Promise<{ page: Page; hub: Frame }> {
  const page = await context.newPage();
  await page.goto(url);
  const hub =
    url === HUB
      ? page.mainFrame()
      : await (async () => {
          for (let i = 0; i < 50; i++) {
            const frame = page.frames().find((f) => f.url() === HUB);
            if (frame) {
              await frame.waitForFunction(() => 'spike' in window);
              return frame;
            }
            await page.waitForTimeout(100);
          }
          throw new Error(`No hub frame in ${url}`);
        })();
  return { page, hub };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

interface Result {
  readonly installation: string;
  readonly version: string;
  readonly checks: Record<string, string>;
  readonly error?: string;
}

async function probe(installationId: string): Promise<Result> {
  const installation = selectInstallations(installationId)[0];
  const engine = { chromium, firefox, webkit }[installation.engine];
  const browser = await engine.launch(
    process.env.PLAYWRIGHT_DEFAULTS === '1'
      ? { executablePath: installation.executablePath }
      : launchOptionsFor(installation),
  );
  const checks: Record<string, string> = {};
  try {
    const context = await browser.newContext(contextOptionsFor(installation));
    await serve(context);
    const a = await open(context, `https://a.${SITE}/`);
    const b = await open(context, `https://b.${SITE}/`);
    const apex = await open(context, HUB);
    const foreign = await open(context, 'https://other.test/');

    const a2 = await open(context, `https://a.${SITE}/`);
    const yes = (ok: boolean) => (ok ? 'shared' : 'PARTITIONED');

    // BroadcastChannel
    checks.channel = String(await a.hub.evaluate(() => window.spike.hasChannel()));
    await a.hub.evaluate(() => window.spike.post('from-a'));
    await settle();
    const heardB = await b.hub.evaluate(() => [...window.spike.heard]);
    const heardApex = await apex.hub.evaluate(() => [...window.spike.heard]);
    const heardForeign = await foreign.hub.evaluate(() => [...window.spike.heard]);
    checks['channel a→b'] = yes(heardB.includes('from-a'));
    checks['channel a→apex'] = yes(heardApex.includes('from-a'));
    checks['channel a→a (2nd tab, same origin)'] = yes(
      (await a2.hub.evaluate(() => [...window.spike.heard])).includes('from-a'),
    );
    await apex.hub.evaluate(() => window.spike.post('from-apex'));
    await settle();
    checks['channel apex→a'] = yes(
      (await a.hub.evaluate(() => [...window.spike.heard])).includes('from-apex'),
    );
    checks['channel a→other.test (control)'] = heardForeign.includes('from-a')
      ? 'shared'
      : 'partitioned';

    // localStorage
    await a.hub.evaluate(() => window.spike.setLocal('k', 'from-a'));
    checks['localStorage a→b'] = yes(
      (await b.hub.evaluate(() => window.spike.getLocal('k'))) === 'from-a',
    );
    checks['localStorage a→apex'] = yes(
      (await apex.hub.evaluate(() => window.spike.getLocal('k'))) === 'from-a',
    );
    checks['localStorage a→other.test (control)'] =
      (await foreign.hub.evaluate(() => window.spike.getLocal('k'))) === 'from-a'
        ? 'shared'
        : 'partitioned';

    // IndexedDB
    await a.hub.evaluate(() => window.spike.idbPut('k', 'from-a'));
    checks['indexedDB a→b'] = yes(
      (await b.hub.evaluate(() => window.spike.idbGet('k'))) === 'from-a',
    );
    checks['indexedDB a→apex'] = yes(
      (await apex.hub.evaluate(() => window.spike.idbGet('k'))) === 'from-a',
    );

    // SharedWorker
    if (await a.hub.evaluate(() => window.spike.hasSharedWorker())) {
      for (const tab of [a, b, apex]) await tab.hub.evaluate(() => window.spike.startWorker());
      await settle();
      await a.hub.evaluate(() => window.spike.workerPost('worker-from-a'));
      await settle();
      checks['sharedWorker a→b'] = yes(
        (await b.hub.evaluate(() => [...window.spike.workerHeard])).includes('worker-from-a'),
      );
      checks['sharedWorker a→apex'] = yes(
        (await apex.hub.evaluate(() => [...window.spike.workerHeard])).includes('worker-from-a'),
      );
    } else {
      checks.sharedWorker = 'unavailable';
    }

    checks['hasStorageAccess (iframe in a)'] = String(
      await a.hub.evaluate(() => window.spike.storageAccess()),
    );
    return { installation: installationId, version: browser.version(), checks };
  } catch (error) {
    return {
      installation: installationId,
      version: browser.version(),
      checks,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser.close();
  }
}

declare global {
  interface Window {
    spike: {
      heard: unknown[];
      workerHeard: unknown[];
      hasChannel(): boolean;
      post(message: unknown): void;
      setLocal(key: string, value: string): void;
      getLocal(key: string): string | null;
      idbPut(key: string, value: unknown): Promise<unknown>;
      idbGet(key: string): Promise<unknown>;
      hasSharedWorker(): boolean;
      startWorker(): void;
      workerPost(message: unknown): void;
      storageAccess(): Promise<boolean> | string;
    };
  }
}

const results: Result[] = [];
for (const installation of selectInstallations()) {
  try {
    results.push(await probe(installation.id));
  } catch (error) {
    results.push({
      installation: installation.id,
      version: '-',
      checks: {},
      error: `launch failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    });
  }
  const last = results.at(-1)!;
  console.log(
    `\n${last.installation} ${last.version}${last.error ? `  ERROR: ${last.error}` : ''}`,
  );
  for (const [check, outcome] of Object.entries(last.checks)) {
    console.log(`  ${check.padEnd(36)} ${outcome}`);
  }
}
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
