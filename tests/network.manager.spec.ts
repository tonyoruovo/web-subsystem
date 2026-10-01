import { describe, expect, it, vi } from 'vitest';

import { NetworkManager, type FetchResult } from '../src';

function ok(data: unknown): FetchResult {
  return { status: 200, statusText: 'OK', headers: {}, json: async () => data };
}

describe('NetworkManager', () => {
  it('fetches and parses a response', async () => {
    const network = new NetworkManager({ fetchFn: async () => ok({ id: 1 }) });
    const res = await network.get('/api');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 1 });
    expect(res.fromCache).toBe(false);
  });

  it('retries a failed request and succeeds', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls < 3) throw new Error('network error');
      return ok({ ok: true });
    };
    const network = new NetworkManager({ fetchFn, retryDelay: () => 0 });

    const res = await network.request({ url: '/api', retries: 2 });

    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('serves cache-first from the cache on a second call', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return ok({ n: calls });
    };
    const network = new NetworkManager({ fetchFn });

    const a = await network.request({ url: '/api', cacheStrategy: 'cache-first' });
    const b = await network.request({ url: '/api', cacheStrategy: 'cache-first' });

    expect(calls).toBe(1);
    expect(a.data).toEqual({ n: 1 });
    expect(b.fromCache).toBe(true);
    expect(b.data).toEqual({ n: 1 });
  });

  it('falls back to cache on failure under network-first', async () => {
    let fail = false;
    const fetchFn = async () => {
      if (fail) throw new Error('network error');
      return ok({ n: 1 });
    };
    const warn = vi.fn();
    const network = new NetworkManager({ fetchFn, retryDelay: () => 0, warn: { warn } });

    await network.request({ url: '/api', cacheStrategy: 'network-first' });
    expect(warn).not.toHaveBeenCalled();
    fail = true;
    const res = await network.request({ url: '/api', cacheStrategy: 'network-first', retries: 0 });

    expect(res.fromCache).toBe(true);
    expect(res.data).toEqual({ n: 1 });
    // Serving stale data is degraded behaviour, so it is reported.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('serving cached response'));
  });

  it('retries on a retryable status', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1)
        return { status: 503, statusText: 'Unavailable', headers: {}, json: async () => ({}) };
      return ok({ ok: true });
    };
    const network = new NetworkManager({ fetchFn, retryDelay: () => 0 });

    const res = await network.request({ url: '/api', retries: 1 });

    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('deduplicates identical in-flight requests', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return ok({ n: calls });
    };
    const network = new NetworkManager({ fetchFn });

    const [a, b] = await Promise.all([
      network.request({ url: '/api', cacheStrategy: 'network-only' }),
      network.request({ url: '/api', cacheStrategy: 'network-only' }),
    ]);

    expect(calls).toBe(1);
    expect(a.data).toEqual(b.data);
  });

  it('applies a request interceptor', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return ok({});
    };
    const network = new NetworkManager({ fetchFn });
    network.addRequestInterceptor((cfg) => ({
      ...cfg,
      headers: { ...cfg.headers, 'x-auth': 'token' },
    }));

    await network.get('/api');

    expect(seenHeaders?.['x-auth']).toBe('token');
  });

  it('aborts active requests', async () => {
    const fetchFn = async (_url: string, init?: RequestInit) =>
      new Promise<FetchResult>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const network = new NetworkManager({ fetchFn });

    const p = network.request({ url: '/api', retries: 0 });
    await new Promise((r) => setTimeout(r, 0));
    network.abortAll();

    await expect(p).rejects.toThrow('aborted');
  });
});
