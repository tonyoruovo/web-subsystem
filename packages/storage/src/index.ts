/**
 * @fileoverview
 * @module @platform/storage
 * @summary The public API of `@platform/storage`.
 * @description
 * Re-exports the Storage subsystem ({@linkcode createStorage}), its
 * collections, its coordinator, the pipeline, the state persistence adapter
 * and the five backends (docs/ARCHITECTURE.md §18.2).
 *
 * ```text
 *   @platform/storage
 *   +-- createStorage            the subsystem: id 'storage', featurized, Tab scope
 *   +-- Collection, Batch        the API for callers: get, set, delete, entries, batch, subscribe
 *   +-- createCoordinator        the processor: the backend chain and the pipeline, one writer for the origin
 *   +-- encode, decode           the pipeline: serialize, compress, encrypt + HMAC, migrate
 *   +-- createStatePersistence   the kernel's persistence option
 *   +-- backends                 IndexedDB, OPFS, Cache, Web Storage, memory
 *   +-- canonical keys           <domain>:<platform>:<platformVersion>:<module>:<key>
 *   @platform/storage/worker     the worker entry that serves the coordinator
 *   ```
 *
 * @example
 * Registering Storage
 * ```ts
 * import { createCrypto } from '@platform/crypto';
 * import { createStatePersistence, createStorage } from '@platform/storage';
 *
 * const kernel = new Kernel([createCrypto(), createStorage({ domain: 'shop' })], {
 *   persistence: createStatePersistence(),
 * });
 * ```
 *
 * @example
 * Using it from another subsystem
 * ```ts
 * import type { StorageControl } from '@platform/storage';
 *
 * const drafts = ctx.dependency<StorageControl>('storage')?.commands.collection({ name: 'drafts' });
 * ```
 *
 * @author MathAid
 */

export * from './backends';
export * from './collection';
export * from './coordinator';
export * from './keys';
export * from './persistence';
export * from './pipeline';
export * from './storage';
export * from './types';
export * from './util';
