/**
 * @fileoverview
 * @summary The Analytics manager: consent-gated metric collection and flush.
 * @description
 * Implements the telemetry core of M5. It collects counters, gauges, and
 * events, then flushes them in one batch to an injected transport. Collection
 * and flush are gated by a consent predicate and a sample rate, so telemetry
 * never runs when the user opted out and never slows the app.
 *
 * ```text
 *   increment / recordGauge / trackEvent  -> collect (consent + sample)
 *   flush()                               -> transport(snapshot) -> reset
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary A tracked usage event.
 */
export interface AnalyticsEvent {
  name: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

/**
 * @summary The payload a flush sends.
 */
export interface AnalyticsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  events: AnalyticsEvent[];
  timestamp: number;
}

/**
 * @summary Options for constructing an {@linkcode AnalyticsManager}.
 */
export interface AnalyticsManagerOptions {
  /** The transport that receives a flush. */
  transport?: (snapshot: AnalyticsSnapshot) => Promise<void>;
  /** Consent gate. When `false`, collection and flush are no-ops. */
  consent?: () => boolean;
  /** Sample rate from 0 to 1. Defaults to 1. */
  sampleRate?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable random for sampling. Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * @summary The Analytics manager.
 * @description
 * One instance per realm. It is the sink of the platform, never a dependency.
 *
 * @example
 * Example 1: Collect and flush metrics
 * ```ts
 * const analytics = new AnalyticsManager({ transport: send, consent: () => consent.isGranted('analytics') });
 * analytics.increment('page.view');
 * await analytics.flush();
 * ```
 */
export class AnalyticsManager {
  /** @internal The counters. */
  private readonly counters = new Map<string, number>();

  /** @internal The gauges. */
  private readonly gauges = new Map<string, number>();

  /** @internal The events. */
  private readonly events: AnalyticsEvent[] = [];

  /** @internal The transport. */
  private readonly transport?: (snapshot: AnalyticsSnapshot) => Promise<void>;

  /** @internal The consent gate. */
  private readonly consent?: () => boolean;

  /** @internal The sample rate. */
  private readonly sampleRate: number;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The random source. */
  private readonly random: () => number;

  /**
   * @summary Creates an AnalyticsManager.
   * @param {AnalyticsManagerOptions} [options] The configuration.
   */
  constructor(options: AnalyticsManagerOptions = {}) {
    this.transport = options.transport;
    this.consent = options.consent;
    this.sampleRate = options.sampleRate ?? 1;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * @summary Increments a counter.
   * @param {string} name The counter name.
   * @param {number} [amount=1] The amount to add.
   * @returns {void}
   */
  increment(name: string, amount = 1): void {
    if (!this.shouldCollect()) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  /**
   * @summary Sets a gauge to a value.
   * @param {string} name The gauge name.
   * @param {number} value The value.
   * @returns {void}
   */
  recordGauge(name: string, value: number): void {
    if (!this.shouldCollect()) return;
    this.gauges.set(name, value);
  }

  /**
   * @summary Tracks a usage event.
   * @param {string} name The event name.
   * @param {Record<string, unknown>} [properties] Event properties.
   * @returns {void}
   */
  trackEvent(name: string, properties: Record<string, unknown> = {}): void {
    if (!this.shouldCollect()) return;
    this.events.push({ name, properties, timestamp: this.now() });
  }

  /**
   * @summary Flushes the collected metrics to the transport and resets them.
   * @returns {Promise<void>}
   */
  async flush(): Promise<void> {
    if (this.consent && !this.consent()) return;
    if (!this.transport) return;

    const snapshot: AnalyticsSnapshot = {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      events: [...this.events],
      timestamp: this.now(),
    };

    await this.transport(snapshot);

    this.counters.clear();
    this.gauges.clear();
    this.events.length = 0;
  }

  /**
   * @summary A snapshot of the current metrics, without flushing.
   * @returns {AnalyticsSnapshot} The snapshot.
   */
  getMetrics(): AnalyticsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      events: [...this.events],
      timestamp: this.now(),
    };
  }

  /**
   * @summary Whether collection is allowed now.
   * @returns {boolean} `true` when consent passes and the sample hits.
   * @internal
   */
  private shouldCollect(): boolean {
    if (this.consent && !this.consent()) return false;
    return this.random() < this.sampleRate;
  }
}
