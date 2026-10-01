/**
 * @fileoverview
 * @summary Owned, serializable unit state with an exposure policy.
 * @description
 * Implements docs/ARCHITECTURE.md §5:
 *
 * - **Owned:** only the owning unit holds the {@linkcode StateCell} with `update`.
 *   Everyone else sees the `readable` view.
 * - **Serializable:** every update is checked with `structuredClone`, so
 *   functions, symbols and DOM nodes are rejected.
 * - **Exposure policy:** each key is private, readable, persisted, or both.
 * - **Restoration:** only persisted keys, and only from the same schema version.
 *
 * @author MathAid
 */

import { createStore, deriveView, type Schedule, type View } from './view';

/** @summary How one state key may leave the unit. */
export interface Exposure {
  /** Visible through the control interface. */
  readonly readable?: boolean;
  /** Written out by persistence and restored on the next boot. */
  readonly persisted?: boolean;
}

/** @summary Exposure for every key of `S`. Keys left out are private. */
export type ExposurePolicy<S> = { readonly [K in keyof S]?: Exposure };

/** @summary How a unit declares its state. */
export interface StateDefinition<S> {
  /** The initial value. Must be structured-cloneable. */
  readonly initial: S;
  /** Per-key exposure. Keys left out are private. */
  readonly policy?: ExposurePolicy<S>;
  /** Schema version of the persisted keys. Persisted state from another version is ignored. Defaults to 1. */
  readonly version?: number;
}

/** @summary Persisted state, tagged with its schema version. */
export interface PersistedState<S> {
  readonly version: number;
  readonly data: Partial<S>;
}

/** @summary Thrown when an update would make the state non-serializable. */
export class StateSerializationError extends Error {
  override readonly name = 'StateSerializationError';
  constructor(unitId: string, cause: unknown) {
    super(`[${unitId}] State must be structured-cloneable.`, { cause });
  }
}

/**
 * @summary The owner's handle on a unit's state.
 */
export interface StateCell<S> {
  /** @summary The current state. Frozen. */
  get(): Readonly<S>;
  /**
   * @summary Changes the state through a draft copy.
   * @param {(draft: S) => void} recipe Mutates the draft.
   * @throws {StateSerializationError} When the result is not structured-cloneable.
   */
  update(recipe: (draft: S) => void): void;
  /** @summary The full state, observable. For the owner only. */
  readonly view: View<S>;
  /** @summary Only the readable keys, observable. Safe to hand out. */
  readonly readable: View<Partial<S>>;
  /** @summary The persisted keys, tagged with the schema version. */
  persist(): PersistedState<S>;
  /**
   * @summary Restores persisted keys when the schema version matches.
   * @param {PersistedState<S>} persisted State from a previous {@linkcode StateCell.persist}.
   * @returns {boolean} `true` when the state was restored; `false` on a version mismatch.
   */
  restore(persisted: PersistedState<S>): boolean;
}

/** @summary Keys of `S` whose exposure has `flag` set. */
function keysWith<S>(policy: ExposurePolicy<S>, flag: keyof Exposure): (keyof S)[] {
  return (Object.keys(policy) as (keyof S)[]).filter((key) => policy[key]?.[flag] === true);
}

/** @summary Picks `keys` from `source`. */
function pick<S>(source: Readonly<S>, keys: readonly (keyof S)[]): Partial<S> {
  const out: Partial<S> = {};
  for (const key of keys) if (key in (source as object)) out[key] = source[key];
  return out;
}

/** @summary Shallow equality over the picked keys, so the readable view keeps its identity. */
function sameKeys<S>(a: Partial<S>, b: Partial<S>, keys: readonly (keyof S)[]): boolean {
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * @summary Creates a state cell from its definition.
 *
 * @example
 * ```ts
 * const cell = createStateCell('auth', {
 *   initial: { user: null as string | null, token: '' },
 *   policy: { user: { readable: true, persisted: true } }, // token stays private
 * });
 * cell.update((s) => { s.user = 'ada'; });
 * cell.readable.getSnapshot(); // { user: 'ada' }
 * ```
 *
 * @param {string} unitId The owning unit, for error messages.
 * @param {StateDefinition<S>} definition The state definition.
 * @param {Schedule} [schedule] Notification scheduling, for tests.
 * @returns {StateCell<S>} The cell.
 */
export function createStateCell<S extends object>(
  unitId: string,
  definition: StateDefinition<S>,
  schedule?: Schedule,
): StateCell<S> {
  const policy = definition.policy ?? {};
  const version = definition.version ?? 1;
  const readableKeys = keysWith(policy, 'readable');
  const persistedKeys = keysWith(policy, 'persisted');

  const clone = (value: S): S => {
    try {
      return structuredClone(value);
    } catch (cause) {
      throw new StateSerializationError(unitId, cause);
    }
  };

  const store = createStore<S>(clone(definition.initial), schedule);

  return {
    get: () => store.view.getSnapshot(),
    update(recipe) {
      const draft = clone(store.view.getSnapshot() as S);
      recipe(draft);
      store.set(clone(draft));
    },
    view: store.view,
    readable: deriveView(
      store.view,
      (state) => pick(state, readableKeys),
      (a, b) => sameKeys(a, b, readableKeys),
    ),
    persist: () => ({ version, data: clone(pick(store.view.getSnapshot(), persistedKeys) as S) }),
    restore(persisted) {
      if (persisted.version !== version) return false;
      const restored = pick(persisted.data as S, persistedKeys);
      store.set(clone({ ...(store.view.getSnapshot() as S), ...restored }));
      return true;
    },
  };
}
