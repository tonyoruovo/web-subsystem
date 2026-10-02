/**
 * @fileoverview
 * @summary The worker budget: how many physical workers the platform may run.
 * @description
 * Implements docs/ARCHITECTURE.md §8.5: at most
 * `clamp(navigator.hardwareConcurrency - 1, 1, maxWorkers)` physical workers.
 * A shared worker counts once per key, however many processors use it.
 * When the budget is used up, a processor falls back to its next host.
 *
 * ```text
 *   cores   limit (maxWorkers = 4)
 *   1, 2    1
 *   3       2
 *   4       3
 *   8+      4
 *   ```
 *
 * @example
 * The default budget for this device
 * ```ts
 * import { WorkerBudget } from '@platform/core';
 *
 * const budget = WorkerBudget.forDevice(); // e.g. 4 on an 8-core laptop
 * ```
 *
 * @example
 * Limiting workers on a low-end device
 * ```ts
 * new Kernel(subsystems, { processors: { budget: new WorkerBudget(1) } });
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Counts physical workers against a limit.
 *
 * @description
 * `tryAcquire` takes a slot for a dedicated worker, or for a shared worker
 * key (several acquisitions of the same shared key share one slot), and
 * returns a release function, or `null` when the budget is used up. `used`
 * is the number of slots taken; `limit` is the maximum.
 *
 * Processor runners acquire a slot before starting a physical host. One
 * budget is shared by the whole platform, so workers stay bounded across
 * subsystems.
 *
 * @example
 * Example 1: Acquiring and releasing
 * ```ts
 * const budget = new WorkerBudget(2);
 * const release = budget.tryAcquire('dedicated', 'sync');
 * if (release) {
 *   // start the worker; call release() when it stops
 * }
 * ```
 *
 * @example
 * Example 2: Shared workers share a slot
 * ```ts
 * budget.tryAcquire('shared', 'storage');
 * budget.tryAcquire('shared', 'storage');
 * budget.used; // 1
 * ```
 *
 * @public
 */
export class WorkerBudget {
  #dedicated = 0;
  readonly #shared = new Map<string, number>();

  /**
   * @summary Creates a budget with a fixed limit.
   * @param {number} limit The maximum number of physical workers. An integer, at least 1.
   * @throws {RangeError} When `limit` is not an integer of at least 1.
   */
  constructor(
    /**
     * @summary The maximum number of physical workers that can run at the same time.
     * @description One shared worker counts one time, however many units use it.
     */
    readonly limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('The worker budget must be at least 1.');
  }

  /**
   * @summary Returns the budget for this device: one worker fewer than its cores, between 1 and `maxWorkers`.
   * @param {number} [maxWorkers=4] Upper bound.
   * @param {number} [hardwareConcurrency] Logical cores. Defaults to `navigator.hardwareConcurrency`, or 2.
   * @returns {WorkerBudget} The budget.
   */
  static forDevice(
    maxWorkers = 4,
    hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 2,
  ): WorkerBudget {
    return new WorkerBudget(Math.min(Math.max(hardwareConcurrency - 1, 1), maxWorkers));
  }

  /**
   * @summary How many slots are taken.
   * @returns {number} Dedicated workers plus distinct shared keys.
   */
  get used(): number {
    return this.#dedicated + this.#shared.size;
  }

  /**
   * @summary Takes a slot, if one is free.
   * @param {'dedicated' | 'shared'} kind The worker kind.
   * @param {string} key Identifies the worker. Shared workers with the same key share a slot.
   * @returns {(() => void) | null} A function that releases the slot (safe to call twice), or `null` when the budget is used up.
   */
  tryAcquire(kind: 'dedicated' | 'shared', key: string): (() => void) | null {
    if (kind === 'shared' && this.#shared.has(key)) {
      this.#shared.set(key, this.#shared.get(key)! + 1);
    } else if (this.used >= this.limit) {
      return null;
    } else if (kind === 'shared') {
      this.#shared.set(key, 1);
    } else {
      this.#dedicated += 1;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'dedicated') {
        this.#dedicated -= 1;
        return;
      }
      const count = this.#shared.get(key)! - 1;
      if (count === 0) this.#shared.delete(key);
      else this.#shared.set(key, count);
    };
  }
}
