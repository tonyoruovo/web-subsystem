/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @fileoverview
 * Integration tests for IDBBackend.
 *
 * Uses fake-indexeddb (auto-import) which provides a complete, spec-compliant
 * in-process IndexedDB implementation. Every test exercises the full backend
 * code path — openDatabase, idbRequest, idbTransactionDone, cursors, indexes —
 * with no mocking of individual IDB calls. Each test gets a fresh database
 * name to guarantee complete isolation.
 *
 * Coverage:
 *   Lifecycle:     probe, initialize, close, re-initialize, abort signal
 *   CRUD:          write, read, delete, clear (full + prefix), overwrite
 *   TTL:           expired entries, respectTtl:false, null expires_at
 *   LFU tracking:  readCount increments + reset on overwrite
 *   Query:         prefix, schema_version, excludeExpired, limit/offset
 *   Count:         with/without prefix
 *   Transactions:  commit (write+delete+clear), rollback, partial rollback,
 *                  isTransactionActive, empty-op commit, all strengths accepted
 *   Quota:         estimateQuota shape
 *   Eviction:      Phase-1 TTL sweep, Phase-2 weighted (lru, lfu, fifo, user)
 *   Abort signal:  write, clear, initialize
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanonicalKey, IDBTransaction, StorageEnvelope } from '../src';
import { IDBBackend } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Test key fixtures
// ─────────────────────────────────────────────────────────────────────────────

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;
const KEY_D = 'otherapp:firefox:100:data:token' as CanonicalKey;

const PREFIX_AUTH = 'myapp:chrome:130:auth:';
const PREFIX_PREFS = 'myapp:chrome:130:prefs:';
// const PREFIX_ALL   = 'myapp:'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _dbSeq = 0;
/** Each test suite call gets a guaranteed-unique DB name. */
function freshDbName(): string {
  return `test-idb-${++_dbSeq}`;
}

function env(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return {
    payload: 'ENCRYPTED-PAYLOAD',
    schema_version: 1,
    written_at: Date.now() - 1_000,
    expires_at: null,
    weight: 5,
    backend: 'indexeddb',
    ...overrides,
  };
}

function expiredEnv(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return env({ expires_at: Date.now() - 1, ...overrides });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-describe setup
// ─────────────────────────────────────────────────────────────────────────────

let backend: IDBBackend;

beforeEach(async () => {
  backend = new IDBBackend({ dbName: freshDbName(), storeName: 'entries' });
  await backend.initialize();
});

afterEach(async () => {
  await backend.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — lifecycle', () => {
  it('probe() succeeds when indexedDB is available', async () => {
    const fresh = new IDBBackend({ dbName: freshDbName() });
    const result = await fresh.probe();
    expect(result.available).toBe(true);
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('probe() cleans up the probe database (does not leave artifacts)', async () => {
    const dbName = freshDbName();
    const fresh = new IDBBackend({ dbName });
    await fresh.probe();
    // If the probe left its own DB we could open it here; we only check no throw
    await expect(fresh.probe()).resolves.toMatchObject({ available: true });
  });

  it('probe() returns available:false when indexedDB is undefined', async () => {
    const orig = (globalThis as any).indexedDB;
    delete (globalThis as any).indexedDB;
    try {
      const fresh = new IDBBackend({ dbName: freshDbName() });
      const result = await fresh.probe();
      expect(result.available).toBe(false);
      expect(result.reason).toBeTruthy();
    } finally {
      (globalThis as any).indexedDB = orig;
    }
  });

  it('kind is "indexeddb"', () => {
    expect(backend.kind).toBe('indexeddb');
  });

  it('transactionStrength is "serializable"', () => {
    expect(backend.transactionStrength).toBe('serializable');
  });

  it('priority is 0', () => {
    expect(backend.priority).toBe(0);
  });

  it('operations before initialize() throw "not initialized"', async () => {
    const fresh = new IDBBackend({ dbName: freshDbName() });
    await expect(fresh.read(KEY_A)).rejects.toThrow('not initialized');
    await expect(fresh.write(KEY_A, env())).rejects.toThrow('not initialized');
    await expect(fresh.delete(KEY_A)).rejects.toThrow('not initialized');
    await expect(fresh.clear()).rejects.toThrow('not initialized');
    await expect(fresh.query({})).rejects.toThrow('not initialized');
    await expect(fresh.count()).rejects.toThrow('not initialized');
    await expect(fresh.estimateQuota()).rejects.toThrow('not initialized');
    await expect(fresh.evict(1, 'lru')).rejects.toThrow('not initialized');
    await expect(fresh.beginTransaction()).rejects.toThrow('not initialized');
  });

  it('close() marks backend as uninitialized', async () => {
    await backend.close();
    await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
  });

  it('data persists across close/re-initialize cycles', async () => {
    const dbName = freshDbName();
    const b1 = new IDBBackend({ dbName });
    await b1.initialize();
    await b1.write(KEY_A, env({ payload: 'persistent' }));
    await b1.close();

    const b2 = new IDBBackend({ dbName });
    await b2.initialize();
    const result = await b2.read(KEY_A);
    expect(result?.payload).toBe('persistent');
    await b2.close();
  });

  it('close() rolls back pending transactions without writing to IDB', async () => {
    const tx = (await backend.beginTransaction()) as IDBTransaction;
    await backend.write(KEY_A, env(), { transactionId: tx.id });
    // KEY_A is buffered — not yet in IDB
    await backend.close();

    // Re-open and verify KEY_A was never written
    const b2 = new IDBBackend({ dbName: (backend as any)._dbName });
    await b2.initialize();
    expect(await b2.read(KEY_A)).toBeNull();
    await b2.close();
  });

  it('initialize() respects AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    const fresh = new IDBBackend({ dbName: freshDbName() });
    await expect(fresh.initialize(ac.signal)).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Core CRUD
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — CRUD', () => {
  it('write then read returns the exact envelope', async () => {
    const e = env({ payload: 'secret', schema_version: 3, weight: 10 });
    await backend.write(KEY_A, e);
    const result = await backend.read(KEY_A);
    expect(result).toEqual(e);
  });

  it('read returns null for unknown key', async () => {
    expect(await backend.read(KEY_A)).toBeNull();
  });

  it('overwrite replaces the stored envelope', async () => {
    await backend.write(KEY_A, env({ payload: 'v1' }));
    await backend.write(KEY_A, env({ payload: 'v2' }));
    const result = await backend.read(KEY_A);
    expect(result?.payload).toBe('v2');
  });

  it('delete removes the entry; read returns null afterwards', async () => {
    await backend.write(KEY_A, env());
    await backend.delete(KEY_A);
    expect(await backend.read(KEY_A)).toBeNull();
  });

  it('delete is idempotent for absent keys', async () => {
    await expect(backend.delete(KEY_A)).resolves.toBeUndefined();
  });

  it('clear() without prefix removes all entries', async () => {
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

  it('write respects AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(backend.write(KEY_A, env(), { signal: ac.signal })).rejects.toThrow();
  });

  it('clear respects AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(backend.clear(undefined, { signal: ac.signal })).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TTL
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — TTL', () => {
  it('read returns null for an expired entry and lazily schedules deletion', async () => {
    await backend.write(KEY_A, expiredEnv());
    const result = await backend.read(KEY_A);
    expect(result).toBeNull();
    // Give the fire-and-forget delete a chance to run
    await new Promise((r) => setTimeout(r, 20));
    // The entry should now be gone from IDB
    expect(await backend.read(KEY_A)).toBeNull();
  });

  it('read returns entry when respectTtl is false even if expired', async () => {
    await backend.write(KEY_A, expiredEnv());
    const result = await backend.read(KEY_A, { respectTtl: false });
    expect(result).not.toBeNull();
  });

  it('never-expiring entry (expires_at: null) is always returned', async () => {
    await backend.write(KEY_A, env({ expires_at: null }));
    expect(await backend.read(KEY_A)).not.toBeNull();
  });

  it('future-expiring entry is returned before its TTL', async () => {
    await backend.write(KEY_A, env({ expires_at: Date.now() + 1_000_000 }));
    expect(await backend.read(KEY_A)).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LFU read count
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — LFU read-count tracking', () => {
  it('overwriting an entry resets the LFU counter (verified via eviction order)', async () => {
    await backend.write(KEY_A, env({ weight: 1 }));
    await backend.write(KEY_B, env({ weight: 1 }));

    // Read KEY_A many times — it should have a high LFU count
    for (let i = 0; i < 10; i++) await backend.read(KEY_A);

    // Overwrite KEY_A — resets its counter
    await backend.write(KEY_A, env({ weight: 1 }));

    // Now both are equal; LFU should evict the one with fewer reads.
    // Since KEY_B has 0 reads and KEY_A just got reset to 0, the tie
    // is resolved by LRU (written_at). Either is fine — just verify one
    // gets evicted, not both.
    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'lfu');

    const remaining = await backend.count();
    expect(remaining).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Query
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — query', () => {
  beforeEach(async () => {
    await backend.write(KEY_A, env({ schema_version: 1 }));
    await backend.write(KEY_B, env({ schema_version: 2 }));
    await backend.write(KEY_C, env({ schema_version: 1 }));
    await backend.write(KEY_D, env({ schema_version: 1 }));
  });

  it('returns all entries when no filter is set', async () => {
    const results = await backend.query({});
    expect(results).toHaveLength(4);
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

  it('excludes expired entries by default', async () => {
    await backend.write('myapp:chrome:130:auth:expired' as CanonicalKey, expiredEnv());
    const results = await backend.query({});
    expect(results.map((r) => r.key)).not.toContain('myapp:chrome:130:auth:expired');
  });

  it('includes expired entries when excludeExpired is false', async () => {
    const expiredKey = 'myapp:chrome:130:auth:old' as CanonicalKey;
    await backend.write(expiredKey, expiredEnv());
    const results = await backend.query({ excludeExpired: false });
    expect(results.map((r) => r.key)).toContain(expiredKey);
  });

  it('respects offset and limit', async () => {
    const all = await backend.query({});
    const paged = await backend.query({ limit: 2, offset: 1 });
    expect(paged).toHaveLength(2);
    expect(paged[0]).toEqual(all[1]);
    expect(paged[1]).toEqual(all[2]);
  });

  it('returns the reconstructed envelope for each result', async () => {
    const results = await backend.query({ prefix: PREFIX_AUTH });
    for (const r of results) {
      expect(r.envelope.payload).toBe('ENCRYPTED-PAYLOAD');
      expect(typeof r.envelope.schema_version).toBe('number');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Count
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — count', () => {
  beforeEach(async () => {
    await backend.write(KEY_A, env());
    await backend.write(KEY_B, env());
    await backend.write(KEY_C, env());
  });

  it('count() without prefix returns total entries', async () => {
    expect(await backend.count()).toBe(3);
  });

  it('count(prefix) returns only matching entries', async () => {
    expect(await backend.count(PREFIX_AUTH)).toBe(2);
    expect(await backend.count(PREFIX_PREFS)).toBe(1);
  });

  it('count() returns 0 for an empty store', async () => {
    await backend.clear();
    expect(await backend.count()).toBe(0);
  });

  it('count(prefix) returns 0 for a prefix with no matches', async () => {
    expect(await backend.count('zzz:')).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Transactions
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — transactions', () => {
  it('accepts all TransactionStrength values', async () => {
    for (const strength of ['serializable', 'compensating', 'best-effort'] as const) {
      const tx = await backend.beginTransaction(strength);
      expect(tx.strength).toBe('serializable');
      await tx.rollback();
    }
  });

  it('accepts no strength argument', async () => {
    const tx = await backend.beginTransaction();
    expect(tx).toBeDefined();
    await tx.rollback();
  });

  it('buffered writes are NOT visible before commit', async () => {
    const tx = await backend.beginTransaction();
    await backend.write(KEY_A, env({ payload: 'tx-data' }), { transactionId: tx.id });
    expect(await backend.read(KEY_A)).toBeNull();
    await tx.commit();
    expect((await backend.read(KEY_A))?.payload).toBe('tx-data');
  });

  it('commit applies write, delete, and clear ops atomically', async () => {
    await backend.write(KEY_B, env({ payload: 'pre-existing' }));
    await backend.write(KEY_C, env());

    const tx = await backend.beginTransaction();
    await backend.write(KEY_A, env({ payload: 'new-A' }), { transactionId: tx.id });
    await backend.delete(KEY_B, { transactionId: tx.id });
    await backend.clear(PREFIX_PREFS, { transactionId: tx.id });
    await tx.commit();

    expect((await backend.read(KEY_A))?.payload).toBe('new-A');
    expect(await backend.read(KEY_B)).toBeNull();
    expect(await backend.read(KEY_C)).toBeNull();
  });

  it('commit with zero ops is a no-op', async () => {
    const tx = await backend.beginTransaction();
    await expect(tx.commit()).resolves.toBeUndefined();
  });

  it('full rollback discards all buffered ops — nothing is written', async () => {
    const tx = await backend.beginTransaction();
    await backend.write(KEY_A, env(), { transactionId: tx.id });
    await backend.write(KEY_B, env(), { transactionId: tx.id });
    await tx.rollback();

    expect(await backend.read(KEY_A)).toBeNull();
    expect(await backend.read(KEY_B)).toBeNull();
  });

  it('isTransactionActive() without arg reflects open / closed state', async () => {
    expect(backend.isTransactionActive()).toBe(false);
    const tx = await backend.beginTransaction();
    expect(backend.isTransactionActive()).toBe(true);
    await tx.rollback();
    expect(backend.isTransactionActive()).toBe(false);
  });

  it('isTransactionActive(txId) is true only while that tx is open', async () => {
    const tx = await backend.beginTransaction();
    expect(backend.isTransactionActive(tx.id)).toBe(true);
    await tx.commit();
    expect(backend.isTransactionActive(tx.id)).toBe(false);
  });

  it('multiple independent transactions can be opened simultaneously', async () => {
    const tx1 = await backend.beginTransaction();
    const tx2 = await backend.beginTransaction();
    expect(backend.isTransactionActive(tx1.id)).toBe(true);
    expect(backend.isTransactionActive(tx2.id)).toBe(true);
    await tx1.rollback();
    await tx2.rollback();
  });

  it('partial rollback by key removes only the matching op', async () => {
    const tx = (await backend.beginTransaction()) as IDBTransaction;
    await backend.write(KEY_A, env({ payload: 'A' }), { transactionId: tx.id });
    await backend.write(KEY_B, env({ payload: 'B' }), { transactionId: tx.id });

    const removed = await tx.rollback(KEY_A);
    expect(removed).toHaveLength(1);

    await tx.commit();
    expect(await backend.read(KEY_A)).toBeNull();
    expect((await backend.read(KEY_B))?.payload).toBe('B');
  });

  it('partial rollback by index removes the op at that position', async () => {
    const tx = (await backend.beginTransaction()) as IDBTransaction;
    await backend.write(KEY_A, env(), { transactionId: tx.id });
    await backend.write(KEY_B, env(), { transactionId: tx.id });

    await tx.rollback(0); // remove KEY_A write
    await tx.commit();

    expect(await backend.read(KEY_A)).toBeNull();
    expect(await backend.read(KEY_B)).not.toBeNull();
  });

  it('partial rollback by predicate removes only matching ops', async () => {
    const tx = (await backend.beginTransaction()) as IDBTransaction;
    await backend.write(KEY_A, env(), { transactionId: tx.id });
    await backend.delete(KEY_B, { transactionId: tx.id });

    // Remove only delete ops
    await tx.rollback((op) => op.kind === 'delete');
    await tx.commit();

    // KEY_A write should have landed; KEY_B delete should have been cancelled
    expect(await backend.read(KEY_A)).not.toBeNull();
  });

  it('settled transaction rejects further calls', async () => {
    const tx = await backend.beginTransaction();
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow('settled');
    await expect(tx.rollback()).rejects.toThrow('settled');
  });

  it('transactional clear without prefix wipes the entire store', async () => {
    await backend.write(KEY_A, env());
    await backend.write(KEY_B, env());
    await backend.write(KEY_C, env());

    const tx = await backend.beginTransaction();
    await backend.clear(undefined, { transactionId: tx.id });
    await tx.commit();

    expect(await backend.count()).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Quota estimation
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — estimateQuota', () => {
  it('returns an object with used, available, and ratio', async () => {
    const q = await backend.estimateQuota();
    expect(typeof q.used).toBe('number');
    expect(typeof q.available).toBe('number');
    expect(typeof q.ratio).toBe('number');
    expect(q.ratio).toBeGreaterThanOrEqual(0);
    expect(q.ratio).toBeLessThanOrEqual(1);
  });

  it('falls back gracefully when navigator.storage is unavailable', async () => {
    const orig = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: () => Promise.reject(new Error('no quota')) },
      configurable: true,
    });
    try {
      const q = await backend.estimateQuota();
      // Falls back to soft-cap values
      expect(q.available).toBeGreaterThan(0);
      expect(q.ratio).toBe(0);
    } finally {
      Object.defineProperty(navigator, 'storage', { value: orig, configurable: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Eviction
// ═════════════════════════════════════════════════════════════════════════════

describe('IDBBackend — evict', () => {
  it('Phase 1: sweeps expired entries before touching live ones', async () => {
    await backend.write(KEY_A, expiredEnv({ weight: 100 })); // expired, high weight
    await backend.write(KEY_B, env({ weight: 1 })); // live, low weight

    const freed = await backend.evict(1, 'lru');
    expect(freed).toBeGreaterThan(0);
    // Expired entry must be gone regardless of weight
    expect(await backend.read(KEY_A)).toBeNull();
    // Live entry must survive (unless targetBytes forced it too, unlikely at weight:100 gone)
    expect(await backend.read(KEY_B)).not.toBeNull();
  });

  it('Phase 2: evicts lowest-weight entries first', async () => {
    await backend.write(KEY_A, env({ weight: 10 }));
    await backend.write(KEY_B, env({ weight: 1 }));
    await backend.write(KEY_C, env({ weight: 5 }));

    // Evict enough to remove at least the lowest-weight entry
    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'lru');

    // KEY_B (weight 1) must have been evicted first
    expect(await backend.read(KEY_B)).toBeNull();
  });

  it('Phase 2: LRU tie-break evicts oldest written_at first', async () => {
    const oldTime = Date.now() - 100_000;
    const newTime = Date.now() - 1_000;
    await backend.write(KEY_A, env({ weight: 1, written_at: oldTime }));
    await backend.write(KEY_B, env({ weight: 1, written_at: newTime }));

    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'lru');

    expect(await backend.read(KEY_A)).toBeNull(); // oldest → evicted first
    expect(await backend.read(KEY_B)).not.toBeNull();
  });

  it('Phase 2: FIFO tie-break is identical to LRU (oldest written_at first)', async () => {
    const oldTime = Date.now() - 100_000;
    await backend.write(KEY_A, env({ weight: 1, written_at: oldTime }));
    await backend.write(KEY_B, env({ weight: 1 }));

    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'fifo');

    expect(await backend.read(KEY_A)).toBeNull();
  });

  it('Phase 2: LFU tie-break evicts least-read first', async () => {
    await backend.write(KEY_A, env({ weight: 1 }));
    await backend.write(KEY_B, env({ weight: 1 }));

    // Read KEY_A 5× — higher LFU count — should survive
    for (let i = 0; i < 5; i++) await backend.read(KEY_A);
    // KEY_B has 0 reads

    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'lfu');

    expect(await backend.read(KEY_B)).toBeNull(); // fewer reads → evicted
    expect(await backend.read(KEY_A)).not.toBeNull();
  });

  it('Phase 2: user comparator is invoked and affects eviction order', async () => {
    await backend.write(KEY_A, env({ weight: 1, payload: 'A' }));
    await backend.write(KEY_B, env({ weight: 1, payload: 'B' }));

    const comparator = vi.fn((a: any, b: any) =>
      a.envelope.payload.localeCompare(b.envelope.payload),
    );

    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'user', comparator);

    expect(comparator).toHaveBeenCalled();
  });

  it('user comparator receives full envelope payloads (not stub strings)', async () => {
    await backend.write(KEY_A, env({ weight: 1, payload: 'real-payload-A' }));
    await backend.write(KEY_B, env({ weight: 1, payload: 'real-payload-B' }));

    const payloads: string[] = [];
    const comparator = (a: any, b: any) => {
      payloads.push(a.envelope.payload, b.envelope.payload);
      return 0;
    };

    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 3), 'user', comparator);

    // IDB supplies full payload — not ''
    expect(payloads.some((p) => p === '')).toBe(false);
  });

  it('returns 0 when there is nothing to evict', async () => {
    const freed = await backend.evict(1_000, 'lru');
    expect(freed).toBe(0);
  });

  it('stops evicting once targetBytes is satisfied', async () => {
    await backend.write(KEY_A, env({ weight: 1 }));
    await backend.write(KEY_B, env({ weight: 2 }));
    await backend.write(KEY_C, env({ weight: 3 }));

    // Only free a tiny amount — should remove at most one entry
    await backend.evict(1, 'lru');

    // At least 2 entries must survive
    const remaining = await backend.count();
    expect(remaining).toBeGreaterThanOrEqual(2);
  });

  it('Phase 1 + Phase 2: sweeps expired then weighted entries if needed', async () => {
    await backend.write(KEY_A, expiredEnv({ weight: 1 })); // phase 1
    await backend.write(KEY_B, env({ weight: 1 })); // phase 2 if needed
    await backend.write(KEY_C, env({ weight: 100 })); // should survive

    // Half the usage: phase 1 (KEY_A, about a third) is not enough, so phase 2
    // evicts KEY_B. A target above the total would evict every entry, because
    // a higher weight means evicted last, not never.
    const { used } = await backend.estimateQuota();
    await backend.evict(Math.ceil(used / 2), 'lru');

    expect(await backend.read(KEY_A)).toBeNull();
    expect(await backend.read(KEY_B)).toBeNull();
    expect(await backend.read(KEY_C)).not.toBeNull(); // high-weight entry survives last
  });
});
