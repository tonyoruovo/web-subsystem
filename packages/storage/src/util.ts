/**
 * @fileoverview
 * @summary Small helpers that the backends and the key functions share.
 * @description
 * `sizeOf` estimates the memory size of a value for quota and eviction
 * decisions. `isNil` and `anyNil` check for `null` and `undefined`. They came
 * from the old `src/libs` and live here so the package has no app-level import.
 *
 * @example
 * Sizing an envelope before eviction
 * ```ts
 * freed += sizeOf(envelope);
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Estimates the memory size of a value, in bytes.
 *
 * @description
 * Strings count 2 bytes for each UTF-16 code unit, numbers 8, booleans 4 and
 * dates 8. Typed arrays and blobs count their byte length. Arrays and plain
 * objects count the sum of their parts, keys included. It is an estimate for
 * eviction and quota decisions, not an exact measure.
 *
 * @example
 * Example 1: A string
 * ```ts
 * sizeOf('abc'); // 6
 * ```
 *
 * @example
 * Example 2: An envelope
 * ```ts
 * sizeOf({ payload: 'x', weight: 1 }); // 2 * 7 + 2 + 2 * 6 + 8
 * ```
 *
 * @param {unknown} value Any value.
 * @returns {number} The estimated size in bytes. `null` and `undefined` give 0.
 *
 * @public
 */
export function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    if (value instanceof Date) return 8;
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + sizeOf(item), 0);
    let size = 0;
    for (const key of Object.keys(value)) {
      size += sizeOf(key) + sizeOf((value as Record<string, unknown>)[key]);
    }
    return size;
  }
  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
      return 8;
    case 'boolean':
      return 4;
    default:
      return 0;
  }
}

/**
 * @summary Tells if a value is `null` or `undefined`.
 *
 * @example
 * Example 1: A missing segment
 * ```ts
 * isNil(segments.domain); // true when the domain is not set
 * ```
 *
 * @example
 * Example 2: A zero is not nil
 * ```ts
 * isNil(0); // false
 * ```
 *
 * @param {unknown} value Any value.
 * @returns {boolean} `true` for `null` and `undefined`.
 *
 * @public
 */
export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * @summary Tells if any of the values is `null` or `undefined`.
 *
 * @example
 * Example 1: Checking key segments
 * ```ts
 * anyNil(platform, platformVersion, callingModule);
 * ```
 *
 * @example
 * Example 2: All set
 * ```ts
 * anyNil('a', 1, false); // false
 * ```
 *
 * @param {...unknown} values The values.
 * @returns {boolean} `true` when at least one value is `null` or `undefined`.
 *
 * @public
 */
export function anyNil(...values: unknown[]): boolean {
  return values.some(isNil);
}
