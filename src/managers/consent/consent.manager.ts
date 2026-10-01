/**
 * @fileoverview
 * @summary The Consent manager: per-category grants and telemetry gating.
 * @description
 * Implements the consent and privacy foundation of M1. It records what the user
 * agrees to per category, keeps the `necessary` category always granted, and
 * invalidates grants when the policy version changes. Analytics and beacon
 * flushes consult `isGranted` before emitting.
 *
 * ```text
 *   isGranted(category)
 *     |-- necessary -> always true
 *     |-- record exists + granted + policy version matches
 *     v
 *   true | false
 *   ```
 *
 * A grant fails closed: an ungranted category stays off. This matches the
 * reliability contract and the "opt out without breaking essential use" rule.
 *
 * @author MathAid
 */

/**
 * @summary A consent category.
 */
export type ConsentCategory = 'necessary' | 'functional' | 'analytics' | 'marketing';

/**
 * @summary One recorded grant or revocation.
 */
export interface ConsentRecord {
  /** The category. */
  category: ConsentCategory;
  /** Whether the user granted it. */
  granted: boolean;
  /** Unix milliseconds when the decision was recorded. */
  timestamp: number;
  /** The policy version the decision was made under. */
  policyVersion: number;
}

/**
 * @summary The categories that can be granted or revoked.
 */
const ALL_CATEGORIES: ConsentCategory[] = ['necessary', 'functional', 'analytics', 'marketing'];

/**
 * @summary Options for constructing a {@linkcode ConsentManager}.
 */
export interface ConsentManagerOptions {
  /** The current policy version. Defaults to 1. */
  policyVersion?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * @summary The Consent manager.
 * @description
 * One instance per realm. Grants persist through Storage, but the manager
 * itself is a plain, testable state holder.
 *
 * @example
 * Example 1: Gate telemetry on consent
 * ```ts
 * const consent = new ConsentManager();
 * consent.grant('analytics');
 * if (consent.isGranted('analytics')) { tracker.send(); }
 * ```
 */
export class ConsentManager {
  /** @internal Category to record. */
  private readonly consent = new Map<ConsentCategory, ConsentRecord>();

  /** @internal The current policy version. */
  private readonly policyVersion: number;

  /** @internal The clock. */
  private readonly now: () => number;

  /**
   * @summary Creates a ConsentManager.
   * @param {ConsentManagerOptions} [options] The configuration and injectables.
   */
  constructor(options: ConsentManagerOptions = {}) {
    this.policyVersion = options.policyVersion ?? 1;
    this.now = options.now ?? Date.now;
  }

  /**
   * @summary Whether a category is currently granted.
   * @description
   * `necessary` is always granted. Other categories need a grant recorded
   * under the current policy version.
   *
   * @param {ConsentCategory} category The category.
   * @returns {boolean} `true` when granted.
   */
  isGranted(category: ConsentCategory): boolean {
    if (category === 'necessary') return true;
    const record = this.consent.get(category);
    return !!record && record.granted && record.policyVersion === this.policyVersion;
  }

  /**
   * @summary Grants a category.
   * @param {ConsentCategory} category The category to grant.
   * @returns {void}
   */
  grant(category: ConsentCategory): void {
    this.consent.set(category, {
      category,
      granted: true,
      timestamp: this.now(),
      policyVersion: this.policyVersion,
    });
  }

  /**
   * @summary Revokes a category.
   * @description
   * `necessary` cannot be revoked. Essential use must work with no consent.
   *
   * @param {ConsentCategory} category The category to revoke.
   * @returns {void}
   */
  revoke(category: ConsentCategory): void {
    if (category === 'necessary') return;
    this.consent.set(category, {
      category,
      granted: false,
      timestamp: this.now(),
      policyVersion: this.policyVersion,
    });
  }

  /**
   * @summary Grants every category.
   * @returns {void}
   */
  grantAll(): void {
    for (const category of ALL_CATEGORIES) this.grant(category);
  }

  /**
   * @summary Revokes every category except `necessary`.
   * @returns {void}
   */
  revokeAll(): void {
    for (const category of ALL_CATEGORIES) {
      if (category !== 'necessary') this.revoke(category);
    }
  }

  /**
   * @summary The current consent records.
   * @returns {ConsentRecord[]} A copy of every recorded decision.
   */
  getConsent(): ConsentRecord[] {
    return [...this.consent.values()];
  }

  /**
   * @summary The current policy version.
   * @returns {number} The policy version.
   */
  getPolicyVersion(): number {
    return this.policyVersion;
  }
}
