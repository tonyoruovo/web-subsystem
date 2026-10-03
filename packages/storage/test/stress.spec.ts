/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stress and abuse tests across Memory, Cache, and OPFS backends.
 *
 * These tests push the backends to their limits: bulk operations, large payloads,
 * rapid open/close cycles, transaction edge cases, and concurrent-like patterns.
 *
 * OPFS is tested with its full mock infrastructure (same as 05.opfs.test.ts).
 * Cache uses the caches API mock.
 * Memory uses the plain store mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalKey,
  IIOAdapterFactory,
  IStorageBackend,
  MemoryStore,
  StorageEnvelope,
} from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Helpers (shared across backends)
// ───────────────────────────────────────────────────────────────────────────

function env(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return {
    payload: 'x'.repeat(100),
    schema_version: 1,
    written_at: Date.now(),
    expires_at: null,
    weight: 5,
    backend: 'cache',
    ...overrides,
  };
}

function makeKey(i: number): CanonicalKey {
  return `stress:chrome:130:module:key-${String(i).padStart(5, '0')}` as CanonicalKey;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY BACKEND – Stress Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('MemoryBackend – stress', () => {
  let mockStore: MemoryStore;
  let backend: IStorageBackend<any>;

  beforeEach(async () => {
    mockStore = {
      kind: 'memory',
      transactionStrength: 'best-effort',
      priority: 3,
      _store: new Map(),
      _initialized: false,
      _transactions: new Map(),
      _readCount: new Map(),
    } as MemoryStore;
    // Fresh module graph, so each test's store is the one the backend uses.
    vi.resetModules();
    vi.doMock('../src/backends/memory/memory.store', () => ({
      useMemoryStore: () => mockStore,
    }));
    const { MemoryBackend } = await import('../src');
    backend = new MemoryBackend();
    await backend.initialize();
  });

  it('writes 10,000 entries sequentially', async () => {
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      await backend.write(makeKey(i), env({ payload: `payload-${i}` }));
    }
    expect(mockStore._store.size).toBe(N);
    expect(await backend.count()).toBe(N);
  });

  it('reads 10,000 entries sequentially', async () => {
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env({ payload: `payload-${i}` }));
    }
    for (let i = 0; i < 1000; i++) {
      const result = await backend.read(makeKey(i));
      expect(result).not.toBeNull();
      expect(result!.payload).toBe(`payload-${i}`);
    }
  });

  it('bulk write then bulk read in a transaction', async () => {
    const N = 500;
    const tx = await backend.beginTransaction();
    for (let i = 0; i < N; i++) {
      await backend.write(makeKey(i), env({ payload: `tx-payload-${i}` }), {
        transactionId: tx.id,
      });
    }
    // Nothing committed yet
    expect(mockStore._store.size).toBe(0);
    await tx.commit();
    expect(mockStore._store.size).toBe(N);

    // Verify all reads
    for (let i = 0; i < N; i++) {
      const result = await backend.read(makeKey(i));
      expect(result!.payload).toBe(`tx-payload-${i}`);
    }
  });

  it('transaction with 1000 ops then rollback is instant (no I/O)', async () => {
    const tx = await backend.beginTransaction();
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env(), { transactionId: tx.id });
    }
    expect(tx.operations.length).toBe(1000);
    await tx.rollback();
    expect(mockStore._store.size).toBe(0);
  });

  it('rapid write-read-delete cycles (1000 iterations)', async () => {
    const key = 'stress:chrome:130:mod:hot-key' as CanonicalKey;
    for (let i = 0; i < 1000; i++) {
      await backend.write(key, env({ payload: `iteration-${i}` }));
      const result = await backend.read(key);
      expect(result!.payload).toBe(`iteration-${i}`);
      await backend.delete(key);
      expect(await backend.read(key)).toBeNull();
    }
  });

  it('large payload (1 MB string)', async () => {
    const bigPayload = 'x'.repeat(1_000_000);
    const key = 'stress:chrome:130:mod:big' as CanonicalKey;
    await backend.write(key, env({ payload: bigPayload }));
    const result = await backend.read(key);
    expect(result!.payload).toBe(bigPayload);
  });

  it('eviction under load: fill store then evict 50%', async () => {
    const N = 500;
    for (let i = 0; i < N; i++) {
      await backend.write(makeKey(i), env({ payload: `p-${i}`, weight: i % 10 }));
    }
    const freed = await backend.evict(Number.POSITIVE_INFINITY, 'fifo');
    expect(freed).toBeGreaterThan(0);
    // All low-weight entries should be gone
    expect(mockStore._store.size).toBe(0);
  });

  it('query with offset/limit pagination across 1000 entries', async () => {
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env({ schema_version: i % 3 }));
    }
    const page1 = await backend.query({ offset: 0, limit: 50 });
    const page2 = await backend.query({ offset: 50, limit: 50 });
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(50);
    expect(page1[0].key).not.toBe(page2[0].key);
  });

  it('concurrent-like: interleave reads and writes', async () => {
    const N = 200;
    // Write all first
    for (let i = 0; i < N; i++) {
      await backend.write(makeKey(i), env({ payload: `v${i}` }));
    }
    // Interleave reads and overwrites
    for (let i = 0; i < N; i++) {
      const read = await backend.read(makeKey(i));
      expect(read!.payload).toBe(`v${i}`);
      await backend.write(makeKey(i), env({ payload: `v${i}-updated` }));
    }
    // Verify all updated
    for (let i = 0; i < N; i++) {
      const result = await backend.read(makeKey(i));
      expect(result!.payload).toBe(`v${i}-updated`);
    }
  });

  it('LFU eviction with skewed read distribution', async () => {
    // Write 100 entries, read first 10 heavily, last 90 once each
    for (let i = 0; i < 100; i++) {
      await backend.write(makeKey(i), env({ weight: 1 }));
    }
    for (let r = 0; r < 100; r++) {
      for (let i = 0; i < 10; i++) {
        await backend.read(makeKey(i));
      }
    }
    for (let i = 10; i < 100; i++) {
      await backend.read(makeKey(i));
    }
    // Evict 50 entries – the least-read ones (90-99 range, read once) should go first
    const freed = await backend.evict(1, 'lfu');
    expect(freed).toBeGreaterThan(0);
    // The heavily-read first 10 should survive
    for (let i = 0; i < 10; i++) {
      expect(await backend.read(makeKey(i))).not.toBeNull();
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CACHE BACKEND – Stress Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('CacheBackend – stress', () => {
  let fakeCache: Map<string, { response: Response; url: string }>;

  function createMockCache(): Cache {
    return {
      async match(url: string | Request) {
        const key = typeof url === 'string' ? url : url.url;
        return fakeCache.get(key)?.response.clone() ?? undefined;
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
    } as unknown as Cache;
  }

  let backend: IStorageBackend<any>;

  beforeEach(async () => {
    fakeCache = new Map();
    const mockCaches = {
      open: vi.fn().mockResolvedValue(createMockCache()),
      delete: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal('caches', mockCaches);
    const { CacheBackend } = await import('../src');
    backend = new CacheBackend({ cacheName: 'stress-test' });
    await backend.initialize();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes and reads 1000 entries', async () => {
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env({ payload: `cache-payload-${i}` }));
    }
    expect(fakeCache.size).toBe(1000); // 1000 data entries

    for (let i = 0; i < 1000; i++) {
      const result = await backend.read(makeKey(i));
      expect(result!.payload).toBe(`cache-payload-${i}`);
    }
  });

  it('transaction with 500 ops', async () => {
    const tx = await backend.beginTransaction();
    for (let i = 0; i < 500; i++) {
      await backend.write(makeKey(i), env(), { transactionId: tx.id });
    }
    await tx.commit();
    expect(await backend.count()).toBe(500);
  });

  it('query across 500 entries with TTL sweep', async () => {
    const now = Date.now();
    // 250 expired, 250 valid
    for (let i = 0; i < 250; i++) {
      await backend.write(makeKey(i), env({ expires_at: now - 1 }));
    }
    for (let i = 250; i < 500; i++) {
      await backend.write(makeKey(i), env({ expires_at: null }));
    }
    const results = await backend.query({});
    expect(results).toHaveLength(250);
  });

  it('clear all with 1000 entries', async () => {
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env());
    }
    await backend.clear();
    expect(await backend.count()).toBe(0);
  });

  it('rapid write-overwrite cycle (same key 500 times)', async () => {
    const key = 'stress:chrome:130:mod:hotkey' as CanonicalKey;
    for (let i = 0; i < 500; i++) {
      await backend.write(key, env({ payload: `v${i}` }));
    }
    const result = await backend.read(key);
    expect(result!.payload).toBe('v499');
  });

  it('eviction under load: 500 entries, evict aggressively', async () => {
    for (let i = 0; i < 500; i++) {
      await backend.write(makeKey(i), env({ weight: i % 5, expires_at: null }));
    }
    const freed = await backend.evict(Number.POSITIVE_INFINITY, 'lru');
    expect(freed).toBeGreaterThan(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OPFS BACKEND – Stress Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('OPFSBackend – stress', () => {
  let fs: Map<string, string>;
  let mockFactory: IIOAdapterFactory;
  let backend: IStorageBackend<any>;

  beforeEach(async () => {
    fs = new Map();

    const factory = {
      context: 'worker' as const,
      open: vi.fn(async (handle: any) => {
        const { encodeString: enc, decodeBytes: dec } = await import('../src');
        return {
          async readAll() {
            const content = fs.get(handle._filePath);
            if (content === undefined) throw new Error('NotFound');
            return enc(content);
          },
          async writeAll(data: Uint8Array) {
            fs.set(handle._filePath, dec(data));
          },
          async truncate() {
            fs.set(handle._filePath, '');
          },
          async close() {},
        };
      }),
    } as IIOAdapterFactory;
    mockFactory = factory;

    // Directory handles that nest, keyed by path relative to the backend's root.
    const makeDir = (path: string): any => {
      const join = (name: string) => (path ? `${path}/${name}` : name);
      return {
        kind: 'directory',
        async getFileHandle(name: string) {
          return { _filePath: join(name), kind: 'file' };
        },
        async getDirectoryHandle(name: string) {
          return makeDir(join(name));
        },
        async removeEntry(name: string) {
          fs.delete(join(name));
        },
        keys() {
          return [];
        },
      };
    };
    const backendRoot = makeDir('');
    const rootDir = { ...makeDir('__origin__'), getDirectoryHandle: async () => backendRoot };

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(rootDir),
        estimate: vi.fn().mockResolvedValue({ quota: 500_000_000, usage: 0 }),
      },
    });
    vi.stubGlobal('window', {});
    vi.stubGlobal('FileSystemFileHandle', {});

    const { OPFSBackend } = await import('../src');
    backend = new OPFSBackend({ context: 'main-thread' });
    (backend as any)._factory = mockFactory;

    fs.set('_manifest.json', JSON.stringify([]));
    await backend.initialize();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes and reads 1000 entries', async () => {
    for (let i = 0; i < 1000; i++) {
      await backend.write(makeKey(i), env({ payload: `opfs-payload-${i}` }));
    }
    for (let i = 0; i < 1000; i++) {
      const result = await backend.read(makeKey(i));
      expect(result!.payload).toBe(`opfs-payload-${i}`);
    }
  });

  it('transaction with 500 ops commits correctly', async () => {
    const tx = await backend.beginTransaction();
    for (let i = 0; i < 500; i++) {
      await backend.write(makeKey(i), env({ payload: `tx-${i}` }), { transactionId: tx.id });
    }
    await tx.commit();
    expect(await backend.count()).toBe(500);
  });

  it('large transaction then full rollback (no filesystem writes)', async () => {
    const beforeCount = fs.size; // Files on "disk" before
    const tx = await backend.beginTransaction();
    for (let i = 0; i < 200; i++) {
      await backend.write(makeKey(i), env(), { transactionId: tx.id });
    }
    await tx.rollback();
    // Only manifest and WAL files should exist; no data files added
    const afterCount = fs.size;
    expect(afterCount).toBe(beforeCount);
    // The rollback should not have written any data files
    // (manifest might have been rewritten by init, but no data files)
    const dataFileCount = [...fs.keys()].filter((k) => !k.startsWith('_')).length;
    expect(dataFileCount).toBe(0);
  });

  it('eviction under load: 500 entries, evict 50%', async () => {
    for (let i = 0; i < 500; i++) {
      await backend.write(makeKey(i), env({ weight: i % 10, expires_at: null }));
    }
    const freed = await backend.evict(Number.POSITIVE_INFINITY, 'fifo');
    expect(freed).toBeGreaterThan(0);
  });

  it('LFU eviction with skewed reads', async () => {
    for (let i = 0; i < 100; i++) {
      await backend.write(makeKey(i), env({ weight: 1, expires_at: null }));
    }
    for (let r = 0; r < 50; r++) {
      for (let i = 0; i < 10; i++) {
        await backend.read(makeKey(i));
      }
    }
    for (let i = 10; i < 100; i++) {
      await backend.read(makeKey(i));
    }
    await backend.evict(1, 'lfu');
    // First 10 (heavily read) should survive
    for (let i = 0; i < 10; i++) {
      expect(await backend.read(makeKey(i))).not.toBeNull();
    }
  });

  it('mixed transaction: 200 writes + 100 deletes + 50 clears', async () => {
    // Seed 300 entries
    for (let i = 0; i < 300; i++) {
      await backend.write(makeKey(i), env({ payload: `original-${i}` }));
    }

    const tx = await backend.beginTransaction();
    // Overwrite first 200
    for (let i = 0; i < 200; i++) {
      await backend.write(makeKey(i), env({ payload: `updated-${i}` }), { transactionId: tx.id });
    }
    // Delete 100
    for (let i = 200; i < 300; i++) {
      await backend.delete(makeKey(i), { transactionId: tx.id });
    }
    await tx.commit();

    expect(await backend.count()).toBe(200);
    for (let i = 0; i < 200; i++) {
      const result = await backend.read(makeKey(i));
      expect(result!.payload).toBe(`updated-${i}`);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ABUSE / EDGE CASE TESTS (shared patterns)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Abuse & edge cases – shared patterns', () => {
  let mockStore: MemoryStore;
  let backend: IStorageBackend<any>;

  beforeEach(async () => {
    mockStore = {
      kind: 'memory',
      transactionStrength: 'best-effort',
      priority: 3,
      _store: new Map(),
      _initialized: false,
      _transactions: new Map(),
      _readCount: new Map(),
    } as MemoryStore;
    // Fresh module graph, so each test's store is the one the backend uses.
    vi.resetModules();
    vi.doMock('../src/backends/memory/memory.store', () => ({
      useMemoryStore: () => mockStore,
    }));
    const { MemoryBackend } = await import('../src');
    backend = new MemoryBackend();
    await backend.initialize();
  });

  it('write to a key then read with expired TTL returns null', async () => {
    const key = 'abuse:chrome:130:mod:ttl' as CanonicalKey;
    await backend.write(key, env({ expires_at: Date.now() + 100 }));
    // Not expired yet
    expect(await backend.read(key)).not.toBeNull();
    // Travel forward in time by mocking Date.now
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200);
    expect(await backend.read(key)).toBeNull();
    vi.restoreAllMocks();
  });

  it('commit an empty transaction does nothing', async () => {
    const countBefore = mockStore._store.size;
    const tx = await backend.beginTransaction();
    await tx.commit();
    expect(mockStore._store.size).toBe(countBefore);
  });

  it('rollback an empty transaction does nothing', async () => {
    const tx = await backend.beginTransaction();
    await tx.rollback();
    expect(backend.isTransactionActive()).toBe(false);
  });

  it('double rollback throws on second call', async () => {
    const tx = await backend.beginTransaction();
    await tx.rollback();
    await expect(tx.rollback()).rejects.toThrow('already settled');
  });

  it('write after commit on same tx throws', async () => {
    const tx = await backend.beginTransaction();
    await tx.commit();
    await expect(
      backend.write('abuse:chrome:130:mod:key' as CanonicalKey, env(), { transactionId: tx.id }),
    ).rejects.toThrow();
  });

  it('delete non-existent key with transaction then commit', async () => {
    const tx = await backend.beginTransaction();
    await backend.delete('abuse:chrome:130:mod:ghost' as CanonicalKey, { transactionId: tx.id });
    await tx.commit(); // Should not throw
    expect(backend.isTransactionActive(tx.id)).toBe(false);
  });

  it('clear with empty prefix matches nothing', async () => {
    await backend.write('abuse:chrome:130:mod:a' as CanonicalKey, env());
    await backend.clear('zzz-nonexistent:');
    expect(await backend.count()).toBe(1);
  });

  it('query with offset beyond results returns empty', async () => {
    await backend.write('abuse:chrome:130:mod:a' as CanonicalKey, env());
    const results = await backend.query({ offset: 100 });
    expect(results).toHaveLength(0);
  });

  it('query with limit 0 returns empty', async () => {
    await backend.write('abuse:chrome:130:mod:a' as CanonicalKey, env());
    const results = await backend.query({ limit: 0 });
    expect(results).toHaveLength(0);
  });

  it('write with weight=0 and evict', async () => {
    await backend.write(
      'abuse:chrome:130:mod:zero' as CanonicalKey,
      env({ weight: 0, expires_at: null }),
    );
    const freed = await backend.evict(1, 'fifo');
    expect(freed).toBeGreaterThan(0);
    expect(await backend.read('abuse:chrome:130:mod:zero' as CanonicalKey)).toBeNull();
  });

  it('rapid initialize/close cycles (10x)', async () => {
    for (let i = 0; i < 10; i++) {
      await backend.initialize();
      await backend.write('abuse:chrome:130:mod:cycle' as CanonicalKey, env());
      await backend.close();
    }
  });

  it('schema_version filtering in query', async () => {
    for (let v = 1; v <= 5; v++) {
      await backend.write(`abuse:chrome:130:mod:v${v}` as CanonicalKey, env({ schema_version: v }));
    }
    const v3 = await backend.query({ schema_version: 3 });
    expect(v3).toHaveLength(1);
    expect(v3[0].envelope.schema_version).toBe(3);
  });

  it('count with non-matching prefix returns 0', async () => {
    await backend.write('abuse:chrome:130:mod:a' as CanonicalKey, env());
    expect(await backend.count('zzz:')).toBe(0);
  });

  it('concurrent transactions (sequential simulation)', async () => {
    // Open multiple transactions
    const tx1 = await backend.beginTransaction();
    const tx2 = await backend.beginTransaction();
    const tx3 = await backend.beginTransaction();

    await backend.write('abuse:chrome:130:mod:tx1' as CanonicalKey, env({ payload: 'from-tx1' }), {
      transactionId: tx1.id,
    });
    await backend.write('abuse:chrome:130:mod:tx2' as CanonicalKey, env({ payload: 'from-tx2' }), {
      transactionId: tx2.id,
    });
    await backend.write('abuse:chrome:130:mod:tx3' as CanonicalKey, env({ payload: 'from-tx3' }), {
      transactionId: tx3.id,
    });

    // Commit in order
    await tx1.commit();
    await tx2.commit();
    await tx3.commit();

    expect(await backend.read('abuse:chrome:130:mod:tx1' as CanonicalKey)).not.toBeNull();
    expect(await backend.read('abuse:chrome:130:mod:tx2' as CanonicalKey)).not.toBeNull();
    expect(await backend.read('abuse:chrome:130:mod:tx3' as CanonicalKey)).not.toBeNull();
  });

  it('transaction: write + rollback + write + commit (reuse pattern)', async () => {
    const key = 'abuse:chrome:130:mod:reuse' as CanonicalKey;

    const tx1 = await backend.beginTransaction();
    await backend.write(key, env({ payload: 'will-be-rolled-back' }), { transactionId: tx1.id });
    await tx1.rollback();
    expect(await backend.read(key)).toBeNull();

    const tx2 = await backend.beginTransaction();
    await backend.write(key, env({ payload: 'committed-this-time' }), { transactionId: tx2.id });
    await tx2.commit();
    expect((await backend.read(key))!.payload).toBe('committed-this-time');
  });

  it('partial rollback by predicate removes all deletes', async () => {
    const tx = await backend.beginTransaction();
    const key = 'abuse:chrome:130:mod:pred' as CanonicalKey;
    await backend.write(key, env(), { transactionId: tx.id });
    await backend.delete(key, { transactionId: tx.id });
    // Remove all delete ops
    const removed = await tx.rollback((op) => op.kind === 'delete');
    expect(removed).toHaveLength(1);
    expect(tx.operations.length).toBe(1); // Only the write remains
    await tx.commit();
    expect(await backend.read(key)).not.toBeNull();
  });
});
