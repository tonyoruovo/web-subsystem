/**
 * @fileoverview
 * @summary The encryption and integrity operations on a key store, without a processor.
 * @description
 * The Crypto processor uses these functions, and so does the Storage
 * coordinator, which opens the same key store (docs/ARCHITECTURE.md §18.2).
 * Both therefore make the same token formats:
 *
 * ```text
 *   encryptText  'v1.<keyId>.<iv>.<ciphertext>'   AES-GCM 256, a new 12-byte IV each time
 *   hmacText     '<keyId>.<tag>'                  HMAC-SHA-256
 *   ```
 *
 * The parts are base64url. Each token names its key, so it still works after a rotation.
 *
 * @example
 * Encrypting with a key store
 * ```ts
 * const keys = await KeyStore.open({ source: { kind: 'device' } }, indexedDB);
 * const token = await encryptText(keys, 'secret');
 * await decryptText(keys, token); // 'secret'
 * ```
 *
 * @author MathAid
 */

import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding';
import type { KeyPurpose, KeyRecord, KeyStore } from './keys';

/**
 * @summary A token or tag names a key that the key store does not have.
 * @description It happens after `forget`, or with data from another device.
 * @example
 * Telling a lost key from a changed token
 * ```ts
 * try { await decryptText(keys, token); } catch (error) { if (error instanceof UnknownKeyError) eraseIt(); }
 * ```
 * @public
 */
export class UnknownKeyError extends Error {
  /**
   * @summary The name of the error: `UnknownKeyError`.
   */
  override readonly name = 'UnknownKeyError';
}

function named(keys: KeyStore, id: string, purpose: KeyPurpose): KeyRecord {
  const record = keys.get(id);
  if (!record || record.purpose !== purpose) {
    throw new UnknownKeyError(`No ${purpose} key "${id}".`);
  }
  return record;
}

/**
 * @summary Encrypts text with the active encryption key.
 * @example
 * Encrypting
 * ```ts
 * const token = await encryptText(keys, 'card ending 4242');
 * ```
 * @param {KeyStore} keys The key store.
 * @param {string} text The text.
 * @returns {Promise<string>} The token `v1.<keyId>.<iv>.<ciphertext>`.
 * @public
 */
export async function encryptText(keys: KeyStore, text: string): Promise<string> {
  const { id, key } = keys.active('encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(text));
  return `v1.${id}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * @summary Decrypts a token from {@linkcode encryptText}, with the key that the token names.
 * @example
 * Decrypting
 * ```ts
 * await decryptText(keys, token); // 'card ending 4242'
 * ```
 * @param {KeyStore} keys The key store.
 * @param {string} token The token.
 * @returns {Promise<string>} The text.
 * @throws {UnknownKeyError} When the key store does not have the key of the token.
 * @throws {Error} When the token has a wrong format or was changed.
 * @public
 */
export async function decryptText(keys: KeyStore, token: string): Promise<string> {
  const [version, id, iv, ciphertext] = token.split('.');
  if (version !== 'v1' || !id || !iv || !ciphertext) {
    throw new Error('The token is not in the "v1.<keyId>.<iv>.<ciphertext>" format.');
  }
  const { key } = named(keys, id, 'encrypt');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv) },
    key,
    fromBase64Url(ciphertext),
  );
  return fromUtf8(new Uint8Array(plain));
}

/**
 * @summary Makes an HMAC-SHA-256 tag of text with the active HMAC key.
 * @example
 * Tagging
 * ```ts
 * const tag = await hmacText(keys, payload);
 * ```
 * @param {KeyStore} keys The key store.
 * @param {string} text The text.
 * @returns {Promise<string>} The tag `<keyId>.<tag>`.
 * @public
 */
export async function hmacText(keys: KeyStore, text: string): Promise<string> {
  const { id, key } = keys.active('hmac');
  const tag = await crypto.subtle.sign('HMAC', key, utf8(text));
  return `${id}.${toBase64Url(new Uint8Array(tag))}`;
}

/**
 * @summary Checks an HMAC tag from {@linkcode hmacText}, in constant time.
 * @example
 * Checking
 * ```ts
 * await verifyHmacText(keys, payload, tag); // true
 * ```
 * @param {KeyStore} keys The key store.
 * @param {string} text The text.
 * @param {string} tag The tag.
 * @returns {Promise<boolean>} `true` when the tag is correct. An unknown key or a bad format gives `false`.
 * @public
 */
export async function verifyHmacText(keys: KeyStore, text: string, tag: string): Promise<boolean> {
  const at = tag.indexOf('.');
  if (at <= 0) return false;
  const record = keys.get(tag.slice(0, at));
  if (!record || record.purpose !== 'hmac') return false;
  try {
    return await crypto.subtle.verify(
      'HMAC',
      record.key,
      fromBase64Url(tag.slice(at + 1)),
      utf8(text),
    );
  } catch {
    return false;
  }
}
