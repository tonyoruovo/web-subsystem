/**
 * @fileoverview OPFS compensating transaction implementation.
 *
 * ## Overview
 * {@link OPFSTransaction} implements the WAL-backed compensating transaction
 * model for the OPFS backend. It accumulates mutation ops in an in-memory
 * buffer and delegates the actual filesystem work to callbacks provided by
 * {@link OPFSBackend} at construction time.
 *
 * ## Transaction model
 * ```
 *  beginTransaction()
 *       |
 *      \/
 *  OPFSTransaction created (ops = [])
 *       |
 *  write/delete/clear called with transactionId
 *       |
 *      \/
 *  bufferWrite / bufferDelete / bufferClear
 *  -> ops[] grows; zero filesystem activity
 *       |
 *       +--- commit() -------------------------------------+
 *       |         |                                        |
 *       |        \/                                        |
 *       |    _onCommit(ops)                                |
 *       |         | (implemented by OPFSBackend)           |
 *       |        \/                                        |
 *       |    1. write _wal.json          <== crash here:   |
 *       |    2. apply ops to files            nothing applied, WAL replayed on next boot
 *       |    3. rewrite _manifest.json   <== crash here:   |
 *       |    4. clear _wal.json               WAL replayed, manifest rewritten
 *       |    5. delete tx from registry       WAL cleared = done
 *       |                                                  |
 *       +--- rollback() -----------------------------------+
 *                 |
 *                \/
 *            ops.length = 0     (discard buffer)
 *            _onRollback(id)    (remove from backend registry)
 *            <- zero filesystem activity
 * ```
 *
 * ## Strength: compensating
 * OPFS has no native multi-file transaction primitive. The WAL provides
 * crash recovery (any partial commit is completed on next boot) but does
 * **not** provide isolation: a concurrent reader in another tab can observe
 * an intermediate state while ops are being applied between steps 2 and 3.
 * For true isolation, use IndexedDB (`serializable` strength).
 *
 * ## Settled state
 * After either `commit()` or `rollback()`, the transaction is "settled".
 * Any further call to a buffer method or `commit()`/`rollback()` throws
 * immediately. Create a new transaction for subsequent work.
 */

import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '../../keys';
import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ITxOpPredicate,
  TransactionStrength,
} from '../../types';

import type { IOPFSTransaction, ManifestEntry, WALOp } from './opfs.types';

/**
 * @summary WAL-backed compensating transaction for {@link OPFSBackend}.
 *
 * @description
 * Obtain instances via {@link OPFSBackend.beginTransaction}, not directly.
 * The constructor callbacks tie this transaction to a specific backend instance.
 *
 * ## Overview
 * {@link OPFSTransaction} implements the WAL-backed compensating transaction
 * model for the OPFS backend. It accumulates mutation ops in an in-memory
 * buffer and delegates the actual filesystem work to callbacks provided by
 * {@link OPFSBackend} at construction time.
 *
 * ## Transaction model
 * ```txt
 *  beginTransaction()
 *       |
 *      \/
 *  OPFSTransaction created (ops = [])
 *       |
 *  write/delete/clear called with transactionId
 *       |
 *      \/
 *  bufferWrite / bufferDelete / bufferClear
 *  -> ops[] grows; zero filesystem activity
 *       |
 *       +--- commit() -------------------------------------+
 *       |         |                                        |
 *       |        \/                                        |
 *       |    _onCommit(ops)                                |
 *       |         | (implemented by OPFSBackend)           |
 *       |        \/                                        |
 *       |    1. write _wal.json          <== crash here:   |
 *       |    2. apply ops to files            nothing applied, WAL replayed on next boot
 *       |    3. rewrite _manifest.json   <== crash here:   |
 *       |    4. clear _wal.json               WAL replayed, manifest rewritten
 *       |    5. delete tx from registry       WAL cleared = done
 *       |                                                  |
 *       +--- rollback() -----------------------------------+
 *                 |
 *                \/
 *            ops.length = 0     (discard buffer)
 *            _onRollback(id)    (remove from backend registry)
 *            <- zero filesystem activity
 * ```
 *
 * ## Strength: compensating
 * OPFS has no native multi-file transaction primitive. The WAL provides
 * crash recovery (any partial commit is completed on next boot) but does
 * **not** provide isolation: a concurrent reader in another tab can observe
 * an intermediate state while ops are being applied between steps 2 and 3.
 * For true isolation, use IndexedDB (`serializable` strength).
 *
 * ## Settled state
 * After either `commit()` or `rollback()`, the transaction is "settled".
 * Any further call to a buffer method or `commit()`/`rollback()` throws
 * immediately. Create a new transaction for subsequent work.
 *
 * @example
 * ```ts
 * const tx = await backend.beginTransaction()
 *
 * await backend.write(keyA, envelopeA, { transactionId: tx.id })
 * await backend.write(keyB, envelopeB, { transactionId: tx.id })
 * await backend.delete(keyC,           { transactionId: tx.id })
 *
 * try {
 *   await tx.commit()    // WAL written -> ops applied -> manifest updated -> WAL cleared
 * } catch {
 *   await tx.rollback()  // buffer discarded, no filesystem changes
 * }
 * ```
 *
 * @see {@link IOPFSTransaction} for the full interface contract.
 */
export class OPFSTransaction implements IOPFSTransaction {
  /**
   * @summary The id of the transaction. Pass it as `transactionId`.
   */
  readonly id: string;
  /**
   * @summary Fixed at `'compensating'` - OPFS cannot offer serializable transactions.
   */
  readonly strength: Extract<TransactionStrength, 'compensating'> = 'compensating';

  /**
   * Accumulated op buffer.
   *
   * @description
   * Populated by the `buffer*` methods. Read by `_onCommit` to construct
   * the WAL and apply mutations. Discarded (set to length 0) on rollback.
   * Exposed as `readonly ops` on {@link IOPFSTransaction} for inspection;
   * external callers must not mutate this array.
   */
  private readonly _ops: WALOp[] = [];

  /**
   * Flag for open/close status
   */
  private _settled = false;

  /**
   * @summary The buffered operations, oldest first.
   * @returns The buffered operations, oldest first.
   */
  get operations() {
    return this._ops as Readonly<WALOp[]>;
  }

  /**
   * @summary Makes a `OPFSTransaction`.
   * @param _onCommit   - Provided by {@link OPFSBackend._commitTransaction}.
   *   Receives the full op buffer and owns all filesystem work: WAL write,
   *   op application, manifest rewrite, WAL clear.
   * @param _onRollback - Provided by {@link OPFSBackend}. Removes this
   *   transaction from the backend's active-transaction registry so it can
   *   be garbage collected.
   */
  constructor(
    private readonly _onCommit: (txId: string, ops: WALOp[]) => Promise<void>,
    private readonly _onRollback: (id: string) => void,
  ) {
    this.id = crypto.randomUUID();
  }

  // ── Buffer methods ────────────────────────────────────────────────────────
  // Called by OPFSBackend when a transactionId is present on a mutating call.
  // These are the only methods that add to ops[]; they touch no filesystem.

  /**
   * @summary Buffer a write op.
   * @param key        - Canonical key being written.
   * @param filePath   - OPFS-relative path for the data file.
   * @param payloadB64 - Base64-encoded encrypted payload bytes.
   * @param meta       - Manifest metadata for this entry.
   */
  bufferWrite(key: CanonicalKey, filePath: string, payloadB64: string, meta: ManifestEntry): void {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, filePath, payloadB64, meta });
  }

  /**
   * @summary Buffer a delete op.
   * @param key      - Canonical key to delete.
   * @param filePath - OPFS-relative path for the data file to remove.
   */
  bufferDelete(key: CanonicalKey, filePath: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'delete', key, filePath });
  }

  /**
   * @summary Buffer a clear op.
   * @param prefix - If supplied, only keys starting with this prefix are
   *   cleared. If omitted, the entire store is cleared on commit.
   */
  bufferClear(prefix?: string): void {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ──────────────────────────────────────────────────────────

  /**
   * @summary Commit all buffered ops to OPFS.
   * @description
   * Delegates entirely to `_onCommit`, which is implemented by
   * {@link OPFSBackend._commitTransaction}. See that method's documentation
   * for the exact commit sequence and crash-recovery guarantees.
   *
   * After this resolves, the transaction is settled and cannot be reused.
   *
   * @throws If any filesystem step fails. The WAL is preserved on disk for
   * crash recovery - {@link OPFSBackend.initialize} will replay it on the
   * next boot.
   */
  async commit(): Promise<void> {
    this._assertOpen();
    this._settled = true;
    await this._onCommit(this.id, this._ops);
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
  rollback(index: number): Promise<Readonly<[WALOp | undefined]>>;
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
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<WALOp>>;
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
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<WALOp>>;
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
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<WALOp>>;
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
  ): Promise<void | Readonly<[WALOp | undefined]> | ReadonlyArray<WALOp>> {
    this._assertOpen();
    // Not `!token`: index 0 is a partial rollback.
    if (token === undefined) {
      this._settled = true;
      this._ops.length = 0;
      this._onRollback(this.id);
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
        const removed: WALOp[] = [];
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

  /**
   * Assert the transaction has not yet been committed or rolled back.
   * @throws {Error} If the transaction is already settled.
   */
  private _assertOpen(): void {
    if (this._settled) {
      throw new Error(
        `[OPFSTransaction:${this.id}] Transaction is already settled. ` +
          'Create a new transaction for further operations.',
      );
    }
  }
}
