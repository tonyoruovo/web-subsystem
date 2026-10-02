import { createEnvelope, type PacketEnvelope } from '@platform/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWindowClient, type WindowClientOptions } from '../src';

import { fakeLink, memoryJar, memoryRelay } from './helpers';

const HUB = 'https://site.test/__platform/hub.html';
const news = (n: number) =>
  createEnvelope({ eventId: 'news', payload: { n } }, { source: 'app', scope: 'window' });

/** Two tabs, on a. and b., sharing cookies (one site) and a relay. */
function twoTabs(partitioned: boolean, extra: Partial<WindowClientOptions> = {}) {
  const cookies = memoryJar();
  const relay = memoryRelay();
  const busA = new Set<(envelope: unknown) => void>();
  const busB = partitioned ? new Set<(envelope: unknown) => void>() : busA;
  const tab = (origin: string, bus: Set<(envelope: unknown) => void>, partition: string) => {
    const client = createWindowClient({
      hubUrl: HUB,
      origin,
      cookies,
      relay,
      link: fakeLink(bus, partition),
      ...extra,
    });
    const heard: number[] = [];
    client.onEnvelope((e: PacketEnvelope) => void heard.push((e.payload as { n: number }).n));
    return { client, heard };
  };
  const a = tab('https://a.site.test', busA, 'p-a');
  const b = tab('https://b.site.test', busB, partitioned ? 'p-b' : 'p-a');
  return { a, b, relay, cookies };
}

afterEach(() => vi.useRealTimers());

describe('createWindowClient', () => {
  it('uses the hub alone once it is known to be shared (Chromium)', async () => {
    const { a, b, relay } = twoTabs(false);
    await a.client.connect();
    expect(a.client.status.getSnapshot()).toMatchObject({
      mode: 'iframe',
      connection: 'connected',
      hub: 'unknown',
      relay: 'connected',
      reach: 'site',
    });
    await b.client.connect();
    expect(b.client.status.getSnapshot()).toMatchObject({ hub: 'shared', reach: 'site' });

    a.client.publish(news(1)); // a learns 'shared' from the cookie: no relay
    expect(b.heard).toEqual([1]);
    expect(relay.published).toHaveLength(0);
    expect(a.client.status.getSnapshot().hub).toBe('shared');
  });

  it('uses the relay where the hub is partitioned (WebKit), once per envelope', async () => {
    const { a, b, relay } = twoTabs(true);
    await a.client.connect();
    await b.client.connect();
    expect(b.client.status.getSnapshot()).toMatchObject({ hub: 'partitioned', reach: 'site' });

    a.client.publish(news(1));
    b.client.publish(news(2));
    expect(b.heard).toEqual([1]);
    expect(a.heard).toEqual([2]);
    expect(relay.published.map((p) => p.windowId)).toEqual([
      relay.published[0].windowId,
      relay.published[0].windowId,
    ]);

    relay.setConnected(false);
    await Promise.resolve();
    expect(b.client.status.getSnapshot()).toMatchObject({ relay: 'disconnected', reach: 'origin' });
  });

  it('reports origin reach on a partitioned hub without a relay', async () => {
    const cookies = memoryJar();
    const tab = (origin: string, partition: string) =>
      createWindowClient({
        hubUrl: HUB,
        origin,
        cookies,
        link: fakeLink(new Set(), partition),
      });
    await tab('https://a.site.test', 'p1').connect();
    const b = tab('https://b.site.test', 'p2');
    await b.connect();
    expect(b.status.getSnapshot()).toMatchObject({
      hub: 'partitioned',
      relay: 'none',
      reach: 'origin',
    });
  });

  it('drops repeats and its own envelopes coming back', async () => {
    const { a, b } = twoTabs(false);
    await a.client.connect();
    await b.client.connect();
    const envelope = news(7);
    a.client.publish(envelope);
    a.client.publish(envelope);
    expect(b.heard).toEqual([7]);
  });

  it('buffers while connecting, then sends', async () => {
    const { a, b } = twoTabs(false, { bufferSize: 1 });
    await b.client.connect();
    a.client.publish(news(1));
    a.client.publish(news(2)); // the buffer keeps the newest
    expect(b.heard).toEqual([]);
    await a.client.connect();
    expect(b.heard).toEqual([2]);
  });

  it('reconnects with backoff after a missed heartbeat or a failed connect', async () => {
    vi.useFakeTimers();
    const link = fakeLink(new Set(), 'p1');
    const client = createWindowClient({
      hubUrl: HUB,
      origin: 'https://a.site.test',
      cookies: memoryJar(),
      link,
      heartbeatMs: 100,
      retryBaseMs: 10,
      random: () => 0.5,
    });
    link.failOpen = true;
    await expect(client.connect()).rejects.toThrow('hub down');
    expect(client.status.getSnapshot().connection).toBe('disconnected');
    link.failOpen = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.status.getSnapshot().connection).toBe('connected');
    expect(link.opens).toBe(2);

    const seen: string[] = [];
    client.status.subscribe(() => void seen.push(client.status.getSnapshot().connection));
    link.alive = false;
    await vi.advanceTimersByTimeAsync(100); // a missed pong, then a reconnect 10 ms later
    expect(seen).toEqual(['disconnected', 'connecting', 'connected']);
    expect(link.opens).toBe(3);
    client.close();
  });

  it('runs single-origin without cookies or relay, and refuses what it cannot carry', async () => {
    const cookies = memoryJar();
    const client = createWindowClient({
      origin: 'https://app.test',
      cookies,
      link: fakeLink(new Set(), null),
    });
    await client.connect();
    expect(client.status.getSnapshot()).toMatchObject({
      mode: 'single-origin',
      hub: 'shared',
      reach: 'site',
      windowId: null,
    });
    expect(cookies.writes).toEqual([]);
    expect(() =>
      client.publish(createEnvelope({ eventId: 'x', payload: 1 }, { source: 's', scope: 'tab' })),
    ).toThrow(TypeError);

    client.close();
    expect(client.status.getSnapshot().connection).toBe('closed');
    client.publish(news(1)); // dropped, not buffered
    await expect(client.connect()).rejects.toThrow('closed');
  });

  it('picks direct mode on the hub origin', () => {
    const client = createWindowClient({
      hubUrl: HUB,
      origin: 'https://site.test',
      cookies: memoryJar(),
      link: fakeLink(new Set(), 'p1'),
    });
    expect(client.status.getSnapshot().mode).toBe('direct');
  });
});
