/**
 * @fileoverview
 * @summary The single lifecycle state machine shared by every unit.
 * @description
 * Implements docs/ARCHITECTURE.md §4 (amendment A8). Every subsystem and
 * feature moves through the same statuses, and the platform status is derived
 * from them, never set by hand.
 *
 * ```text
 *   UNINITIALIZED --> INITIALIZING --> READY <--> BUSY
 *                          |             |  ^
 *                          v             v  |  resume
 *                        FAILED <---- SUSPENDED
 *   READY/BUSY --> DEGRADED --> READY          any --> DESTROYING --> DESTROYED
 *   ```
 *
 * The kernel drives each unit's {@linkcode Lifecycle}; applications only read
 * it, through `kernel.unit(id).lifecycle` or `kernel.statuses`.
 *
 * @example
 * Reacting to a unit becoming degraded
 * ```ts
 * const lifecycle = kernel.unit('storage').lifecycle;
 * lifecycle.subscribe(() => {
 *   const { status, offFeatures } = lifecycle.getSnapshot();
 *   if (status === 'DEGRADED') showBanner(`Storage running without: ${offFeatures.join(', ')}`);
 * });
 * ```
 *
 * @example
 * Checking a transition before asking for it
 * ```ts
 * import { canTransition } from '@platform/core';
 *
 * canTransition('FAILED', 'INITIALIZING'); // true: a restart
 * canTransition('DESTROYED', 'READY');     // false: destroyed is final
 * ```
 *
 * @throws {IllegalTransitionError} From {@linkcode Lifecycle.transition} for any transition not in {@linkcode TRANSITIONS}.
 * @author MathAid
 */

import { createStore, type View } from './view';

/**
 * @summary Every status a unit can be in.
 * @description
 * The statuses in declaration order: `UNINITIALIZED`, `INITIALIZING`, `READY`,
 * `BUSY`, `DEGRADED`, `SUSPENDED`, `FAILED`, `DESTROYING`, `DESTROYED`.
 * {@linkcode UnitStatus} is derived from this tuple.
 *
 * @example
 * Listing every status, for example in a debug panel
 * ```ts
 * for (const status of UNIT_STATUSES) console.log(status);
 * ```
 *
 * @constant
 * @public
 */
export const UNIT_STATUSES = [
  'UNINITIALIZED',
  'INITIALIZING',
  'READY',
  'BUSY',
  'DEGRADED',
  'SUSPENDED',
  'FAILED',
  'DESTROYING',
  'DESTROYED',
] as const;

/**
 * @summary A unit's lifecycle status.
 * @description
 * - `UNINITIALIZED`: not started yet, possibly waiting for dependencies.
 * - `INITIALIZING`: running `init`, its features and its processors.
 * - `READY` / `BUSY`: running; `BUSY` while the unit reports heavy work.
 * - `DEGRADED`: running, with some features off.
 * - `SUSPENDED`: paused (page hidden, bfcache, or a dependency stopped); state kept.
 * - `FAILED`: could not start, or failed while running. Can be restarted.
 * - `DESTROYING` / `DESTROYED`: torn down. `DESTROYED` is final.
 *
 * @public
 */
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/**
 * @summary The allowed transitions, from each status.
 * @description
 * Maps every {@linkcode UnitStatus} to the statuses it may move to.
 * `FAILED -> INITIALIZING` is a restart. `DESTROYING` is reachable from every
 * live status, and `DESTROYED` has no way out.
 *
 * @example
 * Where a running unit can go
 * ```ts
 * TRANSITIONS.READY; // ['BUSY', 'DEGRADED', 'SUSPENDED', 'FAILED', 'DESTROYING']
 * ```
 *
 * @constant
 * @public
 */
export const TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  UNINITIALIZED: ['INITIALIZING', 'DESTROYING'],
  INITIALIZING: ['READY', 'DEGRADED', 'FAILED', 'DESTROYING'],
  READY: ['BUSY', 'DEGRADED', 'SUSPENDED', 'FAILED', 'DESTROYING'],
  BUSY: ['READY', 'DEGRADED', 'SUSPENDED', 'FAILED', 'DESTROYING'],
  DEGRADED: ['READY', 'SUSPENDED', 'FAILED', 'DESTROYING'],
  SUSPENDED: ['READY', 'DEGRADED', 'FAILED', 'DESTROYING'],
  FAILED: ['INITIALIZING', 'DESTROYING'],
  DESTROYING: ['DESTROYED'],
  DESTROYED: [],
};

/**
 * @summary The statuses in which a unit serves requests: `READY`, `BUSY` and `DEGRADED`.
 * @description
 * A dependency is met, a control interface is available, and packets are
 * delivered only while the unit's status is in this set.
 *
 * @example
 * Checking whether a unit can be used
 * ```ts
 * if (RUNNING_STATUSES.has(kernel.unit('auth').lifecycle.getSnapshot().status)) login();
 * ```
 *
 * @constant
 * @public
 */
export const RUNNING_STATUSES: ReadonlySet<UnitStatus> = new Set(['READY', 'BUSY', 'DEGRADED']);

/**
 * @summary Tells whether `from -> to` is an allowed transition.
 *
 * @description
 * Looks `to` up in {@linkcode TRANSITIONS}`[from]`. It is a pure check: it
 * does not change any lifecycle.
 *
 * @example
 * Example 1: A restart is allowed
 * ```ts
 * canTransition('FAILED', 'INITIALIZING'); // true
 * ```
 *
 * @example
 * Example 2: Skipping initialization is not
 * ```ts
 * canTransition('UNINITIALIZED', 'READY'); // false
 * ```
 *
 * @param {UnitStatus} from The current status.
 * @param {UnitStatus} to The requested status.
 * @returns {boolean} `true` when the transition is allowed.
 *
 * @public
 */
export function canTransition(from: UnitStatus, to: UnitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * @summary Thrown when a unit is asked to make a transition the state machine forbids.
 *
 * @description
 * Carries the unit's id and both statuses as `unitId`, `from` and `to`.
 *
 * It signals a bug in whatever drove the lifecycle (normally the kernel), not
 * a runtime condition an application should recover from.
 *
 * @example
 * Example 1: Inspecting the failed transition
 * ```ts
 * try {
 *   lifecycle.transition('READY');
 * } catch (error) {
 *   if (error instanceof IllegalTransitionError) console.error(error.from, '->', error.to);
 * }
 * ```
 *
 * @example
 * Example 2: The message names the unit
 * ```ts
 * new IllegalTransitionError('auth', 'DESTROYED', 'READY').message;
 * // '[auth] Illegal lifecycle transition DESTROYED -> READY.'
 * ```
 *
 * @public
 */
export class IllegalTransitionError extends Error {
  /**
   * @summary The name of the error class: `'IllegalTransitionError'`.
   */
  override readonly name = 'IllegalTransitionError';

  /**
   * @summary Creates the error for one refused transition.
   * @param {string} unitId The full id of the unit.
   * @param {UnitStatus} from The current status.
   * @param {UnitStatus} to The status that was asked for.
   */
  constructor(
    /**
     * @summary The full id of the unit.
     */
    readonly unitId: string,
    /**
     * @summary The status of the unit when the transition was asked for.
     */
    readonly from: UnitStatus,
    /**
     * @summary The status that the transition table does not allow from `from`.
     */
    readonly to: UnitStatus,
  ) {
    super(`[${unitId}] Illegal lifecycle transition ${from} -> ${to}.`);
  }
}

/**
 * @summary A unit's lifecycle at one moment, as published through its view.
 *
 * @description
 * Holds the `status`, the `reason` for it (an error message, a suspension
 * cause, or `null`), the dependencies the unit is `waitingFor` while it cannot
 * start, and the `offFeatures` that are not running while it is `DEGRADED`.
 *
 * Applications use it to explain the platform's state to users (offline
 * banners, degraded-mode notices) and to debug boot problems.
 *
 * @example
 * Example 1: A unit waiting for a dependency
 * ```ts
 * // { status: 'UNINITIALIZED', reason: null, waitingFor: ['consent'], offFeatures: [] }
 * ```
 *
 * @example
 * Example 2: A degraded unit
 * ```ts
 * // { status: 'DEGRADED', reason: 'Features not running: idb.', waitingFor: [], offFeatures: ['idb'] }
 * ```
 *
 * @public
 * @see {@linkcode Lifecycle}
 */
export interface LifecycleSnapshot {
  /**
   * @summary The current status of the unit.
   */
  readonly status: UnitStatus;
  /**
   * @summary Why the unit has this status, or `null`.
   * @description For `FAILED`, it is the error message. For `SUSPENDED`, it is
   * the cause of the suspension, for example `Waiting for storage.`
   */
  readonly reason: string | null;
  /**
   * @summary The unmet required dependencies, while the unit waits to start (ARCHITECTURE §7.1).
   * @description The list is empty when the unit does not wait.
   */
  readonly waitingFor: readonly string[];
  /**
   * @summary The ids of the features that do not run, while the unit is `DEGRADED`.
   */
  readonly offFeatures: readonly string[];
}

/**
 * @summary One unit's lifecycle state machine.
 *
 * @description
 * Holds the unit's current {@linkcode LifecycleSnapshot} in a store and
 * exposes it as a {@linkcode View}. `transition` moves to a new status and
 * rejects forbidden moves with {@linkcode IllegalTransitionError}; `describe`
 * and `wait` update the snapshot's details without changing the status.
 *
 * The kernel creates one per unit and is the only caller of its mutating
 * methods. Applications read it through `kernel.unit(id).lifecycle`.
 *
 * @example
 * Example 1: Driving a lifecycle by hand, as the kernel does
 * ```ts
 * const lifecycle = new Lifecycle('storage');
 * lifecycle.transition('INITIALIZING');
 * lifecycle.transition('READY');
 * lifecycle.view.getSnapshot().status; // 'READY'
 * ```
 *
 * @example
 * Example 2: Recording what a unit waits for
 * ```ts
 * const lifecycle = new Lifecycle('auth');
 * lifecycle.wait(['storage']);
 * lifecycle.view.getSnapshot(); // { status: 'UNINITIALIZED', waitingFor: ['storage'], ... }
 * ```
 *
 * @internal Applications read lifecycles; only the kernel drives them.
 * @see {@linkcode TRANSITIONS}
 */
export class Lifecycle {
  readonly #store = createStore<LifecycleSnapshot>({
    status: 'UNINITIALIZED',
    reason: null,
    waitingFor: [],
    offFeatures: [],
  });

  /**
   * @param {string} unitId The unit's full id, used in error messages.
   */
  constructor(readonly unitId: string) {}

  /**
   * @summary The observable lifecycle snapshot.
   * @returns {View<LifecycleSnapshot>} The view.
   */
  get view(): View<LifecycleSnapshot> {
    return this.#store.view;
  }

  /**
   * @summary The current status.
   * @returns {UnitStatus} The status in the current snapshot.
   */
  get status(): UnitStatus {
    return this.#store.view.getSnapshot().status;
  }

  /**
   * @summary Moves to a new status.
   * @description Clears `waitingFor`, and sets `reason` and `offFeatures` from `details`.
   * @param {UnitStatus} to The new status.
   * @param {object} [details] The reason and the off features for the new snapshot.
   * @throws {IllegalTransitionError} When {@linkcode TRANSITIONS} does not allow the move.
   */
  transition(
    to: UnitStatus,
    details: { reason?: string | null; offFeatures?: readonly string[] } = {},
  ): void {
    const from = this.status;
    if (!canTransition(from, to)) throw new IllegalTransitionError(this.unitId, from, to);
    this.#store.set({
      status: to,
      reason: details.reason ?? null,
      waitingFor: [],
      offFeatures: details.offFeatures ?? [],
    });
  }

  /**
   * @summary Updates the reason and the off features without changing status.
   * @description For example, when another feature fails while the unit is
   * already `DEGRADED`. Fields left out of `details` keep their values.
   * @param {object} details The new reason and off features.
   */
  describe(details: { reason?: string | null; offFeatures?: readonly string[] }): void {
    const current = this.#store.view.getSnapshot();
    this.#store.set({
      ...current,
      reason: details.reason ?? current.reason,
      offFeatures: details.offFeatures ?? current.offFeatures,
    });
  }

  /**
   * @summary Records the dependencies the unit is waiting for, without changing status.
   * @param {readonly string[]} waitingFor The unmet required dependencies.
   */
  wait(waitingFor: readonly string[]): void {
    const current = this.#store.view.getSnapshot();
    this.#store.set({ ...current, waitingFor: [...waitingFor] });
  }
}
