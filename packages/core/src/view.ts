/**
 * @fileoverview
 * @summary Observable views: the external-store contract every framework can bind to.
 * @description
 * Implements docs/ARCHITECTURE.md §6.1. A view exposes an immutable snapshot
 * whose identity is stable while the value is unchanged, and notifies
 * subscribers once per task after a burst of changes.
 *
 * ```text
 *   owner                         consumers (React, Vue, Svelte, plain JS)
 *   store.set(a)  \
 *   store.set(b)   >-- one flush -->  listener()  -->  view.getSnapshot() === b
 *   store.set(c)  /                   (per task)       same object until it changes
 *   ```
 *
 * This shape is exactly what React's `useSyncExternalStore` expects, and Vue
 * or Svelte can wrap it in a `shallowRef` or a readable store, so the core
 * needs no framework adapter to be observed.
 *
 * @example
 * Owning a store and handing out its view
 * ```ts
 * import { createStore } from '@platform/core';
 *
 * const online = createStore({ online: navigator.onLine });
 * addEventListener('online', () => online.set({ online: true }));
 * addEventListener('offline', () => online.set({ online: false }));
 * export const onlineView = online.view;
 * ```
 *
 * @example
 * Deriving a narrower view
 * ```ts
 * import { deriveView } from '@platform/core';
 *
 * const isOnline = deriveView(onlineView, (s) => s.online);
 * isOnline.subscribe(() => console.log('online:', isOnline.getSnapshot()));
 * ```
 *
 * @see {@link https://react.dev/reference/react/useSyncExternalStore React useSyncExternalStore}
 * @author MathAid
 */

/**
 * @summary A read-only value that can be observed.
 *
 * @description
 * A view has two members: {@linkcode View.getSnapshot getSnapshot}, which
 * returns the current value as a frozen snapshot, and
 * {@linkcode View.subscribe subscribe}, which registers a listener and returns
 * its unsubscribe function. The snapshot keeps the same identity until the
 * value changes, and listeners run once per task, however many changes
 * happened in it.
 *
 * Views are how every unit exposes its state to the outside (control
 * interfaces, lifecycles, processor status). Consumers never get a mutable
 * reference, so only the owning unit can change what they see.
 *
 * Listeners take no arguments: read the new value with `getSnapshot()`.
 *
 * @example
 * Example 1: Reading and observing a unit's lifecycle
 * ```ts
 * const lifecycle = kernel.unit('storage').lifecycle;
 * console.log(lifecycle.getSnapshot().status);
 * const stop = lifecycle.subscribe(() => console.log(lifecycle.getSnapshot().status));
 * stop();
 * ```
 *
 * @example
 * Example 2: Binding to React
 * ```tsx
 * const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
 * ```
 *
 * @example
 * Example 3: Binding to Vue
 * ```ts
 * const state = shallowRef(view.getSnapshot());
 * onScopeDispose(view.subscribe(() => (state.value = view.getSnapshot())));
 * ```
 *
 * @template T The value's type. Snapshots are `Readonly<T>`.
 *
 * @public
 * @see {@linkcode createStore}
 * @see {@linkcode deriveView}
 */
export interface View<T> {
  /**
   * @summary Returns the current snapshot.
   * @description The same reference is returned until the value changes, so
   * comparing snapshots with `===` detects changes.
   * @returns {Readonly<T>} The frozen current value.
   */
  getSnapshot(): Readonly<T>;
  /**
   * @summary Registers a listener that runs after changes.
   * @description The listener runs at most once per task, after the changes
   * made in that task. It receives no arguments.
   * @param {() => void} listener Called after a change.
   * @returns {() => void} Removes the listener.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * @summary Schedules a notification flush.
 * @description
 * A function that receives the flush callback and runs it later. The default,
 * `queueMicrotask`, flushes once at the end of the current task. Tests can pass
 * `(flush) => flush()` to notify synchronously.
 *
 * @example
 * Synchronous notifications in a test
 * ```ts
 * const store = createStore(0, (flush) => flush());
 * ```
 *
 * @public
 */
export type Schedule = (flush: () => void) => void;

/**
 * @summary The owner's side of a view: the view plus the right to change it.
 *
 * @description
 * A store pairs a {@linkcode View} (`view`) with `set`, which replaces the
 * snapshot. The owner keeps the store and hands out only `store.view`.
 *
 * Stores back every observable value in the kernel: lifecycles, state cells,
 * the kernel's status map, and processor status.
 *
 * @example
 * Example 1: A connectivity store
 * ```ts
 * const connectivity = createStore({ online: true });
 * connectivity.set({ online: false });
 * ```
 *
 * @example
 * Example 2: Setting an equal value is ignored
 * ```ts
 * const store = createStore('a');
 * store.set('a'); // no notification: Object.is('a', 'a')
 * ```
 *
 * @template T The value's type.
 *
 * @public
 * @see {@linkcode createStore}
 */
export interface Store<T> {
  /** @summary The read-only view to hand to consumers. */
  readonly view: View<T>;
  /**
   * @summary Replaces the snapshot and schedules a notification.
   * @description A value `Object.is`-equal to the current snapshot is ignored.
   * The new value is deep-frozen before it is published.
   * @param {T} next The new snapshot.
   */
  set(next: T): void;
}

/**
 * @summary Freezes a value and every object or array nested in it.
 *
 * @description
 * Walks own properties (including symbol keys) and calls `Object.freeze` on
 * every object it reaches. Already-frozen objects are skipped, which also stops
 * cycles. Primitives are returned unchanged.
 *
 * Used for every snapshot the kernel publishes, so a consumer cannot mutate
 * state it does not own.
 *
 * @example
 * Example 1: Freezing a nested snapshot
 * ```ts
 * const snapshot = deepFreeze({ user: { name: 'ada' } });
 * Object.isFrozen(snapshot.user); // true
 * ```
 *
 * @example
 * Example 2: Primitives pass through
 * ```ts
 * deepFreeze(42); // 42
 * ```
 *
 * @template T The value's type.
 * @param {T} value The value to freeze.
 * @returns {Readonly<T>} The same value, frozen.
 *
 * @public
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
 * @summary Creates a {@linkcode Store} and its view.
 *
 * @description
 * Returns a store whose snapshot starts as `initial` (deep-frozen). Listeners
 * run once per flush, however many `set` calls happened before it. A listener
 * that throws does not stop the others; its error is rethrown asynchronously,
 * so it still reaches the console and error trackers.
 *
 * Use it whenever a unit or an adapter needs to publish a changing value.
 *
 * @example
 * Example 1: Batched renders
 * ```ts
 * const counter = createStore({ count: 0 });
 * counter.view.subscribe(() => render(counter.view.getSnapshot()));
 * counter.set({ count: 1 });
 * counter.set({ count: 2 }); // one render, with { count: 2 }
 * ```
 *
 * @example
 * Example 2: Synchronous notifications for tests
 * ```ts
 * const store = createStore(0, (flush) => flush());
 * ```
 *
 * @template T The value's type.
 * @param {T} initial The initial snapshot.
 * @param {Schedule} [schedule=queueMicrotask] How a notification flush is scheduled.
 * @returns {Store<T>} The store.
 *
 * @public
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
 *
 * @description
 * Returns a {@linkcode View} whose snapshot is `select(source snapshot)`. It is
 * recomputed lazily when the source changes, and keeps its previous identity
 * when `equals` reports the new value as equal, so consumers of the derived
 * view are not notified for changes they do not see.
 *
 * State cells use it to expose only their readable keys.
 *
 * @example
 * Example 1: A view of one field
 * ```ts
 * const user = deriveView(auth.view, (s) => s.user);
 * ```
 *
 * @example
 * Example 2: Keeping identity for structurally equal values
 * ```ts
 * const flags = deriveView(
 *   settings.view,
 *   (s) => ({ dark: s.dark, compact: s.compact }),
 *   (a, b) => a.dark === b.dark && a.compact === b.compact,
 * );
 * ```
 *
 * @template S The source value's type.
 * @template T The derived value's type.
 * @param {View<S>} source The view to derive from.
 * @param {(snapshot: Readonly<S>) => T} select Computes the derived value.
 * @param {(a: T, b: T) => boolean} [equals=Object.is] Decides whether a new value equals the old one.
 * @returns {View<T>} The derived view.
 *
 * @public
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
