/**
 * @fileoverview
 * @summary A bounded, append-only list with an observable view.
 * @description
 * Logs, histories and trails keep their last N items. A {@linkcode createStore}
 * of an array would copy and freeze the whole array on every append; a
 * {@linkcode RingBuffer} appends in place and builds the frozen snapshot only
 * when someone reads it after a change.
 *
 * ```text
 *   push(item) --> [ oldest ... newest ]   (capacity reached: the oldest is evicted, `dropped` + 1)
 *                         |
 *                  view.getSnapshot()  --> frozen copy, rebuilt only after a change
 *                  view.subscribe(fn)  --> fn runs once per task after changes
 *   ```
 *
 * Items are frozen as they are pushed, so a snapshot never needs a deep copy.
 *
 * @example
 * A log of the last 100 events
 * ```ts
 * const events = createRingBuffer<string>(100);
 * events.push('started');
 * events.view.getSnapshot(); // ['started']
 * ```
 *
 * @example
 * Rendering it
 * ```ts
 * events.view.subscribe(() => render(events.view.getSnapshot()));
 * ```
 *
 * @author MathAid
 */

import { deepFreeze, type Schedule, type View } from './view';

/**
 * @summary A bounded, append-only list with an observable view.
 *
 * @description
 * `push` appends (evicting the oldest item at capacity and returning it),
 * `clear` empties it, `size` and `dropped` count what is kept and what was
 * evicted, `toArray` copies it, and `view` observes it (oldest first).
 *
 * @example
 * Example 1: Eviction
 * ```ts
 * const ring = createRingBuffer<number>(2);
 * ring.push(1); ring.push(2);
 * ring.push(3); // returns 1
 * ring.dropped; // 1
 * ```
 *
 * @example
 * Example 2: Searching it
 * ```ts
 * ring.toArray().filter((entry) => entry.level === 'ERROR');
 * ```
 *
 * @template T The item type.
 * @public
 */
export interface RingBuffer<T> {
  /**
   * @summary The largest number of items that the buffer keeps.
   */
  readonly capacity: number;
  /**
   * @summary The number of items in the buffer now.
   */
  readonly size: number;
  /**
   * @summary The number of items that the buffer removed because it was full.
   * @description `clear` does not change this number.
   */
  readonly dropped: number;
  /**
   * @summary The items as a view, oldest first.
   * @description The snapshot is frozen. The buffer makes a new snapshot only
   * when it is read after a change.
   */
  readonly view: View<readonly T[]>;
  /**
   * @summary Adds an item at the end and freezes it.
   * @description When the buffer is full, it removes the oldest item and returns it.
   * @example
   * Keeping the last 100 events
   * ```ts
   * const evicted = ring.push(event);
   * ```
   * @param {T} item The item.
   * @returns {T | undefined} The removed item, when the buffer was full.
   */
  push(item: T): T | undefined;
  /**
   * @summary Removes all items.
   * @example
   * Clearing a log
   * ```ts
   * ring.clear();
   * ```
   */
  clear(): void;
  /**
   * @summary Copies the items, oldest first.
   * @example
   * Searching the items
   * ```ts
   * ring.toArray().filter((entry) => entry.level === 'ERROR');
   * ```
   * @returns {T[]} A new array.
   */
  toArray(): T[];
}

/**
 * @summary Creates a {@linkcode RingBuffer}.
 *
 * @example
 * Example 1: The last 1000 log entries
 * ```ts
 * const entries = createRingBuffer<LogEntry>(1000);
 * ```
 *
 * @example
 * Example 2: Synchronous notification in a test
 * ```ts
 * const ring = createRingBuffer<number>(10, (flush) => flush());
 * ```
 *
 * @template T The item type.
 * @param {number} capacity The most items kept; at least 1.
 * @param {Schedule} [schedule=queueMicrotask] When listeners run after a change.
 * @returns {RingBuffer<T>} The buffer.
 * @throws {RangeError} When `capacity` is below 1.
 *
 * @public
 */
export function createRingBuffer<T>(
  capacity: number,
  schedule: Schedule = queueMicrotask,
): RingBuffer<T> {
  if (!(capacity >= 1)) throw new RangeError('RingBuffer capacity must be at least 1.');
  let items: T[] = [];
  let dropped = 0;
  let snapshot: readonly T[] = Object.freeze([]);
  let dirty = false;
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
  const changed = () => {
    dirty = true;
    if (scheduled || listeners.size === 0) return;
    scheduled = true;
    schedule(flush);
  };

  const view: View<readonly T[]> = {
    getSnapshot() {
      if (dirty) {
        snapshot = Object.freeze([...items]);
        dirty = false;
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };

  return {
    capacity,
    get size() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
    view,
    push(item) {
      items.push(deepFreeze(item) as T);
      changed();
      if (items.length <= capacity) return undefined;
      dropped += 1;
      return items.shift();
    },
    clear() {
      if (items.length === 0) return;
      items = [];
      changed();
    },
    toArray: () => [...items],
  };
}
