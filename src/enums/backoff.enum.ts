/**
 * Defines the retry backoff strategy to use when an asynchronous operation fails
 * and needs to be retried after a calculated wait period.
 *
 * A **backoff strategy** controls how the delay between retry attempts grows over
 * time. Choosing the right strategy is critical for balancing system recovery speed,
 * resource utilisation, and protection of downstream services.
 *
 * ---
 *
 * ### Core Concepts
 *
 * - **Base timeout** (`timeout`): The seed interval all strategies build on.
 * - **Failed attempts** (`failedAttempts`): The number of consecutive failures so far.
 * - **Retry multiplier** (`retryMultiplier`): A scaling coefficient used by select strategies.
 * - **Accumulated timeout** (`accumulatedTimeoutMs`): The total time already spent waiting,
 *   used as a seed by decorrelation-based strategies.
 * - **Max retries** (`maxRetries`): The hard ceiling on retry attempts; once reached,
 *   the operation is considered permanently failed.
 *
 * ---
 *
 * ### Choosing a Strategy
 *
 * | Scenario                                      | Recommended Strategy                               |
 * |-----------------------------------------------|----------------------------------------------------|
 * | General-purpose transient faults              | `EXPONENTIAL`                                      |
 * | Tunable growth rate                           | `MULTIPLICATIVE_EXPONENTIAL`                       |
 * | Predictable, human-readable wait times        | `LINEAR`                                           |
 * | Many clients retrying the same endpoint       | `EXPONENTIAL_WITH_JITTER` or `DECORRELATED_JITTER` |
 * | Large distributed fleets (AWS-style)          | `DECORRELATED_JITTER`                              |
 *
 * @enum {string}
 */
export enum BackoffStrategy {
  /**
   * ### Exponential Backoff
   *
   * **Formula:** `wait = base × 2^attempts`
   *
   * The canonical retry strategy. Each failure doubles the previous wait period,
   * creating an aggressive but highly effective pressure-relief valve for
   * overwhelmed services.
   *
   * #### How it works
   * The wait time grows as a power of 2 relative to the number of failed attempts,
   * meaning the gap between retries widens rapidly. This gives a struggling
   * downstream service substantial breathing room after repeated failures.
   *
   * #### Growth profile (base = 100ms)
   * | Attempt | Wait     |
   * |---------|----------|
   * | 1       | 200ms    |
   * | 2       | 400ms    |
   * | 3       | 800ms    |
   * | 4       | 1,600ms  |
   * | 5       | 3,200ms  |
   *
   * #### When to use
   * - General-purpose transient fault handling (network blips, timeouts, 503s).
   * - Single-client or low-concurrency retry scenarios.
   * - When you want a well-understood, widely supported default.
   *
   * #### Caveats
   * - Without a cap, wait times can grow unbounded. Pair with `CappedExponential`
   *   or enforce a `maxRetries` ceiling to avoid indefinite stalling.
   * - In high-concurrency systems, all clients doubling simultaneously can create
   *   a **thundering herd** - consider `EXPONENTIAL_WITH_JITTER` instead.
   *
   * @example
   * // base=100ms, attempt=3 -> 100 * 2^3 = 800ms
   * const wait = exponentialBackoff({ timeout: 100, failedAttempts: 3, ... });
   */
  EXPONENTIAL,

  /**
   * ### Multiplicative Exponential Backoff
   *
   * **Formula:** `wait = base × multiplier^attempts`
   *
   * A generalisation of `EXPONENTIAL` where the growth base is user-controlled
   * via `retryMultiplier` rather than hardcoded to `2`. This lets you fine-tune
   * how aggressively the wait time escalates.
   *
   * #### How it works
   * Identical in shape to standard exponential backoff, but substitutes the fixed
   * base of `2` with your chosen `retryMultiplier`. A multiplier of `2` produces
   * identical results to `Exponential`. Values above `2` escalate faster; values
   * between `1` and `2` escalate more gently.
   *
   * #### Growth profile (base = 100ms)
   * | Attempt | ×1.5   | ×2 (≡ Exponential) | ×3      |
   * |---------|--------|---------------------|---------|
   * | 1       | 150ms  | 200ms               | 300ms   |
   * | 2       | 225ms  | 400ms               | 900ms   |
   * | 3       | 338ms  | 800ms               | 2,700ms |
   * | 4       | 506ms  | 1,600ms             | 8,100ms |
   *
   * #### When to use
   * - You need the shape of exponential growth but want explicit control over velocity.
   * - Different retry contexts in the same application require different escalation rates
   *   (e.g. aggressive for health checks, gentle for user-facing API calls).
   * - A/B testing retry sensitivity without changing strategy logic.
   *
   * #### Caveats
   * - A multiplier ≤ 1 will produce flat or shrinking waits - validate inputs.
   * - High multipliers (> 3) can reach extreme wait times after very few attempts.
   *
   * @example
   * // base=100ms, multiplier=3, attempt=2 -> 100 * 3^2 = 900ms
   * const wait = multiplicativeExponentialBackoff({ timeout: 100, retryMultiplier: 3, failedAttempts: 2, ... });
   */
  MULTIPLICATIVE_EXPONENTIAL,

  /**
   * ### Linear Backoff
   *
   * **Formula:** `wait = base + (attempts × multiplier)`
   *
   * Adds a fixed increment to the wait time on each attempt, producing a
   * straight-line (arithmetic) growth curve. The most predictable and
   * human-readable of all backoff strategies.
   *
   * #### How it works
   * Unlike exponential strategies, linear backoff grows at a constant rate.
   * Every additional failure adds exactly `retryMultiplier` milliseconds to the
   * previous wait, anchored to the base timeout. This makes it easy to reason
   * about worst-case total wait times at a glance.
   *
   * #### Growth profile (base = 100ms, multiplier = 500ms)
   * | Attempt | Wait     |
   * |---------|----------|
   * | 1       | 600ms    |
   * | 2       | 1,100ms  |
   * | 3       | 1,600ms  |
   * | 4       | 2,100ms  |
   * | 5       | 2,600ms  |
   *
   * #### When to use
   * - The downstream service can tolerate steadily increasing load rather than
   *   needing dramatic breathing room.
   * - SLAs require predictable, bounded wait times that ops teams can reason about.
   * - Retrying operations where humans are waiting and UX responsiveness matters
   *   (e.g. form submissions, file uploads).
   *
   * #### Caveats
   * - Grows too slowly for severely overloaded services - they may never recover
   *   if retries arrive faster than the service can shed load.
   * - Not suitable as the sole strategy in high-concurrency scenarios without jitter.
   *
   * @example
   * // base=100ms, multiplier=500ms, attempt=3 -> 100 + (3 * 500) = 1,600ms
   * const wait = linearBackoff({ timeout: 100, retryMultiplier: 500, failedAttempts: 3, ... });
   */
  LINEAR,

  /**
   * ### Exponential Backoff with Full Jitter
   *
   * **Formula:** `wait = random(0, base × 2^attempts)`
   *
   * Combines the growth envelope of exponential backoff with uniform random
   * sampling across that envelope. The single most recommended strategy for
   * distributed systems retrying shared resources.
   *
   * #### How it works
   * The exponential formula defines an upper bound for the wait window. The actual
   * wait is then a uniformly random value drawn from `[0, cap]`. Because each
   * client independently samples this window, retry storms are naturally dispersed
   * across time even when thousands of clients fail simultaneously.
   *
   * #### Growth profile (base = 100ms) - illustrative samples
   * | Attempt | Cap    | Possible wait range |
   * |---------|--------|---------------------|
   * | 1       | 200ms  | 0 – 200ms           |
   * | 2       | 400ms  | 0 – 400ms           |
   * | 3       | 800ms  | 0 – 800ms           |
   * | 4       | 1,600ms| 0 – 1,600ms         |
   *
   * #### When to use
   * - Multiple clients (microservices, browser tabs, mobile devices) are retrying
   *   the same endpoint after a shared failure event.
   * - Preventing **thundering herd** / **retry storm** scenarios.
   * - Cloud infrastructure, message queue consumers, or any horizontally scaled system.
   *
   * #### Caveats
   * - Can produce very short waits (near 0ms) by chance, which may not give a
   *   struggling service enough time to recover. Consider a minimum floor if needed.
   * - Non-deterministic - harder to unit test without mocking `Math.random()`.
   *
   * @see {@link BackoffStrategy.DECORRELATED_JITTER} for an alternative jitter approach
   * that avoids correlation with the previous wait.
   *
   * @example
   * // base=100ms, attempt=3 -> random value in [0, 800ms]
   * const wait = exponentialBackoffWithJitter({ timeout: 100, failedAttempts: 3, ... });
   */
  EXPONENTIAL_WITH_JITTER,

  /**
   * ### Decorrelated Jitter Backoff
   *
   * **Formula:** `wait = random(base, min(cap, previousWait × 3))`
   *
   * AWS's recommended backoff strategy for distributed systems. Decorrelates each
   * retry wait from the previous one, producing smoother aggregate retry
   * distributions across large fleets compared to standard jitter approaches.
   *
   * #### How it works
   * Rather than anchoring jitter to an exponential formula, each wait is sampled
   * from a window whose upper bound is `3 × the previous wait`. This breaks the
   * correlation between successive retries and prevents clients from inadvertently
   * synchronising into waves even when they started retrying at the same time.
   * `accumulatedTimeoutMs` serves as the seed for `previousWait`.
   *
   * #### Growth profile (base = 100ms, cap = 30,000ms) - illustrative samples
   * | Attempt | Previous wait | Upper bound | Possible wait range  |
   * |---------|--------------|-------------|----------------------|
   * | 1       | 100ms (seed) | 300ms       | 100 – 300ms          |
   * | 2       | ~200ms       | ~600ms      | 100 – 600ms          |
   * | 3       | ~400ms       | ~1,200ms    | 100 – 1,200ms        |
   *
   * #### When to use
   * - Large distributed fleets (hundreds or thousands of nodes) retrying shared infrastructure.
   * - You've already tried `EXPONENTIAL_WITH_JITTER` and are still seeing retry waves.
   * - Following AWS/cloud-provider best practice guidance for resilient service clients.
   *
   * #### Caveats
   * - Requires tracking `accumulatedTimeoutMs` across attempts to use as the previous-wait seed.
   * - Slightly more complex to implement and reason about than pure jitter strategies.
   * - The `3×` multiplier is a convention, not a law - adjust for your traffic profile.
   *
   * @see {@link https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/}
   *
   * @example
   * // base=100ms, prevWait=200ms, cap=30000ms -> random value in [100, 600ms]
   * const wait = decorrelatedJitterBackoff({ timeout: 100, accumulatedTimeoutMs: 200, ... });
   */
  DECORRELATED_JITTER,
}
