/// <reference types="node" />
/**
 * @fileoverview
 * @summary M5 gate: a Window broadcast from a.<site> reaches b.<site>, and foreign origins are refused.
 * @description
 * Runs in every installed browser (playwright.config.ts), with storage
 * partitioning as users have it. Every origin is served by request
 * interception:
 *
 * ```text
 *   https://site.test/__platform/hub.html       the hub page, with its CSP (frame-ancestors: the site)
 *   https://site.test/__platform/hub-open.html  the same page without CSP, to test the hub's own origin check
 *   https://site.test/                          a tab on the apex (direct mode)
 *   https://a.site.test/, https://b.site.test/  tabs on subdomains (iframe mode)
 *   https://evil.test/                          a foreign tab
 *   ```
 *
 * The relay is a server double in this file: a page's `__relayPublish`
 * binding forwards the envelope to every other page subscribed with the
 * same window id.
 *
 * @author MathAid
 */

import { fileURLToPath } from 'node:url';

import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contextOptionsFor,
  launchOptionsFor,
  selectInstallations,
} from '../../../playwright.config';
import { renderHubPage, type HubPage } from '../src';

const SITE = ['https://site.test', 'https://*.site.test'];
const HUB = 'https://site.test/__platform/hub.html';
const OPEN_HUB = 'https://site.test/__platform/hub-open.html';

let bundle = '';
let hub: HubPage;

beforeAll(async () => {
  const build = await rolldown({
    input: fileURLToPath(new URL('./e2e/tab-page.ts', import.meta.url)),
    platform: 'browser',
    logLevel: 'silent',
  });
  const { output } = await build.generate({ format: 'iife' });
  bundle = output[0].code;
  hub = await renderHubPage({ allowedOrigins: SITE });
});

/** The tab page: the config, then the bundled app. */
const tabPage = (hubUrl: string | null, relay: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>tab</title><body><script>window.__E2E_CONFIG = ${JSON.stringify({ hubUrl, relay })};</script><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script></body>`;

interface Serve {
  readonly relay: boolean;
}

async function serve(context: BrowserContext, { relay }: Serve): Promise<void> {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.href === HUB) {
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': hub.csp },
        body: hub.html,
      });
    }
    if (url.href === OPEN_HUB) return route.fulfill({ contentType: 'text/html', body: hub.html });
    if (url.pathname === '/' || url.pathname === '/csp') {
      const hubUrl = url.hostname === 'evil.test' && url.pathname === '/' ? OPEN_HUB : HUB;
      return route.fulfill({ contentType: 'text/html', body: tabPage(hubUrl, relay) });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  // The relay's server double: forward to every other page with the same window id.
  await context.exposeBinding('__relayPublish', async ({ page }, windowId: string, envelope) => {
    for (const other of context.pages()) {
      if (other === page) continue;
      await other
        .evaluate(([w, e]) => window.__e2e.relayDeliver(w, e), [windowId, envelope] as const)
        .catch(() => undefined);
    }
  });
}

interface Status {
  readonly connection: string;
  readonly hub: string;
  readonly reach: string;
  readonly mode: string;
}

async function open(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(() => window.__e2e.ready);
  return page;
}

const status = (page: Page) => page.evaluate(() => window.__e2e.status() as Status);
const heard = (page: Page) => page.evaluate(() => window.__e2e.heard);
const connected = (page: Page) =>
  expect.poll(async () => (await status(page)).connection, { timeout: 10_000 }).toBe('connected');

for (const installation of selectInstallations()) {
  describe(`Window scope on ${installation.id}`, () => {
    let browser: Browser;
    const engine = { chromium, firefox, webkit }[installation.engine];
    const partitioned = installation.engine === 'webkit'; // spikes/m5-hub/FINDINGS.md

    beforeAll(async () => {
      browser = await engine.launch(launchOptionsFor(installation));
    });
    afterAll(async () => {
      await browser?.close();
    });

    const newContext = async (relay: boolean) => {
      const context = await browser.newContext(contextOptionsFor(installation));
      await serve(context, { relay });
      return context;
    };

    it('delivers a broadcast from a.<site> to b.<site> and the apex, once each', async () => {
      const context = await newContext(true);
      const a = await open(context, 'https://a.site.test/');
      await connected(a);
      const b = await open(context, 'https://b.site.test/');
      const apex = await open(context, 'https://site.test/');
      await connected(b);
      await connected(apex);

      expect(await status(b)).toMatchObject({
        mode: 'iframe',
        hub: partitioned ? 'partitioned' : 'shared',
        reach: 'site',
      });
      expect((await status(apex)).mode).toBe('direct');

      await a.evaluate(() => window.__e2e.send({ theme: 'dark' }));
      await expect.poll(() => heard(b), { timeout: 10_000 }).toEqual([{ theme: 'dark' }]);
      await expect.poll(() => heard(apex), { timeout: 10_000 }).toEqual([{ theme: 'dark' }]);

      await b.evaluate(() => window.__e2e.send({ theme: 'light' }));
      await expect.poll(() => heard(a), { timeout: 10_000 }).toEqual([{ theme: 'light' }]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await heard(b)).toEqual([{ theme: 'dark' }]); // once, and not its own
      expect(await heard(apex)).toEqual([{ theme: 'dark' }, { theme: 'light' }]);
      await context.close();
    });

    it('reports its reach without a relay', async () => {
      const context = await newContext(false);
      const a = await open(context, 'https://a.site.test/');
      await connected(a);
      const b = await open(context, 'https://b.site.test/');
      await connected(b);
      expect(await status(b)).toMatchObject({
        hub: partitioned ? 'partitioned' : 'shared',
        reach: partitioned ? 'origin' : 'site',
      });
      await a.evaluate(() => window.__e2e.send(1));
      if (!partitioned) {
        await expect.poll(() => heard(b), { timeout: 10_000 }).toEqual([1]);
      }
      await context.close();
    });

    it('refuses foreign origins: framing is blocked, and the hub ignores them', async () => {
      const context = await newContext(false);
      const a = await open(context, 'https://a.site.test/');
      await connected(a);

      // The CSP's frame-ancestors keeps the hub out of a foreign page.
      const blocked = await open(context, 'https://evil.test/csp');
      // Without the CSP, the hub's own origin check refuses it.
      const evil = await open(context, 'https://evil.test/');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect((await status(blocked)).connection).not.toBe('connected');
      expect((await status(evil)).connection).not.toBe('connected');

      // The open hub did load in the foreign page: its origin check is what refused it.
      expect(evil.frames().some((f) => f.url() === OPEN_HUB)).toBe(true);
      await a.evaluate(() => window.__e2e.send('to-the-site'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await heard(evil)).toEqual([]);
      await context.close();
    });
  });
}
