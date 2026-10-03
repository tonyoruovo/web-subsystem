/**
 * @fileoverview
 * @module @platform/crypto
 * @summary The public API of `@platform/crypto`.
 * @description
 * Re-exports the Crypto subsystem ({@linkcode createCrypto}), its processor
 * module, its key store, and the encodings it uses (docs/ARCHITECTURE.md §18.1).
 *
 * ```text
 *   @platform/crypto
 *   +-- createCrypto            the subsystem: id 'crypto', featurized, Tab scope
 *   +-- createCryptoProcessor   the processor module (shared worker, dedicated worker, main thread)
 *   +-- KeyStore                non-extractable keys, persisted in IndexedDB
 *   +-- KeySource, KeyMaterial  device keys, injected keys, fetched keys
 *   +-- cipher functions        encryptText, decryptText, hmacText, verifyHmacText (Storage uses them)
 *   +-- encodings               utf8, base64url, hex
 *   @platform/crypto/worker     the worker entry that serves the processor
 *   ```
 *
 * @example
 * Registering Crypto with Storage
 * ```ts
 * import { createCrypto } from '@platform/crypto';
 * import { createStorage } from '@platform/storage';
 *
 * const kernel = new Kernel([...centralized, createCrypto(), createStorage({ domain: 'shop' })], { router: queue.router });
 * ```
 *
 * @example
 * Using it from another subsystem
 * ```ts
 * import type { CryptoControl } from '@platform/crypto';
 *
 * const token = await ctx.dependency<CryptoControl>('crypto')?.commands.encrypt(secret);
 * ```
 *
 * @author MathAid
 */

export * from './cipher';
export * from './crypto';
export * from './encoding';
export * from './keys';
export * from './processor';
