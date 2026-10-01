// ─────────────────────────────────────────────────────────────────────────────
// URL key helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { CanonicalKey, StorageEnvelope } from '../../storage.types';
import {
  CACHE_KEY_NAMESPACE,
  HDR_BACKEND,
  HDR_EXPIRES_AT,
  HDR_SCHEMA_VERSION,
  HDR_WEIGHT,
  HDR_WRITTEN_AT,
} from './cache.const';

/**
 * @summary Convert a canonical storage key to a synthetic URL suitable for
 * use as a `Cache.match` / `Cache.put` key.
 *
 * @description
 * The Cache API requires `Request` objects (or URL strings) as keys. Canonical
 * storage keys like `'myapp:chrome:130:auth:user-session'` are not valid URLs
 * and cannot be used directly. This function wraps each canonical key inside a
 * synthetic URL by appending it as the path segment of the
 * `CACHE_KEY_NAMESPACE` origin:
 *
 * ```
 * 'myapp:chrome:130:auth:user-session'
 *                ↓
 * 'https://storage.internal/myapp:chrome:130:auth:user-session'
 * ```
 *
 * The canonical key is URL-encoded to ensure colons and other characters that
 * are technically valid in URL paths (RFC 3986) do not confuse parsers. The
 * `urlToCanonicalKey` function reverses this encoding.
 *
 * @param key - A valid canonical key string.
 * @returns   A synthetic URL string that the Cache API will accept.
 *
 * @see {@link urlToCanonicalKey} for the inverse operation.
 * @see {@link CACHE_KEY_NAMESPACE} for the namespace constant.
 */
export function canonicalKeyToURL(key: CanonicalKey): string {
  return `${CACHE_KEY_NAMESPACE}/${encodeURIComponent(key)}`;
}

/**
 * @summary Extract the canonical key from a synthetic cache URL produced by
 * `canonicalKeyToURL`.
 *
 * @description
 * Strips the `CACHE_KEY_NAMESPACE` prefix and one leading slash from the URL,
 * then URL-decodes the remainder to recover the original canonical key string.
 *
 * Returns `null` if the URL does not start with the expected namespace prefix,
 * so callers can safely filter out any genuine network-response URLs that may
 * have been inadvertently stored in the same cache bucket.
 *
 * @param url - A URL string from a `Cache.keys()` `Request.url` field.
 * @returns   The canonical key, or `null` if the URL is not from this backend.
 *
 * @see {@link canonicalKeyToURL} for the forward direction.
 */
export function urlToCanonicalKey(url: string): CanonicalKey | null {
  const prefix = `${CACHE_KEY_NAMESPACE}/`;
  if (!url.startsWith(prefix)) return null;
  return decodeURIComponent(url.slice(prefix.length)) as CanonicalKey;
}
// ── Helper: build a Response from an envelope ─────────────────────────────

export function buildResponse(envelope: StorageEnvelope<string>): Response {
  const body = JSON.stringify(envelope);
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Content-Length', String(body.length));
  headers.set(HDR_SCHEMA_VERSION, String(envelope.schema_version));
  headers.set(HDR_WRITTEN_AT, String(envelope.written_at));
  headers.set(HDR_EXPIRES_AT, envelope.expires_at !== null ? String(envelope.expires_at) : '-1');
  headers.set(HDR_WEIGHT, String(envelope.weight));
  headers.set(HDR_BACKEND, envelope.backend);
  return new Response(body, { headers });
}

// ── Helper: extract envelope from a Response ──────────────────────────────

export async function extractEnvelope(response: Response): Promise<StorageEnvelope<string>> {
  const text = await response.text();
  return JSON.parse(text) as StorageEnvelope<string>;
}

// ── Helper: get expires_at from headers without reading body ──────────────

export function getExpiresAtFromHeaders(headers: Headers): number | null {
  const val = headers.get(HDR_EXPIRES_AT);
  if (val === '-1' || val === null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

// ── Helper: get byte length from headers ──────────────────────────────────

export function getContentLength(headers: Headers): number {
  const val = headers.get('Content-Length');
  return val ? Number(val) : 0;
}
