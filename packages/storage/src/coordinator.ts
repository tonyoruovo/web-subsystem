/**
 * @fileoverview
 * @summary The Storage coordinator: the one writer of the origin, with the backends and the pipeline.
 *
 * @description
 * The coordinator is the processor `coordinator` of the Storage subsystem
 * (docs/ARCHITECTURE.md §18.2). It runs in a shared worker, or on the main
 * thread after a failover. It chooses a backend in `setup`, then handles one
 * request at a time, in order.
 *
 * ```text
 *   setup(config)  worker:  indexeddb --> opfs --> cache                 none persistent --> refuse
 *                  virtual: ... --> localstorage --> sessionstorage --> memory
 *                  a worker that cannot evaluate portable functions     --> refuse
 *   handle(req)    fromPortable(req) --> get | set | delete | list | batch | migrate | evict | ...
 *                  set: encode (pipeline) --> backend.write --> trim to maxEntries
 *                  get: backend.read --> decode (pipeline) --> migrated? write back
 *   ```
 *
 * @example
 * Running the coordinator on the main thread
 * ```ts
 * const coordinator = createCoordinator();
 * await coordinator.setup?.({ host: 'virtual' } as ProcessorScope, { namespace, backends: ['memory'], keys: null });
 * await coordinator.handle({ op: 'set', spec, key: 'a', value: 1 }, scope);
 * ```
 *
 * @author MathAid
 */

import {
  canEvaluate,
  defineProcessor,
  fromPortable,
  type ProcessorModule,
  type ProcessorScope,
} from '@platform/core';
import { KeyStore, type CryptoConfig } from '@platform/crypto';

import { CacheBackend } from './backends/cache';
import { IDBBackend } from './backends/idb';
import { MemoryBackend } from './backends/memory';
import { OPFSBackend } from './backends/opfs';
import { LocalStorageBackend, SessionStorageBackend } from './backends/webstorage';
import { buildCanonicalKey } from './keys';
import { CorruptEntryError, decode, encode, type CollectionSpec } from './pipeline';
import type {
  BackendKind,
  CanonicalKey,
  EvictionPolicy,
  IStorageBackend,
  QuotaEstimate,
  StorageEnvelope,
  UnderlyingPlatform,
} from './types';

/**
 * @summary The backends that keep data after a reload.
 * @public
 */
export const PERSISTENT_BACKENDS: readonly BackendKind[] = [
  'indexeddb',
  'opfs',
  'cache',
  'localstorage',
];

/**
 * @summary The backend chain in a worker.
 * @public
 */
export const WORKER_CHAIN: readonly BackendKind[] = ['indexeddb', 'opfs', 'cache'];

/**
 * @summary The backend chain on the main thread.
 * @public
 */
export const MAIN_CHAIN: readonly BackendKind[] = [
  ...WORKER_CHAIN,
  'localstorage',
  'sessionstorage',
  'memory',
];

/**
 * @summary The first segments of every canonical key of one app.
 * @public
 */
export interface Namespace {
  /**
   * @summary The name of the app or site.
   */
  readonly domain: string;
  /**
   * @summary The platform segment.
   */
  readonly platform: UnderlyingPlatform;
  /**
   * @summary The version segment. Increase it to start with a new namespace.
   */
  readonly platformVersion: number;
}

/**
 * @summary The configuration of the coordinator. The subsystem gives it to `setup`.
 *
 * @example
 * Example 1: The defaults of an app
 * ```ts
 * const config: CoordinatorConfig = { namespace: { domain: 'shop', platform: 'browser', platformVersion: 1 }, database: '__platform_storage', keys: { source: { kind: 'device' } } };
 * ```
 *
 * @example
 * Example 2: Memory only, no encryption
 * ```ts
 * const config: CoordinatorConfig = { namespace, database: 'test', backends: ['memory'], keys: null };
 * ```
 *
 * @public
 */
export interface CoordinatorConfig {
  /**
   * @summary The namespace of the keys.
   */
  readonly namespace: Namespace;
  /**
   * @summary The name of the IndexedDB database, the OPFS folder and the cache.
   */
  readonly database: string;
  /**
   * @summary The backend chain. The default depends on the host.
   */
  readonly backends?: readonly BackendKind[];
  /**
   * @summary The key store of `@platform/crypto` to open, or `null` for no encryption.
   */
  readonly keys: CryptoConfig | null;
}

/**
 * @summary One write or delete of a batch.
 * @public
 */
export type BatchOperation =
  | {
      /**
       * @summary Writes a value.
       */
      readonly op: 'set';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary The key in the collection.
       */
      readonly key: string;
      /**
       * @summary The value.
       */
      readonly value: unknown;
      /**
       * @summary The time to live of this write, in milliseconds.
       */
      readonly ttl?: number | null;
    }
  | {
      /**
       * @summary Deletes a value.
       */
      readonly op: 'delete';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary The key in the collection.
       */
      readonly key: string;
    };

/**
 * @summary The requests that the coordinator handles.
 * @description Functions in a request (the functions of a spec, `where`,
 * `comparator`) travel as portable functions.
 * @public
 */
export type StorageRequest =
  | {
      /**
       * @summary Returns the {@linkcode CoordinatorStatus}.
       */
      readonly op: 'status';
    }
  | {
      /**
       * @summary Reads one value. It returns a {@linkcode ReadResult}.
       */
      readonly op: 'get';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary The key in the collection.
       */
      readonly key: string;
    }
  | {
      /**
       * @summary Writes one value.
       */
      readonly op: 'set';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary The key in the collection.
       */
      readonly key: string;
      /**
       * @summary The value.
       */
      readonly value: unknown;
      /**
       * @summary The time to live of this write, in milliseconds, or `null` for no expiry.
       */
      readonly ttl?: number | null;
      /**
       * @summary The eviction weight of this write.
       */
      readonly weight?: number;
    }
  | {
      /**
       * @summary Deletes one value.
       */
      readonly op: 'delete';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary The key in the collection.
       */
      readonly key: string;
    }
  | {
      /**
       * @summary Returns the entries of a collection. It returns a {@linkcode ListResult}.
       */
      readonly op: 'list';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
      /**
       * @summary Keeps the entries for which it returns `true`.
       */
      readonly where?: (value: unknown, key: string) => boolean;
      /**
       * @summary Returns only the keys, without decoding the values.
       */
      readonly keysOnly?: boolean;
      /**
       * @summary The largest number of entries.
       */
      readonly limit?: number;
      /**
       * @summary The number of entries to skip.
       */
      readonly offset?: number;
    }
  | {
      /**
       * @summary Counts the entries of a collection.
       */
      readonly op: 'count';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
    }
  | {
      /**
       * @summary Deletes the entries of a collection, or of the whole namespace.
       */
      readonly op: 'clear';
      /**
       * @summary The collection. Without it, the whole namespace is cleared.
       */
      readonly spec?: CollectionSpec;
    }
  | {
      /**
       * @summary Applies writes and deletes in one backend transaction.
       */
      readonly op: 'batch';
      /**
       * @summary The operations, in order.
       */
      readonly operations: readonly BatchOperation[];
    }
  | {
      /**
       * @summary Migrates every old entry of a collection. It returns the number migrated.
       */
      readonly op: 'migrate';
      /**
       * @summary The collection.
       */
      readonly spec: CollectionSpec;
    }
  | {
      /**
       * @summary Returns the {@linkcode QuotaEstimate} of the backend.
       */
      readonly op: 'estimate';
    }
  | {
      /**
       * @summary Deletes entries to free space. It returns the bytes freed.
       */
      readonly op: 'evict';
      /**
       * @summary The bytes to free.
       */
      readonly bytes: number;
      /**
       * @summary The tie-break between entries of the same weight.
       */
      readonly policy: EvictionPolicy;
      /**
       * @summary The order for the `user` policy.
       */
      readonly comparator?: (
        a: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
        b: { key: CanonicalKey; envelope: StorageEnvelope<unknown> },
      ) => number;
    }
  | {
      /**
       * @summary Opens the key store again, after a rotation or `forget` in Crypto.
       */
      readonly op: 'reload-keys';
    };

/**
 * @summary What the coordinator reports about itself.
 * @example
 * Example 1: In a shared worker
 * ```ts
 * // { backend: 'indexeddb', probes: { indexeddb: true }, persistent: true, encryption: true }
 * ```
 * @example
 * Example 2: After a failover, with no persistent backend
 * ```ts
 * // { backend: 'memory', probes: { indexeddb: false, opfs: false, ... , memory: true }, persistent: false, encryption: false }
 * ```
 * @public
 */
export interface CoordinatorStatus {
  /**
   * @summary The active backend.
   */
  readonly backend: BackendKind;
  /**
   * @summary The probe result of each backend that was tried.
   */
  readonly probes: Readonly<Partial<Record<BackendKind, boolean>>>;
  /**
   * @summary Tells if the data survives a reload.
   */
  readonly persistent: boolean;
  /**
   * @summary Tells if encryption is configured.
   */
  readonly encryption: boolean;
}

/**
 * @summary The result of a `get`.
 * @example
 * Example 1: Found
 * ```ts
 * // { found: true, value: { total: 3 } }
 * ```
 * @example
 * Example 2: A corrupt entry
 * ```ts
 * // { found: false, corrupt: 'The integrity tag is wrong.' }
 * ```
 * @public
 */
export interface ReadResult {
  /**
   * @summary Tells if the key has a readable value.
   */
  readonly found: boolean;
  /**
   * @summary The value, when found.
   */
  readonly value?: unknown;
  /**
   * @summary Why the entry is corrupt. The coordinator deleted it.
   */
  readonly corrupt?: string;
}

/**
 * @summary The result of a `list`.
 * @example
 * Example 1: Two entries
 * ```ts
 * // { entries: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }], corrupt: [] }
 * ```
 * @example
 * Example 2: Keys only
 * ```ts
 * // { entries: [{ key: 'a' }, { key: 'b' }], corrupt: [] }
 * ```
 * @public
 */
export interface ListResult {
  /**
   * @summary The matching entries, oldest write first.
   */
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value?: unknown }>;
  /**
   * @summary The keys of corrupt entries that the coordinator found and deleted.
   */
  readonly corrupt: readonly string[];
}

/**
 * @summary Options of {@linkcode createCoordinator}.
 * @public
 */
export interface CoordinatorOptions {
  /**
   * @summary The IndexedDB factory for the key store on the main thread. `null` keeps keys in memory.
   */
  readonly indexedDB?: IDBFactory | null;
}

function makeBackend(kind: BackendKind, database: string): IStorageBackend<unknown> {
  switch (kind) {
    case 'indexeddb':
      return new IDBBackend({ dbName: database }) as IStorageBackend<unknown>;
    case 'opfs':
      return new OPFSBackend({ rootDirName: database }) as IStorageBackend<unknown>;
    case 'cache':
      return new CacheBackend({ cacheName: database }) as IStorageBackend<unknown>;
    case 'localstorage':
      return new LocalStorageBackend({ keyPrefix: `${database}:` }) as IStorageBackend<unknown>;
    case 'sessionstorage':
      return new SessionStorageBackend({ keyPrefix: `${database}:` }) as IStorageBackend<unknown>;
    case 'memory':
      return new MemoryBackend();
  }
}

/**
 * @summary Makes the coordinator processor of Storage.
 * @description The worker entry and the virtual host both use it. One
 * request runs at a time, so writes from all tabs apply in order.
 * @example
 * The worker entry
 * ```ts
 * serveProcessor(createCoordinator());
 * ```
 * @param {CoordinatorOptions} [options] The IndexedDB factory of the key store.
 * @returns {ProcessorModule<StorageRequest, unknown>} The processor.
 * @public
 */
export function createCoordinator(
  options: CoordinatorOptions = {},
): ProcessorModule<StorageRequest, unknown> {
  let config: CoordinatorConfig | null = null;
  let backend: IStorageBackend<unknown> | null = null;
  let probes: Partial<Record<BackendKind, boolean>> = {};
  let keys: Promise<KeyStore> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const factory =
    options.indexedDB === null
      ? undefined
      : (options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB));

  const active = () => {
    if (!backend || !config) throw new Error('The Storage coordinator is not set up.');
    return { backend, config };
  };
  const keyOf = (spec: CollectionSpec, key: string): CanonicalKey =>
    buildCanonicalKey({ ...active().config.namespace, callingModule: spec.name, actualKey: key });
  const prefixOf = (spec?: CollectionSpec) => {
    const { domain, platform, platformVersion } = active().config.namespace;
    return `${domain}:${platform}:${platformVersion}:${spec ? `${spec.name}:` : ''}`;
  };
  // The key store opens on first use, and opens again after a failure.
  const keyStore = async (needed: boolean): Promise<KeyStore | null> => {
    const source = active().config.keys;
    if (!source) {
      if (needed) throw new Error('[storage] Encryption is not configured.');
      return null;
    }
    keys ??= KeyStore.open(source, factory).catch((error: unknown) => {
      keys = null;
      throw error;
    });
    return keys;
  };

  async function write(
    spec: CollectionSpec,
    key: string,
    value: unknown,
    ttl?: number | null,
    weight?: number,
  ) {
    const store = await keyStore(spec.encrypt);
    const envelope = await encode(value, spec, store, {
      ttl,
      weight,
      backend: active().backend.kind,
    });
    await active().backend.write(keyOf(spec, key), envelope);
  }

  /** Deletes the oldest entries of a collection above its `maxEntries`. */
  async function trim(spec: CollectionSpec) {
    if (spec.maxEntries === null) return;
    const rows = await active().backend.query({ prefix: prefixOf(spec) });
    if (rows.length <= spec.maxEntries) return;
    rows.sort((a, b) => a.envelope.written_at - b.envelope.written_at);
    for (const row of rows.slice(0, rows.length - spec.maxEntries)) {
      await active().backend.delete(row.key);
    }
  }

  async function read(spec: CollectionSpec, key: CanonicalKey, envelope: StorageEnvelope<unknown>) {
    const flags = typeof envelope.payload === 'string' ? envelope.payload.split(':', 1)[0] : '';
    const store = await keyStore(flags.includes('e'));
    const decoded = await decode(envelope, spec, store);
    if (decoded.migrated) {
      const fresh = await encode(decoded.value, spec, await keyStore(spec.encrypt), {
        ttl: envelope.expires_at === null ? null : Math.max(0, envelope.expires_at - Date.now()),
        weight: envelope.weight,
        backend: active().backend.kind,
      });
      await active().backend.write(key, fresh);
    }
    return decoded.value;
  }

  async function run(request: StorageRequest): Promise<unknown> {
    switch (request.op) {
      case 'status':
        return {
          backend: active().backend.kind,
          probes: { ...probes },
          persistent: PERSISTENT_BACKENDS.includes(active().backend.kind),
          encryption: active().config.keys !== null,
        } satisfies CoordinatorStatus;
      case 'get': {
        const key = keyOf(request.spec, request.key);
        const envelope = await active().backend.read(key);
        if (!envelope) return { found: false } satisfies ReadResult;
        try {
          return {
            found: true,
            value: await read(request.spec, key, envelope),
          } satisfies ReadResult;
        } catch (error) {
          if (!(error instanceof CorruptEntryError)) throw error;
          await active().backend.delete(key);
          return { found: false, corrupt: error.message } satisfies ReadResult;
        }
      }
      case 'set':
        await write(request.spec, request.key, request.value, request.ttl, request.weight);
        await trim(request.spec);
        return undefined;
      case 'delete':
        await active().backend.delete(keyOf(request.spec, request.key));
        return undefined;
      case 'list': {
        const prefix = prefixOf(request.spec);
        const rows = await active().backend.query({ prefix });
        rows.sort((a, b) => a.envelope.written_at - b.envelope.written_at);
        const entries: Array<{ key: string; value?: unknown }> = [];
        const corrupt: string[] = [];
        for (const row of rows) {
          const key = row.key.slice(prefix.length);
          if (request.keysOnly && !request.where) {
            entries.push({ key });
            continue;
          }
          let value: unknown;
          try {
            value = await read(request.spec, row.key, row.envelope);
          } catch (error) {
            if (!(error instanceof CorruptEntryError)) throw error;
            await active().backend.delete(row.key);
            corrupt.push(key);
            continue;
          }
          if (request.where && !request.where(value, key)) continue;
          entries.push(request.keysOnly ? { key } : { key, value });
        }
        const offset = request.offset ?? 0;
        return {
          entries: entries.slice(offset, offset + (request.limit ?? entries.length)),
          corrupt,
        } satisfies ListResult;
      }
      case 'count':
        return active().backend.count(prefixOf(request.spec));
      case 'clear':
        await active().backend.clear(prefixOf(request.spec));
        return undefined;
      case 'batch': {
        // Encode first, so a bad value fails before the transaction opens.
        const prepared: Array<{ key: CanonicalKey; envelope?: StorageEnvelope<unknown> }> = [];
        for (const operation of request.operations) {
          const key = keyOf(operation.spec, operation.key);
          if (operation.op === 'delete') {
            prepared.push({ key });
            continue;
          }
          const store = await keyStore(operation.spec.encrypt);
          prepared.push({
            key,
            envelope: await encode(operation.value, operation.spec, store, {
              ttl: operation.ttl,
              backend: active().backend.kind,
            }),
          });
        }
        const tx = await active().backend.beginTransaction();
        try {
          for (const { key, envelope } of prepared) {
            if (envelope) await active().backend.write(key, envelope, { transactionId: tx.id });
            else await active().backend.delete(key, { transactionId: tx.id });
          }
          await tx.commit();
        } catch (error) {
          if (active().backend.isTransactionActive(tx.id)) await tx.rollback();
          throw error;
        }
        const specs = new Map(request.operations.map((o) => [o.spec.name, o.spec]));
        for (const spec of specs.values()) await trim(spec);
        return undefined;
      }
      case 'migrate': {
        const rows = await active().backend.query({ prefix: prefixOf(request.spec) });
        let migrated = 0;
        for (const row of rows) {
          if (row.envelope.schema_version >= request.spec.version) continue;
          try {
            await read(request.spec, row.key, row.envelope);
            migrated++;
          } catch (error) {
            if (!(error instanceof CorruptEntryError)) throw error;
            await active().backend.delete(row.key);
          }
        }
        return migrated;
      }
      case 'estimate':
        return active().backend.estimateQuota() satisfies Promise<QuotaEstimate>;
      case 'evict':
        return active().backend.evict(request.bytes, request.policy, request.comparator);
      case 'reload-keys':
        keys = null;
        await keyStore(false);
        return undefined;
      default:
        throw new Error(`Unknown Storage operation "${(request as { op: string }).op}".`);
    }
  }

  return defineProcessor<StorageRequest, unknown>({
    async setup(scope: ProcessorScope, value) {
      config = value as CoordinatorConfig;
      const inWorker = scope.host !== 'virtual';
      if (inWorker && !canEvaluate()) {
        throw new Error('[storage] This worker cannot evaluate portable functions (CSP).');
      }
      probes = {};
      for (const kind of config.backends ?? (inWorker ? WORKER_CHAIN : MAIN_CHAIN)) {
        try {
          const candidate = makeBackend(kind, config.database);
          const result = await candidate.probe();
          probes[kind] = result.available;
          if (!result.available) continue;
          await candidate.initialize();
          backend = candidate;
          break;
        } catch {
          probes[kind] = false;
        }
      }
      if (!backend) throw new Error('[storage] No storage backend is available.');
      if (inWorker && !PERSISTENT_BACKENDS.includes(backend.kind)) {
        await backend.close();
        backend = null;
        throw new Error('[storage] This worker has no persistent backend.');
      }
      // A worker that cannot open the keys refuses (WebKit cannot store a CryptoKey from a
      // shared worker). The main thread keeps going, and tries the keys again at first use.
      try {
        await keyStore(false);
      } catch (error) {
        if (!inWorker) return;
        await backend.close();
        backend = null;
        throw new Error('[storage] This worker cannot open the keys.', { cause: error });
      }
    },

    handle(message) {
      const request = fromPortable<StorageRequest>(message);
      const next = queue.then(() => run(request));
      queue = next.catch(() => undefined);
      return next;
    },

    async teardown() {
      await backend?.close();
      (await keys?.catch(() => null))?.clear();
      backend = null;
      keys = null;
    },
  });
}
