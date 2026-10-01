import type { BackoffParams } from '@/types/backoff.type';

/**
 * Default values applied to every {@link BackoffParams} field that is omitted from a
 * {@link RetryConfig}. These are resolved once at the start of {@link executeWithRetries}
 * before the first attempt, so callers only need to specify the fields they want to
 * override.
 *
 * @example
 * ```ts
 * // Minimal config - all BackoffParams fields come from RETRY_CONFIG_DEFAULTS.
 * await initExecuteWithRetries({ executor: myFn, args: [] });
 *
 * // Partial override - only maxRetries differs from the defaults.
 * await initExecuteWithRetries({ executor: myFn, args: [], maxRetries: 10 });
 * ```
 */
export const RETRY_CONFIG_DEFAULTS = {
  /** 2 minutes 30 seconds - a generous ceiling suitable for most background operations. */
  maxCapMs: 2.5 * 60 * 1000,
  accumulatedTimeout: 0,
  attempts: 0,
  maxRetries: 512,
  retryMultiplier: 1.2,
  /** 100 ms base timeout. */
  timeout: 100,
} as const satisfies Required<BackoffParams>;
