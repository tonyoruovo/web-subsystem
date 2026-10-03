/**
 * The open items of M6 (docs/ARCHITECTURE.md §18.3): the key check between
 * Storage and Crypto, query indexes, and the Web Lock around each request.
 */
import 'fake-indexeddb/auto';

import type { SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  KeyMismatchError,
  STORAGE_ID,
  createStorage,
  type StorageControl,
  type StorageOptions,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

let counter = 0;
const fresh = () => `open-${Date.now()}-${++counter}`;

/** A tab with Storage, and Crypto when `cryptoDatabase` is given. */
async function tab(options: StorageOptions & { cryptoDatabase?: string } = {}) {
  const { cryptoDatabase, ...storageOptions } = options;
  const units: SubsystemDefinition[] = [
    createStorage({
      domain: 'shop',
      hosts: ['virtual'],
      quota: false,
      keys: null,
      database: fresh(),
      ...storageOptions,
    }) as SubsystemDefinition,
  ];
  if (cryptoDatabase) {
    units.push(
      createCrypto({ hosts: ['virtual'], database: cryptoDatabase }) as SubsystemDefinition,
    );
  }
  const platform = createTestPlatform(units);
  platforms.push(platform);
  await platform.start();
  await platform.settle();
  return {
    platform,
    storage: platform.unit<StorageControl>(STORAGE_ID).control!,
    crypto: cryptoDatabase ? platform.unit<CryptoControl>(CRYPTO_ID).control! : undefined,
  };
}

/** The raw keys of the Storage database, as the backend has them. */
async function rawKeys(database: string): Promise<string[]> {
  const open = indexedDB.open(database);
  const db = await new Promise<IDBDatabase>(
    (resolve) => (open.onsuccess = () => resolve(open.result)),
  );
  const store = db
    .transaction(db.objectStoreNames[0]!, 'readonly')
    .objectStore(db.objectStoreNames[0]!);
  const all = store.getAllKeys();
  const keys = await new Promise<IDBValidKey[]>(
    (resolve) => (all.onsuccess = () => resolve(all.result)),
  );
  db.close();
  return keys.map(String);
}

describe('the key check', () => {
  it('matches when Storage and Crypto use the same key source, also after a rotation', async () => {
    const keys = fresh();
    const { storage, crypto, platform } = await tab({
      keys: { source: { kind: 'device' }, database: keys },
      cryptoDatabase: keys,
    });
    await expect.poll(() => storage.views.state.getSnapshot().keyCheck).toBe('match');
    await crypto!.commands.rotate('encrypt');
    await platform.settle();
    await expect.poll(() => storage.views.state.getSnapshot().keyCheck).toBe('match');
    await storage.commands.collection<string>({ name: 'vault', encrypt: true }).set('pin', '1234');
  });

  it('finds a mismatch, reports it, and refuses encrypted writes but not reads or plain writes', async () => {
    const { storage, platform } = await tab({
      keys: { source: { kind: 'device' }, database: fresh() },
      cryptoDatabase: fresh(),
    });
    await expect.poll(() => storage.views.state.getSnapshot().keyCheck).toBe('mismatch');
    expect(platform.errors.some(({ error }) => error instanceof KeyMismatchError)).toBe(true);

    const vault = storage.commands.collection<string>({ name: 'vault', encrypt: true });
    await expect(vault.set('pin', '1234')).rejects.toThrow(KeyMismatchError);
    await expect(storage.commands.batch((b) => b.set(vault, 'pin', '1234'))).rejects.toThrow(
      KeyMismatchError,
    );
    expect(await vault.get('pin')).toBeUndefined();
    await storage.commands.collection<string>({ name: 'plain' }).set('a', 'ok');
  });

  it('is unchecked without Crypto, or without encryption', async () => {
    const alone = await tab({ keys: { source: { kind: 'device' }, database: fresh() } });
    expect(alone.storage.views.state.getSnapshot().keyCheck).toBe('unchecked');
    const plain = await tab({ keys: null, cryptoDatabase: fresh() });
    await plain.platform.settle();
    expect(plain.storage.views.state.getSnapshot().keyCheck).toBe('unchecked');
  });
});

interface Order {
  status: 'open' | 'paid';
  tags: string[];
  total: number;
}
const indexes = {
  status: (order: Order) => order.status,
  tag: (order: Order) => order.tags,
};

describe('query indexes', () => {
  it('finds entries by an index, also by one item of a multi-entry index', async () => {
    const { storage } = await tab();
    const orders = storage.commands.collection<Order>({ name: 'orders', indexes });
    await orders.set('o1', { status: 'open', tags: ['gift'], total: 10 });
    await orders.set('o2', { status: 'paid', tags: ['gift', 'rush'], total: 20 });
    await orders.set('o3', { status: 'open', tags: [], total: 30 });

    expect((await orders.lookup('status', 'open')).map((e) => e.key)).toEqual(['o1', 'o3']);
    expect((await orders.lookup('tag', 'gift')).map((e) => e.key)).toEqual(['o1', 'o2']);
    expect((await orders.lookup('tag', 'rush')).map((e) => e.value.total)).toEqual([20]);
    expect(
      (await orders.lookup('status', 'open', { where: (o) => o.total > 15, limit: 5 })).map(
        (e) => e.key,
      ),
    ).toEqual(['o3']);
    // Index entries are not entries of the collection.
    expect(await orders.count()).toBe(3);
    await expect(orders.lookup('missing', 'x')).rejects.toThrow('no index');
  });

  it('moves an entry between index values on a write, and drops it on a delete or a trim', async () => {
    const database = fresh();
    const { storage } = await tab({ database });
    const orders = storage.commands.collection<Order>({ name: 'orders', indexes, maxEntries: 2 });
    await orders.set('o1', { status: 'open', tags: ['a'], total: 1 });
    await orders.set('o1', { status: 'paid', tags: ['b'], total: 1 });
    expect(await orders.lookup('status', 'open')).toEqual([]);
    expect((await orders.lookup('status', 'paid')).map((e) => e.key)).toEqual(['o1']);
    expect(await orders.lookup('tag', 'a')).toEqual([]);

    await orders.set('o2', { status: 'paid', tags: [], total: 2 });
    await orders.set('o3', { status: 'paid', tags: [], total: 3 }); // trims o1
    expect((await orders.lookup('status', 'paid')).map((e) => e.key)).toEqual(['o2', 'o3']);
    await orders.delete('o2');
    expect((await orders.lookup('status', 'paid')).map((e) => e.key)).toEqual(['o3']);

    // Only o3 is left, with its index entry and its reverse entry.
    const index = (await rawKeys(database)).filter((k) => k.includes('~index'));
    expect(index.sort()).toEqual([
      'shop:browser:1:orders~index:@:o3',
      'shop:browser:1:orders~index:status:%22paid%22:o3',
    ]);
    await orders.clear();
    expect((await rawKeys(database)).filter((k) => k.includes('~index'))).toEqual([]);
  });

  it('keeps the index right when a batch writes the same key twice', async () => {
    const { storage } = await tab();
    const orders = storage.commands.collection<Order>({ name: 'orders', indexes });
    await storage.commands.batch((b) =>
      b
        .set(orders, 'o1', { status: 'open', tags: [], total: 1 })
        .set(orders, 'o1', { status: 'paid', tags: [], total: 1 }),
    );
    expect(await orders.lookup('status', 'open')).toEqual([]);
    expect((await orders.lookup('status', 'paid')).map((e) => e.key)).toEqual(['o1']);
    await storage.commands.batch((b) => b.delete(orders, 'o1'));
    expect(await orders.lookup('status', 'paid')).toEqual([]);
  });

  it('stores no plain index values for an encrypted collection, and finds entries after an HMAC rotation', async () => {
    const database = fresh();
    const keys = fresh();
    const { storage, crypto, platform } = await tab({
      database,
      keys: { source: { kind: 'device' }, database: keys },
      cryptoDatabase: keys,
    });
    const people = storage.commands.collection<{ email: string }>({
      name: 'people',
      encrypt: true,
      indexes: { email: (p) => p.email },
    });
    await people.set('p1', { email: 'ada@example.com' });
    expect((await rawKeys(database)).some((k) => k.includes('ada'))).toBe(false);
    expect((await people.lookup('email', 'ada@example.com')).map((e) => e.key)).toEqual(['p1']);

    await crypto!.commands.rotate('hmac');
    await platform.settle();
    await people.set('p2', { email: 'bob@example.com' });
    expect((await people.lookup('email', 'ada@example.com')).map((e) => e.key)).toEqual(['p1']);
    expect((await people.lookup('email', 'bob@example.com')).map((e) => e.key)).toEqual(['p2']);
  });

  it('cleans stale index entries, and reindex() builds a new index', async () => {
    const database = fresh();
    const { storage } = await tab({ database });
    const codes = storage.commands.collection<{ kind: string }>({
      name: 'codes',
      ttl: 20,
      indexes: { kind: (c) => c.kind },
    });
    await codes.set('c1', { kind: 'otp' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await codes.lookup('kind', 'otp')).toEqual([]);
    expect((await rawKeys(database)).filter((k) => k.includes('~index'))).toEqual([]);

    // A collection that gains an index later.
    const before = storage.commands.collection<{ city: string }>({ name: 'shops' });
    await before.set('s1', { city: 'Lagos' });
    await before.set('s2', { city: 'Accra' });
    const after = storage.commands.collection<{ city: string }>({
      name: 'shops',
      indexes: { city: (s) => s.city },
    });
    expect(await after.lookup('city', 'Lagos')).toEqual([]);
    expect(await after.reindex()).toBe(2);
    expect((await after.lookup('city', 'Lagos')).map((e) => e.key)).toEqual(['s1']);
  });
});

describe('the Web Lock', () => {
  it('runs each request inside the lock of the database, so other coordinators wait', async () => {
    const database = fresh();
    const { storage } = await tab({ database });
    const status = (await storage.commands.estimate()) && storage.views.state.getSnapshot();
    expect(status.backend).toBe('indexeddb');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let granted!: () => void;
    const isHeld = new Promise<void>((resolve) => (granted = resolve));
    // Another coordinator of the origin holds the lock.
    void navigator.locks.request(`platform-storage:${database}`, async () => {
      granted();
      await held;
    });
    await isHeld;

    let done = false;
    const write = storage.commands
      .collection<number>({ name: 'n' })
      .set('a', 1)
      .then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false);
    release();
    await write;
    expect(done).toBe(true);
  });
});
