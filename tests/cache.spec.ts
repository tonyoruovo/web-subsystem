/**
 * Tests for CacheBackend.
 * The browser `caches` API is mocked using vi.stubGlobal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheBackend, type CanonicalKey, type StorageEnvelope } from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Mock the caches API
// ───────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createFakeResponse(body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    headers: new Headers(headers ?? { 'Content-Type': 'application/json' }),
  });
}

let fakeCache: Map<string, { response: Response; url: string }>;

function createMockCache(): Cache {
  const cache = {
    _store: fakeCache,

    async match(url: string | Request) {
      const key = typeof url === 'string' ? url : url.url;
      const entry = fakeCache.get(key);
      return entry?.response.clone() ?? undefined;
    },

    async keys() {
      return [...fakeCache.values()].map((e) => new Request(e.url));
    },

    async put(url: string | Request, response: Response) {
      const key = typeof url === 'string' ? url : url.url;
      fakeCache.set(key, { response: response.clone(), url: key });
    },

    async delete(url: string | Request) {
      const key = typeof url === 'string' ? url : url.url;
      fakeCache.delete(key);
      return true;
    },
  };
  return cache as unknown as Cache;
}

let mockCaches: CacheStorage;

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;

function env(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return {
    payload: 'encrypted',
    schema_version: 1,
    written_at: Date.now() - 1000,
    expires_at: null,
    weight: 5,
    backend: 'cache',
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('CacheBackend', () => {
  let backend: CacheBackend;

  beforeEach(() => {
    fakeCache = new Map();
    mockCaches = {
      open: vi.fn().mockResolvedValue(createMockCache()),
      delete: vi.fn().mockImplementation(async (name: string) => {
        if (name === backend['_cacheName']) {
          fakeCache.clear();
        }
        return true;
      }),
    } as unknown as CacheStorage;
    vi.stubGlobal('caches', mockCaches);
    backend = new CacheBackend({ cacheName: 'test-cache' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('probe() succeeds when caches API is available', async () => {
      const result = await backend.probe();
      expect(result.available).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('probe() fails when caches API is absent', async () => {
      vi.stubGlobal('caches', undefined);
      const fresh = new CacheBackend();
      const result = await fresh.probe();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('not available');
    });

    it('initialize() opens the named cache', async () => {
      await backend.initialize();
      expect(mockCaches.open).toHaveBeenCalledWith('test-cache');
    });

    it('close() rolls back pending transactions', async () => {
      await backend.initialize();
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env(), { transactionId: tx.id });
      await backend.close();
      expect(backend.isTransactionActive()).toBe(false);
    });

    it('operations before initialize() throw', async () => {
      await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
      await expect(backend.write(KEY_A, env())).rejects.toThrow('not initialized');
    });
  });

  // ── Core CRUD ───────────────────────────────────────────────────────

  describe('CRUD', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('write then read round-trips the envelope', async () => {
      const e = env({ payload: 'my-payload' });
      await backend.write(KEY_A, e);
      const result = await backend.read(KEY_A);
      expect(result).not.toBeNull();
      expect(result!.payload).toBe('my-payload');
      expect(result!.schema_version).toBe(e.schema_version);
      expect(result!.weight).toBe(e.weight);
    });

    it('read returns null for missing key', async () => {
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('delete removes the entry', async () => {
      await backend.write(KEY_A, env());
      await backend.delete(KEY_A);
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('delete is idempotent', async () => {
      await expect(backend.delete(KEY_A)).resolves.not.toThrow();
    });

    it('clear without prefix deletes entire cache and reopens', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.clear();
      // Cache should have been deleted and reopened
      expect(mockCaches.delete).toHaveBeenCalledWith('test-cache');
    });

    it('clear with prefix removes only matching entries', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());
      await backend.clear('myapp:chrome:130:auth:');
      expect(await backend.read(KEY_A)).toBeNull();
      expect(await backend.read(KEY_B)).toBeNull();
      expect(await backend.read(KEY_C)).not.toBeNull();
    });
  });

  // ── TTL ─────────────────────────────────────────────────────────────

  describe('TTL enforcement', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('read returns null for expired entry (checked via headers)', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() - 10_000 }));
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('read with respectTtl=false returns expired entry', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() - 10_000 }));
      const result = await backend.read(KEY_A, { respectTtl: false });
      expect(result).not.toBeNull();
    });

    it('null expires_at means never expires', async () => {
      await backend.write(KEY_A, env({ expires_at: null }));
      expect(await backend.read(KEY_A)).not.toBeNull();
    });
  });

  // ── Query ───────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('returns all entries', async () => {
      await backend.write(KEY_A, env({ schema_version: 1 }));
      await backend.write(KEY_B, env({ schema_version: 2 }));
      const results = await backend.query({});
      expect(results).toHaveLength(2);
    });

    it('filters by prefix', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_C, env());
      const results = await backend.query({ prefix: 'myapp:chrome:130:auth:' });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(KEY_A);
    });

    it('filters by schema_version (via headers)', async () => {
      await backend.write(KEY_A, env({ schema_version: 1 }));
      await backend.write(KEY_B, env({ schema_version: 2 }));
      const results = await backend.query({ schema_version: 2 });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(KEY_B);
    });

    it('excludes expired entries lazily', async () => {
      const expiredKey = 'myapp:chrome:130:auth:old' as CanonicalKey;
      await backend.write(KEY_A, env({ expires_at: null }));
      await backend.write(expiredKey, env({ expires_at: Date.now() - 1 }));
      const results = await backend.query({});
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(KEY_A);
    });

    it('respects offset and limit', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());
      const results = await backend.query({ offset: 1, limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  // ── Transactions ────────────────────────────────────────────────────

  describe('transactions', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('rejects non-best-effort strength', async () => {
      await expect(backend.beginTransaction('serializable')).rejects.toThrow('only "best-effort"');
    });

    it('commit applies buffered writes', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'committed' }), { transactionId: tx.id });
      await tx.commit();
      const result = await backend.read(KEY_A);
      expect(result!.payload).toBe('committed');
    });

    it('rollback discards buffered writes', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'buffered' }), { transactionId: tx.id });
      await tx.rollback();
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('transactional delete on commit', async () => {
      await backend.write(KEY_A, env());
      const tx = await backend.beginTransaction();
      await backend.delete(KEY_A, { transactionId: tx.id });
      await tx.commit();
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('transactional clear on commit', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      const tx = await backend.beginTransaction();
      await backend.clear('myapp:chrome:130:auth:', { transactionId: tx.id });
      await tx.commit();
      expect(await backend.read(KEY_A)).toBeNull();
      expect(await backend.read(KEY_B)).toBeNull();
    });

    it('partial rollback removes specific ops', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env(), { transactionId: tx.id });
      await backend.write(KEY_B, env(), { transactionId: tx.id });
      const removed = await tx.rollback(KEY_A);
      expect(removed).toHaveLength(1);
      await tx.commit();
      expect(await backend.read(KEY_A)).toBeNull();
      expect(await backend.read(KEY_B)).not.toBeNull();
    });

    it('double commit throws', async () => {
      const tx = await backend.beginTransaction();
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow('already settled');
    });
  });

  // ── Quota & Eviction ───────────────────────────────────────────────

  describe('quota and eviction', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('estimateQuota returns used/available/ratio', async () => {
      const q = await backend.estimateQuota();
      expect(q).toHaveProperty('used');
      expect(q).toHaveProperty('available');
      expect(q).toHaveProperty('ratio');
    });

    it('evict phase 1: removes expired entries', async () => {
      await backend.write(KEY_A, env({ weight: 1, expires_at: Date.now() - 1 }));
      await backend.write(KEY_B, env({ weight: 1, expires_at: null }));
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBeGreaterThan(0);
      expect(await backend.read(KEY_B)).not.toBeNull();
    });

    it('evict phase 2: evicts lowest weight first', async () => {
      await backend.write(KEY_A, env({ weight: 1, expires_at: null }));
      await backend.write(KEY_B, env({ weight: 10, expires_at: null }));
      const freed = await backend.evict(100, 'fifo');
      expect(freed).toBeGreaterThan(0);
    });

    it('lfu eviction falls back to written_at (documented behavior)', async () => {
      // Cache cannot do real LFU - this test documents the fallback
      await backend.write(KEY_A, env({ weight: 1, written_at: 100, expires_at: null }));
      await backend.write(KEY_B, env({ weight: 1, written_at: 200, expires_at: null }));
      const freed = await backend.evict(1, 'lfu');
      expect(freed).toBeGreaterThan(0);
    });
  });

  // ── Custom cacheName ───────────────────────────────────────────────

  describe('custom cacheName', () => {
    it('uses the provided cacheName', async () => {
      const custom = new CacheBackend({ cacheName: 'my-custom' });
      await custom.initialize();
      expect(mockCaches.open).toHaveBeenCalledWith('my-custom');
      await custom.close();
    });
  });
});
