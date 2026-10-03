# Examples: `@platform/crypto`

Crypto owns the keys of the platform. It encrypts, tags, signs and hashes with non-extractable keys that persist in IndexedDB. In an app, keep the default hosts, so the work runs in a shared worker. These examples use the main thread (`hosts: ['virtual']`) and keep the keys in memory (`indexedDB: null`), so they run in every sandbox.

## Encrypt a value before you store it

<!-- example id="crypto/encrypt-a-value" runtime="any" -->

A notes app encrypts a note before it leaves the main thread. The token names its key, and each call uses a new random IV, so the same text gives a different token each time.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([createCrypto({ hosts: ['virtual'], indexedDB: null })]);
await kernel.start();
const { commands } = kernel.unit<CryptoControl>(CRYPTO_ID).control!;

const note = 'Door code: 4512';
const first = await commands.encrypt(note);
const second = await commands.encrypt(note);

console.log('token format:', first.split('.').length === 4 && first.startsWith('v1.'));
console.log('same text, different tokens:', first !== second);
console.log('decrypted:', await commands.decrypt(first));
await kernel.stop();
```

```text output
token format: true
same text, different tokens: true
decrypted: Door code: 4512
```

## Sign a request for your server

<!-- example id="crypto/sign-a-request" runtime="any" -->

The device sends its public key to the server one time. After that, it signs each sensitive request, and the server checks the signature with the public key.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([createCrypto({ hosts: ['virtual'], indexedDB: null })]);
await kernel.start();
const { commands } = kernel.unit<CryptoControl>(CRYPTO_ID).control!;

const publicKey = await commands.publicKey(); // POST it to /api/devices
console.log('public key:', publicKey.kty, publicKey.crv, 'private part sent:', 'd' in publicKey);

const body = JSON.stringify({ transfer: 250, to: 'savings' });
const signature = await commands.sign(body);
console.log('valid:', await commands.verify(body, signature));
console.log('changed body valid:', await commands.verify(body.replace('250', '2500'), signature));
await kernel.stop();
```

```text output
public key: EC P-256 private part sent: false
valid: true
changed body valid: false
```

## Rotate the encryption key

<!-- example id="crypto/rotate-keys" runtime="any" -->

A security policy asks for a new key every quarter. After `rotate`, new tokens use the new key, and tokens from before still decrypt.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([createCrypto({ hosts: ['virtual'], indexedDB: null })]);
await kernel.start();
const { commands, views } = kernel.unit<CryptoControl>(CRYPTO_ID).control!;

const old = await commands.encrypt('Q3 report');
const newKeyId = await commands.rotate('encrypt');
const fresh = await commands.encrypt('Q4 report');

console.log('new token uses the new key:', fresh.split('.')[1] === newKeyId);
console.log('old token still decrypts:', await commands.decrypt(old));
console.log('keys kept:', views.state.getSnapshot().keys);
await kernel.stop();
```

```text output
new token uses the new key: true
old token still decrypts: Q3 report
keys kept: 4
```

## Use keys from your server

<!-- example id="crypto/injected-keys" runtime="any" -->

Two devices of one user must read the same encrypted data, so the server gives the key material. Here two kernels stand in for two devices that got the same material.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, createCrypto, toBase64Url, type CryptoControl } from '@platform/crypto';

// In an app, this comes from your server. It must be 32 random bytes.
const encrypt = toBase64Url(new Uint8Array(32).fill(42));

async function device() {
  const kernel = new Kernel([
    createCrypto({ hosts: ['virtual'], indexedDB: null, keys: { kind: 'material', encrypt } }),
  ]);
  await kernel.start();
  return { kernel, crypto: kernel.unit<CryptoControl>(CRYPTO_ID).control! };
}

const laptop = await device();
const phone = await device();
const token = await laptop.crypto.commands.encrypt('Shopping list: eggs, tea');
console.log('phone reads:', await phone.crypto.commands.decrypt(token));
console.log('same key id:', laptop.crypto.views.state.getSnapshot().active?.encrypt === phone.crypto.views.state.getSnapshot().active?.encrypt);
await laptop.kernel.stop();
await phone.kernel.stop();
```

```text output
phone reads: Shopping list: eggs, tea
same key id: true
```

## Erase data by forgetting the keys

<!-- example id="crypto/forget-keys" runtime="any" -->

When a user closes the account, `forget` deletes the keys and makes new ones. Every value that the old keys encrypted becomes unreadable at once, even copies in caches and backups (crypto-shredding).

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, UnknownKeyError, createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([createCrypto({ hosts: ['virtual'], indexedDB: null })]);
await kernel.start();
const { commands } = kernel.unit<CryptoControl>(CRYPTO_ID).control!;

const token = await commands.encrypt('Medical history');
await commands.forget();

try {
  await commands.decrypt(token);
} catch (error) {
  console.log('old data readable:', !(error instanceof UnknownKeyError));
}
const fresh = await commands.encrypt('New account');
console.log('new keys work:', await commands.decrypt(fresh));
await kernel.stop();
```

```text output
old data readable: false
new keys work: New account
```

## Hash a value

<!-- example id="crypto/hash" runtime="any" -->

A cache keys large queries by their digest, so the cache key has a fixed length.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([createCrypto({ hosts: ['virtual'], indexedDB: null })]);
await kernel.start();
const { commands } = kernel.unit<CryptoControl>(CRYPTO_ID).control!;

const query = JSON.stringify({ table: 'orders', where: { status: 'open' }, order: 'date' });
const key = await commands.hash(query);
console.log('cache key:', key.slice(0, 16), `(${key.length} hex digits)`);
console.log('sha-256 of "abc":', await commands.hash('abc'));
await kernel.stop();
```

```text output
cache key: d683e82e449817fa (64 hex digits)
sha-256 of "abc": ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
```
