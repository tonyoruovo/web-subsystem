/**
 * @fileoverview
 * @summary Observable views: the external-store contract every framework can bind to.
 * @description
 * Implements docs/ARCHITECTURE.md §6.1. A view exposes an immutable snapshot
 * whose identity is stable while the value is unchanged, and notifies
 * subscribers once per task after a burst of changes. This is exactly what
 * React's `useSyncExternalStore` needs, and Vue can wrap it in a `shallowRef`.
 *
 * @author MathAid
 */

/** @summary A read-only, observable value. */
export interface View<T> {
  /** @summary Returns the current snapshot. Same reference until the value changes. */
  getSnapshot(): Readonly<T>;
  /** @summary Calls `listener` after changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** @summary Schedules a notification flush. Defaults to `queueMicrotask`. */
export type Schedule = (flush: () => void) => void;

/** @summary The owner side of a view. */
export interface Store<T> {
  /** @summary The read-only view handed to callers. */
  readonly view: View<T>;
  /**
   * @summary Replaces the snapshot. A value `Object.is`-equal to the current one is ignored.
   * @param {T} next The new snapshot. It is frozen (shallowly) before publishing.
   */
  set(next: T): void;
}

/**
 * @summary Freezes a value and every nested object or array in it.
 * @param {T} value The value.
 * @returns {Readonly<T>} The same value, frozen.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

/**
 * @summary Creates a store and its view.
 * @description
 * Listeners run once per flush, however many `set` calls happened before it.
 * A listener that throws does not stop the others; the error is rethrown
 * asynchronously so it still surfaces.
 *
 * @example
 * ```ts
 * const counter = createStore({ count: 0 });
 * counter.view.subscribe(() => render(counter.view.getSnapshot()));
 * counter.set({ count: 1 });
 * counter.set({ count: 2 }); // one render, with { count: 2 }
 * ```
 *
 * @param {T} initial The initial snapshot.
 * @param {Schedule} [schedule] How a flush is scheduled. Defaults to `queueMicrotask`.
 * @returns {Store<T>} The store.
 */
export function createStore<T>(initial: T, schedule: Schedule = queueMicrotask): Store<T> {
  let snapshot = deepFreeze(initial);
  let scheduled = false;
  const listeners = new Set<() => void>();

  const flush = () => {
    scheduled = false;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  };

  return {
    view: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(next) {
      if (Object.is(next, snapshot)) return;
      snapshot = deepFreeze(next);
      if (!scheduled && listeners.size > 0) {
        scheduled = true;
        schedule(flush);
      }
    },
  };
}

/**
 * @summary Derives a view from another view.
 * @description
 * The derived snapshot is recomputed when the source changes, and keeps its
 * identity when `equals` says the new value is the same as the old one.
 *
 * @param {View<S>} source The source view.
 * @param {(s: Readonly<S>) => T} select Computes the derived value.
 * @param {(a: T, b: T) => boolean} [equals] Equality used to keep identity. Defaults to `Object.is`.
 * @returns {View<T>} The derived view.
 */
export function deriveView<S, T>(
  source: View<S>,
  select: (snapshot: Readonly<S>) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): View<T> {
  let lastSource = source.getSnapshot();
  let derived = deepFreeze(select(lastSource));

  const current = (): Readonly<T> => {
    const snapshot = source.getSnapshot();
    if (snapshot !== lastSource) {
      lastSource = snapshot;
      const next = select(snapshot);
      if (!equals(next, derived as T)) derived = deepFreeze(next);
    }
    return derived;
  };

  return {
    getSnapshot: current,
    subscribe(listener) {
      let seen = current();
      return source.subscribe(() => {
        const next = current();
        if (next !== seen) {
          seen = next;
          listener();
        }
      });
    },
  };
}
