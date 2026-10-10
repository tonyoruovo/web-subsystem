/**
 * @fileoverview CacheStorage best-effort transaction implementation.
 *
 * ## Overview
 * This module provides `CacheTransaction`, the buffered transaction
 * implementation for the CacheStorage backend. It accumulates mutation ops
 * in an in-memory array and delegates the actual Cache API work to callbacks
 * provided by `CacheBackend` at construction time.
 *
 * ## Transaction model
 * ```txt
 *  beginTransaction()
 *       │
 *      ▼
 *  CacheTransaction created (ops = [])
 *       │
 *  write / delete / clear called with transactionId
 *       │
 *      ▼
 *  bufferWrite / bufferDelete / bufferClear
 *  -> ops[] grows; zero Cache API activity
 *       │
 *       ├─── commit() ──────────────────────────────────────────────────┐
 *       │         │                                                     │
 *       │        ▼                                                      │
 *       │    _onCommit(ops)                                             │
 *       │         │  (implemented by CacheBackend._applyCommit)         │
 *       │        ▼                                                      │
 *       │    for each op in ops:                                        │
 *       │      'write'  -> cache.put(syntheticURL, response)            │
 *       │      'delete' -> cache.delete(syntheticURL)                   │
 *       │      'clear'  -> iterate keys + cache.delete (prefix match)   │
 *       │    _transactions.delete(txId)                                 │
 *       │                                                               │
 *       └─── rollback() ─────────────────────────────────────────────── ┘
 *                 │
 *                ▼
 *            ops.length = 0     (discard buffer)
 *            _onRollback(id)    (remove from backend registry)
 *            <- zero Cache API activity
 * ```
 *
 * ## Strength: best-effort
 * Unlike the OPFS backend which uses a WAL to provide crash-safe compensating
 * transactions, the CacheStorage backend has no persistence-layer journaling
 * mechanism. Ops are applied to the live Cache bucket one-by-one inside
 * `_onCommit`. A crash mid-commit leaves the bucket in a partially applied
 * state with no automatic recovery on next boot. This is the honest definition
 * of `'best-effort'` transaction strength.
 *
 * ## Settled state
 * After either `commit()` or `rollback()` (no-arg), the transaction is
 * "settled". Any further call to a buffer method, `commit()`, or `rollback()`
 * throws immediately. Create a new transaction for subsequent work.
 * Partial-rollback overloads (by index, key, segments, or predicate) do
 * **not** settle the transaction — they remove specific ops from the buffer
 * while keeping the transaction open.
 */

import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '../../keys';
import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ITxOpPredicate,
  TransactionStrength,
} from '../../types';

import type { CacheBufferedOp, ICacheTransaction } from './cache.types';

/**
 * @summary WAL-less best-effort transaction for `CacheBackend`.
 *
 * @description
 * `CacheTransaction` implements `ICacheTransaction`, the buffered transaction
 * model for the CacheStorage backend. It accumulates mutation ops in an
 * in-memory array (`_ops`) and delegates actual Cache API work to two
 * callbacks supplied by `CacheBackend` at construction time:
 *
 * - `_onCommit(txId, ops)` — implemented by `CacheBackend._applyCommit`.
 *   Receives the full op buffer and applies each op sequentially to the live
 *   Cache bucket (writes, deletes, clears). No WAL or crash-recovery
 *   mechanism exists; if the process dies mid-commit, the cache bucket is
 *   left in a partially applied state.
 * - `_onRollback(txId)` — removes this transaction from the backend's active
 *   transaction registry so it can be garbage collected.
 *
 * **Strength: `'best-effort'`** — Atomicity holds only within the JS event
 * loop for ops that land synchronously (no concurrent writes can interleave
 * within a single microtask chain). There is no isolation from concurrent
 * readers in other tabs, and no durability guarantee beyond what the browser
 * provides to CacheStorage.
 *
 * **Partial rollback** — The overloaded `rollback(token)` signatures allow
 * selective removal of individual ops from the buffer without settling the
 * transaction. This is useful when a caller wants to discard a specific
 * buffered write while keeping the rest of the transaction open. See
 * `ITransaction.rollback` for the full contract.
 *
 * **Settled state** — After the no-arg `commit()` or no-arg `rollback()`, the
 * transaction is permanently settled. Subsequent calls throw immediately.
 * Partial rollbacks (with a token) do not settle the transaction.
 *
 * @example Basic commit/rollback pattern
 * ```ts
 * const tx = await backend.beginTransaction()
 *
 * await backend.write(keyA, envelopeA, { transactionId: tx.id })
 * await backend.write(keyB, envelopeB, { transactionId: tx.id })
 * await backend.delete(keyC,           { transactionId: tx.id })
 *
 * try {
 *   await tx.commit()    // ops applied sequentially to the Cache bucket
 * } catch {
 *   await tx.rollback()  // buffer discarded; no Cache API changes
 * }
 * ```
 *
 * @example Partial rollback — discard a specific buffered op
 * ```ts
 * const tx = await backend.beginTransaction()
 * await backend.write(keyA, envA, { transactionId: tx.id })
 * await backend.write(keyB, envB, { transactionId: tx.id })
 *
 * // Discard only the write for keyB before committing
 * await tx.rollback(keyB)
 * // Transaction is still open; keyA write is still buffered
 *
 * await tx.commit()  // Only keyA is written to the cache
 * ```
 *
 * @see {@link ICacheTransaction} for the full interface contract.
 * @see {@link CacheBackend} for the backend that creates and drives this class.
 */
export class CacheTransaction implements ICacheTransaction {
  /**
   * @summary The id of the transaction. Pass it as `transactionId`.
   */
  readonly id: string;

  /**
   * @summary Fixed at `'best-effort'` — CacheStorage provides no native transaction primitive and this implementation performs no WAL or crash recovery.
   * @inheritDoc
   */
  readonly strength: Extract<TransactionStrength, 'best-effort'> = 'best-effort';

  /**
   * Accumulated op buffer.
   *
   * Populated by the `buffer*` methods. Read by `_onCommit` to apply
   * mutations to the Cache API. Discarded (set to length 0) on full rollback.
   * Exposed as a readonly view via `operations`.
   */
  private readonly _ops: CacheBufferedOp[] = [];

  /** Tracks whether this transaction has been committed or fully rolled back. */
  private _settled = false;

  /**
   * @summary The buffered operations, oldest first.
   * @returns The buffered operations, oldest first.
   */
  get operations(): ReadonlyArray<CacheBufferedOp> {
    return this._ops;
  }

  /**
   * @summary Makes a `CacheTransaction`.
   * @param _onCommit
   *   Provided by `CacheBackend._applyCommit`. Receives the full op buffer
   *   and owns all Cache API work: `cache.put`, `cache.delete`, prefix
   *   scans for clears. Called only when the buffer is non-empty.
   *
   * @param _onRollback
   *   Provided by `CacheBackend`. Removes this transaction from the backend's
   *   `_transactions` registry so it can be garbage-collected.
   */
  constructor(
    private readonly _onCommit: (txId: string, ops: CacheBufferedOp[]) => Promise<void>,
    private readonly _onRollback: (txId: string) => void,
  ) {
    this.id = crypto.randomUUID();
  }

  // ── Buffer methods ────────────────────────────────────────────────────────
  // Called by CacheBackend when a transactionId is present on a mutating call.
  // None of these methods touch the Cache API.

  /**
   * @summary Buffer a write operation.
   *
   * @description
   * Appends a `write` op to the internal buffer. The `envelopeJson` argument
   * is the pre-serialized JSON string of the `StorageEnvelope<string>` that
   * the pipeline has already produced. Storing the serialized form here avoids
   * a redundant `JSON.stringify` call at commit time.
   *
   * No Cache API interaction occurs until `commit()` is called.
   *
   * @param key          - The canonical storage key being written.
   * @param envelopeJson - Pre-serialized `JSON.stringify(StorageEnvelope<string>)`.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferWrite(key: CanonicalKey, envelopeJson: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, envelopeJson });
  }

  /**
   * @summary Buffer a delete operation.
   *
   * @description
   * Appends a `delete` op to the internal buffer. No Cache API interaction
   * occurs until `commit()` is called.
   *
   * @param key - The canonical storage key to delete on commit.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferDelete(key: CanonicalKey): void {
    this._assertOpen();
    this._ops.push({ kind: 'delete', key });
  }

  /**
   * @summary Buffer a clear operation.
   *
   * @description
   * Appends a `clear` op to the internal buffer. On commit, if `prefix` is
   * provided, only cache entries whose canonical key begins with that string
   * are deleted. If `prefix` is omitted, the entire cache bucket is cleared.
   *
   * No Cache API interaction occurs until `commit()` is called.
   *
   * @param prefix - Optional key prefix. If absent, clears the entire bucket.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  bufferClear(prefix?: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ──────────────────────────────────────────────────────────

  /**
   * @summary Commit all buffered ops to the Cache bucket.
   *
   * @description
   * Marks the transaction as settled and delegates the full op buffer to
   * `_onCommit`, which is implemented by `CacheBackend._applyCommit`. Each
   * buffered op is applied sequentially to the live Cache API:
   *
   * - `write` → `cache.put(syntheticURL, new Response(envelopeJson))`
   * - `delete` → `cache.delete(syntheticURL)`
   * - `clear`  → iterate all cache keys, delete those matching the prefix
   *
   * After this resolves, the transaction is settled and cannot be reused.
   * If `_onCommit` throws, the transaction is still settled — the caller must
   * open a new transaction to retry.
   *
   * @throws {Error} If the transaction has already been settled.
   * @throws {Error} Re-throws any error from the Cache API during op application.
   */
  async commit(): Promise<void> {
    this._assertOpen();
    this._settled = true;
    await this._onCommit(this.id, this._ops);
  }

  // Overload signatures — kept for interface compliance with ITransaction.
  /**
   * @summary Drops all buffered operations and closes the transaction.
   * @example
   * Rolling back after a failure
   * ```ts
   * await tx.rollback();
   * ```
   * @returns {Promise<void>} Resolves when the transaction is closed.
   */
  rollback(): Promise<void>;
  /**
   * @summary Removes one buffered operation by its position. The transaction stays open.
   * @example
   * Removing the first operation
   * ```ts
   * const [removed] = await tx.rollback(0);
   * ```
   * @param {number} index The position of the operation, from 0.
   * @returns The removed operation, or `undefined` for a position that does not exist.
   */
  rollback(index: number): Promise<Readonly<[CacheBufferedOp | undefined]>>;
  /**
   * @summary Removes the buffered operations on one key. The transaction stays open.
   * @example
   * Cancelling the changes to one entry
   * ```ts
   * await tx.rollback(key);
   * ```
   * @param {CanonicalKey} canonicalKey The key.
   * @returns The removed operations.
   */
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<CacheBufferedOp>>;
  /**
   * @summary Removes the buffered operations under a key or a module prefix. The transaction stays open.
   * @example
   * Cancelling the changes of one module
   * ```ts
   * await tx.rollback({ ...segments, actualKey: '' });
   * ```
   * @param {ICanonicalKeySegments} segments The segments of the key or the prefix.
   * @returns The removed operations.
   */
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<CacheBufferedOp>>;
  /**
   * @summary Removes the buffered operations that match a predicate. The transaction stays open.
   * @example
   * Removing every delete
   * ```ts
   * await tx.rollback((op) => op.kind === 'delete');
   * ```
   * @param {ITxOpPredicate} predicate Returns `true` for an operation to remove.
   * @returns The removed operations.
   */
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<CacheBufferedOp>>;

  /**
   * @summary Roll back all (or a specified subset of) buffered ops.
   *
   * @description
   * When called with no argument, the transaction is permanently settled, the
   * op buffer is discarded, and `_onRollback` removes this transaction from
   * the backend's registry. Because no Cache API writes have occurred yet,
   * rollback requires no undo work.
   *
   * When called with a `token` (number index, canonical key string, key
   * segments object, or predicate function), only the matching ops are removed
   * from the buffer. The transaction remains open and can accept further
   * buffered ops or be committed. Partial rollbacks do **not** settle the
   * transaction.
   *
   * ### Token dispatch
   * - `number` — removes the op at that zero-based index; no-op if out of range.
   * - `CanonicalKey` (string) — removes all ops whose `key` field equals the
   *   argument.
   * - `ICanonicalKeySegments` (object with `domain` field) — if `actualKey` is
   *   set, delegates to the `CanonicalKey` overload; otherwise builds a module
   *   prefix via `buildModulePrefix` and removes all ops whose key starts with
   *   that prefix.
   * - `ITxOpPredicate` (function) — removes all ops for which the predicate
   *   returns truthy.
   *
   * Removed ops are returned in a frozen, readonly array. On any internal
   * error, the method resolves with an empty array rather than throwing.
   *
   * @param token - Optional token controlling which ops are removed.
   * @returns `void` on full rollback; frozen array of removed ops on partial rollback.
   *
   * @throws {Error} If the transaction has already been settled.
   */
  async rollback(
    token?: number | CanonicalKey | ICanonicalKeySegments | ITxOpPredicate,
  ): Promise<void | Readonly<[CacheBufferedOp | undefined]> | ReadonlyArray<CacheBufferedOp>> {
    this._assertOpen();

    if (token === undefined) {
      this._settled = true;
      this._ops.length = 0;
      this._onRollback(this.id);
      return;
    }

    return new Promise<Readonly<[CacheBufferedOp | undefined]> | ReadonlyArray<CacheBufferedOp>>(
      (resolve) => {
        try {
          const indicesToRemove: number[] = [];

          if (typeof token === 'number') {
            if (token >= 0 && token < this._ops.length) {
              indicesToRemove.push(token);
            }
          } else if (typeof token === 'string') {
            // CanonicalKey — match by exact key
            for (let i = 0; i < this._ops.length; i++) {
              const op = this._ops[i];
              if ('key' in op && op.key === token) indicesToRemove.push(i);
            }
          } else if (typeof token === 'object' && token !== null && 'domain' in token) {
            const segments = token as ICanonicalKeySegments;
            if (segments.actualKey !== undefined) {
              // Full segments with actualKey — build canonical key and delegate
              this.rollback(
                buildCanonicalKey({
                  actualKey: segments.actualKey,
                  callingModule: segments.callingModule,
                  domain: segments.domain,
                  platform: segments.platform,
                  platformVersion: segments.platformVersion,
                }),
              ).then((result) => resolve(result as ReadonlyArray<CacheBufferedOp>));
              return;
            }
            // Partial segments — build module prefix for bulk removal
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
              if (parsed === null) continue;
              if (
                buildModulePrefix(
                  parsed.domain,
                  parsed.platform,
                  parsed.platformVersion,
                  parsed.callingModule,
                ) === prefix
              ) {
                indicesToRemove.push(i);
              }
            }
          } else if (typeof token === 'function') {
            for (let i = 0; i < this._ops.length; i++) {
              if (token(this._ops[i])) indicesToRemove.push(i);
            }
          }

          // Remove in reverse order so earlier indices stay valid
          const removed: CacheBufferedOp[] = [];
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
   * @description
   * Guards every public method that must not be called after the transaction
   * has been committed or fully rolled back. Called as the first statement
   * inside each mutating method.
   *
   * @throws {Error} With a descriptive message containing the transaction ID
   *   if the transaction is already in the settled state.
   */
  private _assertOpen(): void {
    if (this._settled) {
      throw new Error(
        `[CacheTransaction:${this.id}] Transaction is already settled. ` +
          'Create a new transaction for further operations.',
      );
    }
  }
}
