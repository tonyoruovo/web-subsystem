/**
 * @fileoverview
 * @summary Text and binary encodings for Crypto: UTF-8, base64url and hex.
 * @description
 * Crypto works on bytes, but its callers send and store strings. These
 * helpers convert between the two without Node-only APIs, so they run in
 * every host: a shared worker, a dedicated worker and the main thread.
 *
 * ```text
 *   string --utf8--> Uint8Array --base64url--> 'aGVsbG8'   (tokens, tags, signatures)
 *                    Uint8Array --hex------->  '68656c6c6f' (digests, key ids)
 *   ```
 *
 * @example
 * A round trip
 * ```ts
 * fromBase64Url(toBase64Url(utf8('hello'))); // the bytes of 'hello'
 * ```
 *
 * @example
 * A digest as hex
 * ```ts
 * toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('hello'))));
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Encodes a string as UTF-8 bytes.
 *
 * @example
 * Example 1: Text to bytes
 * ```ts
 * utf8('héllo').length; // 6
 * ```
 *
 * @example
 * Example 2: Bytes for SubtleCrypto
 * ```ts
 * await crypto.subtle.digest('SHA-256', utf8(text));
 * ```
 *
 * @param {string} text The text.
 * @returns {Uint8Array<ArrayBuffer>} Its UTF-8 bytes.
 *
 * @public
 */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/**
 * @summary Decodes UTF-8 bytes to a string.
 *
 * @example
 * Example 1: Bytes to text
 * ```ts
 * fromUtf8(utf8('hello')); // 'hello'
 * ```
 *
 * @example
 * Example 2: A decrypted buffer
 * ```ts
 * fromUtf8(new Uint8Array(await crypto.subtle.decrypt(params, key, data)));
 * ```
 *
 * @param {Uint8Array} bytes The bytes.
 * @returns {string} The text.
 *
 * @public
 */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * @summary Encodes bytes as base64url, without padding.
 *
 * @description
 * Base64url uses `-` and `_` instead of `+` and `/`, so the result is safe in
 * URLs, file names and the dot-separated tokens of Crypto.
 *
 * @example
 * Example 1: Encoding
 * ```ts
 * toBase64Url(new Uint8Array([251, 255])); // '-_8'
 * ```
 *
 * @example
 * Example 2: An IV in a token
 * ```ts
 * const token = `v1.${keyId}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
 * ```
 *
 * @param {Uint8Array} bytes The bytes.
 * @returns {string} The base64url text.
 *
 * @public
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @summary Decodes base64 or base64url text to bytes.
 *
 * @description Accepts both alphabets, with or without padding, so key
 * material from a server in standard base64 also works.
 *
 * @example
 * Example 1: Decoding
 * ```ts
 * fromBase64Url('-_8'); // Uint8Array [251, 255]
 * ```
 *
 * @example
 * Example 2: Standard base64 from a server
 * ```ts
 * fromBase64Url('q83vEjRWeJA='); // works too
 * ```
 *
 * @param {string} text The base64 or base64url text.
 * @returns {Uint8Array<ArrayBuffer>} The bytes.
 * @throws {Error} When the text is not base64.
 *
 * @public
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @summary Encodes bytes as lowercase hexadecimal.
 *
 * @example
 * Example 1: Encoding
 * ```ts
 * toHex(new Uint8Array([0, 171])); // '00ab'
 * ```
 *
 * @example
 * Example 2: A short id from a digest
 * ```ts
 * toHex(digest.subarray(0, 8));
 * ```
 *
 * @param {Uint8Array} bytes The bytes.
 * @returns {string} Two hex digits for each byte.
 *
 * @public
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
