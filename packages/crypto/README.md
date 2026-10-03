# @platform/crypto

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Crypto** subsystem (id `crypto`, featurized, Tab scope, no required dependency). It owns the keys of the platform and the operations that use them:

- **Encryption**: AES-GCM 256. Each token names its key, so it still decrypts after a rotation.
- **Integrity**: HMAC-SHA-256 tags, checked in constant time.
- **Signatures**: ECDSA P-256, with a public key that you can send to a server.
- **Digests**: SHA-256, SHA-384 and SHA-512.

The keys are **non-extractable** `CryptoKey` objects: the platform can use them but cannot read their bytes. They **persist in IndexedDB**, so every tab, every worker and every session of the origin uses the same keys. The work runs in a **shared worker**, then a dedicated worker, then the main thread (failover). Design: [ARCHITECTURE §18.1](../../docs/ARCHITECTURE.md#181-crypto) and the amended [Crypto proposal](../../proposals/crypto_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/crypto": "workspace:*"
  }
}
```

The package starts its worker with `new SharedWorker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })`. Vite, webpack 5 and Rollup find the worker file from this expression. No configuration is necessary.

## Entry points

| Import                    | Contents                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `@platform/crypto`        | `createCrypto`, `createCryptoProcessor`, `KeyStore`, the key source types, encodings, errors |
| `@platform/crypto/worker` | The worker entry. It serves the Crypto processor. You do not import it yourself.             |

## Usage

```ts
import { createCrypto, type CryptoControl } from '@platform/crypto';

const kernel = new Kernel([...centralized, createCrypto()], { router: queue.router });
await kernel.start();

const { commands } = kernel.unit<CryptoControl>('crypto').control!;
const token = await commands.encrypt('card ending 4242'); // 'v1.<keyId>.<iv>.<ciphertext>'
await commands.decrypt(token); // 'card ending 4242'

const tag = await commands.hmac(payload);
await commands.verifyHmac(payload, tag); // true

const signature = await commands.sign(body);
const jwk = await commands.publicKey(); // send it to the server once
```

From another subsystem, declare `{ target: 'crypto' }` in `requires` and use `ctx.dependency<CryptoControl>('crypto')`.

### Key sources

| Source                                                   | Use it when                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `{ kind: 'device' }` (default)                           | The data belongs to this browser. Crypto makes the keys on first use.      |
| `{ kind: 'material', encrypt, hmac?, previousEncrypt? }` | The server gives the keys, for example in the page config. Base64 text.    |
| `{ kind: 'fetch', url, headers? }`                       | Crypto gets the material from your endpoint at boot, with a plain `fetch`. |

Signing keys are always device keys.

## Behaviour

| Situation                                          | Result                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `rotate(purpose)`                                  | A new active key. Old keys still decrypt and verify. `crypto:keys-changed` is broadcast.              |
| `forget()`                                         | Every key is deleted and new keys are made. Data that the old keys encrypted can never be read again. |
| A token was changed                                | `decrypt` rejects                                                                                     |
| A token names a key that is not known              | `decrypt` rejects with `UnknownKeyError`                                                              |
| No IndexedDB                                       | Keys stay in memory. `state.persistent` is `false`: encrypted data does not survive a reload.         |
| No `SharedWorker` (Chrome for Android)             | Crypto runs in a dedicated worker                                                                     |
| WebKit: a shared worker cannot store a `CryptoKey` | Setup fails there, and Crypto runs in a dedicated worker. The keys are still shared.                  |
| Bad key material, or the key fetch fails           | The subsystem is `FAILED`                                                                             |
| The subsystem stops                                | The keys are removed from memory. The persisted keys stay.                                            |

## Options

| Option      | Default                              | Purpose                                                      |
| ----------- | ------------------------------------ | ------------------------------------------------------------ |
| `keys`      | `{ kind: 'device' }`                 | Where the encryption and HMAC keys come from.                |
| `hosts`     | `['shared', 'dedicated', 'virtual']` | The hosts to try, in order.                                  |
| `database`  | `__platform_crypto`                  | The IndexedDB database that keeps the keys.                  |
| `indexedDB` | the global `indexedDB`               | The factory on the main thread. `null` keeps keys in memory. |

## Testing

```bash
pnpm exec vitest run --project node packages/crypto
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/crypto
```
