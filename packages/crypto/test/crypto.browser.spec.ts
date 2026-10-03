/**
 * Crypto in real browsers: the processor runs in a shared worker, and the
 * keys it persists in IndexedDB are the same keys on the main thread.
 */
import { createTestPlatform } from '@platform/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { CRYPTO_ID, createCrypto, type CryptoControl, type CryptoOptions } from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

async function start(options: CryptoOptions) {
  const platform = createTestPlatform([createCrypto(options)]);
  platforms.push(platform);
  await platform.start();
  return platform.unit<CryptoControl>(CRYPTO_ID).control!;
}

describe('Crypto in the browser', () => {
  it('runs in a worker and shares its persisted keys with the main thread', async () => {
    const database = `crypto-test-${crypto.randomUUID()}`;
    const worker = await start({ database });
    // WebKit cannot store a CryptoKey in IndexedDB from a shared worker
    // ("The object can not be cloned"): setup refuses it and Crypto runs in a dedicated worker.
    const expected =
      navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome')
        ? 'dedicated'
        : 'shared';
    expect(worker.views.state.getSnapshot()).toMatchObject({ host: expected, persistent: true });
    const token = await worker.commands.encrypt('from the worker');

    const main = await start({ database, hosts: ['virtual'] });
    expect(main.views.state.getSnapshot().host).toBe('virtual');
    await expect(main.commands.decrypt(token)).resolves.toBe('from the worker');
    expect(main.views.state.getSnapshot().active).toEqual(worker.views.state.getSnapshot().active);
  });

  it('falls back to a dedicated worker, then signs and verifies there', async () => {
    const crypto = await start({
      database: `crypto-test-${globalThis.crypto.randomUUID()}`,
      hosts: ['dedicated', 'virtual'],
    });
    expect(crypto.views.state.getSnapshot().host).toBe('dedicated');
    const signature = await crypto.commands.sign('order 42');
    await expect(crypto.commands.verify('order 42', signature)).resolves.toBe(true);
  });
});
