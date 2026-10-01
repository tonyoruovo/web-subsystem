/**
 * @fileoverview
 * @summary String compression: gzip via the browser CompressionStream.
 * @description
 * Compresses a string to a base64 gzip string and back, using the browser
 * `CompressionStream`/`DecompressionStream` (gzip). This is a frontend
 * framework, so it targets the browser APIs directly.
 *
 * ```text
 *   compress(plain)   -> gzip -> base64
 *   decompress(base64) -> base64 -> gunzip -> plain
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary Compresses a string into a base64 gzip string.
 * @description
 * Gzips the UTF-8 bytes with `CompressionStream` and base64-encodes the result.
 *
 * @example
 * Example 1: Compress and decompress a round-trip
 * ```ts
 * const packed = await compress('hello '.repeat(100));
 * const plain = await decompress(packed); // "hello hello ..."
 * ```
 *
 * @param {string} data The plain string.
 * @returns {Promise<string>} The base64 gzip string.
 */
export async function compress(data: string): Promise<string> {
  const input = new TextEncoder().encode(data);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  }).pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return bytesToBase64(await readAllBytes(stream));
}

/**
 * @summary Decompresses a base64 gzip string back into a string.
 * @description
 * Base64-decodes, gunzips with `DecompressionStream`, and decodes UTF-8.
 *
 * @param {string} data The base64 gzip string.
 * @returns {Promise<string>} The plain string.
 */
export async function decompress(data: string): Promise<string> {
  const bytes = base64ToBytes(data);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new TextDecoder().decode(await readAllBytes(stream));
}

/**
 * @summary Reads every chunk of a byte stream into one buffer.
 * @param {ReadableStream<Uint8Array>} stream The stream.
 * @returns {Promise<Uint8Array>} The concatenated bytes.
 * @internal
 */
async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * @summary Encodes bytes as a base64 string.
 * @param {Uint8Array} bytes The bytes.
 * @returns {string} The base64 string.
 * @internal
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * @summary Decodes a base64 string into bytes.
 * @param {string} base64 The base64 string.
 * @returns {Uint8Array} The bytes.
 * @internal
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
