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
import { cryptoCodec, CryptoManager, StorageFacade } from '../src';

const subtle = globalThis.crypto.subtle;
const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

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
    if (!prefix) this.map.clear();
    else for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
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

const schema = { shape: z.object({ n: z.number() }), version: 1 };

describe('cryptoCodec + StorageFacade', () => {
  it('round-trips through the facade with encryption and integrity', async () => {
    const cm = new CryptoManager({ subtle, randomBytes });
    await cm.initialize();

    const backend = new FakeBackend();
    const facade = new StorageFacade({ backend, config, secure: true, codec: cryptoCodec(cm) });

    await facade.set('count', { n: 7 }, schema);

    const envelope = await backend.read(facade.resolveKey('count'));
    expect(envelope?.integrity).toBeTruthy();
    expect(envelope?.payload).not.toContain('"n":7'); // encrypted

    const value = await facade.get('count', schema);
    expect(value).toEqual({ n: 7 });
  });

  it('detects a tampered envelope and returns null', async () => {
    const cm = new CryptoManager({ subtle, randomBytes });
    await cm.initialize();

    const backend = new FakeBackend();
    const facade = new StorageFacade({ backend, config, secure: true, codec: cryptoCodec(cm) });

    await facade.set('count', { n: 7 }, schema);

    const key = facade.resolveKey('count');
    const envelope = await backend.read(key);
    envelope!.payload = 'TAMPERED';
    await backend.write(key, envelope!);

    const value = await facade.get('count', schema);
    expect(value).toBeNull();
  });

  it('produces different ciphertext and integrity per write', async () => {
    const cm = new CryptoManager({ subtle, randomBytes });
    await cm.initialize();

    const backend = new FakeBackend();
    const facade = new StorageFacade({ backend, config, secure: true, codec: cryptoCodec(cm) });

    await facade.set('a', { n: 1 }, schema);
    await facade.set('b', { n: 1 }, schema);

    const a = await backend.read(facade.resolveKey('a'));
    const b = await backend.read(facade.resolveKey('b'));
    expect(a?.payload).not.toBe(b?.payload);
    expect(a?.integrity).not.toBe(b?.integrity);
  });
});
