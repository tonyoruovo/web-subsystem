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
 *
 *   Window scope: every tab of the site shares the decisions (ARCHITECTURE §11.3)
 *     a change here      --> 'consent:changed' reaches the Consent of every other tab --> merged
 *     this tab starts    --> 'consent:sync' --> other tabs answer 'consent:state' (their records) --> merged
 *     merge              per category, the newer decision wins
 *   ```
 *
 * Retention and data-subject requests (export, erase) need Storage and arrive
 * with it in M6.
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
 * @summary The event a starting Consent broadcasts to ask the other tabs for their decisions.
 * @constant {'consent:sync'}
 * @public
 */
export const CONSENT_SYNC = 'consent:sync';

/**
 * @summary The event other tabs answer `consent:sync` with: their records, as {@linkcode ConsentRecord}s.
 * @constant {'consent:state'}
 * @public
 */
export const CONSENT_STATE = 'consent:state';

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
  /**
   * @summary The category of the decision, for example `analytics`.
   */
  readonly category: string;
  /**
   * @summary Tells if the user granted the category.
   */
  readonly granted: boolean;
  /**
   * @summary The time of the decision, in Unix milliseconds.
   * @description When two tabs disagree, the newer decision wins.
   */
  readonly timestamp: number;
  /**
   * @summary The policy version under which the user decided.
   * @description A decision under another version does not count.
   */
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
  /**
   * @summary The current version of the policy.
   * @description The default is 1. Increase it when the policy changes: the
   * earlier decisions stop counting, and `pending` lists all categories again.
   */
  readonly policyVersion?: number;
  /**
   * @summary The categories that the user can decide on.
   * @description The default is {@linkcode DEFAULT_CATEGORIES}. The list must include `necessary`.
   */
  readonly categories?: readonly string[];
  /**
   * @summary The clock, in Unix milliseconds.
   * @description The default is `Date.now`.
   */
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
  /**
   * @summary The current version of the policy.
   */
  policyVersion: number;
  /**
   * @summary The categories that the user can decide on.
   */
  categories: string[];
  /**
   * @summary The last decision for each category.
   * @description The kernel persists this key. `necessary` is never in it.
   */
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
  /**
   * @summary The commands of Consent.
   */
  readonly commands: {
    /**
     * @summary Tells if a category is granted now.
     * @description `necessary` is always granted. Other categories need a grant
     * under the current policy version. An unknown category is not granted.
     * @example
     * Gating analytics
     * ```ts
     * if (commands.isGranted('analytics')) track(event);
     * ```
     * @param {string} category The category.
     * @returns {boolean} `true` when the category is granted.
     */
    isGranted(category: string): boolean;
    /**
     * @summary Grants one category.
     * @description Consent records the decision and broadcasts `consent:changed` when the gate changes.
     * @example
     * A switch in the settings page
     * ```ts
     * analyticsSwitch.onchange = () => commands.grant('analytics');
     * ```
     * @param {string} category The category.
     * @returns {boolean} `true` when the gate changed.
     * @throws {RangeError} For a category that is not in `categories`.
     */
    grant(category: string): boolean;
    /**
     * @summary Revokes one category.
     * @description Revoking `necessary` has no effect.
     * @example
     * Turning marketing off
     * ```ts
     * commands.revoke('marketing');
     * ```
     * @param {string} category The category.
     * @returns {boolean} `true` when the gate changed.
     * @throws {RangeError} For a category that is not in `categories`.
     */
    revoke(category: string): boolean;
    /**
     * @summary Records several decisions with one broadcast.
     * @description An explicit "no" for an undecided category is recorded but
     * not broadcast, because the gate does not change.
     * @example
     * The "save" button of a consent banner
     * ```ts
     * save.onclick = () => commands.set({ analytics: analyticsBox.checked, marketing: false });
     * ```
     * @param {Readonly<Record<string, boolean>>} decisions The decision for each category.
     * @returns {ConsentChange[]} The changes of the gate.
     * @throws {RangeError} For a category that is not in `categories`.
     */
    set(decisions: Readonly<Record<string, boolean>>): ConsentChange[];
    /**
     * @summary Grants all categories.
     * @example
     * The "accept all" button
     * ```ts
     * acceptAll.onclick = () => commands.grantAll();
     * ```
     * @returns {ConsentChange[]} The changes of the gate.
     */
    grantAll(): ConsentChange[];
    /**
     * @summary Revokes all categories. `necessary` stays granted.
     * @example
     * The "reject all" button
     * ```ts
     * rejectAll.onclick = () => commands.revokeAll();
     * ```
     * @returns {ConsentChange[]} The changes of the gate.
     */
    revokeAll(): ConsentChange[];
  };
  /**
   * @summary The views of Consent.
   */
  readonly views: {
    /**
     * @summary The state of Consent: the policy version, the categories and the records.
     */
    readonly state: View<Partial<ConsentData>>;
    /**
     * @summary The current gate of each category: `true` when it is granted.
     */
    readonly grants: View<Readonly<Record<string, boolean>>>;
    /**
     * @summary The categories to ask the user about.
     * @description A category is pending when it has no decision under the current policy version.
     */
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
 * @summary Merges decisions from another tab: per category, the newer decision wins.
 *
 * @description
 * Returns the merged records and the incoming records that won. Records for
 * `necessary` and for categories not in `categories` are ignored. On equal
 * timestamps the local decision stays.
 *
 * @example
 * Example 1: A newer grant from another tab
 * ```ts
 * mergeConsentRecords({}, [{ category: 'analytics', granted: true, timestamp: 2, policyVersion: 1 }], ['analytics']);
 * // { records: { analytics: {...} }, applied: [{ category: 'analytics', ... }] }
 * ```
 *
 * @example
 * Example 2: An older one loses
 * ```ts
 * mergeConsentRecords({ analytics: newer }, [older], ['analytics']).applied; // []
 * ```
 *
 * @param {Readonly<Record<string, ConsentRecord>>} local This tab's records.
 * @param {readonly ConsentRecord[]} incoming Records from another tab.
 * @param {readonly string[]} categories The known categories.
 * @returns {{ records: Record<string, ConsentRecord>; applied: ConsentRecord[] }} The merge and the records that won.
 *
 * @public
 */
export function mergeConsentRecords(
  local: Readonly<Record<string, ConsentRecord>>,
  incoming: readonly ConsentRecord[],
  categories: readonly string[],
): { records: Record<string, ConsentRecord>; applied: ConsentRecord[] } {
  const records = { ...local };
  const applied: ConsentRecord[] = [];
  for (const record of incoming) {
    if (record.category === NECESSARY || !categories.includes(record.category)) continue;
    const current = records[record.category];
    if (current && current.timestamp >= record.timestamp) continue;
    records[record.category] = record;
    applied.push(record);
  }
  return { records, applied };
}

/**
 * @summary Creates the Consent subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode CONSENT_ID}, featurized,
 * Window scope). Decisions persist through the kernel's `persistence`. Every
 * change is broadcast as {@linkcode CONSENT_CHANGED}; a failed broadcast is
 * reported, and the change stands. With the Window transport (`window`,
 * `@platform/hub`), every tab of the site shares the decisions; Consent
 * starts after it, so its first `consent:sync` leaves the tab.
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
    scope: 'window',
    kind: 'featurized',
    requires: [{ target: 'window', kind: 'optional' }],
    subscribes: [CONSENT_CHANGED, CONSENT_SYNC, CONSENT_STATE],
    state: {
      initial: { policyVersion, categories, records: {} } as ConsentData,
      policy: {
        policyVersion: { readable: true },
        categories: { readable: true },
        records: { readable: true, persisted: true },
      },
      version: 1,
    },
    init(ctx) {
      ctx.port
        .send({ eventId: CONSENT_SYNC, payload: null, importance: 'HIGH' })
        .catch((error: unknown) => ctx.report(error));
    },
    receive(packet, ctx) {
      const { eventId } = packet.header;
      if (eventId === CONSENT_SYNC) {
        const mine = Object.values(ctx.state.get().records);
        if (mine.length === 0) return;
        ctx.port
          .send({ eventId: CONSENT_STATE, payload: mine, importance: 'HIGH' })
          .catch((error: unknown) => ctx.report(error));
        return;
      }
      // consent:changed or consent:state from another tab (a tab never hears its own).
      const incoming = packet.take();
      if (!Array.isArray(incoming)) return;
      const { records, applied } = mergeConsentRecords(
        ctx.state.get().records,
        incoming as ConsentRecord[],
        categories,
      );
      if (applied.length > 0) ctx.state.update((s) => void (s.records = records));
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
