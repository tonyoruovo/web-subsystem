/**
 * @fileoverview
 * @summary A state persistence adapter for the kernel, on the main thread.
 *
 * @description
 * The kernel loads persisted unit state before any subsystem runs, so this
 * adapter cannot use the Storage coordinator. It talks to IndexedDB directly,
 * then falls back to `localStorage`, then to memory
 * (docs/ARCHITECTURE.md §18.2).
 *
 * ```text
 *   new Kernel(units, { persistence: createStatePersistence() })
 *     load(unitId) / save(unitId, state) --> IndexedDB '<database>', store 'state'
 *                                        --> localStorage '<database>:<unitId>' (JSON)
 *                                        --> Map
 *   ```
 *
 * @example
 * Persisting the state of every unit
 * ```ts
 * const kernel = new Kernel(subsystems, { persistence: createStatePersistence() });
 * ```
 *
 * @author MathAid
 */

import type { PersistedState, StatePersistence } from '@platform/core';

/**
 * @summary Options of {@linkcode createStatePersistence}.
 * @example
 * Example 1: A separate database
 * ```ts
 * createStatePersistence({ database: 'shop-state' });
 * ```
 * @example
 * Example 2: Memory only, for tests
 * ```ts
 * createStatePersistence({ indexedDB: null, localStorage: null });
 * ```
 * @public
 */
export interface StatePersistenceOptions {
  /**
   * @summary The name of the IndexedDB database, and the prefix of `localStorage` keys. The default is `__platform_state`.
   */
  readonly database?: string;
  /**
   * @summary The IndexedDB factory. `null` skips IndexedDB.
   */
  readonly indexedDB?: IDBFactory | null;
  /**
   * @summary The `localStorage` to fall back to. `null` skips it.
   */
  readonly localStorage?: Storage | null;
}

/**
 * @summary A {@linkcode StatePersistence} that tells where it keeps the state.
 * @public
 */
export interface StorageStatePersistence extends StatePersistence {
  /**
   * @summary Where the state is kept. It is known after the first `load` or `save`.
   * @example
   * Checking
   * ```ts
   * await persistence.ready(); // 'indexeddb'
   * ```
   * @returns {Promise<'indexeddb' | 'localstorage' | 'memory'>} The kind of store.
   */
  ready(): Promise<'indexeddb' | 'localstorage' | 'memory'>;
}

interface Store {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  get(id: string): Promise<PersistedState<object> | undefined>;
  put(id: string, state: PersistedState<object>): Promise<void>;
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function openIndexedDB(factory: IDBFactory, name: string): Promise<Store> {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('state');
  const db = await request(open);
  const store = (mode: IDBTransactionMode) => db.transaction('state', mode).objectStore('state');
  return {
    kind: 'indexeddb',
    get: (id) => request(store('readonly').get(id)) as Promise<PersistedState<object> | undefined>,
    put: async (id, state) => void (await request(store('readwrite').put(state, id))),
  };
}

function webStorage(storage: Storage, prefix: string): Store {
  return {
    kind: 'localstorage',
    async get(id) {
      const text = storage.getItem(`${prefix}:${id}`);
      return text === null ? undefined : (JSON.parse(text) as PersistedState<object>);
    },
    async put(id, state) {
      storage.setItem(`${prefix}:${id}`, JSON.stringify(state));
    },
  };
}

function memory(): Store {
  const map = new Map<string, PersistedState<object>>();
  return {
    kind: 'memory',
    get: async (id) => map.get(id),
    put: async (id, state) => void map.set(id, structuredClone(state)),
  };
}

/**
 * @summary Makes the state persistence adapter for the kernel's `persistence` option.
 * @description It opens its store on the first `load` or `save`. A store
 * that fails to open is skipped, so the adapter always works.
 * @example
 * Example 1: The default
 * ```ts
 * new Kernel(subsystems, { persistence: createStatePersistence() });
 * ```
 * @example
 * Example 2: Checking where state is kept
 * ```ts
 * const persistence = createStatePersistence();
 * console.log(await persistence.ready()); // 'indexeddb'
 * ```
 * @param {StatePersistenceOptions} [options] The database and the stores to try.
 * @returns {StorageStatePersistence} The adapter.
 * @public
 */
export function createStatePersistence(
  options: StatePersistenceOptions = {},
): StorageStatePersistence {
  const name = options.database ?? '__platform_state';
  let opened: Promise<Store> | null = null;
  const open = () =>
    (opened ??= (async () => {
      const factory =
        options.indexedDB === null
          ? null
          : (options.indexedDB ?? (typeof indexedDB === 'undefined' ? null : indexedDB));
      if (factory) {
        try {
          return await openIndexedDB(factory, name);
        } catch {
          // A private window or a blocked database: try the next store.
        }
      }
      const local =
        options.localStorage === null
          ? null
          : (options.localStorage ??
            (typeof localStorage === 'undefined' ? null : (localStorage as Storage | undefined)));
      if (local) {
        try {
          const probe = `${name}:__probe__`;
          local.setItem(probe, '1');
          local.removeItem(probe);
          return webStorage(local, name);
        } catch {
          // No quota, or access is blocked.
        }
      }
      return memory();
    })());

  return {
    async load(unitId) {
      return (await open()).get(unitId);
    },
    async save(unitId, state) {
      await (await open()).put(unitId, state);
    },
    async ready() {
      return (await open()).kind;
    },
  };
}
