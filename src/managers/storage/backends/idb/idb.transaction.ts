/**
 * @fileoverview IndexedDB serializable transaction implementation.
 *
 * ## Overview
 * `IDBTransaction` accumulates mutation ops in an in-memory buffer and, at
 * `commit()` time, replays them inside a **single native `IDBTransaction`** in
 * `'readwrite'` mode. IDB's own lock manager serializes concurrent transactions
 * and its storage engine guarantees atomicity and durability — this class adds
 * nothing beyond the buffering step required to map the subsystem's deferred
 * transaction model onto IDB's native one.
 *
 * ## Transaction model
 * ```txt
 *  beginTransaction()
 *       │
 *      ▼
 *  IDBTransaction created (ops = [])
 *       │
 *  backend.write / delete / clear called with transactionId
 *       │
 *      ▼
 *  bufferWrite / bufferDelete / bufferClear
 *  -> ops[] grows; zero IDB activity
 *       │
 *       ├── commit() ──────────────────────────────────────────────────────────┐
 *       │        │                                                             │
 *       │       ▼                                                              │
 *       │   _onCommit(txId, ops)                                               │
 *       │        │  (IDBBackend._applyCommit)                                  │
 *       │       ▼                                                              │
 *       │   Open one native IDBTransaction (readwrite)                         │
 *       │   for each op in ops:                                                │
 *       │     'write'  -> store.put(record)                                    │
 *       │     'delete' -> store.delete(key)                                    │
 *       │     'clear'  -> key cursor over store, delete matching prefix        │
 *       │   IDB auto-commits when the last request settles                     │
 *       │   _transactions.delete(txId)                                         │
 *       │                                                                      │
 *       └── rollback() ─────────────────────────────────────────────────────── ┘
 *                │
 *               ▼
 *           ops.length = 0   (discard buffer; no IDB ops were issued)
 *           _onRollback(txId)
 *           <- zero IDB activity; nothing to undo
 * ```
 *
 * ## Why no native IDBTransaction is kept open between ops
 * Native IDB transactions auto-commit as soon as their pending request queue
 * drains. Holding one open across multiple `await`-separated backend calls is
 * not possible: any `await` that doesn't immediately produce another IDB request
 * on the same transaction will cause the browser to commit it prematurely.
 *
 * Buffering ops in memory and replaying them inside a single transaction at
 * commit time is the standard pattern for building a deferred transaction model
 * on top of IDB's eager-commit model.
 *
 * ## Strength: serializable
 * IDB's `readwrite` transactions are serialized by the browser's lock manager —
 * no two `readwrite` transactions on the same object store can execute
 * concurrently. Buffered ops are applied atomically: either all succeed or IDB
 * rolls back the entire native transaction on error. This is `'serializable'`
 * in this subsystem's terminology.
 *
 * ## Settled state
 * After either `commit()` or no-arg `rollback()`, the transaction is permanently
 * settled. Subsequent calls to any method throw immediately. Partial-rollback
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

import type { IDBBufferedOp, IDBRecord, IIDBTransaction } from './idb.types';

/**
 * @summary Buffer-and-replay serializable transaction for `IDBBackend`.
 *
 * @description
 * `IDBTransaction` implements `IIDBTransaction`. It collects mutation ops in
 * `_ops` and, at commit time, delegates to `_onCommit` (implemented by
 * `IDBBackend._applyCommit`), which opens one native `IDBTransaction` in
 * `readwrite` mode and applies every op within it.
 *
 * Two callbacks inject the backend link without a direct import dependency:
 *
 * - `_onCommit(txId, ops)` — `IDBBackend._applyCommit`. Opens a native
 *   `readwrite` transaction, replays all buffered ops sequentially, and lets
 *   IDB commit automatically. Rejects if any IDB request fails; IDB then
 *   rolls back the entire native transaction atomically.
 * - `_onRollback(txId)` — Removes this transaction from the backend's active
 *   transaction registry.
 *
 * **Partial rollback**: the overloaded `rollback(token)` signatures remove
 * specific ops from the buffer without settling the transaction, keeping the
 * same API contract as `OPFSTransaction`, `CacheTransaction`, and
 * `WebStorageTransaction`. Since no IDB ops have been issued yet, partial
 * rollback is purely an in-memory buffer mutation.
 *
 * @example Standard commit / rollback
 * ```ts
 * const tx = await backend.beginTransaction()
 *
 * await backend.write(keyA, envelopeA, { transactionId: tx.id })
 * await backend.write(keyB, envelopeB, { transactionId: tx.id })
 * await backend.delete(keyC,           { transactionId: tx.id })
 *
 * try {
 *   await tx.commit()   // All three ops land in one native IDB transaction
 * } catch {
 *   await tx.rollback() // Buffer discarded; nothing was written to IDB
 * }
 * ```
 *
 * @example Partial rollback — cancel one op, commit the rest
 * ```ts
 * const tx = await backend.beginTransaction()
 * await backend.write(keyA, envA, { transactionId: tx.id })
 * await backend.write(keyB, envB, { transactionId: tx.id })
 *
 * await tx.rollback(keyB)  // remove keyB write; tx stays open
 * await tx.commit()        // only keyA is written
 * ```
 *
 * @see {@link IIDBTransaction} for the full interface contract.
 * @see {@link IDBBackend} for the backend that creates and drives this class.
 */
export class IDBTransaction implements IIDBTransaction {
  /** @inheritdoc */
  readonly id: string;

  /**
   * Always `'serializable'` — ops are applied inside a native IDB
   * `readwrite` transaction at commit time.
   * @inheritdoc
   */
  readonly strength: Extract<TransactionStrength, 'serializable'> = 'serializable';

  /**
   * Accumulated op buffer. Populated by `buffer*` methods; read by
   * `_onCommit` at commit time. Cleared on full rollback.
   */
  private readonly _ops: IDBBufferedOp[] = [];

  /** Whether this transaction has been committed or fully rolled back. */
  private _settled = false;

  /** @inheritdoc */
  get operations(): ReadonlyArray<IDBBufferedOp> {
    return this._ops;
  }

  /**
   * @param _onCommit
   *   Provided by `IDBBackend._applyCommit`. Receives the full op buffer,
   *   opens one native `IDBTransaction(readwrite)`, applies every op, and
   *   lets IDB auto-commit. Called only when `_ops.length > 0`.
   *
   * @param _onRollback
   *   Provided by `IDBBackend`. Removes this transaction from the backend's
   *   `_transactions` registry after full rollback so it can be GC'd.
   */
  constructor(
    private readonly _onCommit: (txId: string, ops: IDBBufferedOp[]) => Promise<void>,
    private readonly _onRollback: (txId: string) => void,
  ) {
    this.id = uuidV4();
  }

  // ── Buffer methods ────────────────────────────────────────────────────────

  /**
   * @summary Buffer a write op.
   *
   * @description
   * Appends a `write` op. `record` is the pre-built `IDBRecord` that will be
   * passed verbatim to `store.put(record)` at commit time. Building the record
   * here avoids re-assembling it from the envelope at commit time.
   *
   * @param key    - The canonical key (must equal `record.key`).
   * @param record - The complete `IDBRecord` to store.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferWrite(key: CanonicalKey, record: IDBRecord): void {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, record });
  }

  /**
   * @summary Buffer a delete op.
   *
   * @description
   * Appends a `delete` op. At commit time, `store.delete(key)` is called.
   * If the key does not exist in IDB, the delete request succeeds silently —
   * idempotent by the IDB spec.
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
   * Appends a `clear` op. At commit time, if `prefix` is provided a key
   * cursor scans the object store and calls `cursor.delete()` for every
   * record whose key starts with `prefix`. If `prefix` is absent,
   * `store.clear()` is called to wipe the entire object store.
   *
   * @param prefix - Optional key prefix. Absent = clear entire store.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferClear(prefix?: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ──────────────────────────────────────────────────────────

  /**
   * @summary Commit all buffered ops inside one native IDB readwrite transaction.
   *
   * @description
   * Marks the transaction as settled and delegates the op buffer to
   * `_onCommit`, which is implemented by `IDBBackend._applyCommit`. All ops
   * execute within a single native `IDBTransaction(readwrite)`. IDB commits
   * the transaction automatically when the last request settles with no error.
   *
   * If any IDB request fails (e.g., a `ConstraintError` or a `TransactionInactiveError`),
   * IDB rolls back the entire native transaction atomically — no partial writes
   * survive a failed commit.
   *
   * After this resolves, the transaction is settled and cannot be reused.
   *
   * @throws {Error} If the transaction has already been settled.
   * @throws {DOMException} Re-throws any IDB error from `_onCommit`.
   */
  async commit(): Promise<void> {
    this._assertOpen();
    this._settled = true;
    await this._onCommit(this.id, this._ops);
  }

  // Overload signatures — kept for ITransaction interface compliance.
  rollback(): Promise<void>;
  rollback(index: number): Promise<Readonly<[IDBBufferedOp | undefined]>>;
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<IDBBufferedOp>>;
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<IDBBufferedOp>>;
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<IDBBufferedOp>>;

  /**
   * @summary Roll back all (or a specified subset of) buffered ops.
   *
   * @description
   * **Full rollback (no argument):** The transaction is permanently settled,
   * the op buffer is discarded, and `_onRollback` removes this transaction
   * from the backend registry. Because no IDB ops have been issued yet (all
   * ops are buffered until `commit()`), rollback requires no IDB interaction
   * whatsoever — it is a pure in-memory discard.
   *
   * **Partial rollback (with token):** Only the matching ops are removed from
   * the buffer. The transaction remains open for further ops or commit. Since
   * nothing has been written to IDB, no undo is needed — partial rollback is
   * also a pure buffer mutation.
   *
   * ### Token dispatch
   * - `number` — removes the op at that zero-based index.
   * - `CanonicalKey` (string) — removes all ops whose `key` equals the argument.
   * - `ICanonicalKeySegments` — if `actualKey` is set, delegates to the key
   *   overload; otherwise builds a module prefix and removes all ops whose key
   *   starts with it.
   * - `ITxOpPredicate` (function) — removes all ops for which the predicate
   *   returns truthy.
   *
   * Removed ops are returned frozen. On any internal error, resolves with `[]`.
   *
   * @param token - Optional token controlling which ops are removed.
   * @returns `void` on full rollback; frozen array of removed ops on partial.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  async rollback(
    token?: number | CanonicalKey | ICanonicalKeySegments | ITxOpPredicate,
  ): Promise<void | Readonly<[IDBBufferedOp | undefined]> | ReadonlyArray<IDBBufferedOp>> {
    this._assertOpen();

    if (token === undefined) {
      this._settled = true;
      this._ops.length = 0;
      this._onRollback(this.id);
      return;
    }

    return new Promise<Readonly<[IDBBufferedOp | undefined]> | ReadonlyArray<IDBBufferedOp>>(
      (resolve) => {
        try {
          const indicesToRemove: number[] = [];

          if (typeof token === 'number') {
            if (token >= 0 && token < this._ops.length) indicesToRemove.push(token);
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
              ).then((r) => resolve(r as ReadonlyArray<IDBBufferedOp>));
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
              if (!('key' in op) || !op.key) continue;
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

          // Remove in reverse order so earlier indices remain valid during splice.
          const removed: IDBBufferedOp[] = [];
          for (let i = indicesToRemove.length - 1; i >= 0; i--) {
            removed.unshift(Object.freeze(this._ops.splice(indicesToRemove[i], 1)[0]));
          }

          // An index always yields a one-element tuple (ITransaction contract).
          resolve(Object.freeze(typeof token === 'number' ? [removed[0]] : removed));
        } catch {
          resolve([]);
        }
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @summary Assert that this transaction has not yet been settled.
   *
   * @throws {Error} With a descriptive message including the transaction ID
   *   if the transaction is already in the settled state.
   */
  private _assertOpen(): void {
    if (this._settled) {
      throw new Error(
        `[IDBTransaction:${this.id}] Transaction is already settled. ` +
          'Create a new transaction for further operations.',
      );
    }
  }
}
