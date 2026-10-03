/**
 * @fileoverview
 * @summary The key store of Crypto: non-extractable keys, their sources, and their persistence in IndexedDB.
 * @description
 * Implements the key handling of docs/ARCHITECTURE.md §18.1. A
 * {@linkcode KeyStore} holds the keys of one host in memory, and keeps them in
 * IndexedDB as `CryptoKey` objects. IndexedDB stores a `CryptoKey` by
 * structured clone and never exposes its bytes, so every host and every
 * session of the origin uses the same keys.
 *
 * ```text
 *   source 'device'    first use: generate --> IndexedDB      next sessions: read from IndexedDB
 *   source 'material'  import the injected base64 keys (not persisted, the app gives them again)
 *   source 'fetch'     GET url --> JSON { encrypt, hmac?, previousEncrypt? } --> import
 *   signing keys       always 'device' keys (ECDSA P-256), persisted
 *
 *   purposes           encrypt (AES-GCM 256), hmac (HMAC-SHA-256), sign (ECDSA P-256)
 *   one active key for each purpose; older keys stay to decrypt and verify
 *   ```
 *
 * @example
 * Opening the store in a processor
 * ```ts
 * const keys = await KeyStore.open({ source: { kind: 'device' } }, indexedDB);
 * const key = keys.active('encrypt');
 * ```
 *
 * @example
 * Injected material
 * ```ts
 * await KeyStore.open({ source: { kind: 'material', encrypt: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=' } }, undefined);
 * ```
 *
 * @author MathAid
 */

import { fromBase64Url, toHex, utf8 } from './encoding';

/**
 * @summary What a key is for.
 * @public
 */
export type KeyPurpose = 'encrypt' | 'hmac' | 'sign';

/**
 * @summary The raw key material that an app gives to Crypto, as base64 text.
 *
 * @description
 * `encrypt` is a 32-byte AES-256 key. `hmac` is an HMAC-SHA-256 key of any
 * length. Without it, Crypto makes a device HMAC key. `previousEncrypt`
 * lists older encryption keys, so data that they encrypted still decrypts
 * after a server rotates the key.
 *
 * @example
 * Example 1: One key
 * ```ts
 * const material: KeyMaterial = { encrypt: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=' };
 * ```
 *
 * @example
 * Example 2: After a rotation on the server
 * ```ts
 * const material: KeyMaterial = { encrypt: newKey, hmac: tagKey, previousEncrypt: [oldKey] };
 * ```
 *
 * @public
 */
export interface KeyMaterial {
  /**
   * @summary The active AES-256 key: 32 bytes, as base64 or base64url text.
   */
  readonly encrypt: string;
  /**
   * @summary The HMAC-SHA-256 key, as base64 or base64url text.
   * @description Without it, Crypto makes a device key for HMAC tags.
   */
  readonly hmac?: string;
  /**
   * @summary Older AES-256 keys that still decrypt, as base64 or base64url text.
   */
  readonly previousEncrypt?: readonly string[];
}

/**
 * @summary Where Crypto gets its encryption and HMAC keys.
 *
 * @description
 * - `device` (the default): Crypto makes the keys on first use and keeps them in IndexedDB.
 * - `material`: the app injects the keys, for example from its server-rendered config.
 * - `fetch`: Crypto gets the keys at boot from `url`, which returns {@linkcode KeyMaterial} as JSON.
 *
 * @example
 * Example 1: Keys bound to this browser
 * ```ts
 * const source: KeySource = { kind: 'device' };
 * ```
 *
 * @example
 * Example 2: Keys from the server
 * ```ts
 * const source: KeySource = { kind: 'fetch', url: '/api/keys', headers: { 'X-CSRF': token } };
 * ```
 *
 * @public
 */
export type KeySource =
  | {
      /**
       * @summary Makes the keys on first use and keeps them in IndexedDB.
       */
      readonly kind: 'device';
    }
  | ({
      /**
       * @summary Uses keys that the app injects.
       */
      readonly kind: 'material';
    } & KeyMaterial)
  | {
      /**
       * @summary Gets the keys from a URL at boot.
       */
      readonly kind: 'fetch';
      /**
       * @summary The URL that returns the key material as JSON.
       */
      readonly url: string;
      /**
       * @summary Extra request headers, for example for authentication.
       */
      readonly headers?: Readonly<Record<string, string>>;
    };

/**
 * @summary The configuration of the Crypto processor.
 *
 * @example
 * Example 1: The default
 * ```ts
 * const config: CryptoConfig = { source: { kind: 'device' }, database: '__platform_crypto' };
 * ```
 *
 * @example
 * Example 2: A separate database for tests
 * ```ts
 * const config: CryptoConfig = { source: { kind: 'device' }, database: 'crypto-test' };
 * ```
 *
 * @public
 */
export interface CryptoConfig {
  /**
   * @summary Where the encryption and HMAC keys come from.
   */
  readonly source: KeySource;
  /**
   * @summary The name of the IndexedDB database that keeps the keys.
   * @description The default is `__platform_crypto`.
   */
  readonly database?: string;
}

/**
 * @summary One key in the store.
 *
 * @example
 * Example 1: An encryption key
 * ```ts
 * // { id: '3f9a1c2b7d4e5f60', purpose: 'encrypt', key: CryptoKey, createdAt: 1700000000000, active: true }
 * ```
 *
 * @example
 * Example 2: Finding the active signing key
 * ```ts
 * const record = keys.records().find((r) => r.purpose === 'sign' && r.active);
 * ```
 *
 * @public
 */
export interface KeyRecord {
  /**
   * @summary The id of the key. Tokens, tags and signatures carry it.
   */
  readonly id: string;
  /**
   * @summary What the key is for.
   */
  readonly purpose: KeyPurpose;
  /**
   * @summary The key. It is not extractable.
   * @description For `sign`, it is the private key.
   */
  readonly key: CryptoKey;
  /**
   * @summary The public key of a `sign` key pair. It is extractable.
   */
  readonly publicKey?: CryptoKey;
  /**
   * @summary The time when the key was made or imported, in Unix milliseconds.
   */
  readonly createdAt: number;
  /**
   * @summary Tells if this is the key that new operations use.
   * @description Each purpose has one active key. Inactive keys only decrypt and verify.
   */
  active: boolean;
  /**
   * @summary Tells if the key is kept in IndexedDB.
   * @description Injected and fetched keys are not kept: the app gives them again at each boot.
   */
  readonly persisted: boolean;
}

/** @summary The default IndexedDB database of the keys. @internal */
const DEFAULT_DATABASE = '__platform_crypto';

/** @summary The algorithms of each purpose, for generation and import. @internal */
const ALGORITHMS = {
  encrypt: { name: 'AES-GCM', length: 256 } as const,
  hmac: { name: 'HMAC', hash: 'SHA-256' } as const,
  sign: { name: 'ECDSA', namedCurve: 'P-256' } as const,
};

/** @summary A new random key id: 16 hex digits. @internal */
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

/** @summary A key id derived from key material, stable across sessions. @internal */
async function materialId(purpose: KeyPurpose, material: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...utf8(purpose), ...material])),
  );
  return toHex(digest.subarray(0, 8));
}

/** @summary Runs one IndexedDB request and resolves with its result. @internal */
const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * @summary The keys of one host: in memory, and in IndexedDB when it exists.
 *
 * @description
 * {@linkcode KeyStore.open} loads the persisted keys and adds the keys of the
 * source. `active(purpose)` gives the key for new operations, and `get(id)`
 * the key that a token or tag names. `rotate` adds a new active key and keeps
 * the old ones. `forget` deletes every persisted key. `clear` empties the
 * memory, which is the zeroization at teardown.
 *
 * The Crypto processor is its only user. It runs in a shared worker, a
 * dedicated worker or on the main thread, and every one of them opens the same
 * database.
 *
 * @example
 * Example 1: Encrypting with the active key
 * ```ts
 * const { id, key } = await keys.active('encrypt');
 * ```
 *
 * @example
 * Example 2: A new key after a suspected leak
 * ```ts
 * const id = await keys.rotate('encrypt');
 * ```
 *
 * @public
 */
export class KeyStore {
  readonly #records = new Map<string, KeyRecord>();
  #database: IDBDatabase | null;

  /**
   * @summary Creates a store. Use {@linkcode KeyStore.open} instead.
   * @param {IDBDatabase | null} database The open database, or `null` without IndexedDB.
   * @param {KeyRecord[]} records The keys that are already loaded.
   */
  private constructor(database: IDBDatabase | null, records: KeyRecord[]) {
    this.#database = database;
    for (const record of records) this.#records.set(record.id, record);
  }

  /**
   * @summary Opens the store: loads the persisted keys and adds the keys of the source.
   *
   * @description
   * With the `device` source, it makes any missing encryption or HMAC key.
   * With `material` or `fetch`, it imports the given keys and makes them
   * active. It always makes a signing key if none exists. Two tabs that open
   * the store at the same time end with the same keys: the check and the
   * insert run in one IndexedDB transaction.
   *
   * @example
   * Example 1: In a worker
   * ```ts
   * const keys = await KeyStore.open(config, self.indexedDB);
   * ```
   *
   * @example
   * Example 2: Without IndexedDB (keys stay in memory)
   * ```ts
   * const keys = await KeyStore.open(config, undefined);
   * keys.persistent; // false
   * ```
   *
   * @param {CryptoConfig} config The key source and the database name.
   * @param {IDBFactory | undefined} factory The IndexedDB factory, or `undefined` to keep keys in memory.
   * @returns {Promise<KeyStore>} The open store.
   * @throws {Error} When the fetch fails, or the key material is not valid.
   */
  static async open(config: CryptoConfig, factory: IDBFactory | undefined): Promise<KeyStore> {
    const database = factory
      ? await openDatabase(factory, config.database ?? DEFAULT_DATABASE)
      : null;
    const persisted = database
      ? await request(
          database.transaction('keys').objectStore('keys').getAll() as IDBRequest<KeyRecord[]>,
        )
      : [];
    const store = new KeyStore(database, persisted);
    const source = config.source;

    if (source.kind === 'device') {
      await store.#ensure('encrypt');
      await store.#ensure('hmac');
    } else {
      const material =
        source.kind === 'material' ? source : await fetchMaterial(source.url, source.headers);
      await store.#importMaterial(material);
      if (!material.hmac) await store.#ensure('hmac');
    }
    await store.#ensure('sign');
    return store;
  }

  /**
   * @summary Tells if the keys are kept in IndexedDB.
   * @returns {boolean} `false` when the store has no database: keys then die with the host.
   */
  get persistent(): boolean {
    return this.#database !== null;
  }

  /**
   * @summary Returns the active key of a purpose.
   * @example
   * Encrypting
   * ```ts
   * const { id, key } = keys.active('encrypt');
   * ```
   * @param {KeyPurpose} purpose The purpose.
   * @returns {KeyRecord} The active key.
   * @throws {Error} When the store was cleared.
   */
  active(purpose: KeyPurpose): KeyRecord {
    for (const record of this.#records.values()) {
      if (record.purpose === purpose && record.active) return record;
    }
    throw new Error(`No active ${purpose} key. The key store is closed.`);
  }

  /**
   * @summary Returns a key by its id.
   * @example
   * Decrypting a token
   * ```ts
   * const record = keys.get(token.split('.')[1]);
   * ```
   * @param {string} id The id of the key.
   * @returns {KeyRecord | undefined} The key, or `undefined` for an unknown id.
   */
  get(id: string): KeyRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * @summary Returns all keys, oldest first.
   * @example
   * Counting the keys
   * ```ts
   * keys.records().length;
   * ```
   * @returns {KeyRecord[]} The keys.
   */
  records(): KeyRecord[] {
    return [...this.#records.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * @summary Makes a new active key for a purpose. The old keys stay.
   * @example
   * Rotating the encryption key
   * ```ts
   * const id = await keys.rotate('encrypt');
   * ```
   * @param {KeyPurpose} purpose The purpose.
   * @returns {Promise<string>} The id of the new key.
   */
  async rotate(purpose: KeyPurpose): Promise<string> {
    const record = await generate(purpose, this.persistent);
    for (const old of this.#records.values()) if (old.purpose === purpose) old.active = false;
    this.#records.set(record.id, record);
    if (this.#database) {
      const tx = this.#database.transaction('keys', 'readwrite');
      const keys = tx.objectStore('keys');
      for (const old of this.#records.values()) if (old.persisted) keys.put({ ...old });
      await done(tx);
    }
    return record.id;
  }

  /**
   * @summary Deletes every persisted key, and every key in memory.
   * @description Data that these keys encrypted can never be decrypted again.
   * The store is unusable after it. A new store makes new keys.
   * @example
   * Erasing the data of a user who leaves
   * ```ts
   * await keys.forget();
   * ```
   * @returns {Promise<void>} Resolves when the keys are deleted.
   */
  async forget(): Promise<void> {
    if (this.#database) {
      const tx = this.#database.transaction('keys', 'readwrite');
      tx.objectStore('keys').clear();
      await done(tx);
    }
    this.clear();
  }

  /**
   * @summary Removes the keys from memory and closes the database. The persisted keys stay.
   * @example
   * Zeroizing at teardown
   * ```ts
   * teardown: () => keys.clear(),
   * ```
   */
  clear(): void {
    this.#records.clear();
    this.#database?.close();
    this.#database = null;
  }

  /** @summary Makes and persists an active key for a purpose, unless one exists. */
  async #ensure(purpose: KeyPurpose): Promise<void> {
    if ([...this.#records.values()].some((r) => r.purpose === purpose && r.active)) return;
    const candidate = await generate(purpose, this.persistent);
    if (!this.#database) {
      this.#records.set(candidate.id, candidate);
      return;
    }
    // Another tab may have made one meanwhile: check and insert in one transaction.
    const tx = this.#database.transaction('keys', 'readwrite');
    const keys = tx.objectStore('keys');
    const all = await request(keys.getAll() as IDBRequest<KeyRecord[]>);
    const existing = all.find((r) => r.purpose === purpose && r.active);
    if (!existing) keys.put({ ...candidate });
    await done(tx);
    const chosen = existing ?? candidate;
    this.#records.set(chosen.id, chosen);
  }

  /** @summary Imports injected or fetched material as the active encryption and HMAC keys. */
  async #importMaterial(material: KeyMaterial): Promise<void> {
    const add = async (purpose: 'encrypt' | 'hmac', text: string, active: boolean) => {
      const bytes = fromBase64Url(text);
      if (purpose === 'encrypt' && bytes.length !== 32) {
        throw new Error('The encryption key material must be 32 bytes (AES-256).');
      }
      const id = await materialId(purpose, bytes);
      const usages: KeyUsage[] =
        purpose === 'encrypt' ? ['encrypt', 'decrypt'] : ['sign', 'verify'];
      const key = await crypto.subtle.importKey('raw', bytes, ALGORITHMS[purpose], false, usages);
      if (active)
        for (const old of this.#records.values()) if (old.purpose === purpose) old.active = false;
      this.#records.set(id, { id, purpose, key, createdAt: Date.now(), active, persisted: false });
    };
    for (const old of material.previousEncrypt ?? []) await add('encrypt', old, false);
    await add('encrypt', material.encrypt, true);
    if (material.hmac) await add('hmac', material.hmac, true);
  }
}

/** @summary Makes a new active key of a purpose. @internal */
async function generate(purpose: KeyPurpose, persisted: boolean): Promise<KeyRecord> {
  const id = randomId();
  const createdAt = Date.now();
  if (purpose === 'sign') {
    const pair = await crypto.subtle.generateKey(ALGORITHMS.sign, false, ['sign', 'verify']);
    return {
      id,
      purpose,
      key: pair.privateKey,
      publicKey: pair.publicKey,
      createdAt,
      active: true,
      persisted,
    };
  }
  const usages: KeyUsage[] = purpose === 'encrypt' ? ['encrypt', 'decrypt'] : ['sign', 'verify'];
  const key = (await crypto.subtle.generateKey(ALGORITHMS[purpose], false, usages)) as CryptoKey;
  return { id, purpose, key, createdAt, active: true, persisted };
}

/** @summary Opens the key database, creating the `keys` store. @internal */
function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** @summary Resolves when an IndexedDB transaction completes. @internal */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The key transaction was aborted.'));
  });
}

/** @summary Gets key material from a URL. @internal */
async function fetchMaterial(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
): Promise<KeyMaterial> {
  const response = await fetch(url, { headers, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`The key request failed with HTTP ${response.status}.`);
  const material = (await response.json()) as KeyMaterial;
  if (typeof material?.encrypt !== 'string') {
    throw new Error('The key response has no "encrypt" key material.');
  }
  return material;
}
