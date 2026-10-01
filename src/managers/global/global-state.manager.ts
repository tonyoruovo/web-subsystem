/**
 * @fileoverview
 * @summary The Global State manager: platform status, work tokens, and registry.
 * @description
 * Implements the canonical source of truth for platform status. It holds the
 * pending work tokens, the manager registry, and the busy threshold. From these
 * it derives `IDLE`, `BUSY`, `DEGRADED`, `STOPPED`, or `CRASHED`. The bus reads
 * this status to decide admission, and the circuit breakers read manager health.
 *
 * ```text
 *   pendingTokens.size === 0            -> IDLE
 *   pendingTokens.size >  busyThreshold -> BUSY
 *   a CRITICAL manager is unhealthy     -> DEGRADED
 *   stop() called                       -> STOPPED
 *   crash() called                      -> CRASHED
 *   ```
 *
 * This class holds the pure state and computation. It is framework-agnostic: a
 * host framework may wrap it in reactivity for UI binding, but the logic itself
 * has no dependency on Vue, Pinia, or any other framework.
 *
 * @see {@linkcode PendingToken}
 * @see {@linkcode SubsystemStatus}
 * @author MathAid
 */

import type { Importance } from '../packet.dto';
import type {
  PendingToken,
  PlatformStatus,
  SubsystemStatus,
  SubsystemStatusType,
} from './global.state.dto';

/**
 * @summary Options for constructing a {@linkcode GlobalState}.
 */
export interface GlobalStateOptions {
  /** Work token count that triggers `BUSY`. Defaults to 50. */
  busyThreshold?: number;
  /** Heartbeat staleness in milliseconds before a manager is unhealthy. Defaults to 30000. */
  heartbeatTimeout?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * @summary The minimum health score for a manager to count as healthy.
 */
const MIN_HEALTH_SCORE = 50;

/**
 * @summary The Global State manager.
 * @description
 * One instance per realm. The queue and notification center consult it for
 * admission and health. It is a plain class so tests can drive it directly.
 *
 * @example
 * Example 1: Register work and read the derived status
 * ```ts
 * const state = new GlobalState({ busyThreshold: 2 });
 * state.markReady();
 * state.registerPendingToken({ id: 't1', subsystemId: 'sync', importance: 'HIGH', createdAt: Date.now(), estimatedDuration: null, category: 'SYNC' });
 * // state.getPlatformStatus() === 'IDLE' (1 <= 2)
 * ```
 */
export class GlobalState {
  /** @internal The current platform status. */
  private status: PlatformStatus = 'INITIALIZING';

  /** @internal Work token id to token. */
  private readonly pendingTokens = new Map<string, PendingToken>();

  /** @internal Manager id to status. */
  private readonly registry = new Map<string, SubsystemStatus>();

  /** @internal The busy threshold. */
  private readonly busyThreshold: number;

  /** @internal The heartbeat timeout in milliseconds. */
  private readonly heartbeatTimeout: number;

  /** @internal The clock. */
  private readonly now: () => number;

  /**
   * @summary Creates a GlobalState.
   * @param {GlobalStateOptions} [options] The configuration and injectables.
   */
  constructor(options: GlobalStateOptions = {}) {
    this.busyThreshold = options.busyThreshold ?? 50;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * @summary Transitions from `INITIALIZING` to `IDLE`.
   * @description
   * Call this once the manager itself has bootstrapped and registered itself.
   * @returns {void}
   */
  markReady(): void {
    if (this.status === 'INITIALIZING') {
      this.status = 'IDLE';
    }
  }

  /**
   * @summary The current platform status.
   * @returns {PlatformStatus} The status.
   */
  getPlatformStatus(): PlatformStatus {
    return this.status;
  }

  /**
   * @summary True when the platform is `IDLE` or `BUSY`.
   * @returns {boolean} `true` when ready.
   */
  isPlatformReady(): boolean {
    return this.status === 'IDLE' || this.status === 'BUSY';
  }

  /**
   * @summary Registers a pending work token if it is admitted.
   * @param {PendingToken} token The token to register.
   * @returns {boolean} `true` when the token was accepted.
   */
  registerPendingToken(token: PendingToken): boolean {
    if (!this.canAcceptWork(token.importance)) return false;
    this.pendingTokens.set(token.id, token);
    this.recompute();
    return true;
  }

  /**
   * @summary Completes a pending work token.
   * @param {string} id The token id to remove.
   * @returns {void}
   */
  completePendingToken(id: string): void {
    this.pendingTokens.delete(id);
    this.recompute();
  }

  /**
   * @summary Number of pending work tokens.
   * @returns {number} The count.
   */
  getPendingWorkCount(): number {
    return this.pendingTokens.size;
  }

  /**
   * @summary Whether work of a given importance is admitted now.
   * @description
   * `CRITICAL` work passes while `BUSY`. `LOW` work is rejected while
   * `DEGRADED`. Nothing passes while `STOPPED` or `CRASHED`.
   *
   * @param {Importance} importance The importance of the work.
   * @returns {boolean} `true` when admitted.
   */
  canAcceptWork(importance: Importance): boolean {
    if (this.status === 'STOPPED' || this.status === 'CRASHED') return false;
    if (importance === 'CRITICAL') return true;
    if (this.status === 'BUSY') return false;
    if (this.status === 'DEGRADED' && importance === 'LOW') return false;
    return true;
  }

  /**
   * @summary Registers or updates a manager in the registry.
   * @param {SubsystemStatus} status The manager status record.
   * @returns {void}
   */
  registerSubsystem(status: SubsystemStatus): void {
    this.registry.set(status.subsystemId, status);
  }

  /**
   * @summary Updates the status of a registered manager.
   * @param {string} subsystemId The manager id.
   * @param {SubsystemStatusType} status The new status.
   * @returns {void}
   */
  updateSubsystemStatus(subsystemId: string, status: SubsystemStatusType): void {
    const record = this.registry.get(subsystemId);
    if (!record) return;
    record.status = status;
    this.recompute();
  }

  /**
   * @summary Refreshes a manager's heartbeat.
   * @param {string} subsystemId The manager id.
   * @returns {void}
   */
  processHeartbeat(subsystemId: string): void {
    const record = this.registry.get(subsystemId);
    if (!record) return;
    record.lastHeartbeat = this.now();
  }

  /**
   * @summary The status record for one manager.
   * @param {string} subsystemId The manager id.
   * @returns {SubsystemStatus | undefined} The record, or `undefined` when unknown.
   */
  getSubsystemStatus(subsystemId: string): SubsystemStatus | undefined {
    return this.registry.get(subsystemId);
  }

  /**
   * @summary Whether a manager is healthy.
   * @description
   * A manager is unhealthy when it errors, its health score drops below 50, or
   * its heartbeat is stale.
   *
   * @param {string} subsystemId The manager id.
   * @returns {boolean} `true` when healthy.
   */
  isSubsystemHealthy(subsystemId: string): boolean {
    const record = this.registry.get(subsystemId);
    if (!record) return false;
    if (record.status === 'ERROR') return false;
    if (record.healthScore < MIN_HEALTH_SCORE) return false;
    if (this.now() - record.lastHeartbeat > this.heartbeatTimeout) return false;
    return true;
  }

  /**
   * @summary Stops the platform, blocking new work.
   * @returns {void}
   */
  stop(): void {
    this.status = 'STOPPED';
  }

  /**
   * @summary Marks the platform crashed.
   * @returns {void}
   */
  crash(): void {
    this.status = 'CRASHED';
  }

  /**
   * @summary Recomputes the status from pending work and manager health.
   * @description
   * Leaves `STOPPED` and `CRASHED` unchanged. A CRITICAL unhealthy manager sets
   * `DEGRADED`. Pending work over the threshold sets `BUSY`. Otherwise `IDLE`.
   *
   * @returns {void}
   * @internal
   */
  private recompute(): void {
    if (this.status === 'STOPPED' || this.status === 'CRASHED' || this.status === 'INITIALIZING')
      return;

    const degraded = [...this.registry.values()].some(
      (s) => s.importance === 'CRITICAL' && !this.isSubsystemHealthy(s.subsystemId),
    );

    if (degraded) {
      this.status = 'DEGRADED';
    } else if (this.pendingTokens.size > this.busyThreshold) {
      this.status = 'BUSY';
    } else {
      this.status = 'IDLE';
    }
  }
}
