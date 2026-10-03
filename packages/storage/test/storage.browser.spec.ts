/**
 * Storage in real browsers: the coordinator runs in a shared worker over
 * IndexedDB, the main thread reads the same data, and a coordinator that dies
 * during a write fails over to the main thread without data loss (the M6 gate).
 */
import type { ProcessorDef, SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { STORAGE_ID, createStorage, type StorageControl, type StorageOptions } from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

async function start(definition: SubsystemDefinition) {
  const platform = createTestPlatform([definition]);
  platforms.push(platform);
  await platform.start();
  return platform.unit<StorageControl>(STORAGE_ID).control!;
}

const unique = () => `storage-test-${crypto.randomUUID()}`;
const options = (database: string): StorageOptions => ({
  domain: 'shop',
  database,
  keys: { source: { kind: 'device' }, database: `${database}-keys` },
  quota: false,
});

describe('Storage in the browser', () => {
  it('runs the coordinator in a shared worker, and the main thread reads the same data', async () => {
    const database = unique();
    const worker = await start(createStorage(options(database)) as SubsystemDefinition);
    const state = worker.views.state.getSnapshot();
    // WebKit cannot store a CryptoKey from a shared worker, so setup refuses it there.
    const webkit =
      navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome');
    expect(state).toMatchObject({
      host: webkit ? 'virtual' : 'shared',
      backend: 'indexeddb',
      persistent: true,
    });

    const vault = worker.commands.collection<string>({
      name: 'vault',
      encrypt: true,
      compress: true,
    });
    await vault.set('pin', '4512');
    expect(await vault.get('pin')).toBe('4512');

    const main = await start(
      createStorage({ ...options(database), hosts: ['virtual'] }) as SubsystemDefinition,
    );
    expect(
      await main.commands.collection<string>({ name: 'vault', encrypt: true }).get('pin'),
    ).toBe('4512');
  });

  it('fails over without data loss when the shared worker dies during a write', async () => {
    const database = unique();
    const definition = createStorage(options(database)) as SubsystemDefinition;
    const coordinator = definition.processors![0] as ProcessorDef;
    const dying: SubsystemDefinition = {
      ...definition,
      processors: [
        {
          ...coordinator,
          // The test worker closes itself when it receives the write of "die".
          shared: () =>
            new SharedWorker(new URL('./browser/dying.worker.ts', import.meta.url), {
              type: 'module',
              name: database,
            }),
          heartbeat: { shared: { intervalMs: 50, timeoutMs: 300 } },
        },
      ],
    };
    const storage = await start(dying);
    const webkit =
      navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome');
    if (webkit) return; // The coordinator already runs on the main thread there (see above).
    expect(storage.views.state.getSnapshot().host).toBe('shared');

    const orders = storage.commands.collection<number>({ name: 'orders' });
    await orders.set('a', 1);
    await orders.set('b', 2);
    await orders.set('die', 3); // the worker dies; the runner runs the write again on the main thread

    await expect.poll(() => storage.views.state.getSnapshot().host).toBe('virtual');
    expect(await orders.entries()).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'die', value: 3 },
    ]);
  });
});
