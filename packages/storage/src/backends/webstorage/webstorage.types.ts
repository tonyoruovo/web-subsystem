/**
 * @fileoverview WebStorage backend domain types.
 *
 * ## Overview
 * Defines every type exclusive to the `WebStorageBackend` shared abstraction
 * and the two concrete backends (`LocalStorageBackend`, `SessionStorageBackend`)
 * that extend it.  Types shared across all backends live in `storage.types.ts`;
 * this file introduces only WebStorage-specific concepts:
 *
 * - The discriminator that distinguishes the two underlying `Storage` objects.
 * - Construction-time configuration.
 * - The buffered-op types used by `WebStorageTransaction`.
 * - The internal transaction interface that couples `WebStorageBackend` to its
 *   transaction implementation without leaking buffer methods into the public
 *   `ITransaction` surface.
 *
 * ## Dependency graph (within this module)
 * ```
 * webstorage.types  <==  webstorage.transaction
 *                   <==  webstorage.backend     (abstract)
 *                   <==  localstorage.backend
 *                   <==  sessionstorage.backend
 * ```
 * `webstorage.types` is a leaf: it imports nothing from within this module.
 */

import type { CanonicalKey, ITransaction, ITransactionOp, TransactionStrength } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Storage handle discriminator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Discriminates between the two browser Web Storage handles.
 *
 * @description
 * `WebStorageKind` is the single axis of variation between `LocalStorageBackend`
 * and `SessionStorageBackend`. Every behavioural difference between the two
 * backends — persistence scope, availability in private browsing, eviction
 * lifetime — derives from which native `Storage` object is injected at
 * construction time.
 *
 * The shared `WebStorageBackend` class is instantiated by two thin concrete
 * subclasses, each of which passes the appropriate `Storage` handle along with
 * a `WebStorageKind` label that becomes the `BackendKind` on every written
 * `StorageEnvelope`.
 *
 * @example
 * ```ts
 * // LocalStorageBackend passes:
 * super(window.localStorage, 'localstorage', config)
 *
 * // SessionStorageBackend passes:
 * super(window.sessionStorage, 'sessionstorage', config)
 * ```
 */
export type WebStorageKind = 'localstorage' | 'sessionstorage';

// ─────────────────────────────────────────────────────────────────────────────
// Backend configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary Construction-time configuration for `WebStorageBackend` and its
 * two concrete subclasses.
 *
 * @description
 * `WebStorageConfig` exposes two optional knobs. Both have sensible defaults
 * that make zero-argument construction (`new LocalStorageBackend()`) correct
 * for the common case.
 *
 * `keyPrefix` provides namespace isolation within a shared `Storage` object.
 * Because `localStorage` is shared across the entire origin, a prefix ensures
 * this backend's entries do not collide with other libraries or legacy code
 * that write directly to `localStorage`. All read, write, delete, and clear
 * operations are transparently scoped to the prefix.
 *
 * `quotaRecoveryPolicy` controls what the backend does when `setItem` throws
 * `QuotaExceededError`. The default `'ttl-then-lru'` policy attempts one
 * automatic recovery pass (expired entries swept first, then LRU eviction) and
 * retries the write. Set to `'none'` to disable automatic recovery and let the
 * error propagate to the caller.
 *
 * @example No-arg construction (uses all defaults)
 * ```ts
 * const ls = new LocalStorageBackend()
 * // keyPrefix: '__storage__', quotaRecoveryPolicy: 'ttl-then-lru'
 * ```
 *
 * @example Isolated namespace, no automatic recovery
 * ```ts
 * const ss = new SessionStorageBackend({
 *   keyPrefix:             'myapp',
 *   quotaRecoveryPolicy:   'none',
 * })
 * ```
 *
 * @see {@link WebStorageBackend} for the implementation that consumes this config.
 */
export interface WebStorageConfig {
  /**
   * @summary String prepended to every storage key written by this backend.
   * @description
   * Provides namespace isolation within the shared `Storage` object so that
   * entries written by this subsystem do not collide with other code that uses
   * the same `localStorage` / `sessionStorage` origin.
   *
   * The prefix is applied transparently: callers always supply and receive
   * canonical keys; the prefix is added on write and stripped on read.
   * @default `'__storage__'`
   */
  keyPrefix?: string;

  /**
   * @summary Recovery strategy when `setItem` throws `QuotaExceededError`.
   * @description
   * - `'ttl-then-lru'` — Sweep all expired entries first. If the write still
   *   fails, evict entries from lowest weight ascending (LRU tie-break) until
   *   there is estimated room, then retry. One retry attempt only; if the retry
   *   fails the error propagates to the caller.
   * - `'none'` — Do not attempt recovery. Propagate `QuotaExceededError`
   *   immediately.
   * @default `'ttl-then-lru'`
   */
  quotaRecoveryPolicy?: 'ttl-then-lru' | 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot-based compensating transaction types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The op-kind discriminant for operations buffered inside a
 * `WebStorageTransaction`.
 *
 * @description
 * `WebStorageOpKind` narrows the mutation types that appear in a transaction's
 * op buffer to the three things that can change stored state. Reads are absent
 * by design — they do not modify state and require no journaling.
 *
 * @see {@link WebStorageBufferedOp} for the full per-op shape.
 */
export type WebStorageOpKind = 'write' | 'delete' | 'clear';

/**
 * @summary A single buffered operation held inside a `WebStorageTransaction`.
 *
 * @description
 * `WebStorageBufferedOp` is the element type of `WebStorageTransaction`'s
 * internal `_ops` array. Each element represents a mutation that the caller
 * has staged but not yet applied to the `Storage` object.
 *
 * Unlike the OPFS WAL (which stores full payload bytes for crash recovery),
 * the WebStorage transaction buffer is an in-memory staging area only. It does
 * not persist across page reloads, and rollback simply discards it — the
 * pre-transaction snapshot held separately by the transaction is what enables
 * compensating rollback.
 *
 * The three variants map directly to the three Web Storage mutations:
 * - `write` — the full JSON-serialized envelope string, ready to pass to
 *   `Storage.setItem`. Storing the serialized string avoids re-serialization
 *   at commit time.
 * - `delete` — the canonical key; the backend derives the storage key at
 *   commit time.
 * - `clear` — an optional prefix; if absent the entire prefixed namespace is
 *   cleared on commit.
 *
 * @example Write op inside a transaction buffer
 * ```ts
 * const op: WebStorageBufferedOp = {
 *   kind:  'write',
 *   key:   'myapp:chrome:130:auth:session' as CanonicalKey,
 *   json:  JSON.stringify({ payload: 'ENCRYPTED', schema_version: 1, ... }),
 * }
 * ```
 *
 * @see {@link WebStorageTransaction} for the transaction class that holds these ops.
 * @see {@link IWebStorageTransaction} for the public interface consumed by the backend.
 */
export type WebStorageBufferedOp =
  | ({
      /**
       * @summary The kind of operation: `write`.
       */
      kind: 'write';
      /**
       * @summary The key to write.
       */
      key: CanonicalKey;
      /**
       * @summary The envelope, as JSON text.
       */
      json: string;
    } & ITransactionOp)
  | ({
      /**
       * @summary The kind of operation: `delete`.
       */
      kind: 'delete';
      /**
       * @summary The key to delete.
       */
      key: CanonicalKey;
    } & ITransactionOp)
  | ({
      /**
       * @summary The kind of operation: `clear`.
       */
      kind: 'clear';
      /**
       * @summary The prefix to clear. Without it, the commit clears every entry.
       */
      prefix?: string;
    } & ITransactionOp);

/**
 * @summary A snapshot of the Storage values that existed before a transaction
 * began, used to restore prior state on rollback.
 *
 * @description
 * `WebStorageSnapshot` is a `Map` from **storage keys** (the prefixed,
 * stringified keys as they appear in the `Storage` object, not canonical keys)
 * to their raw JSON string values at the moment the snapshot was taken.
 *
 * A `null` value in the map means the key did not exist before the transaction
 * started — it should be removed (via `removeItem`) on rollback to restore the
 * pre-transaction state.
 *
 * The snapshot is populated lazily: keys are only snapshotted the first time
 * they are touched by a transaction op. This avoids a full-store scan at
 * `beginTransaction()` time while still guaranteeing that every affected key
 * has a pre-transaction value recorded before the first write.
 *
 * @example Snapshot after two ops touch KEY_A and KEY_B
 * ```ts
 * // Before transaction: KEY_A existed; KEY_B did not.
 * const snapshot: WebStorageSnapshot = new Map([
 *   ['__storage__myapp:chrome:130:auth:session', '{"payload":"OLD","..."}'],
 *   ['__storage__myapp:chrome:130:auth:refresh', null],
 * ])
 * // On rollback: KEY_A is restored to its old value; KEY_B is removed.
 * ```
 *
 * @see {@link WebStorageTransaction} for where the snapshot is populated and applied.
 */
export type WebStorageSnapshot = Map<string, string | null>;

// ─────────────────────────────────────────────────────────────────────────────
// WebStorage transaction interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @summary The WebStorage-specific transaction handle, extending `ITransaction`
 * with the internal snapshot-management and op-buffering methods used by
 * `WebStorageBackend`.
 *
 * @description
 * `IWebStorageTransaction` is the internal contract between `WebStorageBackend`
 * and `WebStorageTransaction`. It extends the public `ITransaction` interface
 * with three `buffer*` methods (called by the backend when a `transactionId`
 * is present on a mutating op) and one `snapshotKey` method (called by the
 * backend to lazily capture pre-transaction values before the first write to
 * each key).
 *
 * Callers who obtain a transaction via `WebStorageBackend.beginTransaction()`
 * see only the narrower `ITransaction` type. The buffer and snapshot methods
 * are an internal contract and are intentionally hidden from external consumers.
 *
 * **Transaction strength: `'compensating'`**
 *
 * The snapshot + restore mechanism provides compensating-strength transactions:
 * - Ops are buffered in memory until `commit()`.
 * - On `commit()`, ops are applied one by one to the `Storage` object.
 * - On `rollback()`, every key in the snapshot is restored to its pre-transaction
 *   value (re-inserting it, removing it, or overwriting it as appropriate).
 * - There is no isolation from concurrent reads in other tabs — the `storage`
 *   event can fire mid-commit. This is the standard limitation of Web Storage
 *   transactions and is documented in `WebStorageTransaction`.
 *
 * @example Internal usage within WebStorageBackend.write()
 * ```ts
 * // Called before any modification to capture the pre-write value:
 * tx.snapshotKey(storageKey, storage.getItem(storageKey))
 *
 * // Called to stage the write (no Storage mutation yet):
 * tx.bufferWrite(canonicalKey, JSON.stringify(envelope))
 * ```
 *
 * @see {@link WebStorageTransaction} for the concrete implementation.
 * @see {@link ITransaction} for the public interface.
 */
export interface IWebStorageTransaction extends ITransaction {
  /**
   * @summary Always `'compensating'` — snapshot + restore, no true ACID isolation.
   */
  readonly strength: Extract<TransactionStrength, 'compensating'>;

  /**
   * @summary The accumulated op buffer. Exposed for inspection; do not mutate externally.
   */
  readonly operations: ReadonlyArray<WebStorageBufferedOp>;

  /**
   * @summary Record the current value of a storage key before the first transaction mutation touches it.
   * @description
   * Should be called by the backend immediately before the first `bufferWrite`,
   * `bufferDelete`, or `bufferClear` that would affect `storageKey`. Subsequent
   * calls for the same `storageKey` are no-ops — only the first (pre-mutation)
   * value is relevant for rollback.
   *
   * @param storageKey   - The prefixed storage key (as it appears in the `Storage` object).
   * @param currentValue - `storage.getItem(storageKey)` — `null` if the key does not exist.
   */
  snapshotKey(storageKey: string, currentValue: string | null): void;

  /**
   * @summary Buffer a write operation.
   * @param key  - The canonical key being written.
   * @param json - Pre-serialized `JSON.stringify(StorageEnvelope<string>)`.
   */
  bufferWrite(key: CanonicalKey, json: string): void;

  /**
   * @summary Buffer a delete operation.
   * @param key - The canonical key to delete on commit.
   */
  bufferDelete(key: CanonicalKey): void;

  /**
   * @summary Buffer a clear operation.
   * @param prefix - If present, only keys whose canonical key starts with this
   *   string are cleared. If absent, the entire prefixed namespace is cleared.
   */
  bufferClear(prefix?: string): void;
}
