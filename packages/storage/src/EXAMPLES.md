# Examples: `@platform/storage`

Storage keeps the data of an app in collections. One coordinator writes for every tab of the origin, over IndexedDB, OPFS, Cache, Web Storage or memory, and encrypts, compresses and migrates the entries. In an app, keep the default hosts, so the coordinator runs in a shared worker. These examples run it on the main thread (`hosts: ['virtual']`) with the memory backend, so they run in every sandbox.

## Keep user preferences

<!-- example id="storage/preferences" runtime="any" -->

A settings page keeps the preferences of the user in a collection. The schema validates each value before a write and after a read. Here it is a small hand-written schema. A zod schema works the same way.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type SchemaLike, type StorageControl } from '@platform/storage';

interface Prefs {
  theme: 'light' | 'dark';
  fontSize: number;
}
const Prefs: SchemaLike<Prefs> = {
  safeParse(value) {
    const v = value as Prefs;
    const ok = (v?.theme === 'light' || v?.theme === 'dark') && typeof v.fontSize === 'number';
    return ok ? { success: true, data: v } : { success: false, error: 'not a Prefs value' };
  },
};

const kernel = new Kernel([
  createStorage({ domain: 'notes', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const prefs = commands.collection({ name: 'prefs', schema: Prefs });
await prefs.set('main', { theme: 'dark', fontSize: 16 });
const stored = await prefs.get('main');
console.log('theme:', stored?.theme, 'font size:', stored?.fontSize);
console.log('missing key:', (await prefs.get('other')) === undefined);

try {
  await prefs.set('main', { theme: 'blue', fontSize: 16 } as unknown as Prefs);
} catch (error) {
  console.log('refused:', (error as Error).name);
}
await kernel.stop();
```

```text output
theme: dark font size: 16
missing key: true
refused: StorageValidationError
```

## Encrypt a collection

<!-- example id="storage/encrypted-collection" runtime="any" -->

A notes app keeps private notes. With `encrypt: true`, the coordinator encrypts each entry with the keys of `@platform/crypto` and adds an HMAC tag. The backend never sees the text.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, useMemoryStore, type StorageControl } from '@platform/storage';

const kernel = new Kernel([
  createStorage({
    domain: 'notes',
    hosts: ['virtual'],
    backends: ['memory'],
    keys: { source: { kind: 'device' }, database: 'examples-keys' },
    quota: false,
  }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const notes = commands.collection<string>({ name: 'notes', encrypt: true, compress: true });
await notes.set('door', 'The door code is 4512.');

// Look at what the backend stores.
const [envelope] = [...useMemoryStore()._store.values()];
const payload = envelope!.payload as string;
console.log('flags:', payload.split(':')[0]);
console.log('plain text stored:', payload.includes('4512'));
console.log('has a tag:', typeof envelope!.integrity === 'string');
console.log('read back:', await notes.get('door'));
await kernel.stop();
```

```text output
flags: ze
plain text stored: false
has a tag: true
read back: The door code is 4512.
```

## Change the shape of stored data

<!-- example id="storage/migrations" runtime="any" -->

Version 2 of an app adds tags to drafts. Old drafts migrate when they are read, and the coordinator writes them back. `migrate()` migrates the rest at once.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

const kernel = new Kernel([
  createStorage({ domain: 'notes', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

// Version 1 of the app wrote these drafts.
const v1 = commands.collection<{ title: string }>({ name: 'drafts' });
await v1.set('a', { title: 'Shopping' });
await v1.set('b', { title: 'Holiday' });

// Version 2 reads them. The migration must be self-contained: it can run in a worker.
const v2 = commands.collection<{ title: string; tags: string[] }>({
  name: 'drafts',
  version: 2,
  migrations: { 2: (old) => ({ ...(old as { title: string }), tags: [] }) },
});
console.log('read and migrated:', JSON.stringify(await v2.get('a')));
console.log('migrated by migrate():', await v2.migrate());
await kernel.stop();
```

```text output
read and migrated: {"title":"Shopping","tags":[]}
migrated by migrate(): 1
```

## Filter entries where they are stored

<!-- example id="storage/filter-entries" runtime="any" -->

An orders page shows the open orders, 2 at a time. The `where` function runs in the coordinator, so only matching entries cross to the page.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

interface Order {
  total: number;
  open: boolean;
}

const kernel = new Kernel([
  createStorage({ domain: 'shop', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const orders = commands.collection<Order>({ name: 'orders' });
await orders.set('o1', { total: 12, open: false });
await orders.set('o2', { total: 30, open: true });
await orders.set('o3', { total: 7, open: true });
await orders.set('o4', { total: 99, open: true });

const page1 = await orders.entries({ where: (order) => order.open, limit: 2 });
const page2 = await orders.entries({ where: (order) => order.open, limit: 2, offset: 2 });
console.log('page 1:', page1.map((e) => e.key).join(', '));
console.log('page 2:', page2.map((e) => e.key).join(', '));
console.log('all orders:', await orders.count());
await kernel.stop();
```

```text output
page 1: o2, o3
page 2: o4
all orders: 4
```

## Keep only the recent entries

<!-- example id="storage/recent-searches" runtime="any" -->

A search box remembers the last 3 searches. With `maxEntries`, each write removes the oldest entries above the limit.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

const kernel = new Kernel([
  createStorage({ domain: 'shop', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const searches = commands.collection<string>({ name: 'searches', maxEntries: 3 });
for (const query of ['tea', 'green tea', 'teapot', 'cups', 'saucers']) {
  await searches.set(query, query);
}
console.log('kept:', (await searches.keys()).join(', '));
await kernel.stop();
```

```text output
kept: teapot, cups, saucers
```

## Write several collections together

<!-- example id="storage/batch" runtime="any" -->

At checkout, the cart empties and an order appears. A batch applies both in one backend transaction, so a failure never leaves only one of them.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

const kernel = new Kernel([
  createStorage({ domain: 'shop', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const cart = commands.collection<string[]>({ name: 'cart' });
const orders = commands.collection<{ items: string[] }>({ name: 'orders' });
await cart.set('items', ['tea', 'cups']);

await commands.batch((batch) =>
  batch.delete(cart, 'items').set(orders, 'order-1', { items: ['tea', 'cups'] }),
);
console.log('cart:', JSON.stringify(await cart.get('items')));
console.log('order:', JSON.stringify(await orders.get('order-1')));
await kernel.stop();
```

```text output
cart: undefined
order: {"items":["tea","cups"]}
```

## React to changes

<!-- example id="storage/changes" runtime="any" -->

A cart badge updates when the cart changes, in this tab or in another tab. `subscribe` gets each change. `remote` tells if another tab made it.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

const kernel = new Kernel([
  createStorage({ domain: 'shop', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const cart = commands.collection<string[]>({ name: 'cart' });
const stop = cart.subscribe((change) =>
  console.log('change:', change.op, change.key ?? '(all)', 'remote:', change.remote),
);
await cart.set('items', ['tea']);
await cart.delete('items');
await cart.clear();
stop();
await kernel.stop();
```

```text output
change: set items remote: false
change: delete items remote: false
change: clear (all) remote: false
```

## Persist the state of units

<!-- example id="storage/state-persistence" runtime="any" -->

The kernel loads persisted state before any subsystem runs, so it needs an adapter that works without the coordinator. `createStatePersistence` uses IndexedDB, then `localStorage`, then memory. This example turns off the first two, so it gives the same output everywhere.

```ts file=main.ts
import { createStatePersistence } from '@platform/storage';

const persistence = createStatePersistence({ indexedDB: null, localStorage: null });
await persistence.save('prefs', { version: 1, data: { theme: 'dark' } });

console.log('kept in:', await persistence.ready());
console.log('loaded:', JSON.stringify(await persistence.load('prefs')));
console.log('unknown unit:', (await persistence.load('other')) === undefined);
```

```text output
kept in: memory
loaded: {"version":1,"data":{"theme":"dark"}}
unknown unit: true
```

## Build canonical keys

<!-- example id="storage/canonical-keys" runtime="any" -->

Every stored key is canonical: `<domain>:<platform>:<platformVersion>:<module>:<key>`. Storage builds them for you. The functions help when you inspect a backend or write a tool.

```ts file=main.ts
import { buildCanonicalKey, buildModulePrefix, parseCanonicalKey } from '@platform/storage';

const key = buildCanonicalKey({
  domain: 'shop',
  platform: 'browser',
  platformVersion: 1,
  callingModule: 'cart',
  actualKey: 'items',
});
console.log('key:', key);
console.log('module prefix:', buildModulePrefix('shop', 'browser', 1, 'cart'));
console.log('parsed module:', parseCanonicalKey(key)?.callingModule);
```

```text output
key: shop:browser:1:cart:items
module prefix: shop:browser:1:cart:
parsed module: cart
```

## Find entries by an index

<!-- example id="storage/indexes" runtime="any" -->

An orders page shows the open orders, and a gift view shows the orders with the tag `gift`. Indexes find them without reading every order. An index function returns one value, or an array for several.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

interface Order {
  status: 'open' | 'paid';
  tags: string[];
}

const kernel = new Kernel([
  createStorage({ domain: 'shop', hosts: ['virtual'], backends: ['memory'], keys: null, quota: false }),
]);
await kernel.start();
const { commands } = kernel.unit<StorageControl>(STORAGE_ID).control!;

const orders = commands.collection<Order>({
  name: 'orders',
  indexes: { status: (order) => order.status, tag: (order) => order.tags },
});
await orders.set('o1', { status: 'open', tags: ['gift'] });
await orders.set('o2', { status: 'paid', tags: ['gift', 'rush'] });
await orders.set('o3', { status: 'open', tags: [] });

console.log('open:', (await orders.lookup('status', 'open')).map((e) => e.key).join(', '));
console.log('gift:', (await orders.lookup('tag', 'gift')).map((e) => e.key).join(', '));

await orders.set('o1', { status: 'paid', tags: ['gift'] }); // the index follows the new value
console.log('open now:', (await orders.lookup('status', 'open')).map((e) => e.key).join(', '));
await kernel.stop();
```

```text output
open: o1, o3
gift: o1, o2
open now: o3
```

## Check that Storage and Crypto use the same keys

<!-- example id="storage/key-check" runtime="any" -->

Storage must use the keys of Crypto, so that `crypto.forget()` also erases the encrypted data of Storage. Give both the same key source. Storage compares the key ids, and on a mismatch it refuses encrypted writes.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { createCrypto, toBase64Url, type KeySource } from '@platform/crypto';
import { STORAGE_ID, createStorage, type StorageControl } from '@platform/storage';

// In an app, this material comes from your server. Each key is 32 random bytes.
const source: KeySource = {
  kind: 'material',
  encrypt: toBase64Url(new Uint8Array(32).fill(1)),
  hmac: toBase64Url(new Uint8Array(32).fill(2)),
};

async function start(storageSource: KeySource) {
  const kernel = new Kernel([
    createCrypto({ hosts: ['virtual'], indexedDB: null, keys: source }),
    createStorage({ domain: 'notes', hosts: ['virtual'], backends: ['memory'], keys: { source: storageSource }, quota: false }),
  ]);
  await kernel.start();
  await new Promise((resolve) => setTimeout(resolve, 20)); // the check runs after Crypto starts
  return { kernel, storage: kernel.unit<StorageControl>(STORAGE_ID).control! };
}

const same = await start(source);
console.log('same source:', same.storage.views.state.getSnapshot().keyCheck);
await same.kernel.stop();

const other = await start({ kind: 'material', encrypt: toBase64Url(new Uint8Array(32).fill(9)), hmac: source.hmac });
console.log('other source:', other.storage.views.state.getSnapshot().keyCheck);
try {
  await other.storage.commands.collection<string>({ name: 'vault', encrypt: true }).set('pin', '1234');
} catch (error) {
  console.log('encrypted write:', (error as Error).name);
}
await other.kernel.stop();
```

```text output
same source: match
other source: mismatch
encrypted write: KeyMismatchError
```
