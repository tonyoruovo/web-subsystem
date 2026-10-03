import { NO_CONTROL, type SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRYPTO_ID,
  CRYPTO_KEYS_CHANGED,
  KeyStore,
  UnknownKeyError,
  createCrypto,
  fromBase64Url,
  toBase64Url,
  type CryptoControl,
  type CryptoOptions,
  type KeysChanged,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
  vi.unstubAllGlobals();
});

/** One "session": a platform with Crypto on the main thread, and a listener of key changes. */
async function session(options: CryptoOptions) {
  const changes: KeysChanged[] = [];
  const listener: SubsystemDefinition = {
    id: 'listener',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [CRYPTO_KEYS_CHANGED],
    receive: (packet) => void changes.push(packet.take() as KeysChanged),
    control: () => NO_CONTROL,
  };
  const platform = createTestPlatform([createCrypto({ hosts: ['virtual'], ...options }), listener]);
  platforms.push(platform);
  await platform.start();
  return { platform, crypto: platform.unit<CryptoControl>(CRYPTO_ID).control!, changes };
}

const material = toBase64Url(new Uint8Array(32).fill(7));

describe('Crypto', () => {
  it('encrypts with a new IV each time, and decrypts', async () => {
    const { crypto, platform } = await session({ indexedDB: new IDBFactory() });
    const a = await crypto.commands.encrypt('card ending 4242');
    const b = await crypto.commands.encrypt('card ending 4242');
    expect(a).toMatch(/^v1\.[0-9a-f]{16}\.[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
    await expect(crypto.commands.decrypt(a)).resolves.toBe('card ending 4242');
    expect(crypto.views.state.getSnapshot()).toMatchObject({
      host: 'virtual',
      source: 'device',
      persistent: true,
      keys: 3,
    });
    expect(platform.status(CRYPTO_ID)).toBe('READY');
  });

  it('keeps device keys across sessions, so old tokens decrypt after a reload', async () => {
    const factory = new IDBFactory();
    const first = await session({ indexedDB: factory });
    const token = await first.crypto.commands.encrypt('kept');
    const active = first.crypto.views.state.getSnapshot().active;
    await first.platform.stop();

    const second = await session({ indexedDB: factory });
    expect(second.crypto.views.state.getSnapshot().active).toEqual(active);
    await expect(second.crypto.commands.decrypt(token)).resolves.toBe('kept');
  });

  it('rotates keys, keeps the old ones for decryption, and announces the change', async () => {
    const { crypto, changes, platform } = await session({ indexedDB: new IDBFactory() });
    const before = await crypto.commands.encrypt('before');
    const id = await crypto.commands.rotate('encrypt');
    const after = await crypto.commands.encrypt('after');
    expect(after.split('.')[1]).toBe(id);
    expect(before.split('.')[1]).not.toBe(id);
    await expect(crypto.commands.decrypt(before)).resolves.toBe('before');
    expect(crypto.views.state.getSnapshot()).toMatchObject({ keys: 4, active: { encrypt: id } });
    await platform.settle();
    expect(changes).toEqual([{ change: 'rotated', purpose: 'encrypt', keyId: id }]);
  });

  it('tags, signs and hashes, and refuses changed data', async () => {
    const { crypto } = await session({ indexedDB: new IDBFactory() });
    const tag = await crypto.commands.hmac('payload');
    await expect(crypto.commands.verifyHmac('payload', tag)).resolves.toBe(true);
    await expect(crypto.commands.verifyHmac('payload!', tag)).resolves.toBe(false);
    await expect(crypto.commands.verifyHmac('payload', 'unknown.AAAA')).resolves.toBe(false);

    const signature = await crypto.commands.sign('order 42');
    await expect(crypto.commands.verify('order 42', signature)).resolves.toBe(true);
    await expect(crypto.commands.verify('order 43', signature)).resolves.toBe(false);
    const jwk = await crypto.commands.publicKey();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', kid: signature.split('.')[0] });
    expect(jwk).not.toHaveProperty('d'); // no private part

    await expect(crypto.commands.hash('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await expect(crypto.commands.hash('abc', 'SHA-512')).resolves.toHaveLength(128);
  });

  it('refuses tokens that were changed or name an unknown key', async () => {
    const { crypto } = await session({ indexedDB: new IDBFactory() });
    const token = await crypto.commands.encrypt('secret');
    const [v, id, iv, data] = token.split('.');
    const flipped = toBase64Url(fromBase64Url(data).map((byte, i) => (i === 0 ? byte ^ 1 : byte)));
    await expect(crypto.commands.decrypt([v, id, iv, flipped].join('.'))).rejects.toThrow();
    await expect(crypto.commands.decrypt(`v1.0000000000000000.${iv}.${data}`)).rejects.toThrow(
      UnknownKeyError,
    );
    await expect(crypto.commands.decrypt('nonsense')).rejects.toThrow('format');
  });

  it('forgets every key and makes new ones: old data can never be decrypted again', async () => {
    const factory = new IDBFactory();
    const first = await session({ indexedDB: factory });
    const token = await first.crypto.commands.encrypt('to be erased');
    await first.crypto.commands.forget();
    await first.platform.settle();
    expect(first.changes).toEqual([{ change: 'forgotten', purpose: null, keyId: null }]);
    expect(first.crypto.views.state.getSnapshot().keys).toBe(3);
    await expect(first.crypto.commands.decrypt(token)).rejects.toThrow(UnknownKeyError);
    await expect(
      first.crypto.commands.decrypt(await first.crypto.commands.encrypt('x')),
    ).resolves.toBe('x');
    await first.platform.stop();

    const second = await session({ indexedDB: factory });
    await expect(second.crypto.commands.decrypt(token)).rejects.toThrow(UnknownKeyError);
  });

  it('uses injected material with stable key ids, and keeps previous keys for decryption', async () => {
    const one = await session({ keys: { kind: 'material', encrypt: material }, indexedDB: null });
    const token = await one.crypto.commands.encrypt('shared secret');
    expect(one.crypto.views.state.getSnapshot()).toMatchObject({
      source: 'material',
      persistent: false,
    });

    const next = toBase64Url(new Uint8Array(32).fill(9));
    const two = await session({
      keys: { kind: 'material', encrypt: next, previousEncrypt: [material] },
      indexedDB: null,
    });
    await expect(two.crypto.commands.decrypt(token)).resolves.toBe('shared secret');
    expect((await two.crypto.commands.encrypt('x')).split('.')[1]).not.toBe(token.split('.')[1]);
  });

  it('fails to start with bad material, and fetches material from a URL', async () => {
    const bad = createTestPlatform([
      createCrypto({
        hosts: ['virtual'],
        keys: { kind: 'material', encrypt: 'AAAA' },
        indexedDB: null,
      }),
    ]);
    platforms.push(bad);
    await bad.start();
    expect(bad.status(CRYPTO_ID)).toBe('FAILED');

    const fetch = vi.fn(async () => new Response(JSON.stringify({ encrypt: material })));
    vi.stubGlobal('fetch', fetch);
    const fetched = await session({ keys: { kind: 'fetch', url: '/api/keys' }, indexedDB: null });
    expect(fetch).toHaveBeenCalledWith(
      '/api/keys',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    const token = await fetched.crypto.commands.encrypt('from the server');
    expect(fetched.crypto.views.state.getSnapshot().source).toBe('fetch');
    await expect(fetched.crypto.commands.decrypt(token)).resolves.toBe('from the server');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const down = createTestPlatform([
      createCrypto({
        hosts: ['virtual'],
        keys: { kind: 'fetch', url: '/api/keys' },
        indexedDB: null,
      }),
    ]);
    platforms.push(down);
    await down.start();
    expect(down.status(CRYPTO_ID)).toBe('FAILED');
  });

  it('gives two tabs that open at the same time the same device keys', async () => {
    const factory = new IDBFactory();
    const [a, b] = await Promise.all([
      KeyStore.open({ source: { kind: 'device' } }, factory),
      KeyStore.open({ source: { kind: 'device' } }, factory),
    ]);
    expect(a.active('encrypt').id).toBe(b.active('encrypt').id);
    expect(a.active('sign').id).toBe(b.active('sign').id);
    a.clear();
    b.clear();
    expect(() => a.active('encrypt')).toThrow('closed');
  });
});
