/**
 * @fileoverview
 * @summary The platform status, derived from every unit's lifecycle and from pending work.
 * @description
 * Implements the derivation of docs/ARCHITECTURE.md §10.1. The platform
 * status is never set by hand:
 *
 * ```text
 *   any unit INITIALIZING (or not started yet)          --> INITIALIZING
 *   any unit FAILED, DEGRADED, or waiting for a dep     --> DEGRADED
 *   any unit BUSY, or pending work > busy threshold     --> BUSY
 *   otherwise                                           --> IDLE
 *   after shutdown                                      --> STOPPED
 *   ```
 *
 * Admission follows the status: `CRITICAL` work is always accepted, nothing
 * else while `BUSY`, no `LOW` work while `DEGRADED`, nothing once `STOPPED`.
 *
 * @example
 * Deriving a status from the kernel's statuses
 * ```ts
 * import { derivePlatformStatus, summarizeUnits } from '@platform/global-state';
 *
 * const summary = summarizeUnits(kernel.statuses.getSnapshot());
 * derivePlatformStatus(summary, 0, 50); // 'IDLE', 'BUSY', 'DEGRADED' or 'INITIALIZING'
 * ```
 *
 * @example
 * Checking admission
 * ```ts
 * import { canAccept } from '@platform/global-state';
 *
 * canAccept('BUSY', 'CRITICAL'); // true
 * canAccept('BUSY', 'HIGH');     // false
 * ```
 *
 * @author MathAid
 */

import type { Importance, LifecycleSnapshot } from '@platform/core';

/**
 * @summary The status of the whole platform.
 * @description
 * - `INITIALIZING`: some unit is still starting.
 * - `IDLE`: everything runs and there is spare capacity.
 * - `BUSY`: some unit is busy, or too much work is pending; only `CRITICAL` work is admitted.
 * - `DEGRADED`: some unit failed, is degraded, or waits for a missing dependency; `LOW` work is refused.
 * - `STOPPED`: the platform shut down; nothing is admitted.
 *
 * @public
 */
export type PlatformStatus = 'INITIALIZING' | 'IDLE' | 'BUSY' | 'DEGRADED' | 'STOPPED';

/**
 * @summary Counts of units by condition, as used to derive the platform status.
 *
 * @description
 * `total` counts every unit considered (destroyed units are left out).
 * `running` counts `READY`, `BUSY` and `DEGRADED` units; `busy`, `degraded`
 * and `failed` count those statuses; `waiting` counts units held back by a
 * dependency; `initializing` counts units starting, or not started yet.
 *
 * Exposed in Global State's view so a UI can explain the platform's state.
 *
 * @example
 * Example 1: A healthy platform
 * ```ts
 * // { total: 6, running: 6, busy: 0, degraded: 0, failed: 0, waiting: 0, initializing: 0 }
 * ```
 *
 * @example
 * Example 2: A missing optional package
 * ```ts
 * // { total: 6, running: 5, ..., waiting: 1 }  -> the platform is DEGRADED
 * ```
 *
 * @public
 */
export interface UnitSummary {
  /**
   * @summary The number of units that the summary counts.
   * @description Global State leaves out itself and the destroyed units.
   */
  readonly total: number;
  /**
   * @summary The number of units that run: `READY`, `BUSY` or `DEGRADED`.
   */
  readonly running: number;
  /**
   * @summary The number of `BUSY` units.
   */
  readonly busy: number;
  /**
   * @summary The number of `DEGRADED` units.
   */
  readonly degraded: number;
  /**
   * @summary The number of `FAILED` units.
   */
  readonly failed: number;
  /**
   * @summary The number of units that wait for a dependency.
   */
  readonly waiting: number;
  /**
   * @summary The number of `INITIALIZING` units.
   */
  readonly initializing: number;
}

/**
 * @summary Counts units by condition.
 *
 * @description
 * Skips `excludeId` (Global State leaves itself out) and units being or
 * already destroyed. Suspended units are counted in `total` only: a unit
 * suspended because its dependency failed is reflected by that dependency.
 *
 * @example
 * Example 1: Summarizing the kernel's statuses
 * ```ts
 * summarizeUnits(kernel.statuses.getSnapshot());
 * ```
 *
 * @example
 * Example 2: Leaving one unit out
 * ```ts
 * summarizeUnits(ctx.statuses.getSnapshot(), ctx.id);
 * ```
 *
 * @param {Readonly<Record<string, LifecycleSnapshot>>} statuses Every unit's lifecycle, by id.
 * @param {string} [excludeId] A unit to leave out.
 * @returns {UnitSummary} The counts.
 *
 * @public
 */
export function summarizeUnits(
  statuses: Readonly<Record<string, LifecycleSnapshot>>,
  excludeId?: string,
): UnitSummary {
  const summary = {
    total: 0,
    running: 0,
    busy: 0,
    degraded: 0,
    failed: 0,
    waiting: 0,
    initializing: 0,
  };
  for (const [id, { status, waitingFor }] of Object.entries(statuses)) {
    if (id === excludeId || status === 'DESTROYING' || status === 'DESTROYED') continue;
    summary.total += 1;
    if (status === 'READY' || status === 'BUSY' || status === 'DEGRADED') summary.running += 1;
    if (status === 'BUSY') summary.busy += 1;
    if (status === 'DEGRADED') summary.degraded += 1;
    if (status === 'FAILED') summary.failed += 1;
    if (status === 'INITIALIZING') summary.initializing += 1;
    if (status === 'UNINITIALIZED') {
      if (waitingFor.length > 0) summary.waiting += 1;
      else summary.initializing += 1;
    }
  }
  return summary;
}

/**
 * @summary Derives the platform status.
 *
 * @description
 * Applies the rules in the file overview, in order: initializing first,
 * then degraded, then busy, then idle.
 *
 * @example
 * Example 1: Too much pending work
 * ```ts
 * derivePlatformStatus(healthySummary, 80, 50); // 'BUSY'
 * ```
 *
 * @example
 * Example 2: A failed unit outweighs a busy one
 * ```ts
 * derivePlatformStatus({ ...healthySummary, failed: 1, busy: 2 }, 0, 50); // 'DEGRADED'
 * ```
 *
 * @param {UnitSummary} summary The unit counts.
 * @param {number} pendingWork Work items in progress.
 * @param {number} busyThreshold Pending work above which the platform is `BUSY`.
 * @returns {PlatformStatus} The status. Never `STOPPED`: that is set on shutdown.
 *
 * @public
 */
export function derivePlatformStatus(
  summary: UnitSummary,
  pendingWork: number,
  busyThreshold: number,
): PlatformStatus {
  if (summary.initializing > 0) return 'INITIALIZING';
  if (summary.failed > 0 || summary.degraded > 0 || summary.waiting > 0) return 'DEGRADED';
  if (summary.busy > 0 || pendingWork > busyThreshold) return 'BUSY';
  return 'IDLE';
}

/**
 * @summary Tells whether work of an importance is admitted in a platform status.
 *
 * @example
 * Example 1: Critical work always passes (until shutdown)
 * ```ts
 * canAccept('BUSY', 'CRITICAL'); // true
 * canAccept('STOPPED', 'CRITICAL'); // false
 * ```
 *
 * @example
 * Example 2: Low-priority work waits out a degraded platform
 * ```ts
 * canAccept('DEGRADED', 'LOW'); // false
 * canAccept('DEGRADED', 'MEDIUM'); // true
 * ```
 *
 * @param {PlatformStatus} status The platform status.
 * @param {Importance} importance The work's importance.
 * @returns {boolean} `true` when the work is admitted.
 *
 * @public
 */
export function canAccept(status: PlatformStatus, importance: Importance): boolean {
  if (status === 'STOPPED') return false;
  if (importance === 'CRITICAL') return true;
  if (status === 'BUSY') return false;
  if (status === 'DEGRADED' && importance === 'LOW') return false;
  return true;
}
