import 'fake-indexeddb/auto';

import { NO_CONTROL, type SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { CRYPTO_ID, createCrypto, type CryptoControl } from '@platform/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  STORAGE_CHANGED,
  STORAGE_CORRUPT,
  STORAGE_ID,
  STORAGE_QUOTA,
  StorageValidationError,
  createStatePersistence,
  createStorage,
  type CorruptEntry,
  type QuotaAlert,
  type StorageChange,
  type StorageControl,
  type StorageOptions,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

let counter = 0;
const fresh = () => `db-${Date.now()}-${++counter}`;

/** Reads the raw records of the Storage database, as a backend sees them. */
async function raw(
  database: string,
): Promise<Array<{ key: string; payload: string; schema_version: number; integrity?: string }>> {
  const open = indexedDB.open(database);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const store = db
    .transaction(db.objectStoreNames[0]!, 'readonly')
    .objectStore(db.objectStoreNames[0]!);
  const all = store.getAll();
  const rows = await new Promise<unknown[]>(
    (resolve) => (all.onsuccess = () => resolve(all.result)),
  );
  db.close();
  return rows as never;
}

/** One "tab": a platform with Storage on the main thread, and a listener of Storage broadcasts. */
async function tab(options: StorageOptions & { crypto?: boolean } = {}) {
  const events: { eventId: string; payload: unknown }[] = [];
  const listener: SubsystemDefinition = {
    id: 'listener',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [STORAGE_CHANGED, STORAGE_CORRUPT, STORAGE_QUOTA],
    receive: (packet) =>
      void events.push({ eventId: packet.header.eventId, payload: packet.take() }),
    control: () => NO_CONTROL,
  };
  const { crypto, ...storageOptions } = options;
  const keysDatabase = storageOptions.keys?.database;
  const units: SubsystemDefinition[] = [
    createStorage({
      domain: 'shop',
      hosts: ['virtual'],
      quota: false,
      keys: null,
      ...storageOptions,
    }) as SubsystemDefinition,
    listener,
  ];
  if (crypto)
    units.push(createCrypto({ hosts: ['virtual'], database: keysDatabase }) as SubsystemDefinition);
  const platform = createTestPlatform(units);
  platforms.push(platform);
  await platform.start();
  return {
    platform,
    storage: platform.unit<StorageControl>(STORAGE_ID).control!,
    crypto: crypto ? platform.unit<CryptoControl>(CRYPTO_ID).control! : undefined,
    events,
  };
}

const Order = z.object({ id: z.string(), total: z.number().nonnegative(), open: z.boolean() });

describe('Storage', () => {
  it('reads, writes, lists and deletes values in a collection', async () => {
    const database = fresh();
    const { storage, platform } = await tab({ database });
    const orders = storage.commands.collection({ name: 'orders', schema: Order });

    await orders.set('a', { id: 'a', total: 10, open: true });
    await orders.set('b', { id: 'b', total: 0, open: false });
    expect(await orders.get('a')).toEqual({ id: 'a', total: 10, open: true });
    expect(await orders.get('missing')).toBeUndefined();
    expect(await orders.has('b')).toBe(true);
    expect(await orders.keys()).toEqual(['a', 'b']);
    expect(await orders.count()).toBe(2);

    await orders.delete('a');
    expect(await orders.keys()).toEqual(['b']);
    await orders.clear();
    expect(await orders.count()).toBe(0);

    expect(storage.views.state.getSnapshot()).toMatchObject({
      host: 'virtual',
      backend: 'indexeddb',
      persistent: true,
      encryption: false,
      probes: { indexeddb: true },
    });
    expect(platform.status(STORAGE_ID)).toBe('READY');
    expect((await raw(database)).length).toBe(0);
  });

  it('uses canonical keys, so two collections never share an entry', async () => {
    const database = fresh();
    const { storage } = await tab({ database, platformVersion: 3 });
    await storage.commands.collection<number>({ name: 'cart' }).set('items', 1);
    await storage.commands.collection<number>({ name: 'wishlist' }).set('items', 2);
    expect((await raw(database)).map((row) => row.key).sort()).toEqual([
      'shop:browser:3:cart:items',
      'shop:browser:3:wishlist:items',
    ]);
  });

  it('validates with the full schema before a write and after a read', async () => {
    const { storage, events, platform } = await tab({ database: fresh() });
    const orders = storage.commands.collection({ name: 'orders', schema: Order });
    await expect(orders.set('x', { id: 'x', total: -1, open: true })).rejects.toThrow(
      StorageValidationError,
    );
    expect(await orders.count()).toBe(0);

    // A transform runs in the caller's realm.
    const trimmed = storage.commands.collection({
      name: 'names',
      schema: z.string().transform((s) => s.trim()),
    });
    await trimmed.set('n', '  Ada  ');
    expect(await trimmed.get('n')).toBe('Ada');

    // Stored data that no longer matches the schema reads as missing, and is reported.
    await storage.commands.collection<unknown>({ name: 'orders' }).set('old', { id: 1 });
    expect(await orders.get('old')).toBeUndefined();
    await platform.settle();
    expect(
      events
        .filter((e) => e.eventId === STORAGE_CORRUPT)
        .map((e) => (e.payload as CorruptEntry).key),
    ).toEqual(['old']);
  });

  it('encrypts and compresses in the coordinator, and stores no plain text', async () => {
    const database = fresh();
    const keys = { source: { kind: 'device' as const }, database: fresh() };
    const { storage } = await tab({ database, keys });
    const notes = storage.commands.collection<string>({
      name: 'notes',
      encrypt: true,
      compress: true,
    });
    const text = 'Door code: 4512. '.repeat(50);
    await notes.set('door', text);

    const [row] = await raw(database);
    expect(row!.payload.startsWith('ze:v1.')).toBe(true);
    expect(row!.payload).not.toContain('Door code');
    expect(row!.integrity).toMatch(/^[0-9a-f]{16}\./);
    expect(await notes.get('door')).toBe(text);
    expect(storage.views.state.getSnapshot().encryption).toBe(true);
  });

  it('refuses an entry with a wrong tag, deletes it and broadcasts storage:corrupt', async () => {
    const database = fresh();
    const keys = { source: { kind: 'device' as const }, database: fresh() };
    const { storage, events, platform } = await tab({ database, keys });
    const vault = storage.commands.collection<string>({ name: 'vault', encrypt: true });
    await vault.set('pin', '1234');

    // Change the stored payload behind the coordinator's back.
    const open = indexedDB.open(database);
    const db = await new Promise<IDBDatabase>(
      (resolve) => (open.onsuccess = () => resolve(open.result)),
    );
    const name = db.objectStoreNames[0]!;
    const store = db.transaction(name, 'readwrite').objectStore(name);
    const get = store.get('shop:browser:1:vault:pin');
    await new Promise((resolve) => (get.onsuccess = resolve));
    const record = get.result as { payload: string };
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).put({
      ...record,
      payload: record.payload.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    });
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();

    expect(await vault.get('pin')).toBeUndefined();
    expect(await vault.count()).toBe(0);
    await platform.settle();
    const corrupt = events.find((e) => e.eventId === STORAGE_CORRUPT)?.payload as CorruptEntry;
    expect(corrupt).toMatchObject({
      collection: 'vault',
      key: 'pin',
      reason: 'The integrity tag is wrong.',
    });
    expect(platform.errors.some(({ error }) => String(error).includes('corrupt'))).toBe(true);
  });

  it('migrates an old entry on read and writes it back, or all entries with migrate()', async () => {
    const database = fresh();
    const { storage } = await tab({ database });
    const v1 = storage.commands.collection<{ title: string }>({ name: 'drafts' });
    await v1.set('a', { title: 'A' });
    await v1.set('b', { title: 'B' });

    const v2 = storage.commands.collection({
      name: 'drafts',
      version: 2,
      schema: z.object({ title: z.string(), tags: z.array(z.string()) }),
      migrations: { 2: (old) => ({ ...(old as object), tags: ['imported'] }) },
    });
    expect(await v2.get('a')).toEqual({ title: 'A', tags: ['imported'] });
    expect((await raw(database)).find((r) => r.key.endsWith(':a'))?.schema_version).toBe(2);

    expect(await v2.migrate()).toBe(1); // only 'b' was still at version 1
    expect((await raw(database)).every((r) => r.schema_version === 2)).toBe(true);
  });

  it('runs a portable where predicate in the coordinator, with paging', async () => {
    const { storage } = await tab({ database: fresh() });
    const orders = storage.commands.collection({ name: 'orders', schema: Order });
    for (const [id, total] of [
      ['a', 5],
      ['b', 50],
      ['c', 500],
      ['d', 5000],
    ] as const) {
      await orders.set(id, { id, total, open: total > 10 });
    }
    const open = await orders.entries({ where: (order) => order.open, limit: 2, offset: 1 });
    expect(open.map((e) => e.key)).toEqual(['c', 'd']);
  });

  it('keeps at most maxEntries, and removes the oldest first', async () => {
    const { storage } = await tab({ database: fresh() });
    const recent = storage.commands.collection<number>({ name: 'recent', maxEntries: 3 });
    for (let i = 1; i <= 5; i++) await recent.set(`k${i}`, i);
    expect(await recent.keys()).toEqual(['k3', 'k4', 'k5']);
  });

  it('applies a batch in one transaction, and validates before anything is written', async () => {
    const { storage } = await tab({ database: fresh() });
    const cart = storage.commands.collection<string[]>({ name: 'cart' });
    const orders = storage.commands.collection({ name: 'orders', schema: Order });
    await cart.set('items', ['tea']);

    await expect(
      storage.commands.batch((batch) =>
        batch.delete(cart, 'items').set(orders, 'o1', { id: 'o1', total: -5, open: true }),
      ),
    ).rejects.toThrow(StorageValidationError);
    expect(await cart.get('items')).toEqual(['tea']);

    await storage.commands.batch((batch) =>
      batch.delete(cart, 'items').set(orders, 'o1', { id: 'o1', total: 5, open: true }),
    );
    expect(await cart.get('items')).toBeUndefined();
    expect(await orders.get('o1')).toMatchObject({ total: 5 });
  });

  it('expires entries after their time to live', async () => {
    const { storage } = await tab({ database: fresh() });
    const codes = storage.commands.collection<string>({ name: 'codes', ttl: 30 });
    await codes.set('otp', '123456');
    await codes.set('long', 'kept', { ttl: null });
    expect(await codes.get('otp')).toBe('123456');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await codes.get('otp')).toBeUndefined();
    expect(await codes.get('long')).toBe('kept');
  });

  it('tells listeners and the platform about changes, and other tabs too', async () => {
    const database = fresh();
    const first = await tab({ database });
    const second = await tab({ database });
    const seen: StorageChange[] = [];
    const remote: StorageChange[] = [];
    first.storage.commands.collection({ name: 'cart' }).subscribe((change) => seen.push(change));
    second.storage.commands.collection({ name: 'cart' }).subscribe((change) => remote.push(change));

    const cart = first.storage.commands.collection<string[]>({ name: 'cart' });
    await cart.set('items', ['tea']);
    await first.platform.settle();
    expect(seen).toEqual([{ collection: 'cart', key: 'items', op: 'set', remote: false }]);
    expect(first.events.find((e) => e.eventId === STORAGE_CHANGED)?.payload).toEqual(seen[0]);

    await expect
      .poll(() => remote)
      .toEqual([{ collection: 'cart', key: 'items', op: 'set', remote: true }]);
    // The other tab reads the same data.
    expect(
      await second.storage.commands.collection<string[]>({ name: 'cart' }).get('items'),
    ).toEqual(['tea']);
  });

  it('keeps data across sessions', async () => {
    const database = fresh();
    const first = await tab({ database });
    await first.storage.commands.collection<string>({ name: 'prefs' }).set('theme', 'dark');
    await first.platform.stop();

    const second = await tab({ database });
    expect(await second.storage.commands.collection<string>({ name: 'prefs' }).get('theme')).toBe(
      'dark',
    );
  });

  it('falls back to memory, and says the data is not persistent', async () => {
    const { storage } = await tab({ database: fresh(), backends: ['opfs', 'memory'] });
    expect(storage.views.state.getSnapshot()).toMatchObject({
      backend: 'memory',
      persistent: false,
      probes: { opfs: false, memory: true },
    });
    const c = storage.commands.collection<number>({ name: 'c' });
    await c.set('one', 1);
    expect(await c.get('one')).toBe(1);
  });

  it('reloads the keys when Crypto rotates them', async () => {
    const database = fresh();
    const keys = { source: { kind: 'device' as const }, database: fresh() };
    const { storage, crypto, platform } = await tab({ database, keys, crypto: true });
    const vault = storage.commands.collection<string>({ name: 'vault', encrypt: true });
    await vault.set('before', 'old key');
    const id = await crypto!.commands.rotate('encrypt');
    await platform.settle();
    await vault.set('after', 'new key');

    const rows = await raw(database);
    const keyOf = (name: string) => rows.find((r) => r.key.endsWith(name))!.payload.split('.')[1];
    expect(keyOf(':after')).toBe(id);
    expect(keyOf(':before')).not.toBe(id);
    expect(await vault.get('before')).toBe('old key');
  });

  it('broadcasts storage:quota at the warning level and evicts at the critical level', async () => {
    const { storage, events, platform } = await tab({
      database: fresh(),
      backends: ['memory'],
      quota: { intervalMs: 10, warning: 0, critical: 0 },
    });
    await storage.commands.collection<string>({ name: 'big' }).set('x', 'y'.repeat(1000));
    await expect
      .poll(async () => {
        await platform.settle();
        return events.filter((e) => e.eventId === STORAGE_QUOTA).length;
      })
      .toBeGreaterThan(0);
    const alert = events.find((e) => e.eventId === STORAGE_QUOTA)!.payload as QuotaAlert;
    expect(alert.level).toBe('critical');
    expect(storage.views.state.getSnapshot().quota).not.toBeNull();
  });
});

describe('createStatePersistence', () => {
  it('keeps unit state in IndexedDB', async () => {
    const factory = new IDBFactory();
    const first = createStatePersistence({ indexedDB: factory });
    await first.save('prefs', { version: 1, data: { theme: 'dark' } });
    expect(await first.ready()).toBe('indexeddb');

    const second = createStatePersistence({ indexedDB: factory });
    expect(await second.load('prefs')).toEqual({ version: 1, data: { theme: 'dark' } });
    expect(await second.load('none')).toBeUndefined();
  });

  it('falls back to localStorage, then to memory', async () => {
    const map = new Map<string, string>();
    const local = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as Storage;
    const web = createStatePersistence({ indexedDB: null, localStorage: local });
    await web.save('a', { version: 2, data: { n: 1 } });
    expect(await web.ready()).toBe('localstorage');
    expect(JSON.parse(map.get('__platform_state:a')!)).toEqual({ version: 2, data: { n: 1 } });

    const mem = createStatePersistence({ indexedDB: null, localStorage: null });
    await mem.save('a', { version: 1, data: {} });
    expect(await mem.ready()).toBe('memory');
    expect(await mem.load('a')).toEqual({ version: 1, data: {} });
  });
});
