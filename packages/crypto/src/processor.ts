/**
 * @fileoverview
 * @summary The Crypto processor: every cryptographic operation, run next to the keys.
 * @description
 * Implements the processor `crypto` of docs/ARCHITECTURE.md §18.1. The same
 * module runs in a shared worker, a dedicated worker or on the main thread.
 * `setup` opens the {@linkcode KeyStore} with the configuration of the
 * processor definition. `handle` runs one {@linkcode CryptoRequest}.
 *
 * ```text
 *   encrypt  text  --> 'v1.<keyId>.<iv>.<ciphertext>'     AES-GCM 256, a new 12-byte IV each time
 *   decrypt  token --> text                                the key named in the token
 *   hmac     text  --> '<keyId>.<tag>'                     HMAC-SHA-256
 *   sign     text  --> '<keyId>.<signature>'               ECDSA P-256 with SHA-256
 *   verify-*  constant-time checks by SubtleCrypto
 *   hash     text  --> hex digest                          SHA-256, SHA-384 or SHA-512
 *   ```
 *
 * @example
 * The worker entry
 * ```ts
 * import { serveProcessor } from '@platform/core/worker';
 * import { createCryptoProcessor } from '@platform/crypto';
 *
 * serveProcessor(createCryptoProcessor());
 * ```
 *
 * @example
 * Calling it directly in a test
 * ```ts
 * const module = createCryptoProcessor({ indexedDB: new IDBFactory() });
 * await module.setup?.(scope, { source: { kind: 'device' } });
 * await module.handle({ op: 'encrypt', data: 'secret' }, scope);
 * ```
 *
 * @author MathAid
 */

import { defineProcessor, type ProcessorModule } from '@platform/core';

import { decryptText, encryptText, hmacText, verifyHmacText } from './cipher';
import { fromBase64Url, toBase64Url, toHex, utf8 } from './encoding';
import { KeyStore, type CryptoConfig, type KeyPurpose } from './keys';

/**
 * @summary The digest algorithms of `hash`.
 * @public
 */
export type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

/**
 * @summary One request to the Crypto processor.
 *
 * @example
 * Example 1: Encrypting
 * ```ts
 * const request: CryptoRequest = { op: 'encrypt', data: 'card ending 4242' };
 * ```
 *
 * @example
 * Example 2: Verifying a tag
 * ```ts
 * const request: CryptoRequest = { op: 'verify-hmac', data: payload, tag };
 * ```
 *
 * @public
 */
export type CryptoRequest =
  | {
      /** @summary Encrypts `data` with the active encryption key. */
      readonly op: 'encrypt';
      /** @summary The text to encrypt. */
      readonly data: string;
    }
  | {
      /** @summary Decrypts a token from `encrypt`. */
      readonly op: 'decrypt';
      /** @summary The token. */
      readonly token: string;
    }
  | {
      /** @summary Computes an HMAC tag with the active HMAC key. */
      readonly op: 'hmac';
      /** @summary The text to tag. */
      readonly data: string;
    }
  | {
      /** @summary Checks an HMAC tag. */
      readonly op: 'verify-hmac';
      /** @summary The text that was tagged. */
      readonly data: string;
      /** @summary The tag from `hmac`. */
      readonly tag: string;
    }
  | {
      /** @summary Signs `data` with the active signing key. */
      readonly op: 'sign';
      /** @summary The text to sign. */
      readonly data: string;
    }
  | {
      /** @summary Checks a signature. */
      readonly op: 'verify';
      /** @summary The text that was signed. */
      readonly data: string;
      /** @summary The signature from `sign`. */
      readonly signature: string;
    }
  | {
      /** @summary Returns the public key of the active signing key as a JWK. */
      readonly op: 'public-key';
    }
  | {
      /** @summary Computes a digest. */
      readonly op: 'hash';
      /** @summary The text to hash. */
      readonly data: string;
      /** @summary The algorithm. The default is `SHA-256`. */
      readonly algorithm?: HashAlgorithm;
    }
  | {
      /** @summary Makes a new active key for a purpose. */
      readonly op: 'rotate';
      /** @summary The purpose of the new key. */
      readonly purpose: KeyPurpose;
    }
  | {
      /** @summary Deletes every persisted key, then makes new keys. */
      readonly op: 'forget';
    }
  | {
      /** @summary Returns the status of the key store. */
      readonly op: 'status';
    };

/**
 * @summary The status of the key store of the processor.
 *
 * @example
 * Example 1: A device key store
 * ```ts
 * // { persistent: true, keys: 3, active: { encrypt: 'a1…', hmac: 'b2…', sign: 'c3…' } }
 * ```
 *
 * @example
 * Example 2: Warning about data that does not survive a reload
 * ```ts
 * if (!status.persistent) console.warn('Encrypted data will not survive a reload.');
 * ```
 *
 * @public
 */
export interface CryptoStatus {
  /**
   * @summary Tells if the keys are kept in IndexedDB.
   */
  readonly persistent: boolean;
  /**
   * @summary The number of keys, active and old.
   */
  readonly keys: number;
  /**
   * @summary The id of the active key of each purpose.
   */
  readonly active: Readonly<Record<KeyPurpose, string>>;
}

/**
 * @summary Options for {@linkcode createCryptoProcessor}.
 * @public
 */
export interface CryptoProcessorOptions {
  /**
   * @summary The IndexedDB factory that keeps the keys.
   * @description The default is the global `indexedDB`. Pass `null` to keep keys in memory only.
   * Tests pass `new IDBFactory()` from `fake-indexeddb`.
   */
  readonly indexedDB?: IDBFactory | null;
}

/** @summary Splits `<keyId>.<value>` and returns both parts. @internal */
function split(text: string, what: string): [string, string] {
  const at = text.indexOf('.');
  if (at <= 0) throw new Error(`The ${what} is not in the "<keyId>.<value>" format.`);
  return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * @summary Creates the Crypto processor module.
 *
 * @description
 * Each call makes a new module with its own key store. The worker entry
 * (`@platform/crypto/worker`) and the virtual host each call it one time.
 *
 * @example
 * Example 1: The worker entry
 * ```ts
 * serveProcessor(createCryptoProcessor());
 * ```
 *
 * @example
 * Example 2: Keys in memory only
 * ```ts
 * createCryptoProcessor({ indexedDB: null });
 * ```
 *
 * @param {CryptoProcessorOptions} [options] The IndexedDB factory.
 * @returns {ProcessorModule<CryptoRequest, unknown>} The processor module.
 *
 * @public
 */
export function createCryptoProcessor(
  options: CryptoProcessorOptions = {},
): ProcessorModule<CryptoRequest, unknown> {
  let keys: KeyStore | null = null;
  let config: CryptoConfig = { source: { kind: 'device' } };
  const factory =
    options.indexedDB === null
      ? undefined
      : (options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB));

  const store = () => {
    if (!keys) throw new Error('The Crypto processor is not set up.');
    return keys;
  };
  return defineProcessor<CryptoRequest, unknown>({
    async setup(_scope, value) {
      config = (value as CryptoConfig | undefined) ?? { source: { kind: 'device' } };
      keys = await KeyStore.open(config, factory);
    },

    async handle(request) {
      switch (request.op) {
        case 'encrypt':
          return encryptText(store(), request.data);
        case 'decrypt':
          return decryptText(store(), request.token);
        case 'hmac':
          return hmacText(store(), request.data);
        case 'verify-hmac':
          return verifyHmacText(store(), request.data, request.tag);
        case 'sign': {
          const { id, key } = store().active('sign');
          const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            utf8(request.data),
          );
          return `${id}.${toBase64Url(new Uint8Array(signature))}`;
        }
        case 'verify': {
          const [id, signature] = split(request.signature, 'signature');
          const record = store().get(id);
          if (!record?.publicKey) return false;
          return crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            record.publicKey,
            fromBase64Url(signature),
            utf8(request.data),
          );
        }
        case 'public-key': {
          const { id, publicKey } = store().active('sign');
          const jwk = await crypto.subtle.exportKey('jwk', publicKey!);
          return { ...jwk, kid: id };
        }
        case 'hash': {
          const digest = await crypto.subtle.digest(
            request.algorithm ?? 'SHA-256',
            utf8(request.data),
          );
          return toHex(new Uint8Array(digest));
        }
        case 'rotate':
          return store().rotate(request.purpose);
        case 'forget':
          // Delete the keys, then start again with new ones (injected keys come back).
          await store().forget();
          keys = await KeyStore.open(config, factory);
          return undefined;
        case 'status': {
          const current = store();
          return {
            persistent: current.persistent,
            keys: current.records().length,
            active: {
              encrypt: current.active('encrypt').id,
              hmac: current.active('hmac').id,
              sign: current.active('sign').id,
            },
          } satisfies CryptoStatus;
        }
        default:
          throw new Error(`Unknown Crypto operation "${(request as { op: string }).op}".`);
      }
    },

    teardown() {
      keys?.clear();
      keys = null;
    },
  });
}
