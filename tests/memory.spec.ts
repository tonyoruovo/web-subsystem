/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for MemoryBackend.
 * MemoryBackend uses a plain singleton store internally. We mock the store to
 * isolate each test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanonicalKey, MemoryTransaction, StorageEnvelope } from '../src';
import { MemoryBackend } from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Minimal store mock – mirrors the shape of useMemoryStore()
// ───────────────────────────────────────────────────────────────────────────

function createMockStore() {
  const store = {
    kind: 'memory' as const,
    transactionStrength: 'best-effort' as const,
    priority: 3,
    _store: new Map<CanonicalKey, StorageEnvelope<unknown>>(),
    _initialized: false,
    _transactions: new Map<string, any>(),
    _readCount: new Map<CanonicalKey, number>(),
  };
  return store;
}

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
    backend: 'memory',
    ...overrides,
  };
}

// We need to intercept `useMemoryStore` to return our mock
let mockStore: ReturnType<typeof createMockStore>;

vi.mock('@/managers/storage/backends/memory/memory.store', () => ({
  useMemoryStore: () => mockStore,
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('MemoryBackend', () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    mockStore = createMockStore();
    backend = new MemoryBackend();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('probe() always succeeds', async () => {
      const result = await backend.probe();
      expect(result.available).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('initialize() sets _initialized = true', async () => {
      await backend.initialize();
      expect(mockStore._initialized).toBe(true);
    });

    it('close() clears all state', async () => {
      await backend.initialize();
      mockStore._store.set(KEY_A, env());
      mockStore._readCount.set(KEY_A, 5);
      await backend.close();
      expect(mockStore._initialized).toBe(false);
      expect(mockStore._store.size).toBe(0);
      expect(mockStore._readCount.size).toBe(0);
    });

    it('close() rolls back pending transactions', async () => {
      await backend.initialize();
      const tx = (await backend.beginTransaction()) as MemoryTransaction<any>;
      // Simulate a buffered write
      tx.bufferWrite(KEY_A, env());
      await backend.close();
      expect(mockStore._transactions.size).toBe(0);
    });

    it('operations before initialize() throw', async () => {
      await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
      await expect(backend.write(KEY_A, env())).rejects.toThrow('not initialized');
      await expect(backend.delete(KEY_A)).rejects.toThrow('not initialized');
      await expect(backend.query({})).rejects.toThrow('not initialized');
    });
  });

  // ── Core CRUD ───────────────────────────────────────────────────────

  describe('CRUD', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('write then read returns the envelope', async () => {
      const e = env({ payload: 'my-data' });
      await backend.write(KEY_A, e);
      const result = await backend.read(KEY_A);
      expect(result).toEqual(e);
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

    it('delete removes readCount', async () => {
      await backend.write(KEY_A, env());
      await backend.read(KEY_A);
      expect(mockStore._readCount.get(KEY_A)).toBe(1);
      await backend.delete(KEY_A);
      expect(mockStore._readCount.has(KEY_A)).toBe(false);
    });

    it('clear without prefix empties store', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.clear();
      expect(mockStore._store.size).toBe(0);
      expect(mockStore._readCount.size).toBe(0);
    });

    it('clear with prefix removes only matching keys', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());
      await backend.clear('myapp:chrome:130:auth:');
      expect(mockStore._store.has(KEY_A)).toBe(false);
      expect(mockStore._store.has(KEY_B)).toBe(false);
      expect(mockStore._store.has(KEY_C)).toBe(true);
    });

    it('write overwrites existing entry', async () => {
      await backend.write(KEY_A, env({ payload: 'v1' }));
      await backend.write(KEY_A, env({ payload: 'v2' }));
      const result = await backend.read(KEY_A);
      expect(result!.payload).toBe('v2');
    });

    it('write resets readCount', async () => {
      await backend.write(KEY_A, env());
      await backend.read(KEY_A);
      await backend.read(KEY_A);
      expect(mockStore._readCount.get(KEY_A)).toBe(2);
      await backend.write(KEY_A, env({ payload: 'new' }));
      expect(mockStore._readCount.has(KEY_A)).toBe(false);
    });
  });

  // ── TTL ─────────────────────────────────────────────────────────────

  describe('TTL enforcement', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('read returns null for expired entry and deletes it', async () => {
      const expiredAt = Date.now() - 10_000;
      await backend.write(KEY_A, env({ expires_at: expiredAt }));
      expect(await backend.read(KEY_A)).toBeNull();
      expect(mockStore._store.has(KEY_A)).toBe(false);
    });

    it('read returns entry when respectTtl is false', async () => {
      const expiredAt = Date.now() - 10_000;
      await backend.write(KEY_A, env({ expires_at: expiredAt }));
      const result = await backend.read(KEY_A, { respectTtl: false });
      expect(result).not.toBeNull();
    });

    it('entry with null expires_at never expires', async () => {
      await backend.write(KEY_A, env({ expires_at: null }));
      expect(await backend.read(KEY_A)).not.toBeNull();
    });

    it('entry with far-future expires_at is returned', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() + 1_000_000_000 }));
      expect(await backend.read(KEY_A)).not.toBeNull();
    });
  });

  // ── LFU tracking ────────────────────────────────────────────────────

  describe('read count (LFU)', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('increments readCount on each successful read', async () => {
      await backend.write(KEY_A, env());
      await backend.read(KEY_A);
      await backend.read(KEY_A);
      await backend.read(KEY_A);
      expect(mockStore._readCount.get(KEY_A)).toBe(3);
    });

    it('does not increment for expired entries', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() - 1 }));
      await backend.read(KEY_A);
      expect(mockStore._readCount.has(KEY_A)).toBe(false);
    });

    it('does not increment for missing keys', async () => {
      await backend.read(KEY_A);
      expect(mockStore._readCount.has(KEY_A)).toBe(false);
    });
  });

  // ── Query ───────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(async () => {
      await backend.initialize();
      await backend.write(KEY_A, env({ schema_version: 1, weight: 1 }));
      await backend.write(KEY_B, env({ schema_version: 2, weight: 1 }));
      await backend.write(KEY_C, env({ schema_version: 1, weight: 10 }));
    });

    it('returns all entries with no filters', async () => {
      const results = await backend.query({});
      expect(results).toHaveLength(3);
    });

    it('filters by prefix', async () => {
      const results = await backend.query({ prefix: 'myapp:chrome:130:auth:' });
      expect(results).toHaveLength(2);
    });

    it('filters by schema_version', async () => {
      const results = await backend.query({ schema_version: 2 });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(KEY_B);
    });

    it('excludes expired entries', async () => {
      const expiredKey = 'myapp:chrome:130:auth:expired' as CanonicalKey;
      await backend.write(expiredKey, env({ expires_at: Date.now() - 1 }));
      const results = await backend.query({});
      expect(results).toHaveLength(3); // expired one was removed
    });

    it('respects offset and limit', async () => {
      const results = await backend.query({ offset: 1, limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('count() with prefix', async () => {
      expect(await backend.count('myapp:chrome:130:auth:')).toBe(2);
    });

    it('count() without prefix', async () => {
      expect(await backend.count()).toBe(3);
    });
  });

  // ── Transactions ────────────────────────────────────────────────────

  describe('transactions', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('rejects serializable strength', async () => {
      await expect(backend.beginTransaction('serializable')).rejects.toThrow('serializable');
    });

    it('accepts best-effort strength', async () => {
      const tx = await backend.beginTransaction('best-effort');
      expect(tx.strength).toBe('best-effort');
    });

    it('commit applies buffered ops', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'tx-data' }), { transactionId: tx.id });
      expect(mockStore._store.has(KEY_A)).toBe(false); // Not written yet
      await tx.commit();
      const result = await backend.read(KEY_A);
      expect(result!.payload).toBe('tx-data');
    });

    it('rollback discards buffered ops', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'tx-data' }), { transactionId: tx.id });
      await tx.rollback();
      expect(mockStore._store.has(KEY_A)).toBe(false);
    });

    it('isTransactionActive returns correct state', async () => {
      expect(backend.isTransactionActive()).toBe(false);
      const tx = await backend.beginTransaction();
      expect(backend.isTransactionActive()).toBe(true);
      expect(backend.isTransactionActive(tx.id)).toBe(true);
      await tx.commit();
      expect(backend.isTransactionActive(tx.id)).toBe(false);
    });

    it('transactional delete works on commit', async () => {
      await backend.write(KEY_A, env());
      const tx = await backend.beginTransaction();
      await backend.delete(KEY_A, { transactionId: tx.id });
      expect(mockStore._store.has(KEY_A)).toBe(true); // Still there
      await tx.commit();
      expect(mockStore._store.has(KEY_A)).toBe(false);
    });

    it('transactional clear works on commit', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      const tx = await backend.beginTransaction();
      await backend.clear('myapp:chrome:130:auth:', { transactionId: tx.id });
      await tx.commit();
      expect(mockStore._store.has(KEY_A)).toBe(false);
      expect(mockStore._store.has(KEY_B)).toBe(false);
    });
  });

  // ── Quota ───────────────────────────────────────────────────────────

  describe('estimateQuota', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('returns an estimate with used/available/ratio', async () => {
      const q = await backend.estimateQuota();
      expect(q).toHaveProperty('used');
      expect(q).toHaveProperty('available');
      expect(q).toHaveProperty('ratio');
      expect(q.ratio).toBeGreaterThanOrEqual(0);
      expect(q.ratio).toBeLessThanOrEqual(1);
    });

    it('used grows with data', async () => {
      const q1 = await backend.estimateQuota();
      await backend.write(KEY_A, env({ payload: 'x'.repeat(1000) }));
      const q2 = await backend.estimateQuota();
      expect(q2.used).toBeGreaterThan(q1.used);
    });
  });

  // ── Eviction ───────────────────────────────────────────────────────

  describe('evict', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('phase 1: evicts expired entries first', async () => {
      const expiredKey = 'myapp:chrome:130:auth:old' as CanonicalKey;
      await backend.write(expiredKey, env({ weight: 1, expires_at: Date.now() - 1 }));
      await backend.write(KEY_B, env({ weight: 1, expires_at: null }));
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBeGreaterThan(0);
      expect(mockStore._store.has(expiredKey)).toBe(false);
      expect(mockStore._store.has(KEY_B)).toBe(true);
    });

    it('phase 2: evicts lowest weight first', async () => {
      await backend.write(KEY_A, env({ weight: 1 }));
      await backend.write(KEY_B, env({ weight: 10 }));
      await backend.evict(1, 'fifo');
      // The lower weight entry should be evicted
      // (exact behavior depends on sizeOf heuristic)
      expect(mockStore._store.has(KEY_B)).toBe(true);
    });

    it('lfu tie-break evicts least-read entries first', async () => {
      await backend.write(KEY_A, env({ weight: 1 }));
      await backend.write(KEY_B, env({ weight: 1 }));
      // Read KEY_A 5 times, KEY_B 1 time
      for (let i = 0; i < 5; i++) await backend.read(KEY_A);
      await backend.read(KEY_B);
      await backend.evict(1, 'lfu');
      // KEY_B (read once) should be evicted before KEY_A (read 5 times)
      expect(mockStore._store.has(KEY_A)).toBe(true);
      expect(mockStore._store.has(KEY_B)).toBe(false);
    });

    it('returns 0 if nothing to evict', async () => {
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBe(0);
    });
  });

  // ── Abort signal ────────────────────────────────────────────────────

  describe('abort signal', () => {
    beforeEach(async () => {
      await backend.initialize();
    });

    it('clear() respects AbortSignal', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(backend.clear('myapp:', { signal: ac.signal })).rejects.toThrow();
    });
  });
});
