/**
 * @fileoverview WebStorage compensating transaction implementation.
 *
 * ## Overview
 * Provides `WebStorageTransaction`, the snapshot-based compensating transaction
 * for both `LocalStorageBackend` and `SessionStorageBackend`. It accumulates
 * mutation ops in an in-memory buffer, maintains a pre-transaction snapshot of
 * every affected storage key, and delegates actual `Storage` mutations to
 * callbacks supplied by `WebStorageBackend` at construction time.
 *
 * ## Transaction model
 * ```txt
 *  beginTransaction()
 *       │
 *      ▼
 *  WebStorageTransaction created (ops = [], snapshot = Map{})
 *       │
 *  For each op call on the backend with this transactionId:
 *    1. backend calls tx.snapshotKey(storageKey, storage.getItem(storageKey))
 *       -> recorded only once per key (first-write-wins for the snapshot)
 *    2. backend calls tx.bufferWrite / bufferDelete / bufferClear
 *       -> ops[] grows; zero Storage mutations
 *       │
 *       ├── commit() ────────────────────────────────────────────────────────┐
 *       │        │                                                           │
 *       │       ▼                                                            │
 *       │   _onCommit(txId, ops)                                             │
 *       │        │  (implemented by WebStorageBackend._applyCommit)          │
 *       │       ▼                                                            │
 *       │   for each op in ops (in order):                                   │
 *       │     'write'  -> storage.setItem(prefixedKey, json)                 │
 *       │     'delete' -> storage.removeItem(prefixedKey)                    │
 *       │     'clear'  -> iterate all own keys + removeItem matching prefix  │
 *       │   _transactions.delete(txId)                                       │
 *       │                                                                    │
 *       └── rollback() ──────────────────────────────────────────────────────┘
 *                │
 *               ▼
 *           for each (storageKey, priorValue) in snapshot:
 *             priorValue !== null -> storage.setItem(storageKey, priorValue)
 *             priorValue === null -> storage.removeItem(storageKey)
 *           ops.length = 0
 *           _onRollback(txId)
 * ```
 *
 * ## Compensating, not serializable
 * The snapshot restores the values that existed *at the moment each key was
 * first touched* by this transaction.  Because `localStorage` / `sessionStorage`
 * are shared synchronously across the same browsing context, another
 * (synchronous) write from the same tab between two ops in this transaction
 * could create an inconsistency the snapshot cannot account for.  In practice
 * this risk is eliminated by the SharedWorker scheduler, which serializes all
 * ops through a single coordinator thread.  Cross-tab writes via the `storage`
 * event are asynchronous and do not interleave within a synchronous commit pass.
 *
 * ## Settled state
 * After either `commit()` or no-arg `rollback()`, the transaction is permanently
 * settled.  Subsequent calls to any method throw immediately.  Partial-rollback
 * overloads (by index, key, segments, predicate) do NOT settle the transaction.
 */

import { v4 as uuidV4 } from 'uuid';

import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ITxOpPredicate,
  TransactionStrength,
} from '../../storage.types';
import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '../../storage.util';

import type {
  IWebStorageTransaction,
  WebStorageBufferedOp,
  WebStorageSnapshot,
} from './webstorage.types';

/**
 * @summary Snapshot-backed compensating transaction for `WebStorageBackend`.
 *
 * @description
 * `WebStorageTransaction` implements `IWebStorageTransaction`, the transaction
 * model shared by `LocalStorageBackend` and `SessionStorageBackend`. It
 * accumulates mutation ops in an in-memory buffer and maintains a lazily
 * populated snapshot of the pre-transaction value of every key it touches.
 *
 * Two callbacks injected at construction time tie this transaction to its
 * parent backend instance without creating a direct import dependency:
 *
 * - `_onCommit(txId, ops)` — implemented by `WebStorageBackend._applyCommit`.
 *   Applies each buffered op sequentially to the live `Storage` object. Handles
 *   `QuotaExceededError` via the backend's configured recovery policy.
 * - `_onRollback(txId)` — removes this transaction from the backend's active
 *   transaction registry.
 *
 * **Rollback**: compensating. The snapshot records `storage.getItem(key)` for
 * every key touched *before* the first write to that key. On rollback, each
 * snapshot entry is either re-inserted (if the value was non-null) or removed
 * (if the key did not exist before the transaction). This restores the Storage
 * object to its pre-transaction state without requiring a separate undo log.
 *
 * **Partial rollback**: the overloaded `rollback(token)` signatures remove
 * specific ops from the buffer without settling the transaction. Snapshot
 * entries corresponding to removed ops are also pruned where safe (i.e., when
 * no other buffered op still touches the same key).
 *
 * @example Basic commit / rollback
 * ```ts
 * const tx = await backend.beginTransaction()
 *
 * await backend.write(keyA, envelopeA, { transactionId: tx.id })
 * await backend.write(keyB, envelopeB, { transactionId: tx.id })
 * await backend.delete(keyC,           { transactionId: tx.id })
 *
 * try {
 *   await tx.commit()   // ops applied sequentially to Storage
 * } catch {
 *   await tx.rollback() // Storage restored to pre-transaction state
 * }
 * ```
 *
 * @example Partial rollback — cancel one op, keep the rest
 * ```ts
 * const tx = await backend.beginTransaction()
 * await backend.write(keyA, envA, { transactionId: tx.id })
 * await backend.write(keyB, envB, { transactionId: tx.id })
 *
 * // Change of plan: drop the write for keyB
 * await tx.rollback(keyB)  // transaction still open; keyA write remains
 *
 * await tx.commit()  // only keyA is written to Storage
 * ```
 *
 * @see {@link IWebStorageTransaction} for the full interface contract.
 * @see {@link WebStorageBackend} for the backend that creates and drives this class.
 */
export class WebStorageTransaction implements IWebStorageTransaction {
  /** @inheritdoc */
  readonly id: string;

  /**
   * Fixed at `'compensating'` — snapshot + restore, no true ACID isolation.
   * @inheritdoc
   */
  readonly strength: Extract<TransactionStrength, 'compensating'> = 'compensating';

  /**
   * Accumulated op buffer. Populated by the `buffer*` methods; read by
   * `_onCommit` at commit time. Cleared (`.length = 0`) on full rollback.
   * Exposed as a readonly view via `operations`.
   */
  private readonly _ops: WebStorageBufferedOp[] = [];

  /**
   * Pre-transaction snapshot of every storage key touched by this transaction.
   * Keys are the **prefixed storage keys** (as they appear in the `Storage`
   * object). Values are the raw JSON strings that existed before this
   * transaction first wrote to each key (`null` = key did not exist).
   * Populated lazily by `snapshotKey()`.
   */
  private readonly _snapshot: WebStorageSnapshot = new Map();

  /** Whether this transaction has been committed or fully rolled back. */
  private _settled = false;

  /** @inheritdoc */
  get operations(): ReadonlyArray<WebStorageBufferedOp> {
    return this._ops;
  }

  /**
   * @param _storage
   *   The underlying `Storage` object (`localStorage` or `sessionStorage`).
   *   Used directly during `rollback()` to restore snapshot values — the
   *   rollback path must be synchronous and reliable, so it bypasses the
   *   `_onCommit` callback rather than relying on an async path.
   *
   * @param _onCommit
   *   Provided by `WebStorageBackend._applyCommit`. Receives the full op
   *   buffer and owns all `Storage` mutations at commit time, including
   *   `QuotaExceededError` recovery.
   *
   * @param _onRollback
   *   Provided by `WebStorageBackend`. Removes this transaction from the
   *   backend's `_transactions` registry after full rollback.
   */
  constructor(
    private readonly _storage: Storage,
    private readonly _onCommit: (txId: string, ops: WebStorageBufferedOp[]) => Promise<void>,
    private readonly _onRollback: (txId: string) => void,
  ) {
    this.id = uuidV4();
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * @summary Record the pre-transaction value of a storage key.
   *
   * @description
   * Called by the backend immediately before staging the first op that touches
   * `storageKey`. Subsequent calls for the same key are silently ignored —
   * only the value that existed *before* the transaction first wrote to each
   * key is relevant for rollback.
   *
   * @param storageKey   - The prefixed storage key as it appears in the `Storage` object.
   * @param currentValue - `storage.getItem(storageKey)` at snapshot time.
   *   `null` means the key did not exist.
   */
  snapshotKey(storageKey: string, currentValue: string | null): void {
    // First-write-wins: only record the truly pre-transaction value.
    if (!this._snapshot.has(storageKey)) {
      this._snapshot.set(storageKey, currentValue);
    }
  }

  // ── Buffer methods ────────────────────────────────────────────────────────

  /**
   * @summary Buffer a write op.
   *
   * @description
   * Appends a `write` op to the internal buffer. `json` is the pre-serialized
   * `JSON.stringify(StorageEnvelope<string>)` produced by the backend — storing
   * it here avoids a redundant stringify at commit time.
   *
   * No `Storage` mutation occurs until `commit()`.
   *
   * @param key  - The canonical key being written.
   * @param json - Pre-serialized envelope JSON string.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferWrite(key: CanonicalKey, json: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, json });
  }

  /**
   * @summary Buffer a delete op.
   *
   * @description
   * Appends a `delete` op to the internal buffer. No `Storage` mutation occurs
   * until `commit()`.
   *
   * @param key - The canonical key to delete on commit.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferDelete(key: CanonicalKey): void {
    this._assertOpen();
    this._ops.push({ kind: 'delete', key });
  }

  /**
   * @summary Buffer a clear op.
   *
   * @description
   * Appends a `clear` op to the internal buffer. On commit, if `prefix` is
   * provided, only this backend's keys whose canonical key starts with `prefix`
   * are removed. If `prefix` is omitted, the entire prefixed namespace is
   * cleared.
   *
   * @param prefix - Optional key prefix. Absent = clear all backend entries.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferClear(prefix?: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ──────────────────────────────────────────────────────────

  /**
   * @summary Commit all buffered ops to the `Storage` object.
   *
   * @description
   * Marks the transaction as settled and delegates the full op buffer to
   * `_onCommit`, which is implemented by `WebStorageBackend._applyCommit`.
   * Each op is applied sequentially:
   *
   * - `write`  → `storage.setItem(prefixedKey, json)`
   * - `delete` → `storage.removeItem(prefixedKey)`
   * - `clear`  → iterate all backend keys, `removeItem` those matching prefix
   *
   * If `_onCommit` throws (including after a failed `QuotaExceededError`
   * recovery), the error propagates to the caller. The transaction is still
   * settled at that point — any partial writes that succeeded before the
   * failure are left in place. The snapshot can be inspected manually for
   * debugging, but there is no automatic cleanup of partial writes on commit
   * failure.
   *
   * After this resolves, the transaction cannot be reused.
   *
   * @throws {Error} If the transaction has already been settled.
   * @throws {Error} Re-throws any error from `_onCommit`.
   */
  async commit(): Promise<void> {
    this._assertOpen();
    this._settled = true;
    await this._onCommit(this.id, this._ops);
  }

  // Overload signatures for ITransaction interface compliance.
  rollback(): Promise<void>;
  rollback(index: number): Promise<Readonly<[WebStorageBufferedOp | undefined]>>;
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<WebStorageBufferedOp>>;
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<WebStorageBufferedOp>>;
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<WebStorageBufferedOp>>;

  /**
   * @summary Roll back all (or a specified subset of) buffered ops.
   *
   * @description
   * **Full rollback (no argument):** The transaction is permanently settled,
   * the op buffer is discarded, and the `Storage` object is restored to its
   * pre-transaction state by iterating the snapshot:
   *
   * - Snapshot value non-null → `storage.setItem(key, priorValue)` (restore)
   * - Snapshot value null → `storage.removeItem(key)` (key did not exist before)
   *
   * `_onRollback` is then called to remove this transaction from the backend
   * registry.
   *
   * **Partial rollback (with token):** Only the matching ops are removed from
   * the buffer. The transaction remains open. Snapshot entries for keys that
   * are no longer referenced by any remaining buffered op are also pruned.
   * Snapshot entries for keys still referenced by other ops are left untouched.
   *
   * Partial rollback does **not** write anything to the `Storage` object — the
   * full snapshot restore only happens on no-arg full rollback.
   *
   * ### Token dispatch
   * - `number` — removes the op at that zero-based index; no-op if out of range.
   * - `CanonicalKey` (string) — removes all ops whose `key` field equals the argument.
   * - `ICanonicalKeySegments` — if `actualKey` is present, delegates to the key
   *   overload; otherwise builds a module prefix and removes all ops whose key
   *   starts with that prefix.
   * - `ITxOpPredicate` (function) — removes all ops for which the predicate returns truthy.
   *
   * @param token - Optional token controlling which ops are removed.
   * @returns `void` on full rollback; frozen array of removed ops on partial rollback.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  async rollback(
    token?: number | CanonicalKey | ICanonicalKeySegments | ITxOpPredicate,
  ): Promise<
    void | Readonly<[WebStorageBufferedOp | undefined]> | ReadonlyArray<WebStorageBufferedOp>
  > {
    this._assertOpen();

    if (token === undefined) {
      // ── Full rollback: restore Storage then release ─────────────────────
      this._settled = true;
      this._restoreSnapshot();
      this._ops.length = 0;
      this._onRollback(this.id);
      return;
    }

    // ── Partial rollback: remove matching ops, keep transaction open ───────
    return new Promise<
      Readonly<[WebStorageBufferedOp | undefined]> | ReadonlyArray<WebStorageBufferedOp>
    >((resolve) => {
      try {
        const indicesToRemove: number[] = [];

        if (typeof token === 'number') {
          if (token >= 0 && token < this._ops.length) {
            indicesToRemove.push(token);
          }
        } else if (typeof token === 'string') {
          for (let i = 0; i < this._ops.length; i++) {
            const op = this._ops[i];
            if ('key' in op && op.key === token) indicesToRemove.push(i);
          }
        } else if (typeof token === 'object' && token !== null && 'domain' in token) {
          const segments = token as ICanonicalKeySegments;
          if (segments.actualKey !== undefined) {
            this.rollback(
              buildCanonicalKey({
                actualKey: segments.actualKey,
                callingModule: segments.callingModule,
                domain: segments.domain,
                platform: segments.platform,
                platformVersion: segments.platformVersion,
              }),
            ).then((r) => resolve(r as ReadonlyArray<WebStorageBufferedOp>));
            return;
          }
          const prefix = buildModulePrefix(
            segments.domain,
            segments.platform,
            segments.platformVersion,
            segments.callingModule,
          );
          for (let i = 0; i < this._ops.length; i++) {
            const op = this._ops[i];
            if (!('key' in op) || op.key === undefined) continue;
            const parsed = parseCanonicalKey(op.key);
            if (!parsed) continue;
            if (
              buildModulePrefix(
                parsed.domain,
                parsed.platform,
                parsed.platformVersion,
                parsed.callingModule,
              ) === prefix
            )
              indicesToRemove.push(i);
          }
        } else if (typeof token === 'function') {
          for (let i = 0; i < this._ops.length; i++) {
            if (token(this._ops[i])) indicesToRemove.push(i);
          }
        }

        // Remove in reverse order to keep earlier indices valid during splice.
        const removed: WebStorageBufferedOp[] = [];
        for (let i = indicesToRemove.length - 1; i >= 0; i--) {
          removed.unshift(Object.freeze(this._ops.splice(indicesToRemove[i], 1)[0]));
        }

        // Prune snapshot entries for keys no longer referenced by any remaining op.
        this._pruneOrphanedSnapshots();

        resolve(Object.freeze(removed));
      } catch {
        resolve([]);
      }
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Apply the snapshot to the `Storage` object, restoring all touched keys to
   * their pre-transaction values. Called only during full rollback.
   *
   * This is a synchronous operation — `Storage` setItem/removeItem are both
   * synchronous, so the restore completes atomically within a single JS turn.
   */
  private _restoreSnapshot(): void {
    for (const [storageKey, priorValue] of this._snapshot) {
      try {
        if (priorValue !== null) {
          this._storage.setItem(storageKey, priorValue);
        } else {
          this._storage.removeItem(storageKey);
        }
      } catch {
        // Best-effort: if restore itself throws (e.g., quota exceeded after
        // partial commits from another tab), continue restoring remaining keys.
      }
    }
  }

  /**
   * Remove snapshot entries for storage keys that are no longer referenced by
   * any remaining buffered op. Called after a partial rollback to prevent the
   * snapshot from growing unboundedly with stale entries.
   *
   * A snapshot entry is retained if any remaining op references the same
   * canonical key (for write/delete ops) or could affect the same key (for
   * clear ops with a matching prefix). The check is conservative: any remaining
   * `clear` op without a prefix is treated as potentially affecting all keys.
   */
  private _pruneOrphanedSnapshots(): void {
    // Build the set of storage keys still in use by remaining ops.
    // We cannot map canonical keys back to storage keys here without the prefix —
    // so we only prune when there are no remaining clear ops (which could
    // affect any key). If any clear op remains, we keep all snapshot entries.
    const hasAnyRemainingClear = this._ops.some((op) => op.kind === 'clear');
    if (hasAnyRemainingClear) return;

    const stillUsed = new Set<string>();
    // The snapshot stores prefixed storage keys; we cannot reconstruct them
    // here without injecting the prefix. Instead, we identify snapshot keys
    // that appear in the key suffix of remaining write/delete ops by scanning
    // the snapshot map and checking if any remaining op references that key.
    // This is O(snapshot × ops) but both are small (bounded by entry count).
    for (const storageKey of this._snapshot.keys()) {
      for (const op of this._ops) {
        if (!('key' in op)) continue;
        // The storage key ends with the canonical key (preceded by the prefix).
        // We check via endsWith to avoid importing the prefix.
        if (storageKey.endsWith(op.key as string)) {
          stillUsed.add(storageKey);
          break;
        }
      }
    }

    for (const storageKey of [...this._snapshot.keys()]) {
      if (!stillUsed.has(storageKey)) {
        this._snapshot.delete(storageKey);
      }
    }
  }

  /**
   * Guard: throw if this transaction has already been settled.
   *
   * @throws {Error} With a descriptive message including the transaction ID.
   */
  private _assertOpen(): void {
    if (this._settled) {
      throw new Error(
        `[WebStorageTransaction:${this.id}] Transaction is already settled. ` +
          'Create a new transaction for further operations.',
      );
    }
  }
}
