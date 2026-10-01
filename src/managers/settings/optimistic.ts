/**
 * @fileoverview
 * @summary An optimistic-apply helper with rollback on failure.
 * @description
 * Implements the optimistic-UI primitive of M5. A caller applies a change
 * locally, attempts to commit it remotely, and rolls the local change back when
 * the commit fails. This gives instant UI feedback with a safe revert.
 *
 * ```text
 *   apply() -> commit() -> done
 *                |
 *                +-- failure -> rollback() -> rethrow
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary Applies a mutation optimistically, committing and rolling back on failure.
 * @description
 * Runs `apply` first so the UI updates immediately, then `commit`. When
 * `commit` throws, `rollback` runs to revert the local state and the error is
 * rethrown so the caller can surface it.
 *
 * @example
 * Example 1: Optimistically update a value
 * ```ts
 * await optimisticUpdate(
 *   () => facade.set(key, optimistic, schema),
 *   () => sync.syncNow(),
 *   () => facade.set(key, original, schema),
 * );
 * ```
 *
 * @param {() => Promise<void> | void} apply The local, optimistic apply.
 * @param {() => Promise<void> | void} commit The remote commit.
 * @param {() => Promise<void> | void} rollback The local revert.
 * @returns {Promise<void>}
 * @throws {unknown} Rethrows the commit error after rolling back.
 */
export async function optimisticUpdate(
  apply: () => Promise<void> | void,
  commit: () => Promise<void> | void,
  rollback: () => Promise<void> | void,
): Promise<void> {
  await apply();
  try {
    await commit();
  } catch (error) {
    await rollback();
    throw error;
  }
}
