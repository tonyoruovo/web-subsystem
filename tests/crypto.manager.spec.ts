import { describe, expect, it } from 'vitest';

import { CryptoManager } from '../src';

const subtle = globalThis.crypto.subtle;
const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

function makeManager(): CryptoManager {
  return new CryptoManager({ subtle, randomBytes });
}

describe('CryptoManager', () => {
  it('becomes ready after initialize and assigns keys', async () => {
    const cm = makeManager();
    expect(cm.isReady()).toBe(false);

    await cm.initialize();

    expect(cm.isReady()).toBe(true);
    expect(cm.getActiveKeyId('encrypt')).toBeTruthy();
    expect(cm.getActiveKeyId('hmac')).toBeTruthy();
  });

  it('encrypts and decrypts a roundtrip', async () => {
    const cm = makeManager();
    await cm.initialize();

    const blob = await cm.encrypt('hello world');
    const plain = await cm.decrypt(blob);

    expect(plain).toBe('hello world');
  });

  it('produces a different ciphertext for the same input each time', async () => {
    const cm = makeManager();
    await cm.initialize();

    const a = await cm.encrypt('same');
    const b = await cm.encrypt('same');

    expect(new Uint8Array(a.ciphertext)).not.toEqual(new Uint8Array(b.ciphertext));
  });

  it('signs and verifies an HMAC', async () => {
    const cm = makeManager();
    await cm.initialize();

    const tag = await cm.hmac('data');
    expect(await cm.verifyHmac(tag, 'data')).toBe(true);
    expect(await cm.verifyHmac(tag, 'other')).toBe(false);
  });

  it('hashes with SHA-256', async () => {
    const cm = makeManager();

    const digest = await cm.hash('hello');

    expect(digest.byteLength).toBe(32);
  });

  it('throws on decrypt with an unknown key', async () => {
    const cm = makeManager();
    await cm.initialize();

    await expect(
      cm.decrypt({ keyId: 'missing', iv: new ArrayBuffer(12), ciphertext: new ArrayBuffer(0) }),
    ).rejects.toThrow();
  });

  it('zeroizes keys and refuses further use', async () => {
    const cm = makeManager();
    await cm.initialize();
    cm.zeroize();

    expect(cm.isReady()).toBe(false);
    expect(cm.getActiveKeyId('encrypt')).toBeNull();
    await expect(cm.encrypt('x')).rejects.toThrow();
  });
});
