/**
 * @fileoverview
 * @summary The worker budget: how many physical workers the platform may run.
 * @description
 * Implements docs/ARCHITECTURE.md §8.5: at most
 * `clamp(navigator.hardwareConcurrency - 1, 1, maxWorkers)` physical workers.
 * A shared worker counts once per key, however many processors use it.
 * When the budget is used up, a processor falls back to its next host.
 *
 * @author MathAid
 */

/** @summary Counts physical workers against a limit. */
export class WorkerBudget {
  #dedicated = 0;
  readonly #shared = new Map<string, number>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('The worker budget must be at least 1.');
  }

  /**
   * @summary The budget for this device.
   * @param {number} [maxWorkers] Upper bound. Default 4.
   * @param {number} [hardwareConcurrency] Logical cores. Defaults to `navigator.hardwareConcurrency`, or 2.
   */
  static forDevice(
    maxWorkers = 4,
    hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 2,
  ): WorkerBudget {
    return new WorkerBudget(Math.min(Math.max(hardwareConcurrency - 1, 1), maxWorkers));
  }

  /** @summary Workers currently counted. */
  get used(): number {
    return this.#dedicated + this.#shared.size;
  }

  /**
   * @summary Takes a slot, if one is free.
   * @param {'dedicated' | 'shared'} kind The worker kind.
   * @param {string} key Identifies the worker. Shared workers with the same key share a slot.
   * @returns A function that releases the slot, or `null` when the budget is used up.
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
