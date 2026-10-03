import type { BackendKind, CanonicalKey, StorageEnvelope, TransactionStrength } from '../../types';

import type { MemoryTransaction } from './memory.transaction';

/**
 * @summary The state of the memory backend: one plain object for the module.
 * @description
 * It holds the envelopes, the open transactions and the read counts. Every
 * {@linkcode MemoryBackend} uses the same store, so two instances see the same data.
 *
 * @example
 * Example 1: Reading the store in a test
 * ```ts
 * useMemoryStore()._store.size; // the number of entries
 * ```
 *
 * @example
 * Example 2: Two backends, one store
 * ```ts
 * await new MemoryBackend().write(key, envelope);
 * await new MemoryBackend().read(key); // envelope
 * ```
 *
 * @public
 */
export interface MemoryStore {
  /**
   * @summary The kind of the backend: `memory`.
   */
  kind: BackendKind;
  /**
   * @summary The strongest transaction of the backend: `best-effort`.
   */
  transactionStrength: TransactionStrength;
  /**
   * @summary The place of the backend in the old priority order.
   */
  priority: number;
  /**
   * @summary The envelopes, by key.
   */
  _store: Map<CanonicalKey, StorageEnvelope<unknown>>;
  /**
   * @summary Tells if `initialize` ran.
   */
  _initialized: boolean;
  /**
   * @summary The open transactions, by id.
   */
  _transactions: Map<string, MemoryTransaction<unknown>>;
  /**
   * @summary The number of reads of each key, for the `lfu` eviction policy.
   * @description A write resets the count of its key. The counts are lost
   * when the page reloads, so `lfu` works within one session.
   */
  _readCount: Map<CanonicalKey, number>;
}

const store: MemoryStore = {
  kind: 'memory',
  transactionStrength: 'best-effort',
  priority: 3,
  _store: new Map(),
  _initialized: false,
  _transactions: new Map(),
  _readCount: new Map(),
};

/**
 * @summary Returns the store of the memory backend.
 * @example
 * Getting the store
 * ```ts
 * const store = useMemoryStore();
 * ```
 * @returns {MemoryStore} The one store of the module.
 * @public
 */
export function useMemoryStore(): MemoryStore {
  return store;
}
