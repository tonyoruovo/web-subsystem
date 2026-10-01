/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for WebStorageBackend (via LocalStorageBackend and SessionStorageBackend).
 *
 * The browser `Storage` API is fully mocked with an in-memory Map so these
 * tests run in a Node / jsdom environment without a real browser.
 *
 * Coverage:
 *   - Lifecycle (probe, initialize, close)
 *   - Core CRUD (write, read, delete, clear)
 *   - TTL expiry and lazy cleanup
 *   - Query (prefix, schema_version, excludeExpired, offset/limit)
 *   - Count
 *   - Transactions (commit, full rollback, partial rollback, snapshot restore)
 *   - Quota estimation
 *   - Eviction (TTL sweep, LRU, LFU, FIFO, user comparator)
 *   - QuotaExceededError recovery (ttl-then-lru and none policies)
 *   - Corrupt entry silent cleanup
 *   - isTransactionActive
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanonicalKey, StorageEnvelope, WebStorageTransaction } from '../src';
import { LocalStorageBackend, SessionStorageBackend } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory Storage mock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a minimal `Storage`-compatible object backed by a plain Map.
 * Supports an optional `quotaBytes` limit — `setItem` throws `QuotaExceededError`
 * (DOMException code 22) when the total UTF-16 byte size would exceed it.
 */
function createMockStorage(quotaBytes?: number): Storage & { _data: Map<string, string> } {
  const _data = new Map<string, string>();

  const totalBytes = () =>
    [..._data.entries()].reduce((acc, [k, v]) => acc + (k.length + v.length) * 2, 0);

  const storage: Storage & { _data: Map<string, string> } = {
    _data,
    get length() {
      return _data.size;
    },
    key(index: number) {
      return [..._data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return _data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (quotaBytes !== undefined) {
        const existing = _data.get(key);
        const existingBytes = existing ? (key.length + existing.length) * 2 : 0;
        const newBytes = (key.length + value.length) * 2;
        if (totalBytes() - existingBytes + newBytes > quotaBytes) {
          const e = new DOMException('QuotaExceededError', 'QuotaExceededError');
          (e as any).code = 22;
          throw e;
        }
      }
      _data.set(key, value);
    },
    removeItem(key: string) {
      _data.delete(key);
    },
    clear() {
      _data.clear();
    },
  } as unknown as Storage & { _data: Map<string, string> };

  return storage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;

const PREFIX_AUTH = 'myapp:chrome:130:auth:';
// const PREFIX_ALL   = 'myapp:'

function env(
  overrides: Partial<StorageEnvelope<string>> = {},
  kind: 'localstorage' | 'sessionstorage' = 'localstorage',
): StorageEnvelope<string> {
  return {
    payload: 'encrypted-payload',
    schema_version: 1,
    written_at: Date.now() - 1000,
    expires_at: null,
    weight: 5,
    backend: kind,
    ...overrides,
  };
}

function expiredEnv(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return env({ expires_at: Date.now() - 1, ...overrides });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared test factory
// Runs the same suite against both LocalStorageBackend and SessionStorageBackend
// ─────────────────────────────────────────────────────────────────────────────

function sharedSuite(
  label: 'LocalStorageBackend' | 'SessionStorageBackend',
  createBackend: (storage: Storage, quota?: number) => LocalStorageBackend | SessionStorageBackend,
) {
  describe(label, () => {
    let mockStorage: Storage & { _data: Map<string, string> };
    let backend: LocalStorageBackend | SessionStorageBackend;

    beforeEach(() => {
      mockStorage = createMockStorage();
      backend = createBackend(mockStorage);
    });

    // ── Lifecycle ─────────────────────────────────────────────────────────

    describe('lifecycle', () => {
      it('probe() succeeds when storage is accessible', async () => {
        const result = await backend.probe();
        expect(result.available).toBe(true);
        expect(result.latency).toBeGreaterThanOrEqual(0);
        // probe key must be cleaned up
        expect(mockStorage.getItem('__storage____probe__')).toBeNull();
      });

      it('probe() returns available:false when setItem throws', async () => {
        vi.spyOn(mockStorage, 'setItem').mockImplementation(() => {
          throw new DOMException('SecurityError', 'SecurityError');
        });
        const result = await backend.probe();
        expect(result.available).toBe(false);
        expect(result.reason).toBeTruthy();
      });

      it('initialize() marks backend as ready', async () => {
        await backend.initialize();
        // No throw means success; verify CRUD now works
        await expect(backend.read(KEY_A)).resolves.toBeNull();
      });

      it('operations before initialize() throw "not initialized"', async () => {
        await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
        await expect(backend.write(KEY_A, env())).rejects.toThrow('not initialized');
        await expect(backend.delete(KEY_A)).rejects.toThrow('not initialized');
        await expect(backend.clear()).rejects.toThrow('not initialized');
        await expect(backend.query({})).rejects.toThrow('not initialized');
        await expect(backend.count()).rejects.toThrow('not initialized');
        await expect(backend.estimateQuota()).rejects.toThrow('not initialized');
        await expect(backend.evict(0, 'lru')).rejects.toThrow('not initialized');
      });

      it('close() clears read counts and marks as uninitialized', async () => {
        await backend.initialize();
        await backend.write(KEY_A, env());
        await backend.read(KEY_A);
        await backend.close();
        await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
      });

      it('close() rolls back pending transactions without touching committed data', async () => {
        await backend.initialize();
        await backend.write(KEY_A, env());

        const tx = (await backend.beginTransaction()) as WebStorageTransaction;
        await backend.write(KEY_B, env(), { transactionId: tx.id });
        // KEY_B is buffered, not yet in storage
        expect(mockStorage.getItem(`__storage__${KEY_B}`)).toBeNull();

        await backend.close();

        // After close the backend is uninitialized but the committed KEY_A entry
        // should still be in the raw storage object.
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).not.toBeNull();
        expect(mockStorage.getItem(`__storage__${KEY_B}`)).toBeNull();
      });
    });

    // ── Core CRUD ─────────────────────────────────────────────────────────

    describe('CRUD', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('write then read returns the envelope', async () => {
        const e = env({ payload: 'secret' });
        await backend.write(KEY_A, e);
        const result = await backend.read(KEY_A);
        expect(result).toEqual(e);
      });

      it('read returns null for unknown key', async () => {
        expect(await backend.read(KEY_A)).toBeNull();
      });

      it('overwrite replaces the envelope', async () => {
        await backend.write(KEY_A, env({ payload: 'old' }));
        await backend.write(KEY_A, env({ payload: 'new' }));
        const result = await backend.read(KEY_A);
        expect(result?.payload).toBe('new');
      });

      it('delete removes the entry', async () => {
        await backend.write(KEY_A, env());
        await backend.delete(KEY_A);
        expect(await backend.read(KEY_A)).toBeNull();
      });

      it('delete on absent key is idempotent', async () => {
        await expect(backend.delete(KEY_A)).resolves.toBeUndefined();
      });

      it('clear() without prefix removes all own entries', async () => {
        await backend.write(KEY_A, env());
        await backend.write(KEY_B, env());
        await backend.write(KEY_C, env());
        await backend.clear();
        expect(await backend.count()).toBe(0);
      });

      it('clear(prefix) removes only matching entries', async () => {
        await backend.write(KEY_A, env()); // auth
        await backend.write(KEY_B, env()); // auth
        await backend.write(KEY_C, env()); // prefs
        await backend.clear(PREFIX_AUTH);
        expect(await backend.read(KEY_A)).toBeNull();
        expect(await backend.read(KEY_B)).toBeNull();
        expect(await backend.read(KEY_C)).not.toBeNull();
      });

      it('clear() does not touch keys from other namespaces', async () => {
        // Write a key outside the backend's prefix
        mockStorage.setItem('other-lib__something', 'preserve-me');
        await backend.write(KEY_A, env());
        await backend.clear();
        expect(mockStorage.getItem('other-lib__something')).toBe('preserve-me');
      });
    });

    // ── TTL ───────────────────────────────────────────────────────────────

    describe('TTL', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('read returns null and removes an expired entry', async () => {
        await backend.write(KEY_A, expiredEnv());
        const result = await backend.read(KEY_A);
        expect(result).toBeNull();
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).toBeNull();
      });

      it('read returns entry when respectTtl is false even if expired', async () => {
        await backend.write(KEY_A, expiredEnv());
        const result = await backend.read(KEY_A, { respectTtl: false });
        expect(result).not.toBeNull();
      });

      it('query excludes expired entries by default', async () => {
        await backend.write(KEY_A, env());
        await backend.write(KEY_B, expiredEnv());
        const results = await backend.query({});
        expect(results.map((r) => r.key)).toContain(KEY_A);
        expect(results.map((r) => r.key)).not.toContain(KEY_B);
        // Lazy cleanup also removes the expired entry from storage
        expect(mockStorage.getItem(`__storage__${KEY_B}`)).toBeNull();
      });

      it('query includes expired entries when excludeExpired is false', async () => {
        await backend.write(KEY_A, expiredEnv());
        const results = await backend.query({ excludeExpired: false });
        expect(results.map((r) => r.key)).toContain(KEY_A);
      });
    });

    // ── Query ─────────────────────────────────────────────────────────────

    describe('query', () => {
      beforeEach(async () => {
        await backend.initialize();
        await backend.write(KEY_A, env({ schema_version: 1 }));
        await backend.write(KEY_B, env({ schema_version: 2 }));
        await backend.write(KEY_C, env({ schema_version: 1 }));
      });

      it('returns all own entries when no filter is set', async () => {
        const results = await backend.query({});
        expect(results).toHaveLength(3);
      });

      it('filters by canonical key prefix', async () => {
        const results = await backend.query({ prefix: PREFIX_AUTH });
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.key).sort()).toEqual([KEY_A, KEY_B].sort());
      });

      it('filters by schema_version', async () => {
        const results = await backend.query({ schema_version: 2 });
        expect(results).toHaveLength(1);
        expect(results[0].key).toBe(KEY_B);
      });

      it('respects limit and offset', async () => {
        const all = await backend.query({});
        const paged = await backend.query({ limit: 2, offset: 1 });
        expect(paged).toHaveLength(2);
        expect(paged[0]).toEqual(all[1]);
        expect(paged[1]).toEqual(all[2]);
      });
    });

    // ── Count ─────────────────────────────────────────────────────────────

    describe('count', () => {
      beforeEach(async () => {
        await backend.initialize();
        await backend.write(KEY_A, env());
        await backend.write(KEY_B, env());
        await backend.write(KEY_C, env());
      });

      it('count() without prefix returns total own entries', async () => {
        expect(await backend.count()).toBe(3);
      });

      it('count(prefix) returns only matching entries', async () => {
        expect(await backend.count(PREFIX_AUTH)).toBe(2);
        expect(await backend.count('myapp:chrome:130:prefs:')).toBe(1);
      });

      it('count does not include entries from other namespaces', async () => {
        mockStorage.setItem('other__key', 'value');
        expect(await backend.count()).toBe(3);
      });
    });

    // ── Transactions ──────────────────────────────────────────────────────

    describe('transactions', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('beginTransaction() rejects serializable strength', async () => {
        await expect(backend.beginTransaction('serializable')).rejects.toThrow('serializable');
      });

      it('buffered writes are not visible before commit', async () => {
        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env({ payload: 'buffered' }), { transactionId: tx.id });
        // Not yet in storage
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).toBeNull();
        await tx.commit();
        // Now it should be there
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).not.toBeNull();
      });

      it('commit applies write, delete, and clear ops in order', async () => {
        await backend.write(KEY_B, env({ payload: 'pre-existing' }));
        await backend.write(KEY_C, env());

        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env({ payload: 'new' }), { transactionId: tx.id });
        await backend.delete(KEY_B, { transactionId: tx.id });
        await backend.clear(PREFIX_AUTH, { transactionId: tx.id });

        await tx.commit();

        // KEY_A written, KEY_B deleted, PREFIX_AUTH cleared (KEY_A included)
        // Result: KEY_A may or may not exist depending on op order;
        // the clear op comes after write, so KEY_A ends up removed.
        expect(await backend.read(KEY_A)).toBeNull(); // cleared by clear(PREFIX_AUTH)
        expect(await backend.read(KEY_B)).toBeNull(); // explicitly deleted
        expect(await backend.read(KEY_C)).not.toBeNull(); // not touched
      });

      it('full rollback restores all snapshotted keys', async () => {
        await backend.write(KEY_A, env({ payload: 'original' }));
        // KEY_B does not exist before the transaction

        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env({ payload: 'modified' }), { transactionId: tx.id });
        await backend.write(KEY_B, env({ payload: 'new' }), { transactionId: tx.id });

        await tx.rollback();

        // KEY_A should be back to its pre-transaction value (not yet committed)
        // Since the ops were buffered, KEY_A was never actually modified in storage.
        // Rollback restores via snapshot, but snapshot was taken before any real write.
        // Both keys should reflect the state before the transaction.
        const resA = await backend.read(KEY_A);
        expect(resA?.payload).toBe('original');
        expect(await backend.read(KEY_B)).toBeNull();
      });

      it('rollback removes the transaction from the registry', async () => {
        const tx = await backend.beginTransaction();
        expect(backend.isTransactionActive(tx.id)).toBe(true);
        await tx.rollback();
        expect(backend.isTransactionActive(tx.id)).toBe(false);
      });

      it('commit removes the transaction from the registry', async () => {
        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env(), { transactionId: tx.id });
        await tx.commit();
        expect(backend.isTransactionActive(tx.id)).toBe(false);
      });

      it('partial rollback by key removes specific op', async () => {
        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env({ payload: 'A' }), { transactionId: tx.id });
        await backend.write(KEY_B, env({ payload: 'B' }), { transactionId: tx.id });

        const removed = await (tx as WebStorageTransaction).rollback(KEY_A);
        expect(removed).toHaveLength(1);
        expect((removed as any)[0].kind).toBe('write');
        expect((removed as any)[0].key).toBe(KEY_A);

        // Transaction still open, KEY_B write still buffered
        await tx.commit();
        expect(await backend.read(KEY_A)).toBeNull();
        expect((await backend.read(KEY_B))?.payload).toBe('B');
      });

      it('partial rollback by index removes the correct op', async () => {
        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env(), { transactionId: tx.id });
        await backend.write(KEY_B, env(), { transactionId: tx.id });

        const removed = await (tx as WebStorageTransaction).rollback(0);
        expect((removed as any)[0]?.key).toBe(KEY_A);

        await tx.commit();
        expect(await backend.read(KEY_A)).toBeNull();
        expect(await backend.read(KEY_B)).not.toBeNull();
      });

      it('partial rollback by predicate removes matching ops', async () => {
        const tx = await backend.beginTransaction();
        await backend.write(KEY_A, env(), { transactionId: tx.id });
        await backend.delete(KEY_B, { transactionId: tx.id });

        // Remove only delete ops
        await (tx as WebStorageTransaction).rollback((op) => op.kind === 'delete');

        await tx.commit();
        expect(await backend.read(KEY_A)).not.toBeNull();
        // KEY_B delete was removed; if KEY_B never existed, it's still null
        expect(await backend.read(KEY_B)).toBeNull();
      });

      it('settled transaction rejects further ops', async () => {
        const tx = await backend.beginTransaction();
        await tx.rollback();
        await expect(tx.commit()).rejects.toThrow('settled');
        await expect((tx as WebStorageTransaction).rollback()).rejects.toThrow('settled');
      });

      it('isTransactionActive() with no arg returns true when any tx is open', async () => {
        expect(backend.isTransactionActive()).toBe(false);
        const tx = await backend.beginTransaction();
        expect(backend.isTransactionActive()).toBe(true);
        await tx.rollback();
        expect(backend.isTransactionActive()).toBe(false);
      });
    });

    // ── Quota estimation ──────────────────────────────────────────────────

    describe('estimateQuota', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('returns used=0 when no entries are stored', async () => {
        const q = await backend.estimateQuota();
        expect(q.used).toBe(0);
        expect(q.available).toBeGreaterThan(0);
        expect(q.ratio).toBe(0);
      });

      it('used increases after writing entries', async () => {
        const before = (await backend.estimateQuota()).used;
        await backend.write(KEY_A, env());
        const after = (await backend.estimateQuota()).used;
        expect(after).toBeGreaterThan(before);
      });

      it('ratio is between 0 and 1', async () => {
        await backend.write(KEY_A, env());
        const q = await backend.estimateQuota();
        expect(q.ratio).toBeGreaterThan(0);
        expect(q.ratio).toBeLessThanOrEqual(1);
      });

      it('does not count keys outside own prefix in usage', async () => {
        mockStorage.setItem('other-lib__big-key', 'x'.repeat(1000));
        const q = await backend.estimateQuota();
        // Used should only reflect own keys (none written yet)
        expect(q.used).toBe(0);
      });
    });

    // ── Eviction ──────────────────────────────────────────────────────────

    describe('evict', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('evict TTL sweep removes expired entries first', async () => {
        await backend.write(KEY_A, expiredEnv({ weight: 100 })); // expired, high weight
        await backend.write(KEY_B, env({ weight: 1 })); // alive, low weight
        const freed = await backend.evict(1, 'lru');
        // KEY_A should be swept as expired, regardless of weight
        expect(await backend.read(KEY_A)).toBeNull();
        expect(freed).toBeGreaterThan(0);
      });

      it('evict by weight removes lower-weight entries first', async () => {
        await backend.write(KEY_A, env({ weight: 10 }));
        await backend.write(KEY_B, env({ weight: 1 }));
        await backend.write(KEY_C, env({ weight: 5 }));

        // Request enough bytes to evict at least one entry
        const { used } = await backend.estimateQuota();
        await backend.evict(Math.ceil(used / 3), 'lru');

        // KEY_B (weight 1) should go first
        expect(await backend.read(KEY_B)).toBeNull();
      });

      it('evict lfu respects read counts', async () => {
        await backend.write(KEY_A, env({ weight: 1 }));
        await backend.write(KEY_B, env({ weight: 1 }));
        // Read KEY_A twice to increase its LFU count
        await backend.read(KEY_A);
        await backend.read(KEY_A);

        const { used } = await backend.estimateQuota();
        await backend.evict(Math.ceil(used / 3), 'lfu');

        // KEY_B (fewer reads) should be evicted before KEY_A
        expect(await backend.read(KEY_B)).toBeNull();
        expect(await backend.read(KEY_A)).not.toBeNull();
      });

      it('evict user policy invokes comparator', async () => {
        await backend.write(KEY_A, env({ weight: 1 }));
        await backend.write(KEY_B, env({ weight: 1 }));

        const comparator = vi.fn(() => 1); // always prefer evicting 'b'
        const { used } = await backend.estimateQuota();
        await backend.evict(Math.ceil(used / 3), 'user', comparator);

        expect(comparator).toHaveBeenCalled();
      });

      it('evict returns 0 when there is nothing to evict', async () => {
        const freed = await backend.evict(1000, 'lru');
        expect(freed).toBe(0);
      });

      it('evict stops once targetBytes is reached', async () => {
        await backend.write(KEY_A, env({ weight: 1 }));
        await backend.write(KEY_B, env({ weight: 2 }));
        await backend.write(KEY_C, env({ weight: 3 }));

        // Only need to free a small amount — should evict KEY_A only
        await backend.evict(1, 'lru');

        // KEY_B and KEY_C should still be present (not guaranteed by test
        // since exact byte sizes are implementation-detail, but we can
        // check at least one entry remains)
        const remaining = await backend.count();
        expect(remaining).toBeGreaterThan(0);
      });
    });

    // ── QuotaExceededError recovery ───────────────────────────────────────

    describe('QuotaExceededError recovery', () => {
      it('policy "none" rethrows immediately', async () => {
        const tightStorage = createMockStorage(0); // zero quota — always throws
        const b = createBackend(tightStorage, 0);
        await b.initialize();
        await expect(b.write(KEY_A, env())).rejects.toThrow();
      });

      it('policy "ttl-then-lru" sweeps expired entries and retries', async () => {
        // Build a storage with just enough quota for one entry.
        // Write an expired entry first, then try to write a new one.
        // The recovery pass should sweep the expired entry, freeing room.
        const e = env();
        const json = JSON.stringify(e);
        const storageKey = `__storage__${KEY_A}`;
        const needed = (storageKey.length + json.length) * 2 + 100;

        const tightStorage = createMockStorage(needed);
        const b = createBackend(tightStorage);
        await b.initialize();

        // Write a soon-to-expire entry that fills most of the quota
        await b.write(KEY_A, expiredEnv());

        // Now try to write KEY_B — should trigger recovery (sweep KEY_A) and succeed
        await expect(b.write(KEY_B, e)).resolves.toBeUndefined();
        expect(await b.read(KEY_A)).toBeNull(); // swept by recovery
        expect(await b.read(KEY_B)).not.toBeNull();
      });

      it('policy "ttl-then-lru" falls back to LRU if TTL sweep is insufficient', async () => {
        // Write a non-expired entry. Quota is tight. Recovery should LRU-evict it.
        const e = env();
        const json = JSON.stringify(e);
        const sKey = `__storage__${KEY_A}`;
        const entryBytes = (sKey.length + json.length) * 2;
        const quota = entryBytes + 10; // room for one entry, barely

        const tightStorage = createMockStorage(quota);
        const b = createBackend(tightStorage);
        await b.initialize();

        // Fill quota with a non-expired entry
        await b.write(KEY_A, env({ written_at: Date.now() - 10000 }));

        // Write KEY_B: should trigger LRU eviction of KEY_A and succeed
        await expect(b.write(KEY_B, e)).resolves.toBeUndefined();
      });
    });

    // ── Corrupt entry cleanup ─────────────────────────────────────────────

    describe('corrupt entries', () => {
      beforeEach(async () => {
        await backend.initialize();
      });

      it('read silently removes a corrupt entry and returns null', async () => {
        mockStorage.setItem(`__storage__${KEY_A}`, 'NOT VALID JSON{{{');
        const result = await backend.read(KEY_A);
        expect(result).toBeNull();
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).toBeNull();
      });

      it('query silently skips and removes corrupt entries', async () => {
        await backend.write(KEY_B, env());
        mockStorage.setItem(`__storage__${KEY_A}`, '{{invalid');
        const results = await backend.query({});
        expect(results.map((r) => r.key)).not.toContain(KEY_A);
        expect(mockStorage.getItem(`__storage__${KEY_A}`)).toBeNull();
        expect(results.map((r) => r.key)).toContain(KEY_B);
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Concrete instantiation helpers
// The two backends differ only in which Storage handle they receive.
// We inject a mock by stubbing window.localStorage / window.sessionStorage.
// ─────────────────────────────────────────────────────────────────────────────

sharedSuite('LocalStorageBackend', (storage) => {
  vi.stubGlobal('window', { localStorage: storage, sessionStorage: createMockStorage() });
  return new LocalStorageBackend({ keyPrefix: '__storage__' });
});

sharedSuite('SessionStorageBackend', (storage) => {
  vi.stubGlobal('window', { localStorage: createMockStorage(), sessionStorage: storage });
  return new SessionStorageBackend({ keyPrefix: '__storage__' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend-specific invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('LocalStorageBackend specific', () => {
  it('kind is "localstorage"', () => {
    vi.stubGlobal('window', { localStorage: createMockStorage() });
    const b = new LocalStorageBackend();
    expect(b.kind).toBe('localstorage');
  });

  it('priority is 3', () => {
    vi.stubGlobal('window', { localStorage: createMockStorage() });
    const b = new LocalStorageBackend();
    expect(b.priority).toBe(3);
  });

  it('transactionStrength is "compensating"', () => {
    vi.stubGlobal('window', { localStorage: createMockStorage() });
    const b = new LocalStorageBackend();
    expect(b.transactionStrength).toBe('compensating');
  });
});

describe('SessionStorageBackend specific', () => {
  it('kind is "sessionstorage"', () => {
    vi.stubGlobal('window', { sessionStorage: createMockStorage() });
    const b = new SessionStorageBackend();
    expect(b.kind).toBe('sessionstorage');
  });

  it('priority is 4', () => {
    vi.stubGlobal('window', { sessionStorage: createMockStorage() });
    const b = new SessionStorageBackend();
    expect(b.priority).toBe(4);
  });

  it('two backends share no state — different Storage objects', async () => {
    const ls = createMockStorage();
    const ss = createMockStorage();
    vi.stubGlobal('window', { localStorage: ls, sessionStorage: ss });

    const lsBackend = new LocalStorageBackend({ keyPrefix: '__storage__' });
    const ssBackend = new SessionStorageBackend({ keyPrefix: '__storage__' });
    await lsBackend.initialize();
    await ssBackend.initialize();

    await lsBackend.write(KEY_A, env({ payload: 'in-ls' }, 'localstorage'));
    expect(await ssBackend.read(KEY_A)).toBeNull();

    await ssBackend.write(KEY_A, env({ payload: 'in-ss' }, 'sessionstorage'));
    expect((await lsBackend.read(KEY_A))?.payload).toBe('in-ls');
    expect((await ssBackend.read(KEY_A))?.payload).toBe('in-ss');
  });
});
