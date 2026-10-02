/**
 * @fileoverview
 * @summary Retry backoff: how long to wait before the next attempt.
 * @description
 * Ported from the project's original backoff library (`src/libs/backoff.ts`)
 * for every package that retries: the Queue (M3), and Network, Sync and
 * Realtime later. The formulas are unchanged; the API takes one options
 * object and the strategy is a string, so it can live in serializable
 * configuration.
 *
 * ```text
 *   strategy                    wait (before the cap)
 *   exponential                 base * 2^attempts
 *   multiplicative-exponential  base * multiplier^attempts
 *   linear                      base + attempts * multiplier
 *   exponential-jitter          random(0, base * 2^attempts)
 *   decorrelated-jitter         random(base, min(cap, previousWait * 3))
 *   ```
 *
 * | Scenario                                   | Strategy                                       |
 * |--------------------------------------------|------------------------------------------------|
 * | General-purpose transient faults           | `exponential`                                  |
 * | Tunable growth rate                        | `multiplicative-exponential`                   |
 * | Predictable, human-readable waits          | `linear`                                       |
 * | Many clients retrying the same endpoint    | `exponential-jitter` or `decorrelated-jitter`  |
 *
 * @example
 * Waiting before a retry
 * ```ts
 * import { computeBackoff } from '@platform/core';
 *
 * const wait = computeBackoff({ base: 100, attempts: 3, strategy: 'exponential-jitter' });
 * await new Promise((r) => setTimeout(r, wait));
 * ```
 *
 * @example
 * Decorrelated jitter, carrying the previous wait
 * ```ts
 * let previousWait = 0;
 * for (let attempts = 1; attempts <= 5; attempts++) {
 *   previousWait = computeBackoff({ base: 100, attempts, previousWait, strategy: 'decorrelated-jitter' });
 * }
 * ```
 *
 * @see {@link https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ Exponential backoff and jitter}
 * @author MathAid
 */

/**
 * @summary How the wait between retries grows.
 * @description
 * - `exponential`: doubles each attempt. The general-purpose default.
 * - `multiplicative-exponential`: grows by `multiplier` each attempt.
 * - `linear`: grows by `multiplier` milliseconds each attempt.
 * - `exponential-jitter`: a random wait up to the exponential one; spreads out many clients.
 * - `decorrelated-jitter`: a random wait up to three times the previous one; smoothest for large fleets.
 *
 * @public
 */
export type BackoffStrategy =
  | 'exponential'
  | 'multiplicative-exponential'
  | 'linear'
  | 'exponential-jitter'
  | 'decorrelated-jitter';

/**
 * @summary The input of {@linkcode computeBackoff}.
 *
 * @description
 * `base` is the starting wait and `attempts` the number of failures so far.
 * `strategy` picks the formula (default `exponential`). `multiplier` feeds the
 * multiplicative and linear formulas (default `1.5`). `previousWait` seeds
 * decorrelated jitter. `maxCapMs` caps the result (default: the larger of 30 s
 * and 100 times `base`). `random` replaces the randomness source, for tests.
 *
 * @example
 * Example 1: The common case
 * ```ts
 * const options: BackoffOptions = { base: 200, attempts: 2 };
 * ```
 *
 * @example
 * Example 2: Deterministic jitter in a test
 * ```ts
 * const options: BackoffOptions = { base: 100, attempts: 3, strategy: 'exponential-jitter', random: () => 0.5 };
 * ```
 *
 * @public
 */
export interface BackoffOptions {
  /**
   * @summary The first wait, in milliseconds.
   * @description All strategies scale this value.
   */
  readonly base: number;
  /**
   * @summary The number of failures until now.
   * @description Use 1 for the first retry. The wait grows with this number.
   */
  readonly attempts: number;
  /**
   * @summary The formula that computes the wait.
   * @description The default is `exponential`.
   */
  readonly strategy?: BackoffStrategy;
  /**
   * @summary The growth factor of `multiplicative-exponential`, or the step of `linear`.
   * @description For `linear`, the value is in milliseconds for each attempt. The default is `1.5`.
   */
  readonly multiplier?: number;
  /**
   * @summary The previous wait, for `decorrelated-jitter`.
   * @description The default is `base`.
   */
  readonly previousWait?: number;
  /**
   * @summary The longest wait to return, in milliseconds.
   * @description The default is the larger of 30000 and `base * 100`.
   */
  readonly maxCapMs?: number;
  /**
   * @summary Returns a random number from 0 (included) to 1 (not included).
   * @description The default uses `crypto.getRandomValues`. Tests give a fixed value.
   */
  readonly random?: () => number;
}

/**
 * @summary A cryptographically strong random number in [0, 1).
 * @returns {number} The number.
 * @internal
 */
function secureRandom(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  // Dividing by 2^32 keeps the result strictly below 1.
  return value[0] / 0x1_0000_0000;
}

/**
 * @summary Computes the wait before the next retry.
 *
 * @description
 * Applies the chosen strategy's formula (see the file overview) and caps the
 * result at `maxCapMs`. It never waits: callers schedule the retry.
 *
 * @example
 * Example 1: Exponential growth
 * ```ts
 * computeBackoff({ base: 100, attempts: 1 }); // 200
 * computeBackoff({ base: 100, attempts: 3 }); // 800
 * ```
 *
 * @example
 * Example 2: Linear growth with a cap
 * ```ts
 * computeBackoff({ base: 100, attempts: 50, strategy: 'linear', multiplier: 500, maxCapMs: 5_000 }); // 5000
 * ```
 *
 * @param {BackoffOptions} options The base wait, the attempt count, the strategy and its parameters.
 * @returns {number} The wait in milliseconds, between 0 and the cap.
 *
 * @public
 */
export function computeBackoff(options: BackoffOptions): number {
  const { base, attempts, strategy = 'exponential', multiplier = 1.5 } = options;
  const random = options.random ?? secureRandom;
  const maxCapMs = options.maxCapMs ?? Math.max(30_000, base * 100);

  let wait: number;
  switch (strategy) {
    case 'multiplicative-exponential':
      wait = base * Math.pow(multiplier, attempts);
      break;
    case 'linear':
      wait = base + attempts * multiplier;
      break;
    case 'exponential-jitter':
      wait = random() * base * Math.pow(2, attempts);
      break;
    case 'decorrelated-jitter': {
      const previous = options.previousWait || base;
      const upper = Math.max(base, Math.min(maxCapMs, previous * 3));
      wait = base + random() * (upper - base);
      break;
    }
    case 'exponential':
    default:
      wait = base * Math.pow(2, attempts);
  }
  return Math.min(maxCapMs, wait);
}
