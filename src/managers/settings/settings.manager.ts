/**
 * @fileoverview
 * @summary The Settings manager: user-tunable preferences and consent gating.
 * @description
 * Implements the settings surface of M5. It holds user-tunable preferences
 * (sync interval, bandwidth mode, data-saver) and delegates analytics opt-out
 * to the Consent manager. A settings page binds to this and changes apply live
 * without a reload. Opting out never breaks essential use.
 *
 * ```text
 *   getSettings()          -> { syncInterval, bandwidthMode, dataSaver }
 *   setSyncInterval / setBandwidthMode / setDataSaver
 *   isAnalyticsEnabled()   -> consent.isGranted('analytics')
 *   enableAnalytics()      -> consent.grant('analytics')
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary Bandwidth usage mode.
 */
export type BandwidthMode = 'FULL' | 'CONSERVATIVE' | 'MINIMAL';

/**
 * @summary The user-tunable settings.
 */
export interface UserSettings {
  /** Auto-sync interval in milliseconds. */
  syncInterval: number;
  /** Bandwidth mode. */
  bandwidthMode: BandwidthMode;
  /** Whether data-saver is on. */
  dataSaver: boolean;
}

/**
 * @summary The minimal consent surface the settings manager needs.
 * @description
 * The {@linkcode ConsentManager} satisfies this. An interface keeps the
 * settings manager testable without coupling to a concrete manager.
 */
export interface ConsentSurface {
  isGranted(category: string): boolean;
  grant(category: string): void;
  revoke(category: string): void;
}

/**
 * @summary Options for constructing a {@linkcode SettingsManager}.
 */
export interface SettingsManagerOptions {
  /** The consent manager, for analytics opt-out. */
  consent?: ConsentSurface;
  /** Initial overrides. */
  initial?: Partial<UserSettings>;
}

/**
 * @summary The Settings manager.
 * @description
 * One instance per realm. Holds preferences in memory; persistence through the
 * Storage facade is a wiring step.
 *
 * @example
 * Example 1: Tune settings and check analytics
 * ```ts
 * const settings = new SettingsManager({ consent });
 * settings.setDataSaver(true);
 * settings.disableAnalytics();
 * ```
 */
export class SettingsManager {
  /** @internal The sync interval. */
  private syncInterval: number;

  /** @internal The bandwidth mode. */
  private bandwidthMode: BandwidthMode;

  /** @internal The data-saver flag. */
  private dataSaver: boolean;

  /** @internal The consent surface. */
  private readonly consent?: ConsentSurface;

  /**
   * @summary Creates a SettingsManager.
   * @param {SettingsManagerOptions} [options] The consent surface and initial values.
   */
  constructor(options: SettingsManagerOptions = {}) {
    this.consent = options.consent;
    this.syncInterval = options.initial?.syncInterval ?? 300_000;
    this.bandwidthMode = options.initial?.bandwidthMode ?? 'FULL';
    this.dataSaver = options.initial?.dataSaver ?? false;
  }

  /**
   * @summary The current settings.
   * @returns {UserSettings} The settings.
   */
  getSettings(): UserSettings {
    return {
      syncInterval: this.syncInterval,
      bandwidthMode: this.bandwidthMode,
      dataSaver: this.dataSaver,
    };
  }

  /**
   * @summary Sets the sync interval.
   * @param {number} ms The interval in milliseconds.
   * @returns {void}
   */
  setSyncInterval(ms: number): void {
    this.syncInterval = ms;
  }

  /**
   * @summary Sets the bandwidth mode.
   * @param {BandwidthMode} mode The mode.
   * @returns {void}
   */
  setBandwidthMode(mode: BandwidthMode): void {
    this.bandwidthMode = mode;
  }

  /**
   * @summary Sets the data-saver flag.
   * @param {boolean} enabled Whether to enable data-saver.
   * @returns {void}
   */
  setDataSaver(enabled: boolean): void {
    this.dataSaver = enabled;
  }

  /**
   * @summary Whether analytics is currently allowed.
   * @returns {boolean} `true` when consent grants analytics.
   */
  isAnalyticsEnabled(): boolean {
    return this.consent?.isGranted('analytics') ?? false;
  }

  /**
   * @summary Enables analytics through consent.
   * @returns {void}
   */
  enableAnalytics(): void {
    this.consent?.grant('analytics');
  }

  /**
   * @summary Disables analytics through consent.
   * @returns {void}
   */
  disableAnalytics(): void {
    this.consent?.revoke('analytics');
  }
}
