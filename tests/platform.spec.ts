import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  BackendKind,
  CanonicalKey,
  CapabilityResult,
  IStorageBackend,
  ITransaction,
  PendingToken,
  QuotaEstimate,
  StorageEnvelope,
  StorageFacadeConfig,
  StorageQuery,
  TransactionStrength,
} from '../src';
import { CryptoManager, createPlatform } from '../src';

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
  async clear(): Promise<void> {
    this.map.clear();
  }
  async query(
    _q: StorageQuery,
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
    return [];
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

const storageConfig: StorageFacadeConfig = {
  domain: 'app',
  platform: 'chrome',
  platformVersion: 1,
  callingModule: 'test',
};

function makeToken(id: string, importance: PendingToken['importance']): PendingToken {
  return {
    id,
    subsystemId: 'test',
    importance,
    createdAt: 0,
    estimatedDuration: null,
    category: 'SYNC',
  };
}

const schema = { shape: z.object({ n: z.number() }), version: 1 };

describe('createPlatform', () => {
  it('assembles all managers and reaches IDLE on markReady', async () => {
    const platform = await createPlatform({
      cryptoManager: new CryptoManager({
        subtle: globalThis.crypto.subtle,
        randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      }),
    });

    expect(platform.globalState.getPlatformStatus()).toBe('INITIALIZING');
    platform.markReady();
    expect(platform.globalState.getPlatformStatus()).toBe('IDLE');

    expect(platform.queue).toBeDefined();
    expect(platform.notifications).toBeDefined();
    expect(platform.network).toBeDefined();
    expect(platform.auth).toBeDefined();
    expect(platform.sync).toBeDefined();
    expect(platform.translation).toBeDefined();
    expect(platform.analytics).toBeDefined();
  });

  it('wires the queue admission gate to Global State', async () => {
    const platform = await createPlatform({
      busyThreshold: 0,
      cryptoManager: new CryptoManager({
        subtle: globalThis.crypto.subtle,
        randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      }),
    });
    platform.markReady();

    platform.globalState.registerPendingToken(makeToken('t1', 'HIGH'));
    expect(platform.globalState.getPlatformStatus()).toBe('BUSY');

    const low = platform.queue.enqueue({
      eventId: 'x',
      actionName: 'X',
      payload: {},
      importance: 'LOW',
      metadata: { messageId: 'low', sourceSubsystem: 'a', targetSubsystem: 'b', timestamp: 0 },
      fingerprints: [],
    });
    expect(low).toBeNull();
  });

  it('round-trips storage with encryption when secure', async () => {
    const platform = await createPlatform({
      cryptoManager: new CryptoManager({
        subtle: globalThis.crypto.subtle,
        randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      }),
      storageBackend: new FakeBackend(),
      storageConfig,
      secure: true,
    });
    platform.markReady();

    await platform.storage!.set('count', { n: 7 }, schema);
    const value = await platform.storage!.get('count', schema);

    expect(value).toEqual({ n: 7 });
  });

  it('gates analytics on consent', async () => {
    let granted = false;
    const platform = await createPlatform({
      analyticsConsent: () => granted,
      cryptoManager: new CryptoManager({
        subtle: globalThis.crypto.subtle,
        randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      }),
    });

    platform.analytics.increment('page.view');
    expect(platform.analytics.getMetrics().counters).toEqual({});

    granted = true;
    platform.analytics.increment('page.view');
    expect(platform.analytics.getMetrics().counters).toEqual({ 'page.view': 1 });
  });

  it('disposes by zeroizing crypto', async () => {
    const crypto = new CryptoManager({
      subtle: globalThis.crypto.subtle,
      randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    });
    const platform = await createPlatform({ cryptoManager: crypto });

    expect(platform.crypto.isReady()).toBe(true);
    platform.dispose();
    expect(platform.crypto.isReady()).toBe(false);
  });
});
