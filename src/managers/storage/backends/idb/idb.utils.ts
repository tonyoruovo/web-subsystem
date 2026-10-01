/**
 * @fileoverview IndexedDB utility functions.
 *
 * ## Overview
 * Pure helpers that wrap the callback-based IndexedDB API in Promises and
 * provide higher-level cursor operations used by `IDBBackend`. Grouped into
 * three concerns:
 *
 * 1. **Request helpers** — `idbRequest` and `idbTransaction` wrap single
 *    `IDBRequest` objects and full `IDBTransaction` lifecycles in promises.
 * 2. **Cursor helpers** — `cursorAll`, `cursorDeleteMatching` and
 *    `cursorCollectPrefix` iterate object store cursors for scan-heavy ops
 *    (query, count, prefix delete, eviction candidate collection).
 * 3. **Schema helpers** — `openDatabase` opens (or creates/upgrades) the
 *    IDB database and sets up the required object store and indexes.
 *
 * ## Why helpers are separated from the backend class
 * `IDBBackend` manages lifecycle, transactions, and eviction logic.
 * Extracting raw IDB Promise wrappers into this module keeps each unit small,
 * independently testable, and free of `this` binding. Every function here is
 * stateless with respect to the backend's runtime state.
 *
 * ## Error handling convention
 * Every IDB error surfaces as a rejected Promise. The backend catches these at
 * the call site and either re-throws (propagating to the caller) or handles them
 * gracefully (e.g., treating a missing record as `null`).
 */

import type { IDBRecord } from './idb.types';

// ─────────────────────────────────────────────────────────────────────────────
// Request helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Wrap a single `IDBRequest` in a Promise.
 *
 * @description
 * Attaches `onsuccess` and `onerror` handlers to `request` and resolves or
 * rejects accordingly. The resolved value is `request.result` cast to `T`.
 *
 * Used internally by all helpers that issue a single IDB request (get, put,
 * delete, count, etc.) to avoid repetitive callback wiring throughout the
 * backend.
 *
 * @template T - Expected type of `request.result`.
 * @param request - Any `IDBRequest` instance.
 * @returns Promise that resolves with `request.result` or rejects with the
 *   `DOMException` from `request.error`.
 *
 * @throws {DOMException} When `request.onerror` fires.
 *
 * @example
 * ```ts
 * const record = await idbRequest<IDBRecord>(
 *   store.get('myapp:chrome:130:auth:session')
 * )
 * ```
 */
export function idbRequest<T = unknown>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @summary Wrap the commit/abort lifecycle of a native `IDBTransaction` in a
 * Promise.
 *
 * @description
 * Attaches `oncomplete` and `onerror` (and `onabort`) handlers to `tx`.
 * Resolves when `oncomplete` fires; rejects on `onerror` or `onabort`.
 *
 * Used by `IDBBackend._applyCommit` to know when the native transaction has
 * fully committed or been aborted by IDB after a request error.
 *
 * **Important**: this function does not *start* or *submit* any IDB requests.
 * It only observes the transaction lifecycle. The caller must issue all IDB
 * requests on `tx` before (or during) awaiting the returned Promise.
 *
 * @param tx - A native `IDBTransaction` that has already been opened.
 * @returns Promise that resolves when the transaction commits successfully.
 *
 * @throws {DOMException} When `tx.onerror` or `tx.onabort` fires.
 *
 * @example
 * ```ts
 * const nativeTx = db.transaction(['entries'], 'readwrite')
 * const store    = nativeTx.objectStore('entries')
 * store.put(record)
 * await idbTransactionDone(nativeTx)  // wait for IDB to commit
 * ```
 */
export function idbTransactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new DOMException('IDB transaction aborted', 'AbortError'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Collect all `IDBRecord` objects from a store cursor, optionally
 * filtered by a canonical key prefix.
 *
 * @description
 * Opens a cursor over `store` using `IDBKeyRange.bound` when a prefix is
 * supplied, iterating only keys >= `prefix` and < `prefix\uffff` (the highest
 * Unicode code point, giving a tight prefix range). Without a prefix, the
 * cursor walks the entire store.
 *
 * The cursor advances synchronously inside `onsuccess` callbacks — no extra
 * awaits between records — keeping the native IDB transaction alive throughout
 * the scan.
 *
 * Returns an array of all matching `IDBRecord` objects. Parsing/filtering
 * (schema version, TTL) is the caller's responsibility.
 *
 * @param store  - The open `IDBObjectStore` to scan.
 * @param prefix - Optional canonical key prefix to narrow the cursor range.
 * @returns Promise resolving to the array of all matching records.
 *
 * @throws {DOMException} If the cursor request itself fails.
 *
 * @example Collect all records under a module prefix
 * ```ts
 * const records = await cursorCollectPrefix(store, 'myapp:chrome:130:auth:')
 * ```
 *
 * @see {@link cursorDeleteMatching} for a delete-in-place variant.
 */
export function cursorCollectPrefix(
  store: IDBObjectStore | IDBIndex,
  prefix?: string,
): Promise<IDBRecord[]> {
  return new Promise<IDBRecord[]>((resolve, reject) => {
    const range = prefix ? IDBKeyRange.bound(prefix, prefix + '\uffff') : undefined;
    const request = store.openCursor(range);
    const results: IDBRecord[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value as IDBRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @summary Delete all records matching a canonical key prefix using a write
 * cursor, within an already-open `readwrite` transaction.
 *
 * @description
 * Opens a write cursor over `store` bounded by `[prefix, prefix\uffff]` and
 * calls `cursor.delete()` on every record whose key starts with `prefix`. If
 * `prefix` is omitted, `store.clear()` is called instead — more efficient than
 * a full cursor walk for a total-clear operation.
 *
 * Must be called within a `'readwrite'` transaction. The delete requests
 * are issued synchronously inside the cursor's `onsuccess` handler, keeping
 * the transaction alive.
 *
 * @param store  - The open `IDBObjectStore` (must be in `readwrite` mode).
 * @param prefix - Canonical key prefix to match. Absent = clear entire store.
 * @returns Promise that resolves when all matching records have been deleted.
 *
 * @throws {DOMException} If the cursor or any delete request fails.
 *
 * @example Delete all auth-module entries
 * ```ts
 * const tx    = db.transaction(['entries'], 'readwrite')
 * const store = tx.objectStore('entries')
 * await cursorDeleteMatching(store, 'myapp:chrome:130:auth:')
 * await idbTransactionDone(tx)
 * ```
 */
export function cursorDeleteMatching(store: IDBObjectStore, prefix?: string): Promise<void> {
  if (!prefix) {
    // Total clear is far cheaper than a cursor walk.
    return idbRequest<undefined>(store.clear()).then(() => undefined);
  }

  return new Promise<void>((resolve, reject) => {
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
    const request = store.openCursor(range);

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @summary Count the number of records in a store matching an optional key
 * prefix.
 *
 * @description
 * Uses `store.count(range?)` — a native IDB operation that avoids opening a
 * cursor and is significantly faster than collecting records and measuring
 * the resulting array length.
 *
 * @param store  - The open `IDBObjectStore`.
 * @param prefix - Optional canonical key prefix. Absent = count entire store.
 * @returns Promise resolving to the integer count of matching records.
 *
 * @throws {DOMException} If the count request fails.
 *
 * @example
 * ```ts
 * const n = await countPrefix(store, 'myapp:chrome:130:auth:')
 * ```
 */
export function countPrefix(store: IDBObjectStore | IDBIndex, prefix?: string): Promise<number> {
  const range = prefix ? IDBKeyRange.bound(prefix, prefix + '\uffff') : undefined;
  return idbRequest<number>(store.count(range));
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema / open helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Open (or create / upgrade) the IndexedDB database and return the
 * `IDBDatabase` handle.
 *
 * @description
 * Wraps `indexedDB.open(dbName, version)` in a Promise, handling all three
 * lifecycle events:
 *
 * - `onupgradeneeded` — called when the database is created for the first time
 *   or when `version` is higher than the stored version. Creates the `entries`
 *   object store with the `key` keyPath and the two indexes:
 *   - `by_expires_at` (non-unique, non-multi-entry): enables `IDBKeyRange`-based
 *     TTL sweeps (`expires_at < Date.now()`).
 *   - `by_weight` (non-unique): enables ascending-weight cursor for eviction
 *     candidate collection.
 *
 * - `onsuccess` — resolves with the `IDBDatabase` handle.
 * - `onerror` — rejects with the `DOMException` from the request.
 *
 * The database schema is intentionally kept at version `1` for the lifetime of
 * this subsystem's current design. A future breaking schema change (e.g., adding
 * a new index) would increment `DB_VERSION` and add a migration branch inside
 * `onupgradeneeded`.
 *
 * @param dbName    - Database name, passed to `indexedDB.open()`.
 * @param storeName - Object store name, created inside `onupgradeneeded`.
 * @returns Promise resolving to the open `IDBDatabase`.
 *
 * @throws {DOMException} If `indexedDB.open()` fails (e.g., security restrictions
 *   in a sandboxed iframe, or Firefox private mode with `dom.indexedDB.enabled = false`).
 *
 * @example
 * ```ts
 * const db = await openDatabase('storage', 'entries')
 * const tx = db.transaction(['entries'], 'readwrite')
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open | MDN: IDBFactory.open}
 */
export const DB_VERSION = 1;

export function openDatabase(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: 'key' });

        // Index for efficient TTL sweeps:
        //   IDBKeyRange.upperBound(Date.now()) gives all records with expires_at <= now.
        //   null values are invisible to this index — never-expiring records are
        //   correctly excluded from TTL sweeps.
        store.createIndex('by_expires_at', 'expires_at', { unique: false, multiEntry: false });

        // Index for ascending-weight eviction candidate collection.
        store.createIndex('by_weight', 'weight', { unique: false, multiEntry: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Another tab has an open connection with an older version.
      // We do not close that tab's connection — just warn and continue waiting.
      // The request will eventually succeed when the other tab closes or reloads.
      console.warn(
        `[IDBBackend] indexedDB.open("${dbName}") is blocked by an open connection ` +
          `in another tab. Waiting for it to close.`,
      );
    };
  });
}

/**
 * @summary Collect all records from the `by_expires_at` index whose
 * `expires_at` value is <= `nowMs`, meaning they are expired.
 *
 * @description
 * Opens a cursor over the `by_expires_at` index bounded by
 * `IDBKeyRange.upperBound(nowMs)`. Because IDB does not index `null`, records
 * with `expires_at === null` (never-expiring) are invisible to this range and
 * are never returned. Only numeric `expires_at` values <= `nowMs` appear.
 *
 * The cursor walk happens synchronously within IDB's `onsuccess` handler.
 * The returned array contains the full `IDBRecord` for each expired entry,
 * allowing the caller to delete each one by `key` without a separate lookup.
 *
 * @param db        - Open `IDBDatabase` handle.
 * @param storeName - Object store name.
 * @param nowMs     - Current Unix timestamp in milliseconds. Defaults to `Date.now()`.
 * @returns Promise resolving to all expired records.
 *
 * @throws {DOMException} If the index or cursor request fails.
 *
 * @example Sweep all expired entries at eviction time
 * ```ts
 * const expired = await collectExpired(db, 'entries')
 * for (const rec of expired) {
 *   // delete rec.key from the store
 * }
 * ```
 */
export function collectExpired(
  db: IDBDatabase,
  storeName: string,
  nowMs: number = Date.now(),
): Promise<IDBRecord[]> {
  return new Promise<IDBRecord[]>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index('by_expires_at');
    // upperBound is exclusive of null (IDB never stores null in index keys),
    // so only finite timestamps <= nowMs are matched.
    const range = IDBKeyRange.upperBound(nowMs);
    const request = index.openCursor(range);
    const results: IDBRecord[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value as IDBRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @summary Collect eviction candidates from the `by_weight` index in ascending
 * weight order, applying an optional canonical key prefix filter.
 *
 * @description
 * Opens a cursor over the `by_weight` index. Records are yielded in ascending
 * `weight` order (lowest weight first = primary eviction candidates). When
 * `prefix` is supplied, only records whose `key` starts with `prefix` are
 * included; records with non-matching keys are skipped via `cursor.continue()`.
 *
 * The result is used by `IDBBackend.evict()` to build the sorted candidate
 * list for Phase 2 weighted eviction. The sort by weight is native (IDB cursor
 * order) so no JS-side sort is needed for the primary key.
 *
 * @param db        - Open `IDBDatabase`.
 * @param storeName - Object store name.
 * @param prefix    - Optional canonical key prefix to filter candidates.
 * @returns Promise resolving to candidates in ascending weight order.
 *
 * @throws {DOMException} If the index or cursor request fails.
 */
export function collectByWeight(
  db: IDBDatabase,
  storeName: string,
  prefix?: string,
): Promise<IDBRecord[]> {
  return new Promise<IDBRecord[]>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index('by_weight');
    const request = index.openCursor();
    const results: IDBRecord[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      const record = cursor.value as IDBRecord;
      if (!prefix || record.key.startsWith(prefix)) {
        results.push(record);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
