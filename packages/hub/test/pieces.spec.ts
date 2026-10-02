import { createEnvelope } from '@platform/core';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
  HUB_TAG,
  WINDOW_COOKIE,
  isHubMessage,
  isWindowBroadcast,
  originAllowed,
  readPartitionId,
  readWindowCookie,
  recordConnection,
  renderHubPage,
  writeWindowCookie,
  type CookieJar,
} from '../src';

import { memoryJar } from './helpers';

describe('originAllowed', () => {
  const site = ['https://example.com', 'https://*.example.com'];
  it('matches exact origins and subdomain wildcards', () => {
    expect(originAllowed('https://example.com', site)).toBe(true);
    expect(originAllowed('https://a.example.com', site)).toBe(true);
    expect(originAllowed('https://a.b.example.com', site)).toBe(true);
    expect(originAllowed('https://*.example.com', ['https://*.example.com'])).toBe(false);
    expect(originAllowed('https://example.com', ['https://*.example.com'])).toBe(false);
  });

  it('refuses look-alikes, other schemes and ports, and null origins', () => {
    expect(originAllowed('https://example.com.evil.test', site)).toBe(false);
    expect(originAllowed('https://evilexample.com', site)).toBe(false);
    expect(originAllowed('http://a.example.com', site)).toBe(false);
    expect(originAllowed('https://a.example.com:8443', site)).toBe(false);
    expect(originAllowed('https://a.example.com:8443', ['https://*.example.com:8443'])).toBe(true);
    expect(originAllowed('null', site)).toBe(false);
    expect(originAllowed('', site)).toBe(false);
  });
});

describe('messages and envelopes', () => {
  it('recognizes tagged hub messages and Window broadcasts only', () => {
    expect(isHubMessage({ [HUB_TAG]: 1, type: 'hello' })).toBe(true);
    expect(isHubMessage({ type: 'hello' })).toBe(false);
    expect(isHubMessage(null)).toBe(false);

    const window = createEnvelope({ eventId: 'x', payload: 1 }, { source: 's', scope: 'window' });
    const tab = createEnvelope({ eventId: 'x', payload: 1 }, { source: 's', scope: 'tab' });
    const request = createEnvelope(
      { eventId: 'x', payload: 1, target: 't' },
      { source: 's', scope: 'window' },
    );
    expect(isWindowBroadcast(window)).toBe(true);
    expect(isWindowBroadcast(tab)).toBe(false);
    expect(isWindowBroadcast(request)).toBe(false);
    expect(isWindowBroadcast({ eventId: 'x' })).toBe(false);
    expect(isWindowBroadcast('x')).toBe(false);
  });
});

describe('readPartitionId', () => {
  it('creates an id once and returns it after', async () => {
    const factory = new IDBFactory();
    const first = await readPartitionId(factory);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readPartitionId(factory)).toBe(first);
    expect(await readPartitionId(new IDBFactory())).not.toBe(first);
  });
});

describe('window cookie', () => {
  const connect = (jar: CookieJar, partitionId: string, origin: string) =>
    recordConnection(jar, { partitionId, origin, domain: 'site.test', newId: () => 'w1' });

  it('learns that the hub is shared when a second origin sees the same partition', () => {
    const jar = memoryJar();
    expect(connect(jar, 'p1', 'https://a.site.test')).toEqual({
      windowId: 'w1',
      partitionId: 'p1',
      origin: 'https://a.site.test',
      hub: 'unknown',
    });
    expect(connect(jar, 'p1', 'https://a.site.test').hub).toBe('unknown'); // same origin: no news
    expect(connect(jar, 'p1', 'https://b.site.test').hub).toBe('shared');
    expect(jar.writes[0]).toBe(
      `${WINDOW_COOKIE}=w1.p1.https%3A%2F%2Fa%2Esite%2Etest.u; Domain=site.test; Path=/; SameSite=Lax; Secure`,
    );
  });

  it('learns that the hub is partitioned when partitions differ, for good', () => {
    const jar = memoryJar();
    connect(jar, 'p1', 'https://a.site.test');
    expect(connect(jar, 'p2', 'https://b.site.test').hub).toBe('partitioned');
    expect(connect(jar, 'p1', 'https://c.site.test').hub).toBe('partitioned');
    expect(readWindowCookie(jar)).toMatchObject({ windowId: 'w1', hub: 'partitioned' });
  });

  it('ignores a malformed cookie, and writes without Secure on http', () => {
    const jar = memoryJar();
    jar.write(`${WINDOW_COOKIE}=garbage`);
    expect(readWindowCookie(jar)).toBeNull();
    writeWindowCookie(
      jar,
      { windowId: 'w', partitionId: 'p', origin: 'http://localhost:3000', hub: 'shared' },
      'localhost',
      false,
    );
    expect(jar.writes.at(-1)).not.toContain('Secure');
    expect(readWindowCookie(jar)?.origin).toBe('http://localhost:3000');
  });
});

describe('renderHubPage', () => {
  it('renders one inline script and a CSP with its hash and the allowlist', async () => {
    const page = await renderHubPage({
      allowedOrigins: ['https://example.com', 'https://*.example.com'],
    });
    const script = /<script>([\s\S]*)<\/script>/.exec(page.html)![1];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(page.scriptHash).toBe(`'sha256-${base64}'`);
    expect(page.csp).toBe(
      `default-src 'none'; script-src ${page.scriptHash}; frame-ancestors https://example.com https://*.example.com`,
    );
    expect(script).toContain('"channel":"__platform_window"');
    expect(() => new Function(script)).not.toThrow(); // valid JavaScript
  });

  it('refuses an empty or malformed allowlist', async () => {
    await expect(renderHubPage({ allowedOrigins: [] })).rejects.toThrow(RangeError);
    await expect(renderHubPage({ allowedOrigins: ['example.com'] })).rejects.toThrow(
      'is not an origin',
    );
    await expect(
      renderHubPage({ allowedOrigins: ["https://example.com'; script-src *"] }),
    ).rejects.toThrow(RangeError);
  });
});
