import type { BackoffStrategy } from '@/enums/backoff.enum';

/**
 * Parameters for computing backoff delays. This object encapsulates all the necessary
 * information about the retry state and configuration needed by various backoff strategies.
 */
export type BackoffParams = {
  /**
   * The duration in milliseconds of the most recently completed wait. This is used as the
   * "previous wait" seed in decorrelation-based strategies like `DECORRELATED_JITTER`.
   *
   * Pass the delay returned by the last `computeBackoff` call, **not** a running cumulative
   * total. The AWS Decorrelated Jitter algorithm computes the next window as
   * `random(base, min(cap, prevWait × 3))`, so feeding it a sum instead of the last single
   * delay causes the upper bound to inflate far beyond the algorithm's intent.
   */
  accumulatedTimeout: number; // most recent single delay (previous-wait seed)
  /**
   * The base recurring timeout in milliseconds. This is the seed value that all backoff
   * strategies use as a starting point for calculating wait times.
   * For example, with a base timeout of 100ms:
   * - Exponential backoff would double this value on each attempt (200ms, 400ms, etc.).
   * - Linear backoff would add a fixed increment to this value on each attempt (e.g. 100ms, 200ms, etc.).
   */
  timeout: number; // base/preset interval
  /**
   * The number of consecutive failed attempts that have occurred so far. This is a critical
   * input for all backoff strategies, as it determines how the wait time escalates with each retry.
   * For example, in exponential backoff, the wait time is calculated as `base × 2^attempts`, so the number of attempts directly influences the growth of the wait period.
   */
  attempts: number; // consecutive failures
  /**
   * A scaling factor used by certain backoff strategies (e.g. `MULTIPLICATIVE_EXPONENTIAL` and `LINEAR`) to control the growth rate of the wait time.
   * For `MULTIPLICATIVE_EXPONENTIAL`, the wait time is calculated as `base × multiplier^attempts`, so the `retryMultiplier` determines how aggressively the wait escalates with each failure.
   * For `LINEAR`, the wait time is calculated as `base + (attempts × multiplier)`, so the `retryMultiplier` defines the fixed increment added to the wait time on each attempt.
   * The value of `retryMultiplier` should be chosen carefully based on the desired backoff behavior and the characteristics of the system being retried against.
   */
  retryMultiplier: number; // scaling factor
  /**
   * The maximum number of retry attempts allowed before giving up. This parameter serves as a hard limit to prevent infinite retry loops and to ensure that the system eventually fails gracefully if the underlying issue cannot be resolved within a reasonable number of attempts.
   * Once the number of `attempts` reaches `maxRetries`, the retry mechanism should cease further attempts and typically return an error or fallback response to the caller.
   * Setting an appropriate `maxRetries` value is crucial for balancing resilience with resource utilization and user experience. Too low a value may lead to premature failure, while too high a value may cause excessive delays and resource consumption.
   */
  maxRetries: number; // upper retry limit
  /**
   * An optional upper bound on the backoff delay in milliseconds. This parameter is used to cap the maximum wait time that any backoff strategy can produce, preventing excessively long delays that could occur with aggressive strategies like exponential backoff.
   * If not provided, the backoff calculation may produce unbounded wait times based on the growth pattern of the chosen strategy. By setting `maxCapMs`, you can ensure that the wait time never exceeds a certain threshold, which is especially important in user-facing applications or when retrying critical operations.
   * The `maxCapMs` value should be chosen based on the acceptable latency for retries in your specific use
   */
  maxCapMs: number;
};
/**
 * Configurations for {@linkcode initExecuteWithRetries}
 */
export type RetryConfig<ARGS extends unknown[], R = unknown> = Partial<BackoffParams> & {
  /**
   * A function that executes the operation to be retried.
   * @param args The arguments to pass to the executor function.
   * @returns The result of the executor function, or a promise that resolves to it.
   */
  executor(...args: ARGS): R | Promise<R>;
  /**
   * A function that determines whether a retry should be attempted based on the caught error and retry count.
   * @param caught The error that was caught during the last retry attempt.
   * @param retries The number of retry attempts that have been made so far.
   * @param maxRetries The maximum number of retry attempts allowed.
   * @returns `true` if a retry should be attempted, `false` otherwise.
   */
  canRetry?(caught: unknown, retries: number, maxRetries: number): boolean;
  /** The arguments to pass to the executor function. */
  args: ARGS;
  /** The delay in milliseconds to wait before the next retry attempt. */
  sleep?: number;
  /** The backoff strategy to use when computing delays between retry attempts. Defaults to {@link BackoffStrategy.EXPONENTIAL}. */
  retryStrategy?: BackoffStrategy;
  /**
   * An optional {@link AbortSignal} that cancels the entire retry sequence. When the
   * signal fires, any in-progress inter-attempt sleep is interrupted immediately and the
   * returned promise rejects with `signal.reason`. Cancellation is also checked at the
   * top of every loop iteration, so an already-aborted signal prevents even the first
   * execution attempt from starting.
   *
   * This does **not** cancel an in-flight `executor` call - aborting a running async
   * operation is the executor's responsibility. Thread the signal through `args` and
   * handle it inside `executor` (e.g. pass it to `fetch`) to achieve full cancellation.
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   * setTimeout(() => controller.abort(new Error('Timed out')), 5_000);
   *
   * await initExecuteWithRetries({
   *   executor: fetch,
   *   args: ['https://api.example.com/data', { signal: controller.signal }],
   *   signal: controller.signal, // cancels inter-attempt sleeps
   *   timeout: 200, maxRetries: 10, maxCapMs: 30_000,
   *   retryMultiplier: 2,
   * });
   * ```
   */
  signal?: AbortSignal;
  /**
   * An optional array that accumulates every error thrown across all attempts in
   * chronological order. Each caught error is pushed immediately after it is caught,
   * so the array reflects the full failure history whether the sequence eventually
   * succeeds, exhausts its retries, is vetoed by `canRetry`, or is cancelled via
   * `signal`.
   *
   * The array reference is never reassigned - only `Array.prototype.push` is called on
   * it - making it the one intentional, documented mutation point in the retry system.
   *
   * @example
   * ```ts
   * const errors: unknown[] = [];
   * try {
   *   await initExecuteWithRetries({ ..., stack: errors });
   * } catch (final) {
   *   // errors[0] is the first failure, errors[errors.length - 1] === final
   *   console.error(`Failed after ${errors.length} attempt(s):`, errors);
   * }
   * ```
   */
  stack?: unknown[];
};
