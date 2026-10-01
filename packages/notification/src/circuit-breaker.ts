/**
 * @fileoverview
 * @summary A circuit breaker per subscriber: stop calling one that keeps failing.
 * @description
 * Ported from the original Notification Center. Each subscriber has a
 * breaker:
 *
 * ```text
 *   CLOSED --(failureThreshold failures in a row)--> OPEN
 *   OPEN   --(resetTimeoutMs passes)---------------> HALF_OPEN (one trial delivery)
 *   HALF_OPEN --(success)--> CLOSED     HALF_OPEN --(failure)--> OPEN again
 *   ```
 *
 * A broadcast skips a subscriber whose breaker is `OPEN`, so one broken
 * subscriber cannot slow every broadcast down.
 *
 * @example
 * Guarding a delivery
 * ```ts
 * import { CircuitBreakers } from '@platform/notification';
 *
 * const breakers = new CircuitBreakers({ failureThreshold: 3, resetTimeoutMs: 30_000 });
 * if (breakers.allows('analytics')) {
 *   try { await deliver(); breakers.succeeded('analytics'); }
 *   catch { breakers.failed('analytics'); }
 * }
 * ```
 *
 * @author MathAid
 */

/**
 * @summary A breaker's state.
 * @public
 */
export type CircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * @summary One subscriber's breaker.
 *
 * @example
 * Example 1: A healthy subscriber
 * ```ts
 * // { status: 'CLOSED', failures: 0, openedAt: null }
 * ```
 *
 * @example
 * Example 2: A subscriber taken out of rotation
 * ```ts
 * // { status: 'OPEN', failures: 3, openedAt: 1700000000000 }
 * ```
 *
 * @public
 */
export interface CircuitState {
  readonly status: CircuitStatus;
  /** Consecutive failures. */
  readonly failures: number;
  /** When the breaker last opened, or `null`. */
  readonly openedAt: number | null;
}

/**
 * @summary Circuit breakers, one per subscriber key.
 *
 * @description
 * `allows(key)` says whether a delivery may be attempted (moving an `OPEN`
 * breaker to `HALF_OPEN` once `resetTimeoutMs` has passed); `succeeded` and
 * `failed` record the outcome; `state(key)` reads a breaker; `forget(key)`
 * drops one.
 *
 * The Notification Center keeps one instance for all its subscribers.
 *
 * @example
 * Example 1: Opening after repeated failures
 * ```ts
 * const breakers = new CircuitBreakers({ failureThreshold: 2, resetTimeoutMs: 1_000 });
 * breakers.failed('a');
 * breakers.failed('a');
 * breakers.allows('a'); // false until 1 s has passed
 * ```
 *
 * @example
 * Example 2: A fake clock in tests
 * ```ts
 * let t = 0;
 * const breakers = new CircuitBreakers({ failureThreshold: 1, resetTimeoutMs: 10, now: () => t });
 * ```
 *
 * @public
 */
export class CircuitBreakers {
  readonly #states = new Map<string, CircuitState>();

  /**
   * @param {object} options `failureThreshold`, `resetTimeoutMs`, and an optional clock `now`.
   */
  constructor(
    private readonly options: {
      readonly failureThreshold: number;
      readonly resetTimeoutMs: number;
      readonly now?: () => number;
    },
  ) {}

  /**
   * @summary Returns a subscriber's breaker.
   * @param {string} key The subscriber key.
   * @returns {CircuitState} Its state; `CLOSED` for an unknown key.
   */
  state(key: string): CircuitState {
    return this.#states.get(key) ?? { status: 'CLOSED', failures: 0, openedAt: null };
  }

  /**
   * @summary Tells whether a delivery may be attempted, moving `OPEN` to `HALF_OPEN` after the reset timeout.
   * @param {string} key The subscriber key.
   * @returns {boolean} `false` while the breaker is open.
   */
  allows(key: string): boolean {
    const state = this.state(key);
    if (state.status !== 'OPEN') return true;
    if (this.#now() - (state.openedAt ?? 0) < this.options.resetTimeoutMs) return false;
    this.#states.set(key, { ...state, status: 'HALF_OPEN' });
    return true;
  }

  /**
   * @summary Records a successful delivery: the breaker closes.
   * @param {string} key The subscriber key.
   */
  succeeded(key: string): void {
    this.#states.delete(key);
  }

  /**
   * @summary Records a failed delivery: the breaker opens at the threshold, or again after a failed trial.
   * @param {string} key The subscriber key.
   */
  failed(key: string): void {
    const state = this.state(key);
    const failures = state.failures + 1;
    const open = state.status === 'HALF_OPEN' || failures >= this.options.failureThreshold;
    this.#states.set(key, {
      status: open ? 'OPEN' : 'CLOSED',
      failures,
      openedAt: open ? this.#now() : null,
    });
  }

  /**
   * @summary Drops a subscriber's breaker, for example when it unsubscribes.
   * @param {string} key The subscriber key.
   */
  forget(key: string): void {
    this.#states.delete(key);
  }

  /** @summary The clock. @internal */
  #now(): number {
    return (this.options.now ?? Date.now)();
  }
}
