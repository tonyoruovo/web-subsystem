/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for all three transaction implementations.
 * Covers: MemoryTransaction, CacheTransaction, OPFSTransaction
 *
 * All three share the same ITransaction contract (commit, 5x overloaded rollback,
 * settled-state guard). This file tests the common contract and backend-specific
 * buffer methods.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalKey,
  ICanonicalKeySegments,
  ManifestEntry,
  StorageEnvelope,
  WALWriteOp,
} from '../src';
import { CacheTransaction, MemoryTransaction, OPFSTransaction } from '../src';

// ───────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ───────────────────────────────────────────────────────────────────────────

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh-token' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;

function makeEnvelope(
  payload = 'enc-1',
  overrides: Partial<StorageEnvelope<string>> = {},
): StorageEnvelope<string> {
  return {
    payload,
    schema_version: 1,
    written_at: Date.now(),
    expires_at: null,
    weight: 1,
    backend: 'cache',
    ...overrides,
  };
}

const OPFS_META: ManifestEntry = {
  schema_version: 1,
  written_at: Date.now(),
  expires_at: null,
  weight: 1,
  backend: 'opfs',
  filePath: 'myapp/chrome/130/auth/session',
  byteLength: 6,
};

const SEGMENTS: ICanonicalKeySegments = {
  domain: 'myapp',
  platform: 'chrome',
  platformVersion: 130,
  callingModule: 'auth',
  actualKey: 'session',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY TRANSACTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('MemoryTransaction', () => {
  let onCommit: ReturnType<typeof vi.fn>;
  let onRollback: ReturnType<typeof vi.fn>;
  let tx: MemoryTransaction<unknown>;

  beforeEach(() => {
    onCommit = vi.fn();
    onRollback = vi.fn();
    tx = new MemoryTransaction<unknown>(new Map(), onCommit as never, onRollback as never);
  });

  it('has a UUID id and strength "best-effort"', () => {
    expect(tx.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tx.strength).toBe('best-effort');
  });

  // ── Buffer methods ───────────────────────────────────────────────────

  describe('buffer methods', () => {
    it('bufferWrite appends a write op', () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].kind).toBe('write');
      expect(tx.operations[0].key).toBe(KEY_A);
    });

    it('bufferDelete appends a delete op', () => {
      tx.bufferDelete(KEY_A);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].kind).toBe('delete');
    });

    it('bufferClear appends a clear op', () => {
      tx.bufferClear('myapp:chrome:130:');
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].kind).toBe('clear');
      expect((tx.operations[0] as any).prefix).toBe('myapp:chrome:130:');
    });

    it('bufferClear without prefix stores undefined prefix', () => {
      tx.bufferClear();
      expect((tx.operations[0] as any).prefix).toBeUndefined();
    });

    it('all buffer methods throw after settle', async () => {
      await tx.commit();
      expect(() => tx.bufferWrite(KEY_A, makeEnvelope())).toThrow('already settled');
      expect(() => tx.bufferDelete(KEY_A)).toThrow('already settled');
      expect(() => tx.bufferClear()).toThrow('already settled');
    });
  });

  // ── Commit ───────────────────────────────────────────────────────────

  describe('commit', () => {
    it('calls _onCommit with txId and ops', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      tx.bufferDelete(KEY_B);
      await tx.commit();
      expect(onCommit).toHaveBeenCalledWith(tx.id, tx.operations);
    });

    it('throws on second commit', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow('already settled');
    });

    it('commit() callback error triggers rollback', async () => {
      onCommit.mockImplementation(() => {
        throw new Error('boom');
      });
      tx.bufferWrite(KEY_A, makeEnvelope());
      await expect(tx.commit()).rejects.toThrow();
      expect(onRollback).toHaveBeenCalledWith(tx.id);
    });
  });

  // ── Full rollback (no args) ───────────────────────────────────────────

  describe('rollback()', () => {
    it('discards all ops and calls _onRollback', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      tx.bufferDelete(KEY_B);
      await tx.rollback();
      expect(tx.operations).toHaveLength(0);
      expect(onRollback).toHaveBeenCalledWith(tx.id);
    });

    it('settles the transaction', async () => {
      await tx.rollback();
      await expect(tx.commit()).rejects.toThrow('already settled');
      expect(() => tx.bufferWrite(KEY_A, makeEnvelope())).toThrow('already settled');
    });
  });

  // ── Partial rollback by index ────────────────────────────────────────

  describe('rollback(index)', () => {
    it('removes the op at the given index', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope('a'));
      tx.bufferWrite(KEY_B, makeEnvelope('b'));
      tx.bufferDelete(KEY_C);
      const removed = await tx.rollback(1);
      expect(removed).toEqual([expect.objectContaining({ kind: 'write', key: KEY_B })]);
      expect(tx.operations).toHaveLength(2);
      expect(tx.operations[1].key).toBe(KEY_C);
    });

    it('returns [undefined] for out-of-bounds index', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      const removed = await tx.rollback(99);
      expect(removed).toEqual([undefined]);
    });

    it('keeps transaction open', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      await tx.rollback(0);
      expect(tx.operations).toHaveLength(0);
      // Should still be able to buffer
      tx.bufferWrite(KEY_B, makeEnvelope());
      expect(tx.operations).toHaveLength(1);
    });

    it('negative index is ignored', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      const removed = await tx.rollback(-1);
      expect(removed).toEqual([undefined]);
      expect(tx.operations).toHaveLength(1);
    });
  });

  // ── Partial rollback by canonical key ────────────────────────────────

  describe('rollback(canonicalKey)', () => {
    it('removes all ops matching the key', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope('a1'));
      tx.bufferWrite(KEY_A, makeEnvelope('a2'));
      tx.bufferWrite(KEY_B, makeEnvelope('b'));
      const removed = await tx.rollback(KEY_A);
      expect(removed).toHaveLength(2);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].key).toBe(KEY_B);
    });

    it('returns empty array when no match', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      const removed = await tx.rollback(KEY_C);
      expect(removed).toHaveLength(0);
    });
  });

  // ── Partial rollback by ICanonicalKeySegments ────────────────────────

  describe('rollback(ICanonicalKeySegments)', () => {
    it('with actualKey: removes matching full key', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      tx.bufferWrite(KEY_B, makeEnvelope());
      const removed = await tx.rollback(SEGMENTS);
      expect(removed).toHaveLength(1);
      expect(removed[0].key).toBe(KEY_A);
    });

    it('without actualKey: removes by prefix', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      tx.bufferWrite(KEY_B, makeEnvelope());
      tx.bufferWrite(KEY_C, makeEnvelope());
      const removed = await tx.rollback({ ...SEGMENTS, actualKey: undefined as never });
      expect(removed).toHaveLength(2); // KEY_A and KEY_B match auth module
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].key).toBe(KEY_C);
    });
  });

  // ── Partial rollback by predicate ────────────────────────────────────

  describe('rollback(predicate)', () => {
    it('removes ops matching the predicate', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      tx.bufferDelete(KEY_B);
      tx.bufferClear('myapp:');
      const removed = await tx.rollback((op) => op.kind === 'delete' || op.kind === 'clear');
      expect(removed).toHaveLength(2);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].kind).toBe('write');
    });

    it('returns empty array when nothing matches', async () => {
      tx.bufferWrite(KEY_A, makeEnvelope());
      const removed = await tx.rollback((op) => op.kind === 'clear');
      expect(removed).toHaveLength(0);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CACHE TRANSACTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('CacheTransaction', () => {
  let onCommit: ReturnType<typeof vi.fn>;
  let onRollback: ReturnType<typeof vi.fn>;
  let tx: CacheTransaction;

  beforeEach(() => {
    onCommit = vi.fn().mockResolvedValue(undefined);
    onRollback = vi.fn();
    tx = new CacheTransaction(onCommit as any, onRollback as any);
  });

  it('has a UUID id and strength "best-effort"', () => {
    expect(tx.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tx.strength).toBe('best-effort');
  });

  describe('buffer methods', () => {
    it('bufferWrite stores a JSON envelope string', () => {
      const json = '{"payload":"x"}';
      tx.bufferWrite(KEY_A, json);
      expect(tx.operations).toHaveLength(1);
      expect((tx.operations[0] as any).envelopeJson).toBe(json);
    });

    it('bufferDelete stores key only', () => {
      tx.bufferDelete(KEY_A);
      expect((tx.operations[0] as any).key).toBe(KEY_A);
    });

    it('bufferClear stores prefix', () => {
      tx.bufferClear('myapp:chrome:');
      expect((tx.operations[0] as any).prefix).toBe('myapp:chrome:');
    });

    it('throws after settle', async () => {
      await tx.rollback();
      expect(() => tx.bufferWrite(KEY_A, '{}')).toThrow('already settled');
    });
  });

  describe('commit', () => {
    it('invokes _onCommit then transaction is settled', async () => {
      tx.bufferWrite(KEY_A, '{}');
      await tx.commit();
      expect(onCommit).toHaveBeenCalledWith(tx.id, expect.any(Array));
      await expect(tx.rollback()).rejects.toThrow('already settled');
    });
  });

  describe('rollback', () => {
    it('full rollback discards and deregisters', async () => {
      tx.bufferWrite(KEY_A, '{}');
      tx.bufferDelete(KEY_B);
      await tx.rollback();
      expect(tx.operations).toHaveLength(0);
      expect(onRollback).toHaveBeenCalledWith(tx.id);
    });

    it('partial rollback by key', async () => {
      tx.bufferWrite(KEY_A, '{}');
      tx.bufferWrite(KEY_B, '{}');
      const removed = await tx.rollback(KEY_A);
      expect(removed).toHaveLength(1);
      expect(tx.operations).toHaveLength(1);
      // Transaction is still open
      tx.bufferDelete(KEY_C);
      expect(tx.operations).toHaveLength(2);
    });

    it('partial rollback by segments without actualKey', async () => {
      tx.bufferWrite(KEY_A, '{}');
      tx.bufferWrite(KEY_C, '{}');
      const removed = await tx.rollback({ ...SEGMENTS, actualKey: undefined as never });
      // KEY_A is in auth module, KEY_C is in prefs module
      expect(removed).toHaveLength(1);
      expect(removed[0].key).toBe(KEY_A);
    });

    it('partial rollback by predicate', async () => {
      tx.bufferWrite(KEY_A, '{}');
      tx.bufferDelete(KEY_B);
      tx.bufferClear();
      const removed = await tx.rollback((op) => op.kind === 'write');
      expect(removed).toHaveLength(1);
      expect(tx.operations).toHaveLength(2);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OPFS TRANSACTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('OPFSTransaction', () => {
  let onCommit: ReturnType<typeof vi.fn>;
  let onRollback: ReturnType<typeof vi.fn>;
  let tx: OPFSTransaction;

  beforeEach(() => {
    onCommit = vi.fn().mockResolvedValue(undefined);
    onRollback = vi.fn();
    tx = new OPFSTransaction(onCommit as any, onRollback as any);
  });

  it('has a UUID id and strength "compensating"', () => {
    expect(tx.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tx.strength).toBe('compensating');
  });

  describe('buffer methods', () => {
    it('bufferWrite stores WAL op with b64 payload and meta', () => {
      tx.bufferWrite(KEY_A, 'myapp/chrome/130/auth/session', 'aGVsbG8=', OPFS_META);
      const op = tx.operations[0] as WALWriteOp;
      expect(op.kind).toBe('write');
      expect(op.key).toBe(KEY_A);
      expect(op.filePath).toBe('myapp/chrome/130/auth/session');
      expect(op.payloadB64).toBe('aGVsbG8=');
      expect(op.meta).toEqual(OPFS_META);
    });

    it('bufferDelete stores WAL op with filePath', () => {
      tx.bufferDelete(KEY_A, 'myapp/chrome/130/auth/session');
      const op = tx.operations[0] as any;
      expect(op.kind).toBe('delete');
      expect(op.filePath).toBe('myapp/chrome/130/auth/session');
    });

    it('bufferClear stores WAL op', () => {
      tx.bufferClear('myapp:chrome:130:');
      const op = tx.operations[0] as any;
      expect(op.kind).toBe('clear');
      expect(op.prefix).toBe('myapp:chrome:130:');
    });

    it('throws after settle', async () => {
      await tx.rollback();
      expect(() => tx.bufferWrite(KEY_A, '', '', OPFS_META)).toThrow('already settled');
      expect(() => tx.bufferDelete(KEY_A, '')).toThrow('already settled');
      expect(() => tx.bufferClear()).toThrow('already settled');
    });
  });

  describe('commit', () => {
    it('invokes _onCommit with all buffered ops', async () => {
      tx.bufferWrite(KEY_A, 'path/a', 'b64', OPFS_META);
      tx.bufferDelete(KEY_B, 'path/b');
      await tx.commit();
      expect(onCommit).toHaveBeenCalledWith(
        tx.id,
        expect.arrayContaining([
          expect.objectContaining({ kind: 'write', key: KEY_A }),
          expect.objectContaining({ kind: 'delete', key: KEY_B }),
        ]),
      );
    });

    it('throws on second commit', async () => {
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow('already settled');
    });
  });

  describe('rollback', () => {
    it('full rollback discards buffer and deregisters', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferDelete(KEY_B, 'p');
      await tx.rollback();
      expect(tx.operations).toHaveLength(0);
      expect(onRollback).toHaveBeenCalledWith(tx.id);
    });

    it('partial rollback by index', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferDelete(KEY_B, 'p');
      const removed = await tx.rollback(0);
      expect(removed).toHaveLength(1);
      expect((removed[0] as any).kind).toBe('write');
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].kind).toBe('delete');
    });

    it('partial rollback by canonical key', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferWrite(KEY_B, 'p', 'b64', OPFS_META);
      const removed = await tx.rollback(KEY_A);
      expect(removed).toHaveLength(1);
      expect(tx.operations).toHaveLength(1);
    });

    it('partial rollback by segments (with actualKey)', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferWrite(KEY_B, 'p', 'b64', OPFS_META);
      const removed = await tx.rollback(SEGMENTS);
      expect(removed).toHaveLength(1);
      expect(tx.operations).toHaveLength(1);
    });

    it('partial rollback by segments (prefix)', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferWrite(KEY_B, 'p', 'b64', OPFS_META);
      tx.bufferWrite(KEY_C, 'p', 'b64', OPFS_META);
      const removed = await tx.rollback({ ...SEGMENTS, actualKey: undefined as never });
      expect(removed).toHaveLength(2);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].key).toBe(KEY_C);
    });

    it('partial rollback by predicate', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      tx.bufferDelete(KEY_B, 'p');
      tx.bufferClear();
      const removed = await tx.rollback((op) => op.kind === 'delete');
      expect(removed).toHaveLength(1);
      expect(tx.operations).toHaveLength(2);
    });

    it('keeps transaction open after partial rollback', async () => {
      tx.bufferWrite(KEY_A, 'p', 'b64', OPFS_META);
      await tx.rollback(0);
      expect(tx.operations).toHaveLength(0);
      // Should be able to continue buffering
      tx.bufferWrite(KEY_B, 'p', 'b64', OPFS_META);
      expect(tx.operations).toHaveLength(1);
      await tx.commit(); // Should succeed
      expect(onCommit).toHaveBeenCalled();
    });
  });
});
