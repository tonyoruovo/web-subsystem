/**
 * @fileoverview
 * @summary The Consent subsystem: per-category grants, policy versions, and the gate telemetry checks.
 * @description
 * Implements the Consent subsystem of docs/ARCHITECTURE.md §13 (amended
 * proposal: `proposals/consent_PROPOSAL.md`). It records what the user agreed
 * to, per category, under a policy version, and answers `isGranted`. It
 * **fails closed**: a category without a current grant is off.
 *
 * ```text
 *   grant / revoke / set / grantAll / revokeAll
 *     --> records (persisted through the kernel's persistence; Storage from M6)
 *     --> broadcast 'consent:changed' (HIGH) with every change
 *
 *   isGranted(category)
 *     necessary                                   --> true, always
 *     record granted under the current policy     --> true
 *     anything else (none, revoked, stale policy) --> false
 *
 *   views.grants   effective grant per category
 *   views.pending  categories to ask the user about (no decision under the current policy)
 *   ```
 *
 * Retention and data-subject requests (export, erase) need Storage and arrive
 * with it in M6. Consent moves to Window scope in M5.
 *
 * @example
 * Gating analytics
 * ```ts
 * const consent = ctx.dependency<ConsentControl>('consent');
 * if (consent?.commands.isGranted('analytics')) track(event);
 * ```
 *
 * @example
 * Showing the banner when a decision is needed
 * ```ts
 * const { views } = kernel.unit<ConsentControl>('consent').control!;
 * views.pending.subscribe(() => (banner.hidden = views.pending.getSnapshot().length === 0));
 * ```
 *
 * @author MathAid
 */

import { defineSubsystem, deriveView, type SubsystemDefinition, type View } from '@platform/core';

/**
 * @summary The id the Consent subsystem registers under.
 * @constant {'consent'}
 * @public
 */
export const CONSENT_ID = 'consent';

/**
 * @summary The event broadcast after every change, with the {@linkcode ConsentChange}s as payload.
 * @constant {'consent:changed'}
 * @public
 */
export const CONSENT_CHANGED = 'consent:changed';

/**
 * @summary The category that is always granted: essential use never depends on consent.
 * @constant {'necessary'}
 * @public
 */
export const NECESSARY = 'necessary';

/**
 * @summary The default categories.
 * @constant {readonly string[]}
 * @public
 */
export const DEFAULT_CATEGORIES: readonly string[] = [
  NECESSARY,
  'functional',
  'analytics',
  'marketing',
];

/**
 * @summary One decision: granted or revoked, when, and under which policy version.
 *
 * @example
 * Example 1: A grant
 * ```ts
 * // { category: 'analytics', granted: true, timestamp: 1700000000000, policyVersion: 2 }
 * ```
 *
 * @example
 * Example 2: Is it current?
 * ```ts
 * record.policyVersion === state.getSnapshot().policyVersion;
 * ```
 *
 * @public
 */
export interface ConsentRecord {
  readonly category: string;
  readonly granted: boolean;
  readonly timestamp: number;
  readonly policyVersion: number;
}

/**
 * @summary One change, as broadcast in `consent:changed`.
 * @description The same fields as a {@linkcode ConsentRecord}.
 * @public
 */
export type ConsentChange = ConsentRecord;

/**
 * @summary Options for {@linkcode createConsent}.
 *
 * @description
 * `policyVersion` (default 1): raise it when the policy changes, and every
 * earlier decision stops counting. `categories` (default
 * {@linkcode DEFAULT_CATEGORIES}) must include `necessary`. `now` replaces the clock.
 *
 * @example
 * Example 1: A new policy
 * ```ts
 * createConsent({ policyVersion: 3 });
 * ```
 *
 * @example
 * Example 2: Custom categories
 * ```ts
 * createConsent({ categories: ['necessary', 'analytics', 'personalization'] });
 * ```
 *
 * @public
 */
export interface ConsentOptions {
  readonly policyVersion?: number;
  readonly categories?: readonly string[];
  readonly now?: () => number;
}

/**
 * @summary The Consent subsystem's state.
 *
 * @description
 * `records` (persisted) holds the last decision per category; `necessary` is
 * never stored. `policyVersion` and `categories` come from the options.
 *
 * @example
 * Example 1: After accepting analytics
 * ```ts
 * // { policyVersion: 1, categories: [...], records: { analytics: { granted: true, ... } } }
 * ```
 *
 * @example
 * Example 2: Listing decisions
 * ```ts
 * Object.values(state.getSnapshot().records ?? {});
 * ```
 *
 * @public
 */
export interface ConsentData {
  policyVersion: number;
  categories: string[];
  records: Record<string, ConsentRecord>;
}

/**
 * @summary The Consent subsystem's control interface.
 *
 * @description
 * - `isGranted(category)`: the gate. Unknown categories are not granted.
 * - `grant(category)` / `revoke(category)`: one decision; `false` when nothing changed.
 * - `set(decisions)`: several decisions at once (a banner's "save"), one broadcast.
 * - `grantAll()` / `revokeAll()`: every category (`necessary` stays granted).
 *
 * Changing an unknown category throws `RangeError`. Views: `state`, `grants`
 * (effective grant per category) and `pending` (categories to ask about).
 *
 * @example
 * Example 1: A banner's buttons
 * ```ts
 * acceptAll.onclick = () => commands.grantAll();
 * save.onclick = () => commands.set({ analytics: analyticsBox.checked, marketing: false });
 * ```
 *
 * @example
 * Example 2: Binding the grants in Vue
 * ```ts
 * const grants = shallowRef(views.grants.getSnapshot());
 * onScopeDispose(views.grants.subscribe(() => (grants.value = views.grants.getSnapshot())));
 * ```
 *
 * @public
 */
export interface ConsentControl {
  readonly commands: {
    isGranted(category: string): boolean;
    grant(category: string): boolean;
    revoke(category: string): boolean;
    set(decisions: Readonly<Record<string, boolean>>): ConsentChange[];
    grantAll(): ConsentChange[];
    revokeAll(): ConsentChange[];
  };
  readonly views: {
    readonly state: View<Partial<ConsentData>>;
    readonly grants: View<Readonly<Record<string, boolean>>>;
    readonly pending: View<readonly string[]>;
  };
}

/**
 * @summary Whether a category is granted, given the records and the current policy version.
 *
 * @description
 * The rule every consent check uses: `necessary` always; otherwise a record
 * that is granted and was made under `policyVersion`. Exported so code
 * holding a copy of the records (a server, a worker) applies the same rule.
 *
 * @example
 * Example 1: A stale grant
 * ```ts
 * isConsentGranted({ analytics: { category: 'analytics', granted: true, timestamp: 0, policyVersion: 1 } }, 'analytics', 2); // false
 * ```
 *
 * @example
 * Example 2: Necessary
 * ```ts
 * isConsentGranted({}, 'necessary', 1); // true
 * ```
 *
 * @param {Readonly<Record<string, ConsentRecord>>} records The decisions.
 * @param {string} category The category.
 * @param {number} policyVersion The current policy version.
 * @returns {boolean} Whether it is granted.
 *
 * @public
 */
export function isConsentGranted(
  records: Readonly<Record<string, ConsentRecord>>,
  category: string,
  policyVersion: number,
): boolean {
  if (category === NECESSARY) return true;
  const record = records[category];
  return record !== undefined && record.granted && record.policyVersion === policyVersion;
}

/**
 * @summary Creates the Consent subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode CONSENT_ID}, featurized, Tab
 * scope until M5). Decisions persist through the kernel's `persistence`.
 * Every change is broadcast as {@linkcode CONSENT_CHANGED}; a failed
 * broadcast is reported, and the change stands.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * new Kernel([...centralized, createConsent({ policyVersion: 2 }), analytics], { persistence });
 * ```
 *
 * @example
 * Example 2: Reacting to changes in another subsystem
 * ```ts
 * defineSubsystem({
 *   id: 'analytics',
 *   subscribes: ['consent:changed'],
 *   receive: (packet) => applyConsent(packet.take() as ConsentChange[]),
 *   // ...
 * });
 * ```
 *
 * @param {ConsentOptions} [options] Policy version, categories and clock.
 * @returns {SubsystemDefinition<ConsentData, ConsentControl>} The subsystem.
 * @throws {RangeError} When `categories` does not include `necessary`.
 *
 * @public
 */
export function createConsent(
  options: ConsentOptions = {},
): SubsystemDefinition<ConsentData, ConsentControl> {
  const now = options.now ?? Date.now;
  const policyVersion = options.policyVersion ?? 1;
  const categories = [...(options.categories ?? DEFAULT_CATEGORIES)];
  if (!categories.includes(NECESSARY)) {
    throw new RangeError(`Consent categories must include "${NECESSARY}".`);
  }

  return defineSubsystem({
    id: CONSENT_ID,
    scope: 'tab',
    kind: 'featurized',
    state: {
      initial: { policyVersion, categories, records: {} } as ConsentData,
      policy: {
        policyVersion: { readable: true },
        categories: { readable: true },
        records: { readable: true, persisted: true },
      },
      version: 1,
    },
    control: (ctx) => {
      const records = () => ctx.state.get().records;
      const granted = (category: string) => isConsentGranted(records(), category, policyVersion);

      /** Applies decisions, broadcasts the changes, and returns them. */
      const decide = (decisions: Readonly<Record<string, boolean>>): ConsentChange[] => {
        for (const category of Object.keys(decisions)) {
          if (!categories.includes(category)) {
            throw new RangeError(`Unknown consent category "${category}".`);
          }
        }
        const timestamp = now();
        // Record every decision that is new, different, or made under an older policy:
        // an explicit "no" clears `pending` even though nothing effective changes.
        const recorded: ConsentRecord[] = Object.entries(decisions)
          .filter(([category, value]) => {
            const record = records()[category];
            return (
              category !== NECESSARY &&
              (record?.granted !== value || record?.policyVersion !== policyVersion)
            );
          })
          .map(([category, value]) => ({ category, granted: value, timestamp, policyVersion }));
        // Broadcast only what changes the gate.
        const changes = recorded.filter((r) => granted(r.category) !== r.granted);
        if (recorded.length > 0) {
          ctx.state.update((s) => {
            for (const record of recorded) s.records[record.category] = record;
          });
        }
        if (changes.length > 0) {
          ctx.port
            .send({ eventId: CONSENT_CHANGED, payload: changes, importance: 'HIGH' })
            .catch((error: unknown) => ctx.report(error));
        }
        return changes;
      };
      const every = (value: boolean) =>
        Object.fromEntries(categories.map((category) => [category, value]));

      const records$ = deriveView(ctx.state.readable, (s) => s.records ?? {});
      return {
        commands: {
          isGranted: granted,
          grant: (category: string) => decide({ [category]: true }).length > 0,
          revoke: (category: string) => decide({ [category]: false }).length > 0,
          set: decide,
          grantAll: () => decide(every(true)),
          revokeAll: () => decide(every(false)),
        },
        views: {
          state: ctx.state.readable,
          grants: deriveView(records$, (current) =>
            Object.fromEntries(
              categories.map((c) => [c, isConsentGranted(current, c, policyVersion)]),
            ),
          ),
          pending: deriveView(records$, (current) =>
            categories.filter(
              (c) => c !== NECESSARY && current[c]?.policyVersion !== policyVersion,
            ),
          ),
        },
      };
    },
  });
}
