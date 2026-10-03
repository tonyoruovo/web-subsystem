/**
 * Unit tests for all pure utility functions across the storage backends.
 * Covers: storage.util.ts, cache.util.ts, opfs.utils.ts
 */
import { describe, expect, it } from 'vitest';

import type {
  CanonicalKey,
  ICanonicalKeySegments,
  StorageEnvelope,
  UnderlyingPlatform,
} from '../src';
import {
  base64ToBytes,
  buildCanonicalKey,
  buildModulePrefix,
  buildResponse,
  bytesToBase64,
  CACHE_KEY_NAMESPACE,
  canonicalKeyToURL,
  extractEnvelope,
  getContentLength,
  getExpiresAtFromHeaders,
  HDR_BACKEND,
  HDR_EXPIRES_AT,
  HDR_SCHEMA_VERSION,
  HDR_WEIGHT,
  HDR_WRITTEN_AT,
  keyToFilePath,
  parseCanonicalKey,
  urlToCanonicalKey,
} from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ───────────────────────────────────────────────────────────────────────────

const VALID_SEGMENTS: ICanonicalKeySegments = {
  domain: 'myapp',
  platform: 'chrome' as unknown as UnderlyingPlatform,
  platformVersion: 130,
  callingModule: 'auth',
  actualKey: 'session-token',
};

const VALID_KEY: CanonicalKey = 'myapp:chrome:130:auth:session-token';

function makeEnvelope(overrides: Partial<StorageEnvelope<string>> = {}): StorageEnvelope<string> {
  return {
    payload: 'encrypted-payload-string',
    schema_version: 1,
    written_at: 1700000000000,
    expires_at: 1700003600000,
    weight: 5,
    backend: 'cache',
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. storage.util – buildCanonicalKey
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('buildCanonicalKey', () => {
  it('joins segments with colons', () => {
    const result = buildCanonicalKey(VALID_SEGMENTS);
    expect(result).toBe(VALID_KEY);
  });

  it('returns a typed CanonicalKey', () => {
    const result = buildCanonicalKey(VALID_SEGMENTS);
    expect(result).toBe(VALID_KEY);
  });

  it('throws when domain is empty', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, domain: '' })).toThrow(
      '[CanonicalKey] "domain" must not be empty',
    );
  });

  it('throws when platform is empty', () => {
    expect(() =>
      buildCanonicalKey({ ...VALID_SEGMENTS, platform: '' as UnderlyingPlatform }),
    ).toThrow('[CanonicalKey] "platform" must not be empty');
  });

  it('throws when callingModule is empty', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, callingModule: '' })).toThrow(
      '[CanonicalKey] "callingModule" must not be empty',
    );
  });

  it('throws when actualKey is empty', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, actualKey: '' })).toThrow(
      '[CanonicalKey] "actualKey" must not be empty',
    );
  });

  it('throws on unknown platform', () => {
    expect(() =>
      buildCanonicalKey({ ...VALID_SEGMENTS, platform: 'unknown' as UnderlyingPlatform }),
    ).toThrow('Unknown platform "unknown"');
  });

  it('rejects negative platformVersion', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, platformVersion: -1 })).toThrow(
      'non-negative integer',
    );
  });

  it('rejects fractional platformVersion', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, platformVersion: 1.5 })).toThrow(
      'non-negative integer',
    );
  });

  it('allows platformVersion = 0', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, platformVersion: 0 })).not.toThrow();
  });

  it('throws when domain contains separator', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, domain: 'my:app' })).toThrow(
      'must not contain the separator character',
    );
  });

  it('throws when callingModule contains separator', () => {
    expect(() => buildCanonicalKey({ ...VALID_SEGMENTS, callingModule: 'auth:module' })).toThrow(
      'must not contain the separator character',
    );
  });

  it('allows colons in actualKey', () => {
    const key = buildCanonicalKey({ ...VALID_SEGMENTS, actualKey: 'theme:dark:mode' });
    expect(key).toBe('myapp:chrome:130:auth:theme:dark:mode');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. storage.util – parseCanonicalKey
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('parseCanonicalKey', () => {
  it('round-trips with buildCanonicalKey', () => {
    const parsed = parseCanonicalKey(VALID_KEY);
    expect(parsed).toEqual(VALID_SEGMENTS);
  });

  it('handles actualKey containing colons', () => {
    const key = 'myapp:chrome:130:auth:theme:dark:mode';
    const parsed = parseCanonicalKey(key);
    expect(parsed).not.toBeNull();
    expect(parsed!.actualKey).toBe('theme:dark:mode');
  });

  it('returns null for fewer than 5 segments', () => {
    expect(parseCanonicalKey('a:b:c')).toBeNull();
    expect(parseCanonicalKey('a:b:c:d')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCanonicalKey('')).toBeNull();
  });

  it('returns null for invalid platform', () => {
    expect(parseCanonicalKey('app:invalid:1:mod:key')).toBeNull();
  });

  it('returns null for non-integer version', () => {
    expect(parseCanonicalKey('app:chrome:abc:mod:key')).toBeNull();
  });

  it('returns null for negative version', () => {
    expect(parseCanonicalKey('app:chrome:-1:mod:key')).toBeNull();
  });

  it('returns null for any empty segment', () => {
    expect(parseCanonicalKey(':chrome:130:auth:key')).toBeNull();
    expect(parseCanonicalKey('app::130:auth:key')).toBeNull();
    expect(parseCanonicalKey('app:chrome::auth:key')).toBeNull();
    expect(parseCanonicalKey('app:chrome:130::key')).toBeNull();
    expect(parseCanonicalKey('app:chrome:130:auth:')).toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. storage.util – buildModulePrefix
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('buildModulePrefix', () => {
  it('builds from segments object', () => {
    const prefix = buildModulePrefix(VALID_SEGMENTS);
    expect(prefix).toBe('myapp:chrome:130:auth:');
  });

  it('builds from individual arguments', () => {
    const prefix = buildModulePrefix('myapp', 'chrome' as UnderlyingPlatform, 130, 'auth');
    expect(prefix).toBe('myapp:chrome:130:auth:');
  });

  it('returns empty string for nil domain (object overload)', () => {
    expect(buildModulePrefix(undefined as never)).toBe('');
  });

  it('returns empty string for nil platform (args overload)', () => {
    expect(buildModulePrefix('myapp', undefined as never, 130, 'auth')).toBe('');
  });

  it('returns empty string for nil callingModule (args overload)', () => {
    expect(
      buildModulePrefix('myapp', 'chrome' as UnderlyingPlatform, 130, undefined as never),
    ).toBe('');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. cache.util – keyToUrl / urlToKey
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('canonicalKeyToURL / urlToCanonicalKey', () => {
  it('round-trips a canonical key', () => {
    const url = canonicalKeyToURL(VALID_KEY);
    expect(url).toBe(`${CACHE_KEY_NAMESPACE}/${encodeURIComponent(VALID_KEY)}`);
    expect(urlToCanonicalKey(url)).toBe(VALID_KEY);
  });

  it('round-trips a key with colons in actualKey', () => {
    const key = 'myapp:chrome:130:auth:theme:dark' as CanonicalKey;
    expect(urlToCanonicalKey(canonicalKeyToURL(key))).toBe(key);
  });

  it('urlToCanonicalKey returns null for non-matching URL', () => {
    expect(urlToCanonicalKey('https://example.com/something')).toBeNull();
  });

  it('urlToCanonicalKey returns null for empty string', () => {
    expect(urlToCanonicalKey('')).toBeNull();
  });

  it('urlToCanonicalKey handles URL-encoded colons', () => {
    const key = 'myapp:chrome:130:auth:test%3Akey' as CanonicalKey;
    expect(urlToCanonicalKey(canonicalKeyToURL(key))).toBe('myapp:chrome:130:auth:test%3Akey');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. cache.util – buildResponse
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('buildResponse', () => {
  it('sets Content-Type to application/json', () => {
    const response = buildResponse(makeEnvelope());
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('sets Content-Length from the JSON body', () => {
    const env = makeEnvelope();
    const response = buildResponse(env);
    const expected = JSON.stringify(env).length;
    expect(response.headers.get('Content-Length')).toBe(String(expected));
  });

  it('mirrors schema_version in header', () => {
    const response = buildResponse(makeEnvelope({ schema_version: 42 }));
    expect(response.headers.get(HDR_SCHEMA_VERSION)).toBe('42');
  });

  it('mirrors written_at in header', () => {
    const response = buildResponse(makeEnvelope({ written_at: 9999999 }));
    expect(response.headers.get(HDR_WRITTEN_AT)).toBe('9999999');
  });

  it('uses "-1" sentinel for null expires_at', () => {
    const response = buildResponse(makeEnvelope({ expires_at: null }));
    expect(response.headers.get(HDR_EXPIRES_AT)).toBe('-1');
  });

  it('stores numeric expires_at in header', () => {
    const response = buildResponse(makeEnvelope({ expires_at: 1700050000000 }));
    expect(response.headers.get(HDR_EXPIRES_AT)).toBe('1700050000000');
  });

  it('mirrors weight in header', () => {
    const response = buildResponse(makeEnvelope({ weight: 99 }));
    expect(response.headers.get(HDR_WEIGHT)).toBe('99');
  });

  it('mirrors backend kind in header', () => {
    const response = buildResponse(makeEnvelope({ backend: 'cache' }));
    expect(response.headers.get(HDR_BACKEND)).toBe('cache');
  });

  it('body is valid JSON that round-trips through extractEnvelope', async () => {
    const env = makeEnvelope();
    const response = buildResponse(env);
    const extracted = await extractEnvelope(response);
    expect(extracted).toEqual(env);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. cache.util – extractEnvelope
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('extractEnvelope', () => {
  it('deserializes a valid JSON response', async () => {
    const env = makeEnvelope();
    const response = new Response(JSON.stringify(env), {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await extractEnvelope(response)).toEqual(env);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. cache.util – getExpiresAtFromHeaders
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getExpiresAtFromHeaders', () => {
  it('returns null when header is missing', () => {
    expect(getExpiresAtFromHeaders(new Headers())).toBeNull();
  });

  it('returns null for "-1" sentinel', () => {
    const h = new Headers();
    h.set(HDR_EXPIRES_AT, '-1');
    expect(getExpiresAtFromHeaders(h)).toBeNull();
  });

  it('returns null for non-numeric value', () => {
    const h = new Headers();
    h.set(HDR_EXPIRES_AT, 'not-a-number');
    expect(getExpiresAtFromHeaders(h)).toBeNull();
  });

  it('returns the number for valid timestamp', () => {
    const h = new Headers();
    h.set(HDR_EXPIRES_AT, '1700003600000');
    expect(getExpiresAtFromHeaders(h)).toBe(1700003600000);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. cache.util – getContentLength
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getContentLength', () => {
  it('returns the numeric value', () => {
    const h = new Headers();
    h.set('Content-Length', '1024');
    expect(getContentLength(h)).toBe(1024);
  });

  it('returns 0 when header is missing', () => {
    expect(getContentLength(new Headers())).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. opfs.utils – keyToFilePath
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('keyToFilePath', () => {
  it('maps canonical key to directory hierarchy', () => {
    expect(keyToFilePath(VALID_KEY)).toBe('myapp/chrome/130/auth/session-token');
  });

  it('percent-encodes colons in actualKey', () => {
    const key = 'myapp:chrome:130:auth:theme:dark' as CanonicalKey;
    expect(keyToFilePath(key)).toBe('myapp/chrome/130/auth/theme%3Adark');
  });

  it('throws for malformed key (too few segments)', () => {
    expect(() => keyToFilePath('a:b:c' as CanonicalKey)).toThrow('malformed canonical key');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. opfs.utils – base64 round-trip
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips empty bytes', () => {
    const bytes = new Uint8Array(0);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips ASCII text', () => {
    const bytes = new TextEncoder().encode('Hello, OPFS world!');
    const recovered = base64ToBytes(bytesToBase64(bytes));
    expect(new TextDecoder().decode(recovered)).toBe('Hello, OPFS world!');
  });

  it('round-trips binary data', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const recovered = base64ToBytes(bytesToBase64(bytes));
    expect(recovered).toEqual(bytes);
  });

  it('round-trips large payload (10 KB)', () => {
    const bytes = new Uint8Array(10_000);
    crypto.getRandomValues(bytes);
    const recovered = base64ToBytes(bytesToBase64(bytes));
    expect(recovered).toEqual(bytes);
  });
});
