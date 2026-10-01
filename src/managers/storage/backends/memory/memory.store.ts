import type {
  BackendKind,
  CanonicalKey,
  StorageEnvelope,
  TransactionStrength,
} from '../../storage.types';
import type { MemoryTransaction } from './memory.transaction';

/**
 * @summary The Memory backend store, a plain framework-agnostic singleton.
 * @description
 * Holds the in-memory envelope map, the initialization flag, the active
 * transactions, and the LFU read counters. It is a plain object with plain
 * `Map`/`boolean`/`number` fields (no Vue reactivity or Pinia), so any
 * framework or plain JavaScript can consume it.
 */
export interface MemoryStore {
  kind: BackendKind;
  transactionStrength: TransactionStrength;
  priority: number;

  _store: Map<CanonicalKey, StorageEnvelope<unknown>>;
  _initialized: boolean;

  /** Active transactions indexed by id. */
  _transactions: Map<string, MemoryTransaction<unknown>>;

  /**
   * Read-access counter for LFU eviction.
   *
   * It is the access frequency counter for **LFU (Least Frequently Used)** eviction.
   * Every successful `read()` call increments `_readCount[key]`. When `evict()` is
   * called with `policy: 'lfu'`, the tie-breaking comparator sorts by ascending read
   * count - entries read fewest times are evicted first. It resets to zero on overwrite
   * (a rewritten entry is treated as new). It is in-memory only and resets on page
   * reload, which means LFU is a within-session heuristic. Both backends track it for
   * the same reason; Memory just happens to be the only backend where LFU is cheap and
   * reliable since all reads are guaranteed to go through the same process.
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
 * @summary Returns the shared Memory backend store.
 * @returns {MemoryStore} The singleton store.
 */
export function useMemoryStore(): MemoryStore {
  return store;
}
