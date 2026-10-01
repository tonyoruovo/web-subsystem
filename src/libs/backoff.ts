/**
 * Backoff strategies for retrying asynchronous operations after failures.
 *
 * This module provides a comprehensive set of backoff strategies that can be used to
 * calculate the delay before retrying an operation that has failed. The strategies include
 * exponential backoff, multiplicative exponential backoff, linear backoff, exponential backoff with jitter,
 * and decorrelated jitter backoff. Each strategy is designed to handle different retry scenarios and
 * is suitable for various use cases, from simple single-client retries to complex distributed systems.
 *
 * The `computeBackoff` function serves as a unified interface for calculating backoff delays based on the
 * chosen strategy and the current retry state. It takes into account the base timeout, the number of failed attempts,
 * the retry multiplier, the accumulated timeout, and the maximum number of retries to compute the appropriate backoff delay.
 *
 * @module backoff
 * @file backoff.ts
 * @version 1.0.0
 * @see {@link BackoffStrategy} for details on each backoff strategy and when to use them.
 * @see {@link computeBackoff} for the main function to calculate backoff delays based on the chosen strategy.
 * @see {@link computeMaxRetryDelay} for calculating an upper bound on backoff delays.
 * @fileoverview This module defines various backoff strategies and a function to compute the backoff delay based on the retry state and configuration.
 */
import { isNil } from 'lodash';

import { computeClamp, generateSecureRandom } from './utils';

import { RETRY_CONFIG_DEFAULTS } from '@/constants/backoff.const';
import { BackoffStrategy } from '@/enums/backoff.enum';
import type { BackoffParams, RetryConfig } from '@/types/backoff.type';

/** A default retry multiplier value */
const RETRY_MULTIPLIER = 1.5;

/**
 * Computes the maximum retry delay based on the recurring timeout and a scaling factor.
 * This function is useful for determining an upper bound on backoff delays, especially
 * when using strategies that can produce unbounded growth (like exponential backoff).
 *
 * @param recurringTimeoutMs the recurring timeout in milliseconds
 * @param factor a value between 0 (exclusive) and 1 (inclusive)
 * @returns returns the computed maximum retry delay in milliseconds
 */
export function computeMaxRetryDelay(recurringTimeoutMs: number, factor = 0.75) {
  return recurringTimeoutMs * computeClamp({ min: Number.MIN_VALUE, max: 1, value: factor });
}
/**
 * A check to determine whether another retry attempt
 * should be made based on the number of attempts
 * already made and the maximum allowed retries.
 *
 * This function is a simple utility that can be
 * used before calculating the backoff delay to
 * decide if the retry mechanism should continue
 * or if it has reached its limit.
 * @param param0 the arguments as named parameters
 * @returns returns `true` if the number of attempts is less than the number of max retries else returns false
 */
export function shouldRetry({
  attempts,
  maxRetries,
}: Pick<BackoffParams, 'attempts' | 'maxRetries'>): boolean {
  return attempts < maxRetries;
}
/**
 * Wait = base * 2^attempts
 * Classic doubling strategy. Aggressive growth, good for rare transient faults.
 *
 * attempts: 1 -> 200ms | 2 -> 400ms | 3 -> 800ms | 4 -> 1600ms
 */
function exponentialBackoff({
  timeout,
  attempts,
}: Pick<BackoffParams, 'timeout' | 'attempts'>): number {
  return timeout * Math.pow(2, attempts);
}

/**
 * Wait = base * multiplier^attempts
 * Like exponential but the growth rate is user-controlled via retryMultiplier.
 * Set multiplier > 2 for faster back-off, < 2 for gentler growth.
 *
 * attempts: 1 -> 300ms | 2 -> 900ms | 3 -> 2700ms  (base=100, multiplier=3)
 */
function multiplicativeExponentialBackoff({
  timeout,
  attempts,
  retryMultiplier,
}: Pick<BackoffParams, 'timeout' | 'attempts' | 'retryMultiplier'>): number {
  return timeout * Math.pow(retryMultiplier, attempts);
}

/**
 * Wait = base + (attempts * multiplier)
 * Steady, predictable growth. Good when you want gentle pressure without
 * the explosive growth of exponential strategies.
 *
 * attempts: 1 -> 600ms | 2 -> 1100ms | 3 -> 1600ms  (base=100, multiplier=500)
 */
function linearBackoff({
  timeout,
  attempts,
  retryMultiplier,
}: Pick<BackoffParams, 'timeout' | 'attempts' | 'retryMultiplier'>): number {
  return timeout + attempts * retryMultiplier;
}

/**
 * Wait = random(0, base * 2^attempts)
 * Spreads retries across a window to avoid thundering-herd problems when many
 * clients fail simultaneously. Recommended for distributed systems.
 *
 * attempts: 1 -> 0–200ms | 2 -> 0–400ms | 3 -> 0–800ms
 */
function exponentialBackoffWithJitter({
  timeout,
  attempts,
}: Pick<BackoffParams, 'timeout' | 'attempts'>): number {
  const cap = timeout * Math.pow(2, attempts);
  return generateSecureRandom() * cap;
}

/**
 * Wait = random(base, min(maxCap, prev * 3))
 * AWS's recommended strategy. Decorrelates each wait from the last, producing
 * smoother aggregate retry curves than full jitter in large fleets.
 *
 * Uses accumulatedTimeout as the "previous wait" seed.
 */
function decorrelatedJitterBackoff({
  timeout,
  accumulatedTimeout,
  maxCapMs,
}: Pick<BackoffParams, 'timeout' | 'accumulatedTimeout' | 'maxCapMs'>): number {
  const prevWait = accumulatedTimeout || timeout;
  const upper = Math.max(timeout, Math.min(maxCapMs, prevWait * 3));
  return timeout + generateSecureRandom() * (upper - timeout);
}
/**
 * Computes the backoff delay based on the provided parameters and the chosen backoff strategy.
 * This function serves as a unified interface for calculating backoff delays, allowing you to
 * easily switch between different strategies by simply changing the `retryStrategy` parameter.
 * It also ensures that the computed backoff delay does not exceed the specified maximum cap.
 * @param {number} timeout A recurring timeout in milliseconds that serves as the base interval for
 * backoff calculations.
 * @param {number} accumulatedTimeout The total time in milliseconds that has already been spent
 * waiting across all previous retry attempts.
 * @param {number} attempts The number of consecutive failed attempts that have occurred so far.
 * @param {number} maxRetries The configured maximum number of retry attempts allowed before giving up.
 * This is used to enforce a hard limit on retries and should be checked before calling this
 * function to avoid unnecessary backoff calculations when the retry limit has already been
 * reached.
 * @param {number | undefined | null} maxCapMs The maximum backoff delay in milliseconds. This parameter is used to cap
 * the computed backoff delay, ensuring that it does not exceed a certain threshold regardless
 * of the growth pattern of the chosen strategy. If not provided, the backoff calculation may
 * produce unbounded wait times based on the growth pattern of the chosen strategy. By setting
 * `maxCapMs`, you can ensure that the wait time never exceeds a certain threshold, which is
 * especially important in user-facing applications or when retrying critical operations.
 * @param {number | undefined} retryMultiplier A value used by certain backoff strategies to control the growth
 * rate of the wait time. For `MULTIPLICATIVE_EXPONENTIAL`, the wait time is calculated as
 * `base × multiplier^attempts`, so the `retryMultiplier` determines how aggressively the wait
 * escalates with each failure. For `LINEAR`, the wait time is calculated as
 * `base + (attempts × multiplier)`, so the `retryMultiplier` defines the fixed increment added
 * to the wait time on each attempt. The value of `retryMultiplier` should be chosen carefully
 * based on the desired backoff behavior and the characteristics of the system being retried
 * against.
 * @param {BackoffStrategy | undefined} retryStrategy The backoff strategy to use for calculating the wait time. This
 * determines the formula used to compute the backoff delay based on the provided parameters.
 * The available strategies include:
 * - `EXPONENTIAL`: Wait = base * 2^attempts
 * - `MULTIPLICATIVE_EXPONENTIAL`: Wait = base * multiplier^attempts
 * - `LINEAR`: Wait = base + (attempts * multiplier)
 * - `EXPONENTIAL_WITH_JITTER`: Wait = random(0, base * 2^attempts)
 * - `DECORRELATED_JITTER`: Wait = random(base, min(maxCap, prev * 3))
 *
 * The choice of strategy should be guided by the specific retry scenario, the characteristics
 * of the downstream service, and the desired balance between recovery speed and resource
 * utilization.
 * @returns {number} returns the computed backoff delay in milliseconds, which is the amount of time that
 * should be waited before the next retry attempt is made. The returned value is guaranteed to not
 *  exceed `maxCapMs` if it is provided, ensuring that the backoff delay remains within acceptable
 *  bounds regardless of the growth pattern of the chosen strategy.
 */
export function computeBackoff(
  timeout: number,
  accumulatedTimeout: number,
  attempts: number,
  maxRetries: number = 200,
  maxCapMs?: number | null,
  retryMultiplier: number = RETRY_MULTIPLIER,
  retryStrategy: BackoffStrategy = BackoffStrategy.EXPONENTIAL,
): number {
  // maxCapMs ||= computeMaxRetryDelay(timeout, retryMultiplier / getDecimalScale(retryMultiplier));
  // Default cap: at least 30 s, or 100× the base timeout - whichever is larger.
  // Using ??= (not ||=) so an explicit 0 isn't accidentally overwritten.
  maxCapMs ??= Math.max(30_000, timeout * 100);

  const params: BackoffParams = {
    accumulatedTimeout,
    attempts,
    maxCapMs,
    maxRetries,
    retryMultiplier,
    timeout,
  };
  let backoff: (x: BackoffParams) => number;
  switch (retryStrategy) {
    default:
    case BackoffStrategy.EXPONENTIAL:
      backoff = exponentialBackoff;
      break;
    case BackoffStrategy.MULTIPLICATIVE_EXPONENTIAL:
      backoff = multiplicativeExponentialBackoff;
      break;
    case BackoffStrategy.LINEAR:
      backoff = linearBackoff;
      break;
    case BackoffStrategy.EXPONENTIAL_WITH_JITTER:
      backoff = exponentialBackoffWithJitter;
      break;
    case BackoffStrategy.DECORRELATED_JITTER:
      backoff = decorrelatedJitterBackoff;
      break;
  }
  return Math.min(maxCapMs, backoff(params));
}

/**
 * Returns `10^n` where `n` is the number of digits after the decimal point
 * in the string representation of `x`.
 *
 * Examples:
 * - 3    => 1   (no decimal places -> 10^0)
 * - 1.5  => 10  (1 decimal place  -> 10^1)
 * - 0.75 => 100 (2 decimal places -> 10^2)
 *
 * @param x - The number to inspect (must be finite and > 0).
 * @returns The power-of-ten scale corresponding to the fractional precision of `x`.
 */
export function getDecimalScale(x: number): number {
  const str = x.toString();
  const dotIndex = str.indexOf('.');
  if (dotIndex === -1) return 1;
  return Math.pow(10, str.length - dotIndex - 1);
}

/**
 * Causes the currently executing thread to sleep (temporarily cease execution)
 * for the specified number of milliseconds, subject to the precision and
 * accuracy of system timers and schedulers. This implements a simple sleep
 * function that returns a promise that resolves after the specified duration.
 * @param {number} milliseconds - The number of milliseconds to sleep.
 * @returns {Promise<void>} A promise that resolves after the specified duration.
 */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Like {@link sleep} but respects an {@link AbortSignal}. If the signal fires before the
 * timer expires the returned promise rejects with `signal.reason` and the underlying
 * `setTimeout` handle is cleared immediately to avoid a memory leak.
 *
 * If the signal is already aborted when this function is called, the promise rejects in
 * the next microtask without ever scheduling a timer.
 *
 * @param milliseconds - How long to wait before resolving.
 * @param signal - An optional abort signal that can cut the sleep short.
 * @returns A `Promise<void>` that resolves after `milliseconds` ms, or rejects early
 *   with `signal.reason` if the signal is aborted during the wait.
 */
function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  // No signal provided - plain sleep with no cancellation overhead.
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  // Capture as a non-optional local so TypeScript narrows without a `!` assertion.
  const abortSignal = signal;
  return new Promise<void>((resolve, reject) => {
    function onAbort() {
      clearTimeout(timer);
      reject(abortSignal.reason);
    }
    const timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Core retry engine that executes an asynchronous operation and automatically retries it
 * on failure using a configurable backoff strategy.
 *
 * @description
 * `executeWithRetries` sits at the heart of the retry system. It runs the provided
 * `executor` in a loop, catching any thrown error and deciding - based on the configured
 * backoff strategy, attempt count, and optional `canRetry` veto - whether to wait and
 * try again or to surface the failure to the caller.
 *
 * #### How it works
 * 1. Calls `config.executor(...config.args)` and immediately returns its resolved value
 *    on success.
 * 2. On failure, increments a local attempt counter and computes the next delay via
 *    {@link computeBackoff}, passing `previousWait` (the last single delay) as the seed
 *    so that {@link BackoffStrategy.DECORRELATED_JITTER} receives the correct input.
 * 3. If a `canRetry` predicate is supplied it acts as a hard veto gate - returning
 *    `false` causes the error to be re-thrown immediately regardless of how many attempts
 *    remain.
 * 4. If `canRetry` allows it (or is absent) **and** the attempt ceiling has not been
 *    reached, the function sleeps for exactly the newly computed delay and loops.
 * 5. Once all retries are exhausted the original error is re-thrown unchanged, preserving
 *    the full stack trace for the caller.
 *
 * The function is iterative (not recursive), so it is safe for arbitrarily high
 * `maxRetries` values without risk of stack overflow.
 *
 * #### Pros
 * - **Transparent to callers** - just `await` the result; retry plumbing is invisible.
 * - **Fully configurable** - any {@link BackoffStrategy}, a custom `canRetry` veto, a
 *   custom multiplier, and an explicit cap are all first-class options.
 * - **Cancellable** - pass an `AbortSignal` via `config.signal` to interrupt any
 *   scheduled inter-attempt sleep and prevent subsequent attempts from running.
 * - **Observable failure history** - pass a `config.stack` array to collect every
 *   caught error in order; inspect it after a terminal failure for full context.
 * - **Non-mutating** - all mutable state (`attempts`, `previousWait`) is local; the
 *   caller's `config` object is never modified (`stack` is the sole documented exception).
 * - **Stack-safe** - loop-based execution handles hundreds of retries without recursion.
 *
 * #### Cons
 * - **Executor is not signal-aware by default** - `config.signal` cancels inter-attempt
 *   sleeps and blocks new attempts, but an already in-flight `executor` call runs to
 *   completion unless the signal is also threaded through `args` and handled inside
 *   `executor` (e.g. passed to `fetch`).
 * - **Fixed arguments per call** - `executor` is always invoked with the same `args`. If
 *   the request must change between attempts (e.g. refreshing a bearer token) that logic
 *   must live inside `executor` itself.
 * - **Intermediate errors are discarded by default** - only the final error is re-thrown;
 *   pass a `config.stack` array to retain the full per-attempt failure history.
 *
 * #### When to use
 * - Retrying HTTP calls to flaky or rate-limited third-party REST/GraphQL APIs.
 * - Reconnecting to a database or message broker after a transient network drop.
 * - Idempotent write operations (e.g. S3 `PutObject`, Postgres `INSERT … ON CONFLICT`)
 *   that are safe to replay without side effects.
 * - Any operation whose failure mode is "try again in a moment" rather than "give up".
 *
 * @example <caption>Retrying a fetch call with exponential backoff</caption>
 * ```ts
 * const response = await initExecuteWithRetries({
 *   executor: fetch,
 *   args: ['https://api.example.com/data'],
 *   timeout: 200,          // base delay: 200 ms
 *   maxRetries: 5,
 *   maxCapMs: 10_000,      // never wait more than 10 s per attempt
 *   retryMultiplier: 2,
 *   retryStrategy: BackoffStrategy.EXPONENTIAL,
 * });
 * ```
 *
 * @example <caption>Retrying a database write, bailing out on constraint violations</caption>
 * ```ts
 * const record = await initExecuteWithRetries({
 *   executor: (payload) => db.users.create({ data: payload }),
 *   args: [{ email: 'user@example.com', name: 'Alice' }],
 *   timeout: 100,
 *   maxRetries: 3,
 *   maxCapMs: 5_000,
 *   retryMultiplier: 1.5,
 *   retryStrategy: BackoffStrategy.EXPONENTIAL_WITH_JITTER,
 *   // Only retry on transient connectivity errors; surface unique-constraint
 *   // violations (Prisma code P2002) to the caller immediately without retrying.
 *   canRetry: (err) =>
 *     !(err instanceof PrismaClientKnownRequestError && err.code === 'P2002'),
 * });
 * ```
 *
 * @template ARGS - A tuple type that describes the argument list accepted by
 *   `config.executor`. Inferred automatically when `args` is supplied inline; provide
 *   it explicitly only when TypeScript cannot narrow it on its own.
 * @template R - The resolved value type returned by `config.executor`. Defaults to
 *   `unknown` when it cannot be inferred; narrow it for a fully-typed return value.
 *
 * @param config - A {@link RetryConfig} object that bundles the executor function, its
 *   arguments, the optional `canRetry` predicate, an optional `AbortSignal`, and an
 *   optional `stack` error-collection array. All {@link BackoffParams} fields are
 *   optional and fall back to {@link RETRY_CONFIG_DEFAULTS} when omitted. The object
 *   itself is never reassigned - retry state is kept in local variables; `stack` is the
 *   sole intentional mutation point.
 *
 * @returns A `Promise` that resolves with the value produced by `config.executor` on the
 *   first successful attempt, rejects with the error from the final failed attempt once
 *   all retries are exhausted or `canRetry` vetoes further attempts, or rejects with
 *   `config.signal.reason` if the signal is aborted at any point during the sequence.
 */
async function executeWithRetries<ARGS extends unknown[], R = unknown>(
  config: RetryConfig<ARGS, R>,
) {
  // Resolve every omitted BackoffParams field against RETRY_CONFIG_DEFAULTS up-front
  // so the rest of the function can use plain locals without null-checks.
  const {
    maxCapMs = RETRY_CONFIG_DEFAULTS.maxCapMs,
    maxRetries = RETRY_CONFIG_DEFAULTS.maxRetries,
    retryMultiplier = RETRY_CONFIG_DEFAULTS.retryMultiplier,
    timeout = RETRY_CONFIG_DEFAULTS.timeout,
  } = config;

  // Local mutable state - never mutates the caller's config object.
  let attempts = 0;
  // Tracks only the most recent delay so DECORRELATED_JITTER receives the
  // correct "previous wait" seed rather than a bloated cumulative total.
  let previousWait = 0;

  while (true) {
    // Honour cancellation before every attempt - including the very first one.
    if (config.signal?.aborted) throw config.signal.reason;

    try {
      return await config.executor(...config.args);
    } catch (reason) {
      attempts++;

      // Record each failure so callers can inspect the full history via config.stack.
      config.stack?.push(reason);

      const backoffMs = computeBackoff(
        timeout,
        previousWait, // previous single delay - seed for DECORRELATED_JITTER
        attempts,
        maxRetries,
        maxCapMs,
        retryMultiplier,
        config.retryStrategy, // honour the configured strategy, not a hard-coded one
      );
      previousWait = backoffMs;
      // canRetry (when provided) is a veto gate: returning false must prevent
      // the retry even if shouldRetry() would otherwise allow it.
      const userAllows = isNil(config.canRetry) || config.canRetry(reason, attempts, maxRetries);
      if (userAllows && shouldRetry({ attempts, maxRetries })) {
        // abortableSleep rejects with signal.reason if the signal fires mid-sleep,
        // propagating the cancellation out of the loop without an extra try/catch.
        await abortableSleep(backoffMs, config.signal);
        continue;
      }

      throw reason;
    }
  }
}

/**
 * Public entry point for the retry system. Optionally pauses for a fixed initial delay
 * before delegating to the core retry loop in {@link executeWithRetries}.
 *
 * @description
 * `initExecuteWithRetries` is the recommended way to invoke the retry system. It wraps
 * {@link executeWithRetries} and adds a single, optional "warm-up" sleep before the very
 * first execution attempt. This is distinct from the per-failure backoff delays managed
 * internally by `executeWithRetries` - it fires once at start-up, before anything has
 * been tried.
 *
 * #### How it works
 * 1. If `config.sleep` is provided and non-null, the function waits that many milliseconds
 *    before making any attempt. This flat delay is entirely independent of the chosen
 *    {@link BackoffStrategy} and is not factored into any subsequent backoff calculation.
 * 2. It then calls `executeWithRetries(config)`, which owns the full retry loop, backoff
 *    computation, `canRetry` gating, and final error propagation.
 * 3. The resolved or rejected result of `executeWithRetries` is forwarded directly to the
 *    caller - `initExecuteWithRetries` adds no further transformation.
 *
 * #### Pros
 * - **Single call-site** - callers never need to reference `executeWithRetries` directly;
 *   this function is the only public surface of the retry system.
 * - **Respects `Retry-After` headers** - set `config.sleep` to the server-mandated wait
 *   time and the first attempt will not fire until that window has elapsed.
 * - **Initial sleep is also cancellable** - if `config.signal` is aborted during the
 *   pre-flight pause, the sleep is cut short and the promise rejects immediately with
 *   `signal.reason`, without ever invoking `executor`.
 * - **Zero-overhead when unused** - when `config.sleep` is absent or `null`, the
 *   function is a thin pass-through with no extra allocations or delays.
 *
 * #### Cons
 * - **Flat initial delay only** - `config.sleep` is a one-shot pause; it does not
 *   influence `previousWait` or any subsequent per-failure delay calculation.
 * - **No partial-progress reporting** - there is no callback or event for observing
 *   individual attempt outcomes between the initial sleep and the final resolution.
 *
 * #### When to use
 * - Calling APIs that return a `Retry-After` response header on a 429 - pass the header
 *   value (converted to ms) as `config.sleep` to defer the first attempt correctly.
 * - Background jobs or queue consumers that should wait for a downstream service to
 *   finish its own warm-up sequence before beginning work after a cold start.
 * - Integration tests or scripts where a deliberate pre-flight pause is needed before
 *   the first attempt and the retry curve handles subsequent failures.
 *
 * @example <caption>Honouring a `Retry-After` header from a 429 response</caption>
 * ```ts
 * async function fetchWithRateLimit(url: string, retryAfterMs: number) {
 *   return initExecuteWithRetries({
 *     executor: fetch,
 *     args: [url],
 *     sleep: retryAfterMs,   // wait the server-mandated window before attempt #1
 *     timeout: 500,
 *     maxRetries: 4,
 *     maxCapMs: 30_000,
 *     retryMultiplier: 2,
 *     retryStrategy: BackoffStrategy.EXPONENTIAL_WITH_JITTER,
 *   });
 * }
 * ```
 *
 * @example <caption>Queue consumer that defers startup until the broker is ready</caption>
 * ```ts
 * // Wait 3 s for the message broker to finish its own startup sequence,
 * // then attempt to connect - retrying up to 5 times with decorrelated jitter
 * // so that multiple consumer instances don't storm the broker simultaneously.
 * const connection = await initExecuteWithRetries({
 *   executor: broker.connect.bind(broker),
 *   args: [{ host: 'rabbitmq', port: 5672 }],
 *   sleep: 3_000,           // one-time warm-up pause before the first attempt
 *   timeout: 250,
 *   maxRetries: 5,
 *   maxCapMs: 15_000,
 *   retryMultiplier: 1.5,
 *   retryStrategy: BackoffStrategy.DECORRELATED_JITTER,
 *   canRetry: (err) => err instanceof BrokerUnavailableError,
 * });
 * ```
 *
 * @template ARGS - A tuple type describing the argument list of `config.executor`.
 *   Inferred automatically when `args` is provided inline; supply it explicitly only
 *   when TypeScript cannot narrow it on its own.
 * @template R - The resolved value type of `config.executor`. Defaults to `unknown`
 *   when inference is not possible; narrow it for a fully-typed return value.
 *
 * @param config - A {@link RetryConfig} object containing the executor function, its
 *   arguments, the optional `sleep` pre-flight delay, `canRetry` veto predicate,
 *   `AbortSignal`, and `stack` error-collection array. All {@link BackoffParams} fields
 *   are optional and fall back to {@link RETRY_CONFIG_DEFAULTS} when omitted.
 *
 * @returns A `Promise` that resolves with the value produced by `config.executor` on the
 *   first successful attempt (after the optional initial sleep), rejects with the error
 *   thrown on the final failed attempt once all retries are exhausted or `canRetry` vetoes
 *   further attempts, or rejects with `config.signal.reason` if the signal is aborted at
 *   any point - including during the initial `config.sleep` pause.
 */
export async function initExecuteWithRetries<ARGS extends unknown[], R = unknown>(
  config: RetryConfig<ARGS, R>,
) {
  const retry = async () => await executeWithRetries(config);
  if (!isNil(config.sleep)) {
    // The pre-flight pause is abortable so a pending warm-up delay does not
    // block cancellation any longer than an inter-attempt sleep would.
    await abortableSleep(config.sleep, config.signal);
    return await retry();
  } else return await retry();
}
