/**
 * @fileoverview
 * @summary The Crypto subsystem: commands for encryption, tags, signatures and digests, backed by the Crypto processor.
 * @description
 * Implements the subsystem `crypto` of docs/ARCHITECTURE.md §18.1. Each
 * command sends one {@linkcode CryptoRequest} to the processor `crypto`, which
 * runs in a shared worker when it can, so every tab of the origin uses one key
 * store. The state shows the host, the key source, and if the keys persist.
 *
 * ```text
 *   ctx.dependency('crypto').commands.encrypt(text)
 *     --> processor 'crypto': shared --> dedicated --> virtual (failover)
 *     <-- 'v1.<keyId>.<iv>.<ciphertext>'
 *   ```
 *
 * @example
 * Registering Crypto
 * ```ts
 * const kernel = new Kernel([...centralized, createCrypto(), createStorage({ domain: 'shop' })], { router: queue.router });
 * ```
 *
 * @example
 * Encrypting a value
 * ```ts
 * const crypto = kernel.unit<CryptoControl>('crypto').control!;
 * const token = await crypto.commands.encrypt('card ending 4242');
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  type HostKind,
  type ProcessorDef,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import type { CryptoConfig, KeyPurpose, KeySource } from './keys';
import {
  createCryptoProcessor,
  type CryptoRequest,
  type CryptoStatus,
  type HashAlgorithm,
} from './processor';

/**
 * @summary The id the Crypto subsystem registers under.
 * @constant {'crypto'}
 * @public
 */
export const CRYPTO_ID = 'crypto';

/**
 * @summary The event that Crypto broadcasts after `rotate` or `forget`, with a {@linkcode KeysChanged} payload.
 * @description Storage listens to it and reloads the keys of its coordinator.
 * @constant {'crypto:keys-changed'}
 * @public
 */
export const CRYPTO_KEYS_CHANGED = 'crypto:keys-changed';

/**
 * @summary The payload of {@linkcode CRYPTO_KEYS_CHANGED}.
 *
 * @example
 * Example 1: After a rotation
 * ```ts
 * // { change: 'rotated', purpose: 'encrypt', keyId: '3f9a1c2b7d4e5f60' }
 * ```
 *
 * @example
 * Example 2: Reacting in a subsystem
 * ```ts
 * receive: (packet) => { if ((packet.take() as KeysChanged).change === 'forgotten') clearCache(); },
 * ```
 *
 * @public
 */
export interface KeysChanged {
  /**
   * @summary What changed: a new active key, or all keys deleted.
   */
  readonly change: 'rotated' | 'forgotten';
  /**
   * @summary The purpose of the new key, or `null` after `forget`.
   */
  readonly purpose: KeyPurpose | null;
  /**
   * @summary The id of the new key, or `null` after `forget`.
   */
  readonly keyId: string | null;
}

/**
 * @summary Options for {@linkcode createCrypto}.
 *
 * @example
 * Example 1: Keys from the server
 * ```ts
 * createCrypto({ keys: { kind: 'fetch', url: '/api/storage-keys' } });
 * ```
 *
 * @example
 * Example 2: The main thread only, with keys in memory (tests)
 * ```ts
 * createCrypto({ hosts: ['virtual'], indexedDB: null });
 * ```
 *
 * @public
 */
export interface CryptoOptions {
  /**
   * @summary Where the encryption and HMAC keys come from.
   * @description The default is `{ kind: 'device' }`: keys made on first use and kept in IndexedDB.
   */
  readonly keys?: KeySource;
  /**
   * @summary The hosts to try, in order. The list must end with `virtual`.
   * @description The default is `['shared', 'dedicated', 'virtual']`.
   */
  readonly hosts?: readonly HostKind[];
  /**
   * @summary The name of the IndexedDB database that keeps the keys.
   * @description The default is `__platform_crypto`.
   */
  readonly database?: string;
  /**
   * @summary The IndexedDB factory for the virtual host.
   * @description The default is the global `indexedDB`. Pass `null` to keep
   * keys in memory. Worker hosts always use their own global `indexedDB`.
   */
  readonly indexedDB?: IDBFactory | null;
}

/**
 * @summary The state of the Crypto subsystem.
 *
 * @example
 * Example 1: In a shared worker with device keys
 * ```ts
 * // { host: 'shared', source: 'device', persistent: true, keys: 3, active: { encrypt: 'a1…', … } }
 * ```
 *
 * @example
 * Example 2: Warning when keys do not persist
 * ```ts
 * if (state.getSnapshot().persistent === false) showWarning('Encrypted data is lost on reload.');
 * ```
 *
 * @public
 */
export interface CryptoData {
  /**
   * @summary The host that runs the processor now, or `null` while it does not run.
   */
  host: HostKind | null;
  /**
   * @summary The kind of key source.
   */
  source: KeySource['kind'];
  /**
   * @summary Tells if the keys are kept in IndexedDB.
   * @description When it is `false`, data that Crypto encrypted cannot be decrypted after a reload.
   */
  persistent: boolean;
  /**
   * @summary The number of keys, active and old.
   */
  keys: number;
  /**
   * @summary The id of the active key of each purpose, or `null` before the first status.
   */
  active: Record<KeyPurpose, string> | null;
}

/**
 * @summary The control interface of the Crypto subsystem.
 *
 * @example
 * Example 1: Encrypting and decrypting
 * ```ts
 * const token = await commands.encrypt('secret');
 * await commands.decrypt(token); // 'secret'
 * ```
 *
 * @example
 * Example 2: Signing a request for the server
 * ```ts
 * const signature = await commands.sign(body);
 * await fetch('/api/orders', { method: 'POST', body, headers: { 'X-Signature': signature } });
 * ```
 *
 * @public
 */
export interface CryptoControl {
  /**
   * @summary The commands of Crypto.
   */
  readonly commands: {
    /**
     * @summary Encrypts text with the active encryption key (AES-GCM 256).
     * @description Each call uses a new random IV, so the same text gives a
     * different token each time. The token names its key, so it decrypts after a rotation.
     * @example
     * Encrypting a value before it is stored
     * ```ts
     * const token = await commands.encrypt(JSON.stringify(profile));
     * ```
     * @param {string} data The text to encrypt.
     * @returns {Promise<string>} The token: `v1.<keyId>.<iv>.<ciphertext>`.
     */
    encrypt(data: string): Promise<string>;
    /**
     * @summary Decrypts a token from `encrypt`.
     * @example
     * Reading a stored value
     * ```ts
     * const profile = JSON.parse(await commands.decrypt(token));
     * ```
     * @param {string} token The token.
     * @returns {Promise<string>} The text.
     * @throws {UnknownKeyError} When the key of the token is not known, for example after `forget`.
     * @throws {Error} When the token was changed or is damaged.
     */
    decrypt(token: string): Promise<string>;
    /**
     * @summary Computes an HMAC-SHA-256 tag, to detect changed data.
     * @example
     * Tagging a stored envelope
     * ```ts
     * const tag = await commands.hmac(payload);
     * ```
     * @param {string} data The text to tag.
     * @returns {Promise<string>} The tag: `<keyId>.<tag>`.
     */
    hmac(data: string): Promise<string>;
    /**
     * @summary Checks a tag from `hmac`. The check takes constant time.
     * @example
     * Refusing changed data
     * ```ts
     * if (!(await commands.verifyHmac(payload, tag))) throw new Error('The data was changed.');
     * ```
     * @param {string} data The text that was tagged.
     * @param {string} tag The tag.
     * @returns {Promise<boolean>} `true` when the tag matches.
     */
    verifyHmac(data: string, tag: string): Promise<boolean>;
    /**
     * @summary Signs text with the active ECDSA P-256 key of this device.
     * @example
     * Signing a payload
     * ```ts
     * const signature = await commands.sign(JSON.stringify(order));
     * ```
     * @param {string} data The text to sign.
     * @returns {Promise<string>} The signature: `<keyId>.<signature>`.
     */
    sign(data: string): Promise<string>;
    /**
     * @summary Checks a signature from `sign`.
     * @example
     * Checking a signed message
     * ```ts
     * const valid = await commands.verify(message, signature);
     * ```
     * @param {string} data The text that was signed.
     * @param {string} signature The signature.
     * @returns {Promise<boolean>} `true` when the signature matches.
     */
    verify(data: string, signature: string): Promise<boolean>;
    /**
     * @summary Returns the public key of the active signing key, as a JWK.
     * @description Send it to a server, so the server can check the signatures of this device.
     * The `kid` member is the key id in the signatures.
     * @example
     * Registering the device with the server
     * ```ts
     * await fetch('/api/devices', { method: 'POST', body: JSON.stringify(await commands.publicKey()) });
     * ```
     * @returns {Promise<JsonWebKey & { kid: string }>} The public key.
     */
    publicKey(): Promise<JsonWebKey & { kid: string }>;
    /**
     * @summary Computes a digest of text.
     * @example
     * A cache key for a large query
     * ```ts
     * const key = await commands.hash(JSON.stringify(query));
     * ```
     * @param {string} data The text to hash.
     * @param {HashAlgorithm} [algorithm='SHA-256'] The algorithm.
     * @returns {Promise<string>} The digest, as hex.
     */
    hash(data: string, algorithm?: HashAlgorithm): Promise<string>;
    /**
     * @summary Makes a new active key for a purpose. Old keys still decrypt and verify.
     * @example
     * Rotating the encryption key every quarter
     * ```ts
     * await commands.rotate('encrypt');
     * ```
     * @param {KeyPurpose} purpose The purpose.
     * @returns {Promise<string>} The id of the new key.
     */
    rotate(purpose: KeyPurpose): Promise<string>;
    /**
     * @summary Deletes every key, then makes new keys. Data that the old keys encrypted can never be read again.
     * @description Use it for an erase request (crypto-shredding). Crypto then
     * works with new device keys. With the `material` or `fetch` source, the
     * injected keys come back, so `forget` only deletes the device keys (signing, and HMAC without material).
     * @example
     * Erasing the data of a user who closes the account
     * ```ts
     * await commands.forget();
     * ```
     * @returns {Promise<void>} Resolves when the keys are deleted.
     */
    forget(): Promise<void>;
  };
  /**
   * @summary The views of Crypto.
   */
  readonly views: {
    /**
     * @summary The state of Crypto: host, key source, persistence and keys.
     */
    readonly state: View<Partial<CryptoData>>;
  };
}

/**
 * @summary Creates the Crypto subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode CRYPTO_ID}, featurized, Tab
 * scope, no required dependency). Its processor runs in a shared worker by
 * default, so all tabs share one key store. When the shared worker is not
 * available, it falls back to a dedicated worker, then to the main thread.
 *
 * @example
 * Example 1: The default
 * ```ts
 * createCrypto();
 * ```
 *
 * @example
 * Example 2: Keys injected by the server
 * ```ts
 * createCrypto({ keys: { kind: 'material', encrypt: window.__KEYS__.encrypt } });
 * ```
 *
 * @param {CryptoOptions} [options] Key source, hosts and database.
 * @returns {SubsystemDefinition<CryptoData, CryptoControl>} The subsystem.
 *
 * @public
 */
export function createCrypto(
  options: CryptoOptions = {},
): SubsystemDefinition<CryptoData, CryptoControl> {
  const source = options.keys ?? { kind: 'device' };
  const config: CryptoConfig = { source, database: options.database };
  const processor: ProcessorDef<CryptoRequest, unknown> = {
    id: 'crypto',
    job: 'sink',
    hosts: options.hosts ?? ['shared', 'dedicated', 'virtual'],
    config,
    load: async () => createCryptoProcessor({ indexedDB: options.indexedDB }),
    shared: () =>
      new SharedWorker(new URL('./crypto.worker.ts', import.meta.url), {
        type: 'module',
        name: `platform-crypto:${options.database ?? '__platform_crypto'}`,
      }),
    dedicated: () => new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' }),
  };
  const readable = { readable: true } as const;

  return defineSubsystem({
    id: CRYPTO_ID,
    scope: 'tab',
    kind: 'featurized',
    processors: [processor],
    state: {
      initial: {
        host: null,
        source: source.kind,
        persistent: false,
        keys: 0,
        active: null,
      } as CryptoData,
      policy: {
        host: readable,
        source: readable,
        persistent: readable,
        keys: readable,
        active: readable,
      },
    },
    async init(ctx) {
      const handle = ctx.processor<CryptoRequest, unknown>('crypto');
      const syncHost = () =>
        ctx.state.update((s) => void (s.host = handle.status.getSnapshot().host));
      const stop = handle.status.subscribe(syncHost);
      syncHost();
      const status = (await handle.call({ op: 'status' })) as CryptoStatus;
      ctx.state.update((s) => {
        s.persistent = status.persistent;
        s.keys = status.keys;
        s.active = { ...status.active };
      });
      return stop;
    },
    control: (ctx) => {
      const call = <T>(request: CryptoRequest) =>
        ctx.processor<CryptoRequest, unknown>('crypto').call(request) as Promise<T>;
      const announce = (payload: KeysChanged) =>
        void ctx.port
          .send({ eventId: CRYPTO_KEYS_CHANGED, payload, importance: 'HIGH' })
          .catch((error: unknown) => ctx.report(error));
      const refresh = async () => {
        const status = await call<CryptoStatus>({ op: 'status' });
        ctx.state.update((s) => {
          s.keys = status.keys;
          s.active = { ...status.active };
        });
      };
      return {
        commands: {
          encrypt: (data: string) => call<string>({ op: 'encrypt', data }),
          decrypt: (token: string) => call<string>({ op: 'decrypt', token }),
          hmac: (data: string) => call<string>({ op: 'hmac', data }),
          verifyHmac: (data: string, tag: string) =>
            call<boolean>({ op: 'verify-hmac', data, tag }),
          sign: (data: string) => call<string>({ op: 'sign', data }),
          verify: (data: string, signature: string) =>
            call<boolean>({ op: 'verify', data, signature }),
          publicKey: () => call<JsonWebKey & { kid: string }>({ op: 'public-key' }),
          hash: (data: string, algorithm?: HashAlgorithm) =>
            call<string>({ op: 'hash', data, algorithm }),
          async rotate(purpose: KeyPurpose) {
            const id = await call<string>({ op: 'rotate', purpose });
            await refresh();
            announce({ change: 'rotated', purpose, keyId: id });
            return id;
          },
          async forget() {
            await call<void>({ op: 'forget' });
            await refresh();
            announce({ change: 'forgotten', purpose: null, keyId: null });
          },
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
