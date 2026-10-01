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
import { StorageFacade } from '../src';

interface TxOp {
  kind: 'write' | 'delete';
  key: CanonicalKey;
  envelope?: StorageEnvelope<string>;
}

class TxBackend implements IStorageBackend<string> {
  readonly kind: BackendKind = 'memory';
  readonly transactionStrength: TransactionStrength = 'best-effort';
  private readonly map = new Map<CanonicalKey, StorageEnvelope<string>>();
  private readonly txs = new Map<string, TxOp[]>();
  private counter = 0;

  async probe(): Promise<CapabilityResult> {
    return { available: true };
  }
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async write(
    key: CanonicalKey,
    envelope: StorageEnvelope<string>,
    options?: { transactionId?: string },
  ): Promise<void> {
    if (options?.transactionId) {
      this.txs.get(options.transactionId)!.push({ kind: 'write', key, envelope });
      return;
    }
    this.map.set(key, envelope);
  }
  async read(key: CanonicalKey): Promise<StorageEnvelope<string> | null> {
    return this.map.get(key) ?? null;
  }
  async delete(key: CanonicalKey, options?: { transactionId?: string }): Promise<void> {
    if (options?.transactionId) {
      this.txs.get(options.transactionId)!.push({ kind: 'delete', key });
      return;
    }
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
    const id = `tx-${++this.counter}`;
    this.txs.set(id, []);
    return {
      id,
      strength: 'best-effort' as TransactionStrength,
      operations: [],
      commit: async () => {
        for (const op of this.txs.get(id) ?? []) {
          if (op.kind === 'write') this.map.set(op.key, op.envelope!);
          else this.map.delete(op.key);
        }
        this.txs.delete(id);
      },
      rollback: async () => {
        this.txs.delete(id);
      },
    } as unknown as ITransaction;
  }
  isTransactionActive(): boolean {
    return this.txs.size > 0;
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

describe('StorageFacade.transaction', () => {
  it('commits buffered writes atomically', async () => {
    const backend = new TxBackend();
    const facade = new StorageFacade({ backend, config });

    await facade.transaction(async (tx) => {
      await tx.set('a', { n: 1 }, schema);
      await tx.set('b', { n: 2 }, schema);
    });

    expect(await facade.get('a', schema)).toEqual({ n: 1 });
    expect(await facade.get('b', schema)).toEqual({ n: 2 });
  });

  it('rolls back when the block throws', async () => {
    const backend = new TxBackend();
    const facade = new StorageFacade({ backend, config });

    await expect(
      facade.transaction(async (tx) => {
        await tx.set('a', { n: 1 }, schema);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await facade.get('a', schema)).toBeNull();
  });

  it('deletes inside a transaction on commit', async () => {
    const backend = new TxBackend();
    const facade = new StorageFacade({ backend, config });
    await facade.set('a', { n: 1 }, schema);

    await facade.transaction(async (tx) => {
      await tx.delete('a');
    });

    expect(await facade.get('a', schema)).toBeNull();
  });

  it('interleaves concurrent transactions without corruption', async () => {
    const backend = new TxBackend();
    const facade = new StorageFacade({ backend, config });

    await Promise.all([
      facade.transaction(async (tx) => {
        await tx.set('a', { n: 1 }, schema);
      }),
      facade.transaction(async (tx) => {
        await tx.set('b', { n: 2 }, schema);
      }),
      facade.transaction(async (tx) => {
        await tx.set('c', { n: 3 }, schema);
      }),
    ]);

    expect(await facade.get('a', schema)).toEqual({ n: 1 });
    expect(await facade.get('b', schema)).toEqual({ n: 2 });
    expect(await facade.get('c', schema)).toEqual({ n: 3 });
  });
});
