/**
 * @fileoverview
 * @summary The Storage subsystem: collections, change events and the quota monitor.
 *
 * @description
 * `createStorage` gives the subsystem `storage` (featurized, Tab scope, no
 * required dependency). Its coordinator runs in a shared worker, or on the
 * main thread after a failover (docs/ARCHITECTURE.md §18.2).
 *
 * ```text
 *   collection.set --> coordinator --> change --> collection listeners (this tab)
 *                                             --> BroadcastChannel --> other tabs --> their listeners
 *                                             --> 'storage:changed' (Tab broadcast)
 *   quota monitor --> 'storage:quota' at the warning level; eviction at the critical level
 *   'crypto:keys-changed' --> the coordinator opens the key store again
 *   ```
 *
 * @example
 * Starting Storage
 * ```ts
 * const kernel = new Kernel([createCrypto(), createStorage({ domain: 'shop' })]);
 * await kernel.start();
 * const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  type HostKind,
  type ProcessorDef,
  type SubsystemDefinition,
  type UnitContext,
  toPortable,
  type View,
} from '@platform/core';
import { CRYPTO_KEYS_CHANGED, type CryptoConfig } from '@platform/crypto';

import {
  Batch,
  Collection,
  type CollectionDefinition,
  type CollectionHost,
  type StorageChange,
} from './collection';
import {
  createCoordinator,
  type CoordinatorConfig,
  type CoordinatorStatus,
  type StorageRequest,
} from './coordinator';
import type { BackendKind, EvictionPolicy, QuotaEstimate, UnderlyingPlatform } from './types';

/**
 * @summary The id of the Storage subsystem.
 * @public
 */
export const STORAGE_ID = 'storage';

/**
 * @summary The Tab broadcast after each change to stored data. The payload is a {@linkcode StorageChange}.
 * @public
 */
export const STORAGE_CHANGED = 'storage:changed';

/**
 * @summary The Tab broadcast when the use of storage reaches the warning level. The payload is a {@linkcode QuotaAlert}.
 * @public
 */
export const STORAGE_QUOTA = 'storage:quota';

/**
 * @summary The Tab broadcast when an entry cannot be read. The payload is a {@linkcode CorruptEntry}.
 * @public
 */
export const STORAGE_CORRUPT = 'storage:corrupt';

/**
 * @summary The payload of `storage:quota`.
 * @example
 * Example 1: Warning
 * ```ts
 * // { level: 'warning', used: 41943040, available: 10485760, ratio: 0.8 }
 * ```
 * @example
 * Example 2: Critical, after an eviction
 * ```ts
 * // { level: 'critical', used: 49807360, available: 2621440, ratio: 0.95, freed: 8388608 }
 * ```
 * @public
 */
export interface QuotaAlert extends QuotaEstimate {
  /**
   * @summary `warning` or `critical`.
   */
  readonly level: 'warning' | 'critical';
  /**
   * @summary The bytes that an eviction freed, at the critical level.
   */
  readonly freed?: number;
}

/**
 * @summary The payload of `storage:corrupt`.
 * @example
 * Example 1: A wrong tag
 * ```ts
 * // { collection: 'vault', key: 'pin', reason: 'The integrity tag is wrong.' }
 * ```
 * @example
 * Example 2: A value that fails the schema
 * ```ts
 * // { collection: 'prefs', key: 'main', reason: '[storage] The value for "prefs:main" does not match the schema.' }
 * ```
 * @public
 */
export interface CorruptEntry {
  /**
   * @summary The collection.
   */
  readonly collection: string;
  /**
   * @summary The key.
   */
  readonly key: string;
  /**
   * @summary Why the entry cannot be read.
   */
  readonly reason: string;
}

/**
 * @summary Options of {@linkcode createStorage}.
 *
 * @example
 * Example 1: An app
 * ```ts
 * createStorage({ domain: 'shop' });
 * ```
 *
 * @example
 * Example 2: Tests and sandboxes: main thread, memory, no encryption
 * ```ts
 * createStorage({ domain: 'demo', hosts: ['virtual'], backends: ['memory'], keys: null });
 * ```
 *
 * @public
 */
export interface StorageOptions {
  /**
   * @summary The name of the app, the first segment of every key.
   * @description The default is `location.hostname`, or `app` without a location.
   */
  readonly domain?: string;
  /**
   * @summary The platform segment of the keys. The default is `browser`.
   */
  readonly platform?: UnderlyingPlatform;
  /**
   * @summary The version segment of the keys. The default is 1.
   */
  readonly platformVersion?: number;
  /**
   * @summary The hosts to try, in order. The default is `['shared', 'virtual']`.
   */
  readonly hosts?: readonly HostKind[];
  /**
   * @summary The backend chain. The default depends on the host.
   */
  readonly backends?: readonly BackendKind[];
  /**
   * @summary The name of the database, the OPFS folder and the cache. The default is `__platform_storage`.
   */
  readonly database?: string;
  /**
   * @summary The key store of `@platform/crypto`, or `null` for no encryption.
   * @description Give the same source as `createCrypto`. The default is the device keys.
   */
  readonly keys?: CryptoConfig | null;
  /**
   * @summary The quota monitor, or `false` to turn it off.
   */
  readonly quota?:
    | {
        /**
         * @summary The time between checks, in milliseconds. The default is 60 000.
         */
        readonly intervalMs?: number;
        /**
         * @summary The warning level, from 0 to 1. The default is 0.8.
         */
        readonly warning?: number;
        /**
         * @summary The critical level, from 0 to 1. The default is 0.95.
         */
        readonly critical?: number;
      }
    | false;
}

/**
 * @summary The state of the Storage subsystem.
 * @example
 * Example 1: In a shared worker
 * ```ts
 * // { host: 'shared', backend: 'indexeddb', persistent: true, encryption: true, probes: { indexeddb: true }, quota: null }
 * ```
 * @example
 * Example 2: After a failover in a private window
 * ```ts
 * // { host: 'virtual', backend: 'memory', persistent: false, ... }
 * ```
 * @public
 */
export interface StorageData {
  /**
   * @summary The host of the coordinator, or `null` before it starts.
   */
  host: HostKind | null;
  /**
   * @summary The active backend, or `null` before the coordinator starts.
   */
  backend: BackendKind | null;
  /**
   * @summary Tells if the data survives a reload.
   */
  persistent: boolean;
  /**
   * @summary Tells if encryption is configured.
   */
  encryption: boolean;
  /**
   * @summary The probe result of each backend that the coordinator tried.
   */
  probes: Partial<Record<BackendKind, boolean>>;
  /**
   * @summary The last quota estimate, or `null` before the first check.
   */
  quota: QuotaEstimate | null;
}

/**
 * @summary The control interface of the Storage subsystem.
 * @public
 */
export interface StorageControl {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Returns the collection with this definition.
     * @example
     * A cart
     * ```ts
     * const cart = commands.collection({ name: 'cart', schema: z.array(z.string()) });
     * ```
     * @param {CollectionDefinition<T>} definition The definition.
     * @returns {Collection<T>} The collection.
     */
    collection<T>(definition: CollectionDefinition<T>): Collection<T>;
    /**
     * @summary Applies writes and deletes on several collections in one backend transaction.
     * @example
     * Checkout
     * ```ts
     * await commands.batch((batch) => batch.delete(cart, 'items').set(orders, id, order));
     * ```
     * @param {Function} build Adds the operations to the batch.
     * @returns {Promise<void>} Resolves when all operations are applied.
     */
    batch(build: (batch: Batch) => void): Promise<void>;
    /**
     * @summary Checks the quota now.
     * @example
     * Checking
     * ```ts
     * const { ratio } = await commands.estimate();
     * ```
     * @returns {Promise<QuotaEstimate>} The estimate.
     */
    estimate(): Promise<QuotaEstimate>;
    /**
     * @summary Deletes entries to free space: expired entries first, then the lowest weight.
     * @example
     * Freeing 5 MB
     * ```ts
     * await commands.evict(5 * 1024 * 1024);
     * ```
     * @param {number} bytes The bytes to free.
     * @param {EvictionPolicy} [policy] The tie-break between entries of the same weight. The default is `lru`.
     * @returns {Promise<number>} The bytes freed.
     */
    evict(bytes: number, policy?: EvictionPolicy): Promise<number>;
    /**
     * @summary Deletes every entry of the namespace, in every collection.
     * @example
     * Erasing at account deletion
     * ```ts
     * await commands.clear();
     * ```
     * @returns {Promise<void>} Resolves when the entries are deleted.
     */
    clear(): Promise<void>;
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of the subsystem.
     */
    readonly state: View<Partial<StorageData>>;
  };
}

/**
 * @summary Makes the Storage subsystem.
 *
 * @example
 * Example 1: An app
 * ```ts
 * const kernel = new Kernel([createCrypto(), createStorage({ domain: 'shop' })], { router: queue.router });
 * ```
 *
 * @example
 * Example 2: A test
 * ```ts
 * const kernel = new Kernel([createStorage({ hosts: ['virtual'], backends: ['memory'], keys: null })]);
 * ```
 *
 * @param {StorageOptions} [options] The namespace, hosts, backends, keys and quota monitor.
 * @returns {SubsystemDefinition<StorageData, StorageControl>} The definition, for the kernel.
 * @public
 */
export function createStorage(
  options: StorageOptions = {},
): SubsystemDefinition<StorageData, StorageControl> {
  const database = options.database ?? '__platform_storage';
  const config: CoordinatorConfig = {
    namespace: {
      domain: options.domain ?? ((typeof location !== 'undefined' && location.hostname) || 'app'),
      platform: options.platform ?? 'browser',
      platformVersion: options.platformVersion ?? 1,
    },
    database,
    keys: options.keys === undefined ? { source: { kind: 'device' } } : options.keys,
    ...(options.backends ? { backends: options.backends } : {}),
  };

  const processor: ProcessorDef<StorageRequest, unknown> = {
    id: 'coordinator',
    job: 'sink',
    hosts: options.hosts ?? ['shared', 'virtual'],
    config,
    load: async () => createCoordinator(),
    shared: () =>
      new SharedWorker(new URL('./coordinator.worker.ts', import.meta.url), {
        type: 'module',
        name: `platform-storage:${database}`,
      }),
    dedicated: () =>
      new Worker(new URL('./coordinator.worker.ts', import.meta.url), { type: 'module' }),
  };

  // Listeners of each collection. They live as long as the definition.
  const listeners = new Map<string, Set<(change: StorageChange) => void>>();
  let channel: BroadcastChannel | null = null;

  const deliver = (ctx: UnitContext<StorageData>, change: StorageChange) => {
    const targets =
      change.collection === null ? [...listeners.values()] : [listeners.get(change.collection)];
    for (const set of targets) {
      for (const listener of set ?? []) {
        try {
          listener(change);
        } catch (error) {
          ctx.report(error);
        }
      }
    }
    ctx.port
      .send({ eventId: STORAGE_CHANGED, payload: change })
      .catch((error: unknown) => ctx.report(error));
  };

  const readable = { readable: true } as const;
  return defineSubsystem({
    id: STORAGE_ID,
    scope: 'tab',
    kind: 'featurized',
    processors: [processor],
    subscribes: [CRYPTO_KEYS_CHANGED],
    state: {
      initial: {
        host: null,
        backend: null,
        persistent: false,
        encryption: config.keys !== null,
        probes: {},
        quota: null,
      } as StorageData,
      policy: {
        host: readable,
        backend: readable,
        persistent: readable,
        encryption: readable,
        probes: readable,
        quota: readable,
      },
    },

    async init(ctx) {
      const handle = ctx.processor<StorageRequest, unknown>('coordinator');
      const syncStatus = async () => {
        const status = (await handle.call({ op: 'status' })) as CoordinatorStatus;
        ctx.state.update((s) => {
          s.host = handle.status.getSnapshot().host;
          s.backend = status.backend;
          s.persistent = status.persistent;
          s.encryption = status.encryption;
          s.probes = { ...status.probes };
        });
      };
      // A failover changes the host and maybe the backend.
      const stopStatus = handle.status.subscribe(() => {
        if (handle.status.getSnapshot().host)
          syncStatus().catch((error: unknown) => ctx.report(error));
      });
      await syncStatus();

      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(`platform-storage:${database}:${config.namespace.domain}`);
        channel.onmessage = (event: MessageEvent<Omit<StorageChange, 'remote'>>) =>
          deliver(ctx, { ...event.data, remote: true });
      }

      let timer: ReturnType<typeof setInterval> | undefined;
      if (options.quota !== false) {
        const quota = options.quota ?? {};
        const warning = quota.warning ?? 0.8;
        const critical = quota.critical ?? 0.95;
        const check = async () => {
          const estimate = (await handle.call({ op: 'estimate' })) as QuotaEstimate;
          ctx.state.update((s) => void (s.quota = { ...estimate }));
          if (estimate.ratio < warning) return;
          let alert: QuotaAlert = { ...estimate, level: 'warning' };
          if (estimate.ratio >= critical) {
            const total = estimate.used + estimate.available;
            const bytes = Math.ceil(estimate.used - warning * total);
            const freed = (await handle.call({ op: 'evict', bytes, policy: 'lru' })) as number;
            alert = { ...estimate, level: 'critical', freed };
          }
          await ctx.port.send({ eventId: STORAGE_QUOTA, payload: alert, importance: 'HIGH' });
        };
        timer = setInterval(
          () => void check().catch((error: unknown) => ctx.report(error)),
          quota.intervalMs ?? 60_000,
        );
        (timer as { unref?: () => void }).unref?.();
        check().catch((error: unknown) => ctx.report(error));
      }

      return () => {
        stopStatus();
        clearInterval(timer);
        channel?.close();
        channel = null;
      };
    },

    receive(packet, ctx) {
      if (packet.header.eventId !== CRYPTO_KEYS_CHANGED) return undefined;
      packet.take();
      return ctx.processor<StorageRequest, unknown>('coordinator').call({ op: 'reload-keys' });
    },

    control: (ctx) => {
      const handle = () => ctx.processor<StorageRequest, unknown>('coordinator');
      const changed = (change: Omit<StorageChange, 'remote'>) => {
        channel?.postMessage(change);
        deliver(ctx, { ...change, remote: false });
      };
      const host: CollectionHost = {
        call: (request) => handle().call(request),
        changed,
        corrupt(collection, key, reason) {
          const payload: CorruptEntry = { collection, key, reason };
          ctx.report(new Error(`[storage] "${collection}:${key}" is corrupt: ${reason}`));
          ctx.port
            .send({ eventId: STORAGE_CORRUPT, payload, importance: 'HIGH' })
            .catch((error: unknown) => ctx.report(error));
        },
        listen(collection, listener) {
          let set = listeners.get(collection);
          if (!set) listeners.set(collection, (set = new Set()));
          set.add(listener);
          return () => void set.delete(listener);
        },
      };
      return {
        commands: {
          collection: <T>(definition: CollectionDefinition<T>) =>
            new Collection<T>(definition, host),
          async batch(build: (batch: Batch) => void) {
            const batch = new Batch();
            build(batch);
            if (batch.operations.length === 0) return;
            await handle().call(
              toPortable({ op: 'batch', operations: batch.operations }) as StorageRequest,
            );
            for (const operation of batch.operations) {
              changed({ collection: operation.spec.name, key: operation.key, op: operation.op });
            }
          },
          estimate: () => handle().call({ op: 'estimate' }) as Promise<QuotaEstimate>,
          evict: (bytes: number, policy: EvictionPolicy = 'lru') =>
            handle().call({ op: 'evict', bytes, policy }) as Promise<number>,
          async clear() {
            await handle().call({ op: 'clear' });
            changed({ collection: null, key: null, op: 'clear' });
          },
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
