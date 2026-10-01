/**
 * @fileoverview
 * @summary The Sync manager: reconcile local changes with the server.
 * @description
 * Implements the reconciliation core of M3. It queues offline changes, pushes
 * them on sync, pulls the remote state, detects conflicts, and resolves them
 * by client-wins, server-wins, or merge. Push, pull, and conflict detection are
 * injected so the manager is testable without a network.
 *
 * ```text
 *   recordChange(...) -> offline queue
 *   syncNow()
 *     |-- push(offlineChanges) -> clear queue
 *     |-- pull() -> remote
 *     |-- detectConflicts -> CONFLICT | IDLE
 *   resolveConflict(id, CLIENT_WINS|SERVER_WINS|MERGE)
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary The sync status.
 */
export type SyncStatus = 'IDLE' | 'SYNCING' | 'CONFLICT' | 'ERROR';

/**
 * @summary A conflict resolution strategy.
 */
export type ConflictResolution = 'CLIENT_WINS' | 'SERVER_WINS' | 'MERGE' | 'MANUAL';

/**
 * @summary A recorded offline change.
 */
export interface OfflineChange {
  /** Unique id. */
  id: string;
  /** The operation. */
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  /** The entity id. */
  entityId: string;
  /** The change data. */
  data: unknown;
  /** Unix milliseconds. */
  timestamp: number;
}

/**
 * @summary A detected conflict between local and remote.
 */
export interface SyncConflict {
  /** Unique id. */
  id: string;
  /** The entity id. */
  entityId: string;
  /** The local value. */
  local: unknown;
  /** The remote value. */
  remote: unknown;
}

/**
 * @summary Options for constructing a {@linkcode SyncManager}.
 */
export interface SyncManagerOptions {
  /** Pushes offline changes to the server. */
  push?: (changes: OfflineChange[]) => Promise<void>;
  /** Pulls the remote state, keyed by entity id. Receives the last sync time for delta sync. */
  pull?: (since: number | null) => Promise<Record<string, unknown>>;
  /** Detects conflicts between local changes and the remote state. */
  detectConflicts?: (changes: OfflineChange[], remote: Record<string, unknown>) => SyncConflict[];
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
}

/**
 * @summary The Sync manager.
 * @description
 * One instance per realm. Records local mutations while offline and reconciles
 * them on sync.
 *
 * @example
 * Example 1: Record a change and sync
 * ```ts
 * const sync = new SyncManager({ push, pull });
 * sync.recordChange('UPDATE', 'user-1', { name: 'Alice' });
 * await sync.syncNow();
 * ```
 */
export class SyncManager {
  /** @internal The offline change queue. */
  private readonly offlineChanges: OfflineChange[] = [];

  /** @internal The active conflicts. */
  private readonly conflicts: SyncConflict[] = [];

  /** @internal The status. */
  private status: SyncStatus = 'IDLE';

  /** @internal The last successful sync time. */
  private lastSyncAt: number | null = null;

  /** @internal The push function. */
  private readonly push?: (changes: OfflineChange[]) => Promise<void>;

  /** @internal The pull function. */
  private readonly pull?: (since: number | null) => Promise<Record<string, unknown>>;

  /** @internal The conflict detector. */
  private readonly detectConflicts?: (
    changes: OfflineChange[],
    remote: Record<string, unknown>,
  ) => SyncConflict[];

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /**
   * @summary Creates a SyncManager.
   * @param {SyncManagerOptions} [options] The configuration and injectables.
   */
  constructor(options: SyncManagerOptions = {}) {
    this.push = options.push;
    this.pull = options.pull;
    this.detectConflicts = options.detectConflicts;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? makeCounter();
  }

  /**
   * @summary Records an offline change.
   * @param {'CREATE' | 'UPDATE' | 'DELETE'} operation The operation.
   * @param {string} entityId The entity id.
   * @param {unknown} data The change data.
   * @returns {void}
   */
  recordChange(operation: 'CREATE' | 'UPDATE' | 'DELETE', entityId: string, data: unknown): void {
    this.offlineChanges.push({
      id: this.makeId(),
      operation,
      entityId,
      data,
      timestamp: this.now(),
    });
  }

  /**
   * @summary Runs one sync cycle.
   * @description
   * Pushes the offline queue, pulls remote state, detects conflicts, and sets
   * the status to `CONFLICT` when any remain, otherwise `IDLE`.
   *
   * @returns {Promise<void>}
   * @throws {Error} Rethrows a push or pull failure, setting status `ERROR`.
   */
  async syncNow(): Promise<void> {
    if (this.status === 'SYNCING') return; // coalesce concurrent sync calls
    this.status = 'SYNCING';
    try {
      const changes = [...this.offlineChanges];
      await this.push?.(changes);
      this.offlineChanges.length = 0;

      const remote = (await this.pull?.(this.lastSyncAt)) ?? {};
      const conflicts = this.detectConflicts?.(changes, remote) ?? [];
      this.conflicts.length = 0;
      this.conflicts.push(...conflicts);

      this.lastSyncAt = this.now();
      this.status = conflicts.length > 0 ? 'CONFLICT' : 'IDLE';
    } catch (error) {
      this.status = 'ERROR';
      throw error;
    }
  }

  /**
   * @summary Resolves a conflict and returns the winning value.
   * @param {string} id The conflict id.
   * @param {ConflictResolution} resolution The strategy.
   * @returns {unknown} The resolved value, or `undefined` when not found.
   */
  resolveConflict(id: string, resolution: ConflictResolution): unknown {
    const index = this.conflicts.findIndex((c) => c.id === id);
    if (index < 0) return undefined;

    const [conflict] = this.conflicts.splice(index, 1);

    if (resolution === 'CLIENT_WINS') return conflict.local;
    if (resolution === 'SERVER_WINS') return conflict.remote;
    if (resolution === 'MERGE') {
      const local = (conflict.local ?? {}) as Record<string, unknown>;
      const remote = (conflict.remote ?? {}) as Record<string, unknown>;
      return { ...remote, ...local };
    }
    return conflict.remote; // MANUAL default to remote
  }

  /**
   * @summary The current sync status.
   * @returns {SyncStatus} The status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * @summary Number of pending offline changes.
   * @returns {number} The count.
   */
  getPendingSyncCount(): number {
    return this.offlineChanges.length;
  }

  /**
   * @summary The active conflicts.
   * @returns {SyncConflict[]} A copy of the conflicts.
   */
  getConflicts(): SyncConflict[] {
    return [...this.conflicts];
  }

  /**
   * @summary The last successful sync time, or `null`.
   * @returns {number | null} The timestamp.
   */
  getLastSyncAt(): number | null {
    return this.lastSyncAt;
  }

  /**
   * @summary Clears the offline change queue.
   * @returns {void}
   */
  clearOfflineChanges(): void {
    this.offlineChanges.length = 0;
  }
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `chg-${++counter}`;
}
