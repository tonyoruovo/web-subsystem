/**
 * @fileoverview
 * @module @platform/consent
 * @summary The public API of `@platform/consent`.
 * @description
 * Re-exports the Consent subsystem ({@linkcode createConsent}), the grant
 * rule it applies ({@linkcode isConsentGranted}), its event and category
 * constants, and its types.
 *
 * ```text
 *   @platform/consent
 *   +-- createConsent      the subsystem: id 'consent', featurized, Tab scope (Window from M5)
 *   +-- isConsentGranted   necessary always; otherwise granted under the current policy
 *   +-- CONSENT_CHANGED    'consent:changed', broadcast with every change
 *   +-- NECESSARY, DEFAULT_CATEGORIES
 *   +-- types              ConsentControl, ConsentData, ConsentRecord, ConsentChange, ConsentOptions
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * import { createConsent } from '@platform/consent';
 *
 * const kernel = new Kernel([...centralized, createConsent({ policyVersion: 2 })], { persistence });
 * ```
 *
 * @example
 * Gating on it
 * ```ts
 * import type { ConsentControl } from '@platform/consent';
 *
 * ctx.dependency<ConsentControl>('consent')?.commands.isGranted('analytics');
 * ```
 *
 * @author MathAid
 */

export * from './consent';
