/**
 * @fileoverview
 * @summary Adapts the CryptoManager to the Storage facade's string codec.
 * @description
 * The Storage facade encrypts and signs through a string-to-string
 * {@linkcode StorageCodec}. The CryptoManager produces an {@linkcode EncryptedBlob}
 * of ArrayBuffers and signs HMAC tags as ArrayBuffers. This adapter bridges the
 * two by base64-encoding the blob and tag into strings. Compression is a no-op
 * here: a real CompressionStream plugs into `compress` and `decompress`.
 *
 * ```text
 *   encrypt(plain)  -> EncryptedBlob -> JSON { keyId, iv, ciphertext } base64
 *   decrypt(cipher) -> JSON.parse     -> EncryptedBlob -> plain
 *   sign(data)      -> hmac(data)     -> base64
 *   verify(tag, d)  -> base64 -> hmac verify
 *   ```
 *
 * @see {@linkcode CryptoManager}
 * @see {@linkcode StorageCodec}
 * @author MathAid
 */

import { CryptoManager } from './crypto.manager';
import { compress as gzip, decompress as gunzip } from '../compression';
import type { StorageCodec } from '../storage/storage.facade';

/**
 * @summary Builds a Storage codec backed by a CryptoManager.
 * @description
 * Encryption and integrity come from the CryptoManager. Compression is a no-op
 * placeholder; replace the two no-op functions with a CompressionStream adapter
 * when real compression is needed.
 *
 * @param {CryptoManager} cm The initialized CryptoManager.
 * @returns {StorageCodec} The codec for a Storage facade.
 */
export function cryptoCodec(cm: CryptoManager): StorageCodec {
  return {
    async encrypt(plain: string): Promise<string> {
      const blob = await cm.encrypt(plain);
      return JSON.stringify({
        keyId: blob.keyId,
        iv: bufToB64(blob.iv),
        ciphertext: bufToB64(blob.ciphertext),
      });
    },

    async decrypt(cipher: string): Promise<string> {
      const parsed = JSON.parse(cipher) as { keyId: string; iv: string; ciphertext: string };
      return cm.decrypt({
        keyId: parsed.keyId,
        iv: b64ToBuf(parsed.iv),
        ciphertext: b64ToBuf(parsed.ciphertext),
      });
    },

    async compress(plain: string): Promise<string> {
      return gzip(plain);
    },

    async decompress(compressed: string): Promise<string> {
      return gunzip(compressed);
    },

    async sign(data: string): Promise<string> {
      return bufToB64(await cm.hmac(data));
    },

    async verify(tag: string, data: string): Promise<boolean> {
      return cm.verifyHmac(b64ToBuf(tag), data);
    },
  };
}

/**
 * @summary Encodes an ArrayBuffer as base64.
 * @param {ArrayBuffer} buf The buffer.
 * @returns {string} The base64 string.
 * @internal
 */
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * @summary Decodes a base64 string into an ArrayBuffer.
 * @param {string} b64 The base64 string.
 * @returns {ArrayBuffer} The buffer.
 * @internal
 */
function b64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
