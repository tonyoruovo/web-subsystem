/**
 * @fileoverview
 * @summary The single lifecycle state machine shared by every unit.
 * @description
 * Implements docs/ARCHITECTURE.md §4 (amendment A8). Every subsystem and
 * feature moves through the same statuses; the platform status is derived
 * from them, never set by hand.
 *
 * ```text
 *   UNINITIALIZED -> INITIALIZING -> READY <-> BUSY
 *                         |           |  ^
 *                         v           v  |  resume
 *                       FAILED <--- SUSPENDED
 *   READY/BUSY -> DEGRADED -> READY        any -> DESTROYING -> DESTROYED
 *   ```
 *
 * @author MathAid
 */

import { createStore, type View } from './view';

/** @summary Every status a unit can be in. */
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

/** @summary A unit's lifecycle status. */
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/**
 * @summary The allowed transitions, from each status.
 * @description
 * - `FAILED -> INITIALIZING` is a restart.
 * - `DESTROYING` is reachable from every live status; `DESTROYED` is final.
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

/** @summary Statuses in which a unit serves requests. */
export const RUNNING_STATUSES: ReadonlySet<UnitStatus> = new Set(['READY', 'BUSY', 'DEGRADED']);

/**
 * @summary True when `from -> to` is an allowed transition.
 * @param {UnitStatus} from The current status.
 * @param {UnitStatus} to The requested status.
 * @returns {boolean} Whether the transition is allowed.
 */
export function canTransition(from: UnitStatus, to: UnitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** @summary Thrown when a unit is asked to make a transition the state machine forbids. */
export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(
    readonly unitId: string,
    readonly from: UnitStatus,
    readonly to: UnitStatus,
  ) {
    super(`[${unitId}] Illegal lifecycle transition ${from} -> ${to}.`);
  }
}

/** @summary A unit's lifecycle, as observed through a view. */
export interface LifecycleSnapshot {
  readonly status: UnitStatus;
  /** Why the unit is in this status (the error message, the suspension cause, ...). */
  readonly reason: string | null;
  /** Unmet required dependencies, while the unit waits to start (§7.1). */
  readonly waitingFor: readonly string[];
  /** Ids of features that are not running, while the unit is `DEGRADED`. */
  readonly offFeatures: readonly string[];
}

/**
 * @summary One unit's lifecycle state machine.
 * @description
 * Rejects illegal transitions with {@linkcode IllegalTransitionError} and
 * publishes every change through an observable {@linkcode View}.
 *
 * @example
 * ```ts
 * const lifecycle = new Lifecycle('storage');
 * lifecycle.transition('INITIALIZING');
 * lifecycle.transition('READY');
 * lifecycle.view.getSnapshot().status; // 'READY'
 * ```
 */
export class Lifecycle {
  readonly #store = createStore<LifecycleSnapshot>({
    status: 'UNINITIALIZED',
    reason: null,
    waitingFor: [],
    offFeatures: [],
  });

  constructor(readonly unitId: string) {}

  /** @summary The observable lifecycle snapshot. */
  get view(): View<LifecycleSnapshot> {
    return this.#store.view;
  }

  /** @summary The current status. */
  get status(): UnitStatus {
    return this.#store.view.getSnapshot().status;
  }

  /**
   * @summary Moves to `to`.
   * @param {UnitStatus} to The new status.
   * @param {object} [details] Reason and feature details for the snapshot.
   * @throws {IllegalTransitionError} When the state machine forbids the transition.
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
   * @summary Updates the reason and off features without changing status
   * (for example, a different feature failed while already `DEGRADED`).
   * @param {object} details The new details.
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
