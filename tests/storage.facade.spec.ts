import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  BackendKind,
  CanonicalKey,
  CapabilityResult,
  IStorageBackend,
  ITransaction,
  QuotaEstimate,
  StorageEnvelope,
  StorageFacadeConfig,
  StorageQuery,
  TransactionStrength,
} from '../src';
import { StorageFacade, type StorageCodec } from '../src';

class FakeBackend implements IStorageBackend<string> {
  readonly kind: BackendKind = 'memory';
  readonly transactionStrength: TransactionStrength = 'best-effort';
  private readonly map = new Map<CanonicalKey, StorageEnvelope<string>>();

  async probe(): Promise<CapabilityResult> {
    return { available: true };
  }
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async write(key: CanonicalKey, envelope: StorageEnvelope<string>): Promise<void> {
    this.map.set(key, envelope);
  }
  async read(key: CanonicalKey): Promise<StorageEnvelope<string> | null> {
    return this.map.get(key) ?? null;
  }
  async delete(key: CanonicalKey): Promise<void> {
    this.map.delete(key);
  }
  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.map.clear();
      return;
    }
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }
  async query(
    q: StorageQuery,
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
    const out: Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }> = [];
    for (const [key, envelope] of this.map) {
      if (q.prefix && !key.startsWith(q.prefix)) continue;
      out.push({ key, envelope });
    }
    const offset = q.offset ?? 0;
    return out.slice(offset, offset + (q.limit ?? out.length));
  }
  async count(): Promise<number> {
    return this.map.size;
  }
  async beginTransaction(): Promise<ITransaction> {
    throw new Error('not supported');
  }
  isTransactionActive(): boolean {
    return false;
  }
  async estimateQuota(): Promise<QuotaEstimate> {
    return { used: 0, available: 0, ratio: 0 };
  }
  async evict(): Promise<number> {
    return 0;
  }
}

const config: StorageFacadeConfig = {
  domain: 'app',
  platform: 'chrome',
  platformVersion: 1,
  callingModule: 'test',
};

const codec: StorageCodec = {
  encrypt: (s) => Promise.resolve(`ENC:${s}`),
  decrypt: (s) =>
    s.startsWith('ENC:') ? Promise.resolve(s.slice(4)) : Promise.reject(new Error('not encrypted')),
  compress: (s) => Promise.resolve(`Z:${s}`),
  decompress: (s) =>
    s.startsWith('Z:') ? Promise.resolve(s.slice(2)) : Promise.reject(new Error('not compressed')),
};

const numberSchema = { shape: z.object({ n: z.number() }), version: 1 };

describe('StorageFacade', () => {
  it('round-trips a value without security', async () => {
    const facade = new StorageFacade({ backend: new FakeBackend(), config });

    await facade.set('count', { n: 1 }, numberSchema);
    const value = await facade.get('count', numberSchema);

    expect(value).toEqual({ n: 1 });
  });

  it('encrypts and compresses when secure', async () => {
    const backend = new FakeBackend();
    const facade = new StorageFacade({ backend, config, secure: true, codec });

    await facade.set('count', { n: 5 }, numberSchema);

    const envelope = await backend.read(facade.resolveKey('count'));
    expect(envelope?.payload).toMatch(/^ENC:Z:/);

    const value = await facade.get('count', numberSchema);
    expect(value).toEqual({ n: 5 });
  });

  it('returns null for a missing key', async () => {
    const facade = new StorageFacade({ backend: new FakeBackend(), config });
    expect(await facade.get('missing', numberSchema)).toBeNull();
  });

  it('warns and returns null instead of throwing on a decode failure', async () => {
    const backend = new FakeBackend();
    const warnings: string[] = [];
    const writer = new StorageFacade({ backend, config }); // secure false
    await writer.set('count', { n: 1 }, numberSchema);

    const reader = new StorageFacade({
      backend,
      config,
      secure: true,
      codec,
      warn: { warn: (m) => warnings.push(m) },
    });

    await expect(reader.get('count', numberSchema)).resolves.toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('migrates a stale schema on read', async () => {
    const facade = new StorageFacade({ backend: new FakeBackend(), config });
    const v2 = {
      shape: z.object({ n: z.number(), s: z.string() }),
      version: 2,
      migrations: [
        { fromVersion: 1, transform: (old: unknown) => ({ ...(old as object), s: 'default' }) },
      ],
    };

    await facade.set('count', { n: 1 }, numberSchema);
    const value = await facade.get('count', v2);

    expect(value).toEqual({ n: 1, s: 'default' });
  });

  it('builds a canonical key and deletes entries', async () => {
    const backend = new FakeBackend();
    const facade = new StorageFacade({ backend, config });

    const key = facade.resolveKey('count');
    expect(key).toBe('app:chrome:1:test:count');
    expect(facade.parseKey(key)?.actualKey).toBe('count');

    await facade.set('count', { n: 1 }, numberSchema);
    expect(await facade.get('count', numberSchema)).toEqual({ n: 1 });

    await facade.delete('count');
    expect(await facade.get('count', numberSchema)).toBeNull();
  });

  it('queries and decodes results', async () => {
    const facade = new StorageFacade({ backend: new FakeBackend(), config });

    await facade.set('a', { n: 1 }, numberSchema);
    await facade.set('b', { n: 2 }, numberSchema);

    const results = await facade.query({ prefix: 'app:chrome:1:test:' }, numberSchema);
    expect(results.map((r) => r.value)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('handles many concurrent writes without loss', async () => {
    const facade = new StorageFacade({ backend: new FakeBackend(), config });

    await Promise.all(
      Array.from({ length: 100 }, (_, i) => facade.set(`k${i}`, { n: i }, numberSchema)),
    );

    for (let i = 0; i < 100; i++) {
      expect(await facade.get(`k${i}`, numberSchema)).toEqual({ n: i });
    }
  });
});
