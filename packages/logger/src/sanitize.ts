/**
 * @fileoverview
 * @summary Redacts sensitive values from log context before it is kept.
 * @description
 * A log outlives the request that produced it and may be persisted or
 * exported, so secrets must never reach it. {@linkcode sanitize} copies a
 * context object, replacing the value of every key that looks sensitive, and
 * turning values that cannot be cloned (functions, errors, class instances)
 * into plain descriptions.
 *
 * ```text
 *   { url: '/api', headers: { Authorization: 'Bearer x' }, error: new Error('boom') }
 *     --> { url: '/api', headers: { Authorization: '[REDACTED]' }, error: { name: 'Error', message: 'boom' } }
 *   ```
 *
 * @example
 * With the default patterns
 * ```ts
 * sanitize({ user: 'ada', password: 'hunter2' }); // { user: 'ada', password: '[REDACTED]' }
 * ```
 *
 * @example
 * With extra patterns
 * ```ts
 * sanitize({ ssn: '123' }, { patterns: [...DEFAULT_SENSITIVE_PATTERNS, 'ssn'] });
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Key fragments treated as sensitive by default, matched case-insensitively.
 * @constant {readonly string[]}
 * @public
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  'token',
  'password',
  'passwd',
  'secret',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'api_key',
  'api-key',
  'private',
];

/**
 * @summary What a redacted value is replaced with.
 * @constant {'[REDACTED]'}
 * @public
 */
export const REDACTED = '[REDACTED]';

/**
 * @summary Options for {@linkcode sanitize}.
 *
 * @description
 * `patterns` are key fragments, matched case-insensitively anywhere in a key
 * (default {@linkcode DEFAULT_SENSITIVE_PATTERNS}). `maxDepth` is how deep
 * nested objects are copied; deeper ones become `'[Truncated]'` (default 6).
 *
 * @example
 * Example 1: Also redacting card numbers
 * ```ts
 * const options: SanitizeOptions = { patterns: [...DEFAULT_SENSITIVE_PATTERNS, 'card'] };
 * ```
 *
 * @example
 * Example 2: Shallow copies only
 * ```ts
 * sanitize(context, { maxDepth: 1 });
 * ```
 *
 * @public
 */
export interface SanitizeOptions {
  /**
   * @summary The key fragments to treat as sensitive.
   * @description The match ignores case and looks anywhere in the key. The default is {@linkcode DEFAULT_SENSITIVE_PATTERNS}.
   */
  readonly patterns?: readonly string[];
  /**
   * @summary The depth up to which nested objects are copied.
   * @description Deeper objects become `[Truncated]`. The default is 6.
   */
  readonly maxDepth?: number;
}

/**
 * @summary Copies a log context, redacting sensitive keys and describing values that cannot be cloned.
 *
 * @description
 * - A key containing a sensitive pattern: its value becomes `'[REDACTED]'`.
 * - Plain objects and arrays: copied, recursively, up to `maxDepth`.
 * - `Error`: `{ name, message }` (the stack is left out: it can hold paths and data).
 * - `Date`: its ISO string. `bigint`: its decimal string.
 * - Functions and symbols: `'[Function]'` and the symbol's description.
 * - Other class instances (`Map`, DOM nodes, ...): `'[ClassName]'`.
 * - A reference back to an enclosing object: `'[Circular]'`.
 *
 * The result is always `structuredClone`-able.
 *
 * @example
 * Example 1: Nested secrets
 * ```ts
 * sanitize({ request: { headers: { 'X-Api-Key': 'k' } } });
 * // { request: { headers: { 'X-Api-Key': '[REDACTED]' } } }
 * ```
 *
 * @example
 * Example 2: An error in context
 * ```ts
 * sanitize({ error: new TypeError('bad') }); // { error: { name: 'TypeError', message: 'bad' } }
 * ```
 *
 * @param {Readonly<Record<string, unknown>>} context The context to copy.
 * @param {SanitizeOptions} [options] Patterns and depth.
 * @returns {Record<string, unknown>} The sanitized copy.
 *
 * @public
 */
export function sanitize(
  context: Readonly<Record<string, unknown>>,
  options: SanitizeOptions = {},
): Record<string, unknown> {
  const patterns = (options.patterns ?? DEFAULT_SENSITIVE_PATTERNS).map((p) => p.toLowerCase());
  const maxDepth = options.maxDepth ?? 6;
  const seen = new WeakSet<object>();
  const sensitive = (key: string) => {
    const lower = key.toLowerCase();
    return patterns.some((pattern) => lower.includes(pattern));
  };

  const copy = (value: unknown, depth: number): unknown => {
    switch (typeof value) {
      case 'function':
        return '[Function]';
      case 'symbol':
        return value.description ?? '[Symbol]';
      case 'bigint':
        return value.toString();
      case 'object':
        break;
      default:
        return value;
    }
    if (value === null) return null;
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return '[Circular]';
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      return `[${(value as object).constructor?.name ?? 'Object'}]`;
    }
    if (depth >= maxDepth) return '[Truncated]';
    seen.add(value); // ancestors only: a value shared by two branches is copied twice
    let out: unknown;
    if (isArray) {
      out = value.map((item) => copy(item, depth + 1));
    } else {
      const record: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        record[key] = sensitive(key) ? REDACTED : copy(item, depth + 1);
      }
      out = record;
    }
    seen.delete(value);
    return out;
  };

  return copy(context, 0) as Record<string, unknown>;
}
