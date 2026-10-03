import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '../../keys';
import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ITransaction,
  ITransactionOp,
  ITxOpPredicate,
  StorageEnvelope,
  TransactionStrength,
} from '../../types';

/**
 * @summary A buffered operation of a {@linkcode MemoryTransaction}.
 * @example
 * Example 1: A buffered write
 * ```ts
 * // { kind: 'write', key: 'shop:browser:1:cart:items', envelope: { payload: [], ... } }
 * ```
 * @example
 * Example 2: A buffered delete
 * ```ts
 * // { kind: 'delete', key: 'shop:browser:1:cart:items' }
 * ```
 * @template TRaw The type of the payload.
 * @public
 */
export interface BufferedOp<TRaw> extends ITransactionOp {
  /**
   * @summary The envelope of a write.
   */
  envelope?: StorageEnvelope<TRaw>;
}

/**
 * @summary A `best-effort` transaction of the memory backend.
 *
 * @description
 * Operations go to a buffer. The commit applies them to the store in one
 * step, which is atomic because JavaScript runs on one thread. A rollback
 * drops the buffer: nothing was written, so nothing must be undone.
 *
 * @example
 * Example 1: Commit
 * ```ts
 * const tx = await backend.beginTransaction();
 * await backend.write(key, envelope, { transactionId: tx.id });
 * await tx.commit();
 * ```
 *
 * @example
 * Example 2: Roll back one key
 * ```ts
 * await tx.rollback(key);
 * await tx.commit(); // the other operations apply
 * ```
 *
 * @template TRaw The type of the payload.
 * @public
 */
export class MemoryTransaction<TRaw> implements ITransaction {
  /**
   * @summary The id of the transaction. Pass it as `transactionId`.
   */
  readonly id: string;
  /**
   * @summary The atomicity of the transaction.
   */
  readonly strength: TransactionStrength = 'best-effort';

  private readonly _ops: BufferedOp<TRaw>[] = [];
  private _settled = false;

  /**
   * @summary The buffered operations, oldest first.
   * @returns The buffered operations, oldest first.
   */
  get operations() {
    return this._ops as Readonly<typeof this._ops>; //Object.freeze(this._ops)
  }

  /**
   * @summary Makes a `MemoryTransaction`. {@linkcode MemoryBackend.beginTransaction} calls it.
   * @param _onCommit Applies the buffered operations to the store.
   * @param _onRollback Removes the transaction from the open transactions of the backend.
   */
  constructor(
    private readonly _onCommit: (txId: string, ops: BufferedOp<TRaw>[]) => void,
    private readonly _onRollback?: (txId: string) => void,
  ) {
    this.id = crypto.randomUUID();
  }

  // ── Internal: called by MemoryBackend to buffer ops ─────────────────────

  /**
   * @summary Buffers a write. The backend calls it for a write with this `transactionId`.
   * @example
   * Buffering
   * ```ts
   * tx.bufferWrite(key, envelope);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {StorageEnvelope<TRaw>} envelope The envelope.
   * @returns {void}
   * @throws {Error} When the transaction is settled.
   */
  bufferWrite(key: CanonicalKey, envelope: StorageEnvelope<TRaw>) {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, envelope });
  }

  /**
   * @summary Buffers a delete. The backend calls it for a delete with this `transactionId`.
   * @example
   * Buffering
   * ```ts
   * tx.bufferDelete(key);
   * ```
   * @param {CanonicalKey} key The key.
   * @returns {void}
   * @throws {Error} When the transaction is settled.
   */
  bufferDelete(key: CanonicalKey) {
    this._assertOpen();
    this._ops.push({ kind: 'delete', key });
  }

  /**
   * @summary Buffers a clear. The backend calls it for a clear with this `transactionId`.
   * @example
   * Buffering
   * ```ts
   * tx.bufferClear('shop:browser:1:cart:');
   * ```
   * @param {string} [prefix] The prefix. Without it, the commit empties the store.
   * @returns {void}
   * @throws {Error} When the transaction is settled.
   */
  bufferClear(prefix?: string) {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ─────────────────────────────────────────────────────────

  /**
   * @summary Applies all buffered operations and closes the transaction.
   * @example
   * Committing
   * ```ts
   * await tx.commit();
   * ```
   * @returns {Promise<void>} Resolves when the operations are applied.
   * @throws {Error} When the transaction is settled.
   * @throws {ReferenceError} When an operation throws. The buffer is dropped.
   */
  async commit(): Promise<void> {
    this._assertOpen();
    this._settled = true;
    try {
      this._onCommit(this.id, this._ops);
    } catch (cause) {
      // Already settled, so discard directly: rollback() would throw "already settled".
      this._discard();
      throw new ReferenceError(`An op threw. Rollback was applied: ${cause}`, { cause });
    }
  }

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
  rollback(index: number): Promise<Readonly<[BufferedOp<TRaw> | undefined]>>;
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
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
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
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
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
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
  /**
   * @summary Rolls back all buffered operations, or removes some of them. See the overloads.
   * @example
   * Every form
   * ```ts
   * await tx.rollback(0); // await tx.rollback(key); await tx.rollback(segments); await tx.rollback(fn);
   * ```
   * @param token Nothing, a position, a key, key segments or a predicate.
   * @returns Nothing for a full rollback, else the removed operations.
   * @throws {Error} When the transaction is settled.
   */
  async rollback(
    token?: number | CanonicalKey | ICanonicalKeySegments | ITxOpPredicate,
  ): Promise<void | Readonly<[BufferedOp<TRaw> | undefined]> | ReadonlyArray<BufferedOp<TRaw>>> {
    this._assertOpen();
    if (token === undefined) {
      this._settled = true;
      this._discard();
      return;
    }

    return await new Promise((resolve) => {
      try {
        // Partial rollback: remove matching ops, keep transaction open
        const indicesToRemove: number[] = [];

        if (typeof token === 'number') {
          if (token >= 0 && token < this._ops.length) {
            indicesToRemove.push(token);
          }
        } else if (typeof token === 'string') {
          // Canonical key
          for (let i = 0; i < this._ops.length; i++) {
            if (this._ops[i].key === token) {
              indicesToRemove.push(i);
            }
          }
        } else if (typeof token === 'object' && token !== null && 'domain' in token) {
          const { actualKey, callingModule, domain, platform, platformVersion } =
            token as ICanonicalKeySegments;
          if (actualKey !== undefined) {
            // ICanonicalKeySegments – build the key
            this.rollback(
              buildCanonicalKey({
                actualKey,
                callingModule,
                domain,
                platform,
                platformVersion,
              }),
            ).then((result) => resolve(result));
            return;
          }
          // ICanonicalKeySegments – build the prefix
          const prefix = buildModulePrefix(domain, platform, platformVersion, callingModule);
          for (let i = 0; i < this._ops.length; i++) {
            const { key: opsKey } = this._ops[i];
            if (opsKey === undefined) continue;
            const opsKeySegment = parseCanonicalKey(opsKey);
            if (opsKeySegment === undefined || opsKeySegment === null) continue;
            if (
              buildModulePrefix(
                opsKeySegment.domain,
                opsKeySegment.platform,
                opsKeySegment.platformVersion,
                opsKeySegment.callingModule,
              ) === prefix
            ) {
              indicesToRemove.push(i);
            }
          }
        } else if (typeof token === 'function') {
          for (let i = 0; i < this._ops.length; i++) {
            if (token(this._ops[i])) {
              indicesToRemove.push(i);
            }
          }
        }

        // Remove in reverse order so earlier indices stay valid during splice.
        const removed: BufferedOp<TRaw>[] = [];
        for (let i = indicesToRemove.length - 1; i >= 0; i--) {
          removed.unshift(Object.freeze(this._ops.splice(indicesToRemove[i], 1)[0]));
        }

        // An index always yields a one-element tuple (ITransaction contract).
        resolve(Object.freeze(typeof token === 'number' ? [removed[0]] : removed));
      } catch {
        // reject(error); // Do not throw an error
        resolve([]);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** Discards the buffer and deregisters. Nothing was written, so no undo is needed. */
  private _discard() {
    this._ops.length = 0;
    this._onRollback?.(this.id);
  }

  private _assertOpen() {
    if (this._settled) {
      throw new Error(`[MemoryTransaction:${this.id}] Transaction already settled.`);
    }
  }
}
