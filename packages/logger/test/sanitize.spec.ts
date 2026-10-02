import { describe, expect, it } from 'vitest';

import { DEFAULT_SENSITIVE_PATTERNS, REDACTED, sanitize } from '../src';

describe('sanitize', () => {
  it('redacts sensitive keys at any depth, case-insensitively', () => {
    expect(
      sanitize({
        url: '/api',
        headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k' },
        list: [{ password: 'p' }],
      }),
    ).toEqual({
      url: '/api',
      headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED },
      list: [{ password: REDACTED }],
    });
  });

  it('describes values that cannot be cloned', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const shared = { n: 1 };
    const result = sanitize({
      error: new TypeError('bad'),
      when: new Date(0),
      big: 10n,
      fn: () => 1,
      sym: Symbol('tag'),
      anonymous: Symbol(),
      map: new Map(),
      bare: Object.create(null) as object,
      circular,
      a: shared,
      b: shared,
      nothing: null,
      missing: undefined,
    });
    expect(result).toEqual({
      error: { name: 'TypeError', message: 'bad' },
      when: '1970-01-01T00:00:00.000Z',
      big: '10',
      fn: '[Function]',
      sym: 'tag',
      anonymous: '[Symbol]',
      map: '[Map]',
      bare: {},
      circular: { name: 'loop', self: '[Circular]' },
      a: { n: 1 },
      b: { n: 1 },
      nothing: null,
      missing: undefined,
    });
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('honours custom patterns and depth', () => {
    expect(sanitize({ ssn: '1', token: 't' }, { patterns: ['SSN'] })).toEqual({
      ssn: REDACTED,
      token: 't',
    });
    expect(sanitize({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({
      a: { b: '[Truncated]' },
    });
    expect(DEFAULT_SENSITIVE_PATTERNS).toContain('password');
  });
});
