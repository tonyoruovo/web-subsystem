/**
 * @fileoverview
 * @summary The Crypto manager: key management and cryptographic primitives.
 * @description
 * Implements the cryptographic foundation of M1. It holds non-extractable keys
 * in memory, encrypts with AES-GCM, signs integrity tags with HMAC-SHA-256, and
 * hashes with SHA-256. Storage uses `encrypt` and `verifyHmac`. The keys are
 * generated at boot and zeroized on shutdown. They never leave the manager.
 *
 * ```text
 *   initialize()  -> generate AES-GCM key + HMAC key (non-extractable)
 *   encrypt(data) -> { keyId, iv, ciphertext }
 *   decrypt(blob) -> data
 *   hmac(data)    -> integrity tag
 *   zeroize()     -> drop every key
 *   ```
 *
 * @see {@linkcode EncryptedBlob}
 * @author MathAid
 */

/**
 * @summary An encrypted payload plus the material needed to decrypt it.
 * @description
 * `keyId` names the key. `iv` is the AES-GCM nonce. `ciphertext` is the
 * encrypted bytes. Storage serializes this into the envelope.
 */
export interface EncryptedBlob {
  /** Id of the key that encrypted the payload. */
  keyId: string;
  /** The AES-GCM initialization vector. */
  iv: ArrayBuffer;
  /** The encrypted bytes. */
  ciphertext: ArrayBuffer;
}

/**
 * @summary Options for constructing a {@linkcode CryptoManager}.
 */
export interface CryptoManagerOptions {
  /** The SubtleCrypto. Defaults to the browser's `crypto.subtle`. */
  subtle?: SubtleCrypto;
  /** The random byte source. Defaults to `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
}

/**
 * @summary The Crypto manager.
 * @description
 * One instance per realm. Call `initialize` once at boot, then use the
 * primitives. `zeroize` on shutdown.
 *
 * @example
 * Example 1: Encrypt and decrypt a roundtrip
 * ```ts
 * const cryptoManager = new CryptoManager();
 * await cryptoManager.initialize();
 * const blob = await cryptoManager.encrypt('secret');
 * const plain = await cryptoManager.decrypt(blob);
 * ```
 */
export class CryptoManager {
  /** @internal Key id to CryptoKey. */
  private readonly keys = new Map<string, CryptoKey>();

  /** @internal The active encryption key id. */
  private activeEncryptId: string | null = null;

  /** @internal The active HMAC key id. */
  private activeHmacId: string | null = null;

  /** @internal The SubtleCrypto. */
  private readonly subtle: SubtleCrypto;

  /** @internal The random byte source. */
  private readonly randomBytes: (length: number) => Uint8Array;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /** @internal Whether initialization ran. */
  private ready = false;

  /**
   * @summary Creates a CryptoManager.
   * @param {CryptoManagerOptions} [options] The configuration and injectables.
   */
  constructor(options: CryptoManagerOptions = {}) {
    this.subtle = options.subtle ?? (globalThis.crypto?.subtle as SubtleCrypto);
    this.randomBytes =
      options.randomBytes ??
      ((length) => (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(length)));
    this.makeId = options.makeId ?? makeCounter();
  }

  /**
   * @summary Generates the encryption and HMAC keys.
   * @description
   * Generates a 256-bit AES-GCM key and an HMAC-SHA-256 key, both
   * non-extractable. Idempotent: a second call is a no-op.
   *
   * @returns {Promise<void>}
   */
  async initialize(): Promise<void> {
    if (this.ready) return;

    const encryptKey = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const hmacKey = await this.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);

    const encryptId = this.makeId();
    const hmacId = this.makeId();
    this.keys.set(encryptId, encryptKey);
    this.keys.set(hmacId, hmacKey);
    this.activeEncryptId = encryptId;
    this.activeHmacId = hmacId;
    this.ready = true;
  }

  /**
   * @summary True when the keys are ready.
   * @returns {boolean} `true` after a successful `initialize`.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * @summary The active key id for a purpose.
   * @param {'encrypt' | 'hmac'} purpose The purpose.
   * @returns {string | null} The key id, or `null` when not ready.
   */
  getActiveKeyId(purpose: 'encrypt' | 'hmac'): string | null {
    return purpose === 'encrypt' ? this.activeEncryptId : this.activeHmacId;
  }

  /**
   * @summary Encrypts a string.
   * @param {string} data The plain text.
   * @returns {Promise<EncryptedBlob>} The blob to store.
   * @throws {Error} When the manager is not initialized.
   */
  async encrypt(data: string): Promise<EncryptedBlob> {
    this.assertReady();
    const keyId = this.activeEncryptId as string;
    const key = this.keys.get(keyId) as CryptoKey;
    const iv = this.randomBytes(12);
    const ciphertext = await this.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(data),
    );
    return { keyId, iv: iv.buffer as ArrayBuffer, ciphertext };
  }

  /**
   * @summary Decrypts a blob.
   * @param {EncryptedBlob} blob The blob to decrypt.
   * @returns {Promise<string>} The plain text.
   * @throws {Error} When the manager is not initialized or the key id is unknown.
   */
  async decrypt(blob: EncryptedBlob): Promise<string> {
    this.assertReady();
    const key = this.keys.get(blob.keyId);
    if (!key) {
      throw new Error(`[CryptoManager] no key "${blob.keyId}"`);
    }
    const plain = await this.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(blob.iv) as BufferSource },
      key,
      blob.ciphertext,
    );
    return new TextDecoder().decode(plain);
  }

  /**
   * @summary Signs data with an integrity tag.
   * @param {string} data The data to sign.
   * @returns {Promise<ArrayBuffer>} The HMAC tag.
   * @throws {Error} When the manager is not initialized.
   */
  async hmac(data: string): Promise<ArrayBuffer> {
    this.assertReady();
    const key = this.keys.get(this.activeHmacId as string) as CryptoKey;
    return this.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  }

  /**
   * @summary Verifies an integrity tag.
   * @param {ArrayBuffer} tag The tag to verify.
   * @param {string} data The data the tag covers.
   * @returns {Promise<boolean>} `true` when the tag matches.
   * @throws {Error} When the manager is not initialized.
   */
  async verifyHmac(tag: ArrayBuffer, data: string): Promise<boolean> {
    this.assertReady();
    const key = this.keys.get(this.activeHmacId as string) as CryptoKey;
    return this.subtle.verify('HMAC', key, tag, new TextEncoder().encode(data));
  }

  /**
   * @summary Hashes data with SHA-256.
   * @param {string} data The data to hash.
   * @returns {Promise<ArrayBuffer>} The digest.
   */
  async hash(data: string): Promise<ArrayBuffer> {
    return this.subtle.digest('SHA-256', new TextEncoder().encode(data));
  }

  /**
   * @summary Drops every key and marks the manager not ready.
   * @returns {void}
   */
  zeroize(): void {
    this.keys.clear();
    this.activeEncryptId = null;
    this.activeHmacId = null;
    this.ready = false;
  }

  /**
   * @summary Throws when not initialized.
   * @returns {void}
   * @throws {Error} When the manager is not initialized.
   * @internal
   */
  private assertReady(): void {
    if (!this.ready) {
      throw new Error('[CryptoManager] not initialized');
    }
  }
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `key-${++counter}`;
}
