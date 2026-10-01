import { v4 as uuidV4 } from 'uuid';

import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ITransaction,
  ITransactionOp,
  ITxOpPredicate,
  StorageEnvelope,
  TransactionStrength,
} from '../../storage.types';
import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '../../storage.util';

export interface BufferedOp<TRaw> extends ITransactionOp {
  envelope?: StorageEnvelope<TRaw>;
}

/**
 * ### MemoryTransaction
 * strength: best-effort
 *
 * Ops are buffered and applied to the store map atomically in JS (single
 * thread). "Rollback" means discarding the buffer - no actual undo needed
 * because nothing was written yet.
 */

export class MemoryTransaction<TRaw> implements ITransaction {
  readonly id: string;
  readonly strength: TransactionStrength = 'best-effort';

  private readonly _ops: BufferedOp<TRaw>[] = [];
  private _settled = false;

  get operations() {
    return this._ops as Readonly<typeof this._ops>; //Object.freeze(this._ops)
  }

  constructor(
    private readonly _onCommit: (txId: string, ops: BufferedOp<TRaw>[]) => void,
    private readonly _onRollback?: (txId: string) => void,
  ) {
    this.id = uuidV4();
  }

  // ── Internal: called by MemoryBackend to buffer ops ─────────────────────

  bufferWrite(key: CanonicalKey, envelope: StorageEnvelope<TRaw>) {
    this._assertOpen();
    this._ops.push({ kind: 'write', key, envelope });
  }

  bufferDelete(key: CanonicalKey) {
    this._assertOpen();
    this._ops.push({ kind: 'delete', key });
  }

  bufferClear(prefix?: string) {
    this._assertOpen();
    this._ops.push({ kind: 'clear', prefix });
  }

  // ── ITransaction ─────────────────────────────────────────────────────────

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
   * {@inheritdoc}
   */
  rollback(): Promise<void>;
  /**
   * {@inheritdoc}
   */
  rollback(index: number): Promise<Readonly<[BufferedOp<TRaw> | undefined]>>;
  /**
   * {@inheritdoc}
   */
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
  /**
   * {@inheritdoc}
   */
  rollback(segments: ICanonicalKeySegments): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
  /**
   * {@inheritdoc}
   */
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<BufferedOp<TRaw>>>;
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
