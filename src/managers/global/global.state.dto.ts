/**
 * @fileoverview
 * @summary Global State data types: platform status, registry, and work tokens.
 * @description
 * Defines the state shapes the Global State manager holds. Global State is the
 * canonical source of truth for platform status. It tracks which managers are
 * healthy, how much work is pending, and what the platform status should be.
 *
 * ```text
 *   pendingTokens.size === 0            -> IDLE
 *   pendingTokens.size >  busyThreshold -> BUSY
 *   pendingTokens === null              -> STOPPED
 *   a CRITICAL manager is unhealthy     -> DEGRADED
 *   an unrecoverable error occurred     -> CRASHED
 *   ```
 *
 * @see {@linkcode Importance}
 * @author MathAid
 */

import type { Importance } from '../packet.dto';

/**
 * @summary The lifecycle status of the whole platform.
 * @description
 * Global State computes this from {@linkcode PendingToken} count and manager
 * health. CRITICAL work may exceed the busy threshold and still be admitted.
 */
export type PlatformStatus = 'INITIALIZING' | 'IDLE' | 'BUSY' | 'DEGRADED' | 'STOPPED' | 'CRASHED';

/**
 * @summary The lifecycle status of one manager.
 */
export type SubsystemStatusType =
  'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'BUSY' | 'ERROR' | 'DESTROYED';

/**
 * @summary Whether a manager coordinates others or serves a capability.
 */
export type SubsystemType = 'CENTRALIZED' | 'FEATURIZED';

/**
 * @summary The category a work token belongs to.
 * @description
 * Used to report workload distribution and to decide admission under load.
 */
export type WorkCategory = 'NETWORK' | 'STORAGE' | 'AUTH' | 'COMPUTATION' | 'UI' | 'SYNC';

/**
 * @summary One unit of in-flight work.
 * @description
 * A manager registers a pending token before it starts work and completes it
 * when done. Global State uses the count to derive {@linkcode PlatformStatus}.
 */
export interface PendingToken {
  /** Unique id of the token. */
  id: string;
  /** The manager that owns the work. */
  subsystemId: string;
  /** Scheduling importance of the work. */
  importance: Importance;
  /** Unix milliseconds when the work was registered. */
  createdAt: number;
  /** Expected duration in milliseconds, or `null` when unknown. */
  estimatedDuration: number | null;
  /** The category of the work. */
  category: WorkCategory;
}

/**
 * @summary The live health record of one manager.
 * @description
 * Global State keeps one of these per manager in the subsystem registry.
 * Heartbeats refresh `lastHeartbeat`. A manager is unhealthy when it errors,
 * its health score drops below 50, or its heartbeat goes stale.
 */
export interface SubsystemStatus {
  /** Id of the manager. */
  subsystemId: string;
  /** Whether the manager is centralized or featurized. */
  type: SubsystemType;
  /** Current lifecycle status. */
  status: SubsystemStatusType;
  /** The manager's declared importance. */
  importance: Importance;
  /** Unix milliseconds of the last heartbeat. */
  lastHeartbeat: number;
  /** Number of errors the manager recorded. */
  errorCount: number;
  /** Ids of managers this one depends on. */
  dependencies: string[];
  /** Health score from 0 to 100. */
  healthScore: number;
  /** Unix milliseconds when the manager started, or `null`. */
  startedAt: number | null;
}
