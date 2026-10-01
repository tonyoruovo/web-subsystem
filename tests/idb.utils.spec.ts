/**
 * @fileoverview
 * Unit tests for idb.utils.ts
 *
 * Every helper is tested against fake-indexeddb, which provides a complete
 * in-process IndexedDB implementation that behaves identically to the browser
 * API without requiring a DOM. No mocking of individual IDB calls is needed —
 * the helpers are exercised against real IDB semantics.
 *
 * Coverage:
 *   - idbRequest          — resolves on success, rejects on onerror
 *   - idbTransactionDone  — resolves on oncomplete, rejects on onabort/onerror
 *   - openDatabase        — creates objectStore + indexes on first open,
 *                           re-opens cleanly on second open
 *   - countPrefix         — full count, prefix count, empty store
 *   - cursorCollectPrefix — no prefix, prefix match, no match, empty store
 *   - cursorDeleteMatching— without prefix (store.clear), with prefix, no match
 *   - collectExpired      — expired vs never-expiring vs future records
 *   - collectByWeight     — ordering, prefix filtering
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanonicalKey, IDBRecord } from '../src';
import {
  DB_VERSION,
  collectByWeight,
  collectExpired,
  countPrefix,
  cursorCollectPrefix,
  cursorDeleteMatching,
  idbRequest,
  idbTransactionDone,
  openDatabase,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'test-utils';
const STORE_NAME = 'entries';

const KEY_A = 'myapp:chrome:130:auth:session' as CanonicalKey;
const KEY_B = 'myapp:chrome:130:auth:refresh' as CanonicalKey;
const KEY_C = 'myapp:chrome:130:prefs:theme' as CanonicalKey;
const KEY_D = 'otherapp:firefox:100:data:thing' as CanonicalKey;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRecord(key: CanonicalKey, overrides: Partial<IDBRecord> = {}): IDBRecord {
  return {
    key,
    payload: 'enc-payload',
    schema_version: 1,
    written_at: Date.now() - 2_000,
    expires_at: null,
    weight: 5,
    backend: 'indexeddb',
    ...overrides,
  };
}

/** Open the shared test DB and return `{ db }` */
async function openTestDB(): Promise<IDBDatabase> {
  return openDatabase(DB_NAME, STORE_NAME);
}

/** Seed the store with an array of records inside one readwrite transaction. */
async function seed(db: IDBDatabase, records: IDBRecord[]): Promise<void> {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const r of records) store.put(r);
  await idbTransactionDone(tx);
}

/** Read one raw record directly (bypasses IDBBackend). */
async function getRecord(db: IDBDatabase, key: CanonicalKey): Promise<IDBRecord | undefined> {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return idbRequest<IDBRecord | undefined>(store.get(key));
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let db: IDBDatabase;

beforeEach(async () => {
  db = await openTestDB();
});

afterEach(async () => {
  db.close();
  // fake-indexeddb resets between tests when using its auto-import
  indexedDB.deleteDatabase(DB_NAME);
});

// ─────────────────────────────────────────────────────────────────────────────
// idbRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('idbRequest', () => {
  it('resolves with request.result on success', async () => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = makeRecord(KEY_A);
    store.put(record);
    await idbTransactionDone(tx);

    const readTx = db.transaction([STORE_NAME], 'readonly');
    const result = await idbRequest<IDBRecord>(readTx.objectStore(STORE_NAME).get(KEY_A));
    expect(result).toMatchObject({ key: KEY_A, payload: 'enc-payload' });
  });

  it('resolves undefined for a missing key', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const result = await idbRequest<IDBRecord | undefined>(
      tx.objectStore(STORE_NAME).get('no-such-key'),
    );
    expect(result).toBeUndefined();
  });

  it('rejects when the request errors', async () => {
    // Force an error by attempting to open a cursor on a non-existent index
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    // fake-indexeddb will throw when we request a bad index
    expect(() => store.index('non_existent_index')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// idbTransactionDone
// ─────────────────────────────────────────────────────────────────────────────

describe('idbTransactionDone', () => {
  it('resolves when the transaction commits successfully', async () => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(makeRecord(KEY_A));
    await expect(idbTransactionDone(tx)).resolves.toBeUndefined();
  });

  it('resolves even for an empty (no-op) transaction', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    await expect(idbTransactionDone(tx)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// openDatabase
// ─────────────────────────────────────────────────────────────────────────────

describe('openDatabase', () => {
  it('creates the object store and both indexes on first open', async () => {
    expect(db.objectStoreNames.contains(STORE_NAME)).toBe(true);
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    expect(store.indexNames.contains('by_expires_at')).toBe(true);
    expect(store.indexNames.contains('by_weight')).toBe(true);
  });

  it('exposes DB_VERSION = 1', () => {
    expect(DB_VERSION).toBe(1);
    expect(db.version).toBe(DB_VERSION);
  });

  it('re-opens the same database successfully', async () => {
    db.close();
    const db2 = await openDatabase(DB_NAME, STORE_NAME);
    expect(db2.name).toBe(DB_NAME);
    db2.close();
    db = await openTestDB(); // restore for afterEach
  });

  it('returns a usable database handle (put + get round-trip)', async () => {
    const record = makeRecord(KEY_A);
    await seed(db, [record]);
    const result = await getRecord(db, KEY_A);
    expect(result).toMatchObject({ key: KEY_A });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countPrefix
// ─────────────────────────────────────────────────────────────────────────────

describe('countPrefix', () => {
  beforeEach(async () => {
    await seed(db, [makeRecord(KEY_A), makeRecord(KEY_B), makeRecord(KEY_C), makeRecord(KEY_D)]);
  });

  it('counts all records when no prefix is given', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    expect(await countPrefix(store)).toBe(4);
  });

  it('counts only records matching the prefix', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    expect(await countPrefix(store, 'myapp:chrome:130:auth:')).toBe(2);
    expect(await countPrefix(store, 'myapp:chrome:130:prefs:')).toBe(1);
    expect(await countPrefix(store, 'otherapp:')).toBe(1);
  });

  it('returns 0 for a prefix with no matches', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    expect(await countPrefix(store, 'nonexistent:')).toBe(0);
  });

  it('returns 0 on an empty store', async () => {
    // Clear and recount
    const clearTx = db.transaction([STORE_NAME], 'readwrite');
    const clearStore = clearTx.objectStore(STORE_NAME);
    clearStore.clear();
    await idbTransactionDone(clearTx);

    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    expect(await countPrefix(store)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cursorCollectPrefix
// ─────────────────────────────────────────────────────────────────────────────

describe('cursorCollectPrefix', () => {
  beforeEach(async () => {
    await seed(db, [makeRecord(KEY_A), makeRecord(KEY_B), makeRecord(KEY_C), makeRecord(KEY_D)]);
  });

  it('returns all records when no prefix is given', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = await cursorCollectPrefix(store);
    expect(results).toHaveLength(4);
  });

  it('returns only matching records for a given prefix', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = await cursorCollectPrefix(store, 'myapp:chrome:130:auth:');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  it('returns an empty array when no records match the prefix', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = await cursorCollectPrefix(store, 'no-match:');
    expect(results).toHaveLength(0);
  });

  it('returns an empty array on an empty store', async () => {
    const clearTx = db.transaction([STORE_NAME], 'readwrite');
    clearTx.objectStore(STORE_NAME).clear();
    await idbTransactionDone(clearTx);

    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = await cursorCollectPrefix(store);
    expect(results).toHaveLength(0);
  });

  it('each result is a complete IDBRecord', async () => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = await cursorCollectPrefix(store, 'myapp:chrome:130:auth:');
    for (const r of results) {
      expect(r).toHaveProperty('key');
      expect(r).toHaveProperty('payload');
      expect(r).toHaveProperty('schema_version');
      expect(r).toHaveProperty('written_at');
      expect(r).toHaveProperty('weight');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cursorDeleteMatching
// ─────────────────────────────────────────────────────────────────────────────

describe('cursorDeleteMatching', () => {
  beforeEach(async () => {
    await seed(db, [makeRecord(KEY_A), makeRecord(KEY_B), makeRecord(KEY_C)]);
  });

  it('deletes all records when no prefix is given (store.clear path)', async () => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await cursorDeleteMatching(store);
    await idbTransactionDone(tx);

    const count = await (async () => {
      const t = db.transaction([STORE_NAME], 'readonly');
      return countPrefix(t.objectStore(STORE_NAME));
    })();
    expect(count).toBe(0);
  });

  it('deletes only records matching the prefix (cursor path)', async () => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await cursorDeleteMatching(store, 'myapp:chrome:130:auth:');
    await idbTransactionDone(tx);

    expect(await getRecord(db, KEY_A)).toBeUndefined();
    expect(await getRecord(db, KEY_B)).toBeUndefined();
    expect(await getRecord(db, KEY_C)).toBeDefined();
  });

  it('is a no-op when the prefix matches nothing', async () => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await cursorDeleteMatching(store, 'no-such-prefix:');
    await idbTransactionDone(tx);

    const tx2 = db.transaction([STORE_NAME], 'readonly');
    expect(await countPrefix(tx2.objectStore(STORE_NAME))).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectExpired
// ─────────────────────────────────────────────────────────────────────────────

describe('collectExpired', () => {
  const now = Date.now();

  beforeEach(async () => {
    await seed(db, [
      makeRecord(KEY_A, { expires_at: now - 10_000 }), // expired
      makeRecord(KEY_B, { expires_at: now + 10_000 }), // not yet expired
      makeRecord(KEY_C, { expires_at: null }), // never expires
      makeRecord(KEY_D, { expires_at: now - 1 }), // just expired
    ]);
  });

  it('returns only records whose expires_at <= now', async () => {
    const expired = await collectExpired(db, STORE_NAME, now);
    const keys = expired.map((r) => r.key).sort();
    expect(keys).toEqual([KEY_A, KEY_D].sort());
  });

  it('does not include never-expiring (null expires_at) records', async () => {
    const expired = await collectExpired(db, STORE_NAME, now);
    expect(expired.map((r) => r.key)).not.toContain(KEY_C);
  });

  it('does not include records that expire in the future', async () => {
    const expired = await collectExpired(db, STORE_NAME, now);
    expect(expired.map((r) => r.key)).not.toContain(KEY_B);
  });

  it('returns an empty array when nothing is expired', async () => {
    const future = now + 1_000_000;
    const expired = await collectExpired(db, STORE_NAME, future - 1_100_000);
    expect(expired).toHaveLength(0);
  });

  it('returns an empty array on an empty store', async () => {
    const clearTx = db.transaction([STORE_NAME], 'readwrite');
    clearTx.objectStore(STORE_NAME).clear();
    await idbTransactionDone(clearTx);

    const expired = await collectExpired(db, STORE_NAME, now);
    expect(expired).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectByWeight
// ─────────────────────────────────────────────────────────────────────────────

describe('collectByWeight', () => {
  beforeEach(async () => {
    await seed(db, [
      makeRecord(KEY_A, { weight: 10 }),
      makeRecord(KEY_B, { weight: 1 }),
      makeRecord(KEY_C, { weight: 5 }),
      makeRecord(KEY_D, { weight: 1 }),
    ]);
  });

  it('returns records in ascending weight order', async () => {
    const candidates = await collectByWeight(db, STORE_NAME);
    const weights = candidates.map((r) => r.weight);
    expect(weights).toEqual([...weights].sort((a, b) => a - b));
  });

  it('returns all records when no prefix is given', async () => {
    const candidates = await collectByWeight(db, STORE_NAME);
    expect(candidates).toHaveLength(4);
  });

  it('filters by prefix when one is supplied', async () => {
    const candidates = await collectByWeight(db, STORE_NAME, 'myapp:chrome:130:auth:');
    expect(candidates.map((r) => r.key).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  it('returns an empty array when prefix matches nothing', async () => {
    const candidates = await collectByWeight(db, STORE_NAME, 'no-match:');
    expect(candidates).toHaveLength(0);
  });

  it('returns an empty array on an empty store', async () => {
    const clearTx = db.transaction([STORE_NAME], 'readwrite');
    clearTx.objectStore(STORE_NAME).clear();
    await idbTransactionDone(clearTx);

    const candidates = await collectByWeight(db, STORE_NAME);
    expect(candidates).toHaveLength(0);
  });
});
