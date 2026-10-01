import { describe, expect, it } from 'vitest';

import type {
  BackendKind,
  CanonicalKey,
  CapabilityResult,
  IStorageBackend,
  ITransaction,
  QuotaEstimate,
  StorageEnvelope,
  StorageQuery,
  TransactionStrength,
} from '../src';
import { StrategyRegistry } from '../src';

function makeBackend(kind: BackendKind, available: boolean): IStorageBackend<string> {
  return {
    kind,
    transactionStrength: 'best-effort' as TransactionStrength,
    async probe(): Promise<CapabilityResult> {
      return available ? { available: true } : { available: false, reason: `${kind} unavailable` };
    },
    async initialize(): Promise<void> {},
    async close(): Promise<void> {},
    async write(_key: CanonicalKey, _envelope: StorageEnvelope<string>): Promise<void> {},
    async read(_key: CanonicalKey): Promise<StorageEnvelope<string> | null> {
      return null;
    },
    async delete(_key: CanonicalKey): Promise<void> {},
    async clear(_prefix?: string): Promise<void> {},
    async query(
      _q: StorageQuery,
    ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<string> }>> {
      return [];
    },
    async count(): Promise<number> {
      return 0;
    },
    async beginTransaction(): Promise<ITransaction> {
      throw new Error('not supported');
    },
    isTransactionActive(): boolean {
      return false;
    },
    async estimateQuota(): Promise<QuotaEstimate> {
      return { used: 0, available: 0, ratio: 0 };
    },
    async evict(): Promise<number> {
      return 0;
    },
  };
}

describe('StrategyRegistry', () => {
  it('resolves the first available backend in priority order', async () => {
    const idb = makeBackend('indexeddb', true);
    const opfs = makeBackend('opfs', true);
    const registry = new StrategyRegistry([
      { backend: idb, priority: 0 },
      { backend: opfs, priority: 1 },
    ]);

    expect(await registry.resolve()).toBe(idb);
  });

  it('skips unavailable backends', async () => {
    const idb = makeBackend('indexeddb', false);
    const opfs = makeBackend('opfs', true);
    const registry = new StrategyRegistry([
      { backend: idb, priority: 0 },
      { backend: opfs, priority: 1 },
    ]);

    expect(await registry.resolve()).toBe(opfs);
  });

  it('returns null when none are available', async () => {
    const registry = new StrategyRegistry([
      { backend: makeBackend('indexeddb', false), priority: 0 },
      { backend: makeBackend('memory', false), priority: 3 },
    ]);

    expect(await registry.resolve()).toBeNull();
  });

  it('returns all available backends in order', async () => {
    const idb = makeBackend('indexeddb', false);
    const opfs = makeBackend('opfs', true);
    const memory = makeBackend('memory', true);
    const registry = new StrategyRegistry([
      { backend: idb, priority: 0 },
      { backend: opfs, priority: 1 },
      { backend: memory, priority: 3 },
    ]);

    const available = await registry.resolveAll();
    expect(available).toEqual([opfs, memory]);
  });
});
