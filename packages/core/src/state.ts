/**
 * @fileoverview
 * @summary Owned, serializable unit state with an exposure policy.
 * @description
 * Implements docs/ARCHITECTURE.md §5:
 *
 * - **Owned:** only the owning unit holds the {@linkcode StateCell} with
 *   `update`. Everyone else sees the `readable` view.
 * - **Serializable:** every update is checked with `structuredClone`, so
 *   functions, symbols and DOM nodes are rejected.
 * - **Exposure policy:** each key is private, readable, persisted, or both.
 * - **Restoration:** only persisted keys, and only from the same schema version.
 *
 * ```text
 *   state { user, token, visits }      policy
 *   +-- user    readable + persisted   --> readable view, persist()
 *   +-- token   (private)              --> owner only
 *   +-- visits  persisted              --> persist() only
 *   ```
 *
 * @example
 * Declaring a unit's state
 * ```ts
 * defineSubsystem({
 *   id: 'auth',
 *   scope: 'window',
 *   kind: 'featurized',
 *   state: {
 *     initial: { user: null as string | null, token: '' },
 *     policy: { user: { readable: true, persisted: true } },
 *     version: 2,
 *   },
 *   control: (ctx) => ({ commands: {}, views: { state: ctx.state.readable } }),
 * });
 * ```
 *
 * @example
 * Using a state cell directly
 * ```ts
 * const cell = createStateCell('prefs', { initial: { theme: 'light' }, policy: { theme: { readable: true } } });
 * cell.update((s) => { s.theme = 'dark'; });
 * cell.readable.getSnapshot(); // { theme: 'dark' }
 * ```
 *
 * @throws {StateSerializationError} When an update or the initial value is not structured-cloneable.
 * @author MathAid
 */

import { createStore, deriveView, type Schedule, type View } from './view';

/**
 * @summary How one state key may leave its unit.
 *
 * @description
 * Two optional flags. `readable` puts the key in the cell's `readable` view,
 * which a unit can hand out through its control interface. `persisted`
 * includes the key in `persist()` and lets `restore()` bring it back on the
 * next boot. A key with neither flag is private to the unit.
 *
 * @example
 * Example 1: Visible and remembered
 * ```ts
 * const theme: Exposure = { readable: true, persisted: true };
 * ```
 *
 * @example
 * Example 2: Remembered but not shown
 * ```ts
 * const lastSync: Exposure = { persisted: true };
 * ```
 *
 * @public
 */
export interface Exposure {
  /**
   * @summary Shows the key in `ctx.state.readable`, and so in the control interface.
   * @description The default is `false`: the key stays private to the unit.
   */
  readonly readable?: boolean;
  /**
   * @summary Saves the key through the kernel's persistence and restores it at the next boot.
   * @description The default is `false`.
   */
  readonly persisted?: boolean;
}

/**
 * @summary The {@linkcode Exposure} of every key of a state shape. Keys left out are private.
 *
 * @example
 * A policy for an auth state
 * ```ts
 * const policy: ExposurePolicy<{ user: string | null; token: string }> = {
 *   user: { readable: true, persisted: true },
 * };
 * ```
 *
 * @template S The state shape.
 * @public
 */
export type ExposurePolicy<S> = { readonly [K in keyof S]?: Exposure };

/**
 * @summary How a unit declares its state.
 *
 * @description
 * Holds the `initial` value (structured-cloneable), the optional per-key
 * `policy`, and the schema `version` of the persisted keys (default `1`).
 *
 * Every unit definition has one. The kernel turns it into a
 * {@linkcode StateCell} when the unit is registered. Bump `version` when the
 * persisted keys change shape: persisted state from another version is
 * ignored instead of being restored into the wrong shape.
 *
 * @example
 * Example 1: Private state only
 * ```ts
 * const definition: StateDefinition<{ retries: number }> = { initial: { retries: 0 } };
 * ```
 *
 * @example
 * Example 2: A versioned, persisted preference
 * ```ts
 * const definition: StateDefinition<{ theme: 'light' | 'dark' }> = {
 *   initial: { theme: 'light' },
 *   policy: { theme: { readable: true, persisted: true } },
 *   version: 3,
 * };
 * ```
 *
 * @template S The state shape.
 * @public
 */
export interface StateDefinition<S> {
  /**
   * @summary The initial value of the state.
   * @description The value must be structured-cloneable.
   */
  readonly initial: S;
  /**
   * @summary The exposure of each key.
   * @description A key that is not in the policy is private and not persisted.
   */
  readonly policy?: ExposurePolicy<S>;
  /**
   * @summary The schema version of the persisted keys.
   * @description The kernel ignores persisted state from another version. The
   * default is `1`. Increase it when the shape of a persisted key changes.
   */
  readonly version?: number;
}

/**
 * @summary The persisted part of a unit's state, tagged with its schema version.
 *
 * @description
 * `data` holds only the keys marked `persisted`; `version` is the state
 * definition's version when it was written. It is what
 * {@linkcode StateCell.persist} returns and what persistence adapters store.
 *
 * @example
 * Example 1: What a preference unit persists
 * ```ts
 * const saved: PersistedState<{ theme: string }> = { version: 1, data: { theme: 'dark' } };
 * ```
 *
 * @example
 * Example 2: Storing it in a persistence adapter
 * ```ts
 * const persistence: StatePersistence = {
 *   load: (id) => JSON.parse(localStorage.getItem(id) ?? 'null') ?? undefined,
 *   save: (id, state) => localStorage.setItem(id, JSON.stringify(state)),
 * };
 * ```
 *
 * @template S The state shape.
 * @public
 */
export interface PersistedState<S> {
  /**
   * @summary The version of the state definition when the state was saved.
   */
  readonly version: number;
  /**
   * @summary The values of the persisted keys.
   */
  readonly data: Partial<S>;
}

/**
 * @summary Thrown when a unit's state would stop being structured-cloneable.
 *
 * @description
 * Wraps the `DataCloneError` from `structuredClone` as its `cause`. Thrown by
 * {@linkcode createStateCell} for a bad initial value and by
 * {@linkcode StateCell.update} for a bad update, which is then not applied.
 *
 * @example
 * Example 1: Storing a function is rejected
 * ```ts
 * cell.update((s) => { s.callback = () => {}; }); // throws StateSerializationError
 * ```
 *
 * @example
 * Example 2: Reading the original cause
 * ```ts
 * try { cell.update(recipe); } catch (error) { console.error((error as Error).cause); }
 * ```
 *
 * @public
 */
export class StateSerializationError extends Error {
  /**
   * @summary The name of the error class: `'StateSerializationError'`.
   */
  override readonly name = 'StateSerializationError';

  /**
   * @summary Creates the error for one refused state.
   * @param {string} unitId The unit whose state was rejected.
   * @param {unknown} cause The error from `structuredClone`.
   */
  constructor(unitId: string, cause: unknown) {
    super(`[${unitId}] State must be structured-cloneable.`, { cause });
  }
}

/**
 * @summary The owner's handle on a unit's state.
 *
 * @description
 * A state cell holds one unit's state. `get` reads it (frozen), `update`
 * changes it through a draft copy, `view` observes all of it, and `readable`
 * observes only the keys marked readable. `persist` and `restore` move the
 * persisted keys in and out, guarded by the schema version.
 *
 * The kernel creates one per unit and hands it to the unit as `ctx.state`.
 * Only the unit holds it; it shares `readable` (never the cell) through its
 * control interface.
 *
 * @example
 * Example 1: Updating through a draft
 * ```ts
 * ctx.state.update((s) => {
 *   s.items.push(item);
 *   s.count += 1;
 * });
 * ```
 *
 * @example
 * Example 2: Exposing the readable keys
 * ```ts
 * control: (ctx) => ({ commands: {}, views: { state: ctx.state.readable } }),
 * ```
 *
 * @example
 * Example 3: Round-tripping persisted keys
 * ```ts
 * const saved = cell.persist();
 * otherCell.restore(saved); // true when the versions match
 * ```
 *
 * @template S The state shape.
 * @public
 * @see {@linkcode createStateCell}
 */
export interface StateCell<S> {
  /**
   * @summary Returns the current state.
   * @returns {Readonly<S>} The frozen state.
   */
  get(): Readonly<S>;
  /**
   * @summary Changes the state through a draft copy.
   * @description The recipe mutates a clone of the current state. The result
   * is checked, frozen and published; listeners are notified once per task.
   * @param {(draft: S) => void} recipe Mutates the draft.
   * @throws {StateSerializationError} When the result is not structured-cloneable. The state is unchanged.
   */
  update(recipe: (draft: S) => void): void;
  /** @summary The full state, observable. For the owner only. */
  readonly view: View<S>;
  /** @summary Only the readable keys, observable. Safe to hand out. */
  readonly readable: View<Partial<S>>;
  /**
   * @summary Returns the persisted keys, tagged with the schema version.
   * @returns {PersistedState<S>} A copy of the persisted keys.
   */
  persist(): PersistedState<S>;
  /**
   * @summary Restores persisted keys when the schema version matches.
   * @description Keys that are not marked persisted are ignored, even if present in `persisted.data`.
   * @param {PersistedState<S>} persisted State from a previous `persist()`.
   * @returns {boolean} `true` when the state was restored; `false` on a version mismatch.
   */
  restore(persisted: PersistedState<S>): boolean;
}

/**
 * @summary Lists the keys of `S` whose exposure has `flag` set.
 * @template S The state shape.
 * @param {ExposurePolicy<S>} policy The policy.
 * @param {keyof Exposure} flag `readable` or `persisted`.
 * @returns {(keyof S)[]} The matching keys.
 * @internal
 */
function keysWith<S>(policy: ExposurePolicy<S>, flag: keyof Exposure): (keyof S)[] {
  return (Object.keys(policy) as (keyof S)[]).filter((key) => policy[key]?.[flag] === true);
}

/**
 * @summary Copies the listed keys that exist in `source`.
 * @template S The state shape.
 * @param {Readonly<S>} source The object to copy from.
 * @param {readonly (keyof S)[]} keys The keys to copy.
 * @returns {Partial<S>} A new object with those keys.
 * @internal
 */
function pick<S>(source: Readonly<S>, keys: readonly (keyof S)[]): Partial<S> {
  const out: Partial<S> = {};
  for (const key of keys) if (key in (source as object)) out[key] = source[key];
  return out;
}

/**
 * @summary Shallow equality over the listed keys, so the readable view keeps its identity.
 * @template S The state shape.
 * @param {Partial<S>} a One object.
 * @param {Partial<S>} b The other.
 * @param {readonly (keyof S)[]} keys The keys to compare.
 * @returns {boolean} `true` when every listed key is `Object.is`-equal.
 * @internal
 */
function sameKeys<S>(a: Partial<S>, b: Partial<S>, keys: readonly (keyof S)[]): boolean {
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * @summary Creates a {@linkcode StateCell} from a {@linkcode StateDefinition}.
 *
 * @description
 * Clones `definition.initial` (rejecting values that cannot be cloned),
 * builds the store and the readable view, and returns the cell. The kernel
 * calls it for every unit; call it directly to test state logic in isolation.
 *
 * @example
 * Example 1: A private token and a readable user
 * ```ts
 * const cell = createStateCell('auth', {
 *   initial: { user: null as string | null, token: '' },
 *   policy: { user: { readable: true, persisted: true } }, // token stays private
 * });
 * cell.update((s) => { s.user = 'ada'; });
 * cell.readable.getSnapshot(); // { user: 'ada' }
 * ```
 *
 * @example
 * Example 2: Synchronous notifications in a test
 * ```ts
 * const cell = createStateCell('unit', { initial: { n: 0 } }, (flush) => flush());
 * ```
 *
 * @template S The state shape. Must be an object.
 * @param {string} unitId The owning unit, for error messages.
 * @param {StateDefinition<S>} definition The state definition.
 * @param {Schedule} [schedule] Notification scheduling. Defaults to `queueMicrotask`.
 * @returns {StateCell<S>} The cell.
 * @throws {StateSerializationError} When `definition.initial` is not structured-cloneable.
 *
 * @public
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
