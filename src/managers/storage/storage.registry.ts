/**
 * @fileoverview
 * @summary The strategy registry: selects a storage backend by probing.
 * @description
 * Implements the boot-time fallback-chain selection. It holds a set of backend
 * candidates with priorities and resolves the first one whose `probe()`
 * reports `available: true`. The default order is IndexedDB, OPFS,
 * CacheStorage, localStorage, sessionStorage, Memory.
 *
 * ```text
 *   resolve()
 *     |-- probe each candidate in priority order
 *     |-- first available wins
 *     v
 *   backend | null (none available)
 *   ```
 *
 * This is the piece that turns "low storage / unavailable backend" into a
 * graceful fallback rather than a crash.
 *
 * @see {@linkcode IStorageBackend}
 * @author MathAid
 */

import type { IStorageBackend } from './storage.types';

/**
 * @summary A backend candidate with its fallback priority.
 */
export interface StrategyEntry {
  /** The backend. */
  backend: IStorageBackend<string>;
  /** Lower is tried first. */
  priority: number;
}

/**
 * @summary The strategy registry.
 * @description
 * Sorts candidates by priority and resolves the first available backend. Use
 * `resolve` for a single backend, or `resolveAll` to get the full available
 * chain (for read-through / write-through cache orchestration).
 *
 * @example
 * Example 1: Select the best available backend at boot
 * ```ts
 * const registry = new StrategyRegistry([
 *   { backend: idb, priority: 0 },
 *   { backend: opfs, priority: 1 },
 *   { backend: memory, priority: 3 },
 * ]);
 * const backend = await registry.resolve();
 * ```
 */
export class StrategyRegistry {
  /** @internal The sorted candidates. */
  private readonly entries: StrategyEntry[];

  /**
   * @summary Creates a StrategyRegistry.
   * @param {StrategyEntry[]} entries The candidates. Sorted by priority.
   */
  constructor(entries: StrategyEntry[]) {
    this.entries = [...entries].sort((a, b) => a.priority - b.priority);
  }

  /**
   * @summary Resolves the first available backend.
   * @description
   * Probes each candidate in priority order and returns the first whose probe
   * reports available. Returns `null` when none are available.
   *
   * @returns {Promise<IStorageBackend<string> | null>} The backend, or `null`.
   */
  async resolve(): Promise<IStorageBackend<string> | null> {
    for (const entry of this.entries) {
      const probe = await entry.backend.probe();
      if (probe.available) return entry.backend;
    }
    return null;
  }

  /**
   * @summary Resolves every available backend in priority order.
   * @returns {Promise<IStorageBackend<string>[]>} The available backends.
   */
  async resolveAll(): Promise<IStorageBackend<string>[]> {
    const available: IStorageBackend<string>[] = [];
    for (const entry of this.entries) {
      const probe = await entry.backend.probe();
      if (probe.available) available.push(entry.backend);
    }
    return available;
  }
}
