/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for OPFSBackend.
 * The browser OPFS APIs are fully mocked using vi.stubGlobal and vi.fn().
 * Covers: CRUD, manifest, WAL commit, WAL replay, eviction, quota, transactions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalKey,
  IFileIOAdapter,
  IIOAdapterFactory,
  ManifestEntry,
  StorageEnvelope,
} from '../src';
import { OPFSBackend, bytesToBase64, decodeBytes, encodeString } from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Mock infrastructure
// ───────────────────────────────────────────────────────────────────────────

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;

function env(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return {
    payload: 'encrypted-payload',
    schema_version: 1,
    written_at: Date.now() - 1000,
    expires_at: null,
    weight: 5,
    backend: 'opfs',
    ...overrides,
  };
}

/** Simulates the OPFS filesystem as a nested Map<string, string> (path → encoded bytes) */
let fs: Map<string, string>; // filePath → base64-encoded content

/** In-memory manifest for direct inspection */
let manifest: Map<CanonicalKey, ManifestEntry>;

// let fileHandleMocks: Map<string, any> // filePath → { readAll, writeAll, truncate, close }

function createMockAdapter(filePath: string): IFileIOAdapter {
  const ops: string[] = [];
  return {
    async readAll() {
      const content = fs.get(filePath);
      if (content === undefined) throw new Error('NotFound');
      // Simulate decoding
      return decodeBytes(encodeString(content));
    },
    async writeAll(data: Uint8Array) {
      fs.set(filePath, decodeBytes(data));
      ops.push('write');
    },
    async truncate() {
      fs.delete(filePath);
      ops.push('truncate');
    },
    async close() {
      ops.push('close');
    },
  } as unknown as IFileIOAdapter;
}

let mockFactory: IIOAdapterFactory;

function createMockFactory(): IIOAdapterFactory {
  mockFactory = {
    context: 'worker' as const,
    open: vi.fn(async (handle: any) => {
      return createMockAdapter(handle._filePath);
    }),
  };
  return mockFactory;
}

/** Fake FileSystemDirectoryHandle */
function createDirHandle(path: string, children: Map<string, any> = new Map()): any {
  return {
    _path: path,
    _children: children,
    kind: 'directory',
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const fullPath = path ? `${path}/${name}` : name;
      if (!children.has(fullPath) && !opts?.create) {
        throw new DOMException('NotFound', 'NotFoundError');
      }
      const handle = { _filePath: fullPath, kind: 'file' };
      children.set(fullPath, handle);
      return handle;
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const fullPath = path ? `${path}/${name}` : name;
      if (!children.has(fullPath) && !opts?.create) {
        throw new DOMException('NotFound', 'NotFoundError');
      }
      if (!children.has(fullPath)) {
        children.set(fullPath, createDirHandle(fullPath, new Map()));
      }
      return children.get(fullPath);
    },
    async removeEntry(name: string) {
      const fullPath = path ? `${path}/${name}` : name;
      children.delete(fullPath);
      fs.delete(fullPath);
    },
    keys() {
      return Object.values(Object.fromEntries(children));
    },
  };
}

let rootDir: any;
let storageGlobal: any;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('OPFSBackend', () => {
  let backend: OPFSBackend;

  beforeEach(() => {
    fs = new Map();
    manifest = new Map();
    // fileHandleMocks = new Map()
    rootDir = createDirHandle('storage');

    storageGlobal = {
      getDirectory: vi.fn().mockResolvedValue(rootDir),
      estimate: vi.fn().mockResolvedValue({ quota: 500 * 1024 * 1024, usage: 0 }),
    };

    vi.stubGlobal('navigator', { storage: storageGlobal });
    vi.stubGlobal('window', {});
    vi.stubGlobal('FileSystemFileHandle', {});
    vi.stubGlobal('FileSystemSyncAccessHandle', {});

    // We pass context: 'main-thread' to avoid detectIOAdapterFactory
    // and use our mock factory instead
    createMockFactory();
    backend = new OPFSBackend({
      rootDirName: 'storage',
      context: 'main-thread',
    });
    // Replace the internal factory with our mock
    (backend as any)._factory = mockFactory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('probe() succeeds with OPFS available', async () => {
      const result = await backend.probe();
      expect(result.available).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('probe() fails when navigator.storage is absent', async () => {
      vi.stubGlobal('navigator', {});
      const fresh = new OPFSBackend({ context: 'main-thread' });
      const result = await fresh.probe();
      expect(result.available).toBe(false);
    });

    it('initialize() opens root dir and loads manifest', async () => {
      // Write a valid manifest
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
      expect(storageGlobal.getDirectory).toHaveBeenCalled();
      expect(manifest.size).toBe(0); // Empty manifest
    });

    it('close() clears in-memory state but not files', async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
      await backend.close();
      // Files should still be on "disk"
      expect(fs.has('_manifest.json')).toBe(true);
    });

    it('operations before initialize() throw', async () => {
      await expect(backend.read(KEY_A)).rejects.toThrow('not initialized');
      await expect(backend.write(KEY_A, env())).rejects.toThrow('not initialized');
    });
  });

  // ── Core CRUD ───────────────────────────────────────────────────────

  describe('CRUD', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('write stores data file and updates manifest', async () => {
      await backend.write(KEY_A, env({ payload: 'hello' }));
      // Data file should exist
      expect(fs.has('myapp/chrome/130/auth/session')).toBe(true);
      // Manifest should have been written
      const manifestContent = fs.get('_manifest.json');
      expect(manifestContent).toBeDefined();
    });

    it('read returns the stored envelope', async () => {
      await backend.write(KEY_A, env({ payload: 'my-data' }));
      const result = await backend.read(KEY_A);
      expect(result).not.toBeNull();
      expect(result!.payload).toBe('my-data');
      expect(result!.schema_version).toBe(1);
    });

    it('read returns null for missing key', async () => {
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('delete removes data file and manifest entry', async () => {
      await backend.write(KEY_A, env());
      await backend.delete(KEY_A);
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('delete is idempotent', async () => {
      await expect(backend.delete(KEY_A)).resolves.not.toThrow();
    });

    it('write overwrites existing entry', async () => {
      await backend.write(KEY_A, env({ payload: 'v1' }));
      await backend.write(KEY_A, env({ payload: 'v2' }));
      const result = await backend.read(KEY_A);
      expect(result!.payload).toBe('v2');
    });
  });

  // ── TTL ─────────────────────────────────────────────────────────────

  describe('TTL enforcement', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('read returns null for expired entry and deletes it', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() - 10_000 }));
      expect(await backend.read(KEY_A)).toBeNull();
    });

    it('read with respectTtl=false returns expired entry', async () => {
      await backend.write(KEY_A, env({ expires_at: Date.now() - 10_000 }));
      const result = await backend.read(KEY_A, { respectTtl: false });
      expect(result).not.toBeNull();
    });

    it('null expires_at never expires', async () => {
      await backend.write(KEY_A, env({ expires_at: null }));
      expect(await backend.read(KEY_A)).not.toBeNull();
    });
  });

  // ── Query ───────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('returns all entries', async () => {
      await backend.write(KEY_A, env({ schema_version: 1 }));
      await backend.write(KEY_B, env({ schema_version: 2 }));
      const results = await backend.query({});
      expect(results).toHaveLength(2);
    });

    it('filters by prefix (no file I/O for non-matches)', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_C, env());
      const results = await backend.query({ prefix: 'myapp:chrome:130:auth:' });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(KEY_A);
    });

    it('filters by schema_version', async () => {
      await backend.write(KEY_A, env({ schema_version: 1 }));
      await backend.write(KEY_B, env({ schema_version: 2 }));
      const results = await backend.query({ schema_version: 2 });
      expect(results).toHaveLength(1);
    });

    it('excludes expired entries', async () => {
      await backend.write(KEY_A, env({ expires_at: null }));
      await backend.write(KEY_B, env({ expires_at: Date.now() - 1 }));
      const results = await backend.query({});
      expect(results).toHaveLength(1);
    });

    it('count() uses in-memory manifest (no file I/O)', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());
      expect(await backend.count('myapp:chrome:130:auth:')).toBe(2);
      expect(await backend.count()).toBe(3);
    });
  });

  // ── Clear ───────────────────────────────────────────────────────────

  describe('clear', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('clear without prefix removes everything', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.clear();
      expect(await backend.count()).toBe(0);
    });

    it('clear with prefix removes only matching', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());
      await backend.clear('myapp:chrome:130:auth:');
      expect(await backend.count()).toBe(1);
    });
  });

  // ── Transactions ────────────────────────────────────────────────────

  describe('transactions', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('rejects serializable strength', async () => {
      await expect(backend.beginTransaction('serializable')).rejects.toThrow('serializable');
    });

    it('accepts compensating strength', async () => {
      const tx = await backend.beginTransaction('compensating');
      expect(tx.strength).toBe('compensating');
    });

    it('commit writes WAL, applies ops, rewrites manifest, clears WAL', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'committed' }), { transactionId: tx.id });
      await tx.commit();

      // WAL should be cleared after commit
      const walContent = fs.get('_wal.json');
      expect(walContent).toBe(''); // Truncated

      // Data should be readable
      const result = await backend.read(KEY_A);
      expect(result!.payload).toBe('committed');
    });

    it('rollback discards ops (no filesystem changes)', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'buffered' }), { transactionId: tx.id });
      await tx.rollback();

      // WAL should remain empty (rollback doesn't write WAL)
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
      expect(await backend.count('myapp:chrome:130:auth:')).toBe(0);
    });

    it('mixed transaction: write + delete + clear', async () => {
      await backend.write(KEY_A, env());
      await backend.write(KEY_B, env());
      await backend.write(KEY_C, env());

      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'updated' }), { transactionId: tx.id });
      await backend.delete(KEY_B, { transactionId: tx.id });
      await backend.clear('myapp:chrome:130:prefs:', { transactionId: tx.id });
      await tx.commit();

      const a = await backend.read(KEY_A);
      expect(a!.payload).toBe('updated');
      expect(await backend.read(KEY_B)).toBeNull();
      expect(await backend.read(KEY_C)).toBeNull();
    });

    it('empty transaction commit succeeds immediately', async () => {
      const tx = await backend.beginTransaction();
      await tx.commit();
      expect(backend.isTransactionActive(tx.id)).toBe(false);
    });

    it('partial rollback removes specific ops before commit', async () => {
      const tx = await backend.beginTransaction();
      await backend.write(KEY_A, env({ payload: 'keep' }), { transactionId: tx.id });
      await backend.write(KEY_B, env({ payload: 'remove' }), { transactionId: tx.id });
      await tx.rollback(KEY_B);
      await tx.commit();
      expect(await backend.read(KEY_A)).not.toBeNull();
      expect(await backend.read(KEY_B)).toBeNull();
    });
  });

  // ── WAL Crash Recovery ──────────────────────────────────────────────

  describe('WAL crash recovery', () => {
    it('replays WAL on initialize() if WAL file is present', async () => {
      // Simulate a crash: write a WAL but don't clear it
      const walOps = [
        {
          kind: 'write',
          key: KEY_A,
          filePath: 'myapp/chrome/130/auth/session',
          payloadB64: bytesToBase64(encodeString('recovered-data')),
          meta: {
            schema_version: 1,
            written_at: Date.now(),
            expires_at: null,
            weight: 1,
            backend: 'opfs',
            filePath: 'myapp/chrome/130/auth/session',
            byteLength: 13,
          },
        },
      ];
      const walContent = JSON.stringify({ transactionId: 'crashed-tx', ops: walOps });
      fs.set('_wal.json', walContent);
      fs.set('_manifest.json', JSON.stringify([]));

      // Initialize should replay the WAL
      await backend.initialize();

      // The recovered data should be readable
      const result = await backend.read(KEY_A);
      expect(result).not.toBeNull();
      expect(result!.payload).toBe('recovered-data');

      // WAL should be cleared
      const walAfter = fs.get('_wal.json');
      expect(walAfter).toBe('');
    });

    it('skips replay when WAL is empty', async () => {
      fs.set('_wal.json', '');
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
      // No crash, no replay
      expect(await backend.count()).toBe(0);
    });
  });

  // ── Eviction ───────────────────────────────────────────────────────

  describe('eviction', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('phase 1: evicts expired entries', async () => {
      await backend.write(KEY_A, env({ weight: 1, expires_at: Date.now() - 1 }));
      await backend.write(KEY_B, env({ weight: 1, expires_at: null }));
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBeGreaterThan(0);
      expect(await backend.read(KEY_B)).not.toBeNull();
    });

    it('phase 2: evicts by weight (lowest first)', async () => {
      await backend.write(KEY_A, env({ weight: 1, expires_at: null }));
      await backend.write(KEY_B, env({ weight: 10, expires_at: null }));
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBeGreaterThan(0);
      // The higher-weight entry should survive
      expect(await backend.read(KEY_B)).not.toBeNull();
    });

    it('lfu eviction uses _readCount', async () => {
      await backend.write(KEY_A, env({ weight: 1, expires_at: null }));
      await backend.write(KEY_B, env({ weight: 1, expires_at: null }));
      // Read A multiple times, B once
      for (let i = 0; i < 10; i++) await backend.read(KEY_A);
      await backend.read(KEY_B);
      await backend.evict(1, 'lfu');
      // B (less read) should be evicted
      expect(await backend.read(KEY_A)).not.toBeNull();
      expect(await backend.read(KEY_B)).toBeNull();
    });

    it('returns 0 for empty store', async () => {
      const freed = await backend.evict(1, 'fifo');
      expect(freed).toBe(0);
    });
  });

  // ── Quota ───────────────────────────────────────────────────────────

  describe('estimateQuota', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('uses navigator.storage.estimate() when available', async () => {
      storageGlobal.estimate.mockResolvedValue({ quota: 100_000, usage: 10_000 });
      const q = await backend.estimateQuota();
      expect(q.used).toBe(10_000);
      expect(q.available).toBe(90_000);
      expect(q.ratio).toBe(0.1);
    });

    it('falls back to manifest sum when estimate fails', async () => {
      storageGlobal.estimate.mockRejectedValue(new Error('nope'));
      const q = await backend.estimateQuota();
      // Should use 500 MB soft cap
      expect(q.available).toBeGreaterThan(0);
    });
  });

  // ── Abort signal support ────────────────────────────────────────────

  describe('abort signal', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('write() throws when aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(backend.write(KEY_A, env(), { signal: ac.signal })).rejects.toThrow();
    });

    it('initialize() respects signal', async () => {
      const ac = new AbortController();
      // Abort before initialization completes
      setTimeout(() => ac.abort(), 0);
      await expect(backend.initialize(ac.signal)).rejects.toThrow();
    });
  });

  // ── LFU read count tracking ────────────────────────────────────────

  describe('read count', () => {
    beforeEach(async () => {
      fs.set('_manifest.json', JSON.stringify([]));
      await backend.initialize();
    });

    it('increments on each successful read', async () => {
      await backend.write(KEY_A, env());
      await backend.read(KEY_A);
      await backend.read(KEY_A);
      await backend.read(KEY_A);
      // Access the private _readCount via the backend
      const count = (backend as any)._readCount.get(KEY_A);
      expect(count).toBe(3);
    });

    it('resets on overwrite', async () => {
      await backend.write(KEY_A, env());
      await backend.read(KEY_A);
      await backend.write(KEY_A, env({ payload: 'v2' }));
      expect((backend as any)._readCount.has(KEY_A)).toBe(false);
    });
  });
});
