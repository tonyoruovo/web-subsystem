/**
 * @fileoverview
 * @summary Collections: the API of Storage for callers, on the main thread.
 *
 * @description
 * A collection is a named group of values with one schema. The caller's
 * realm validates every value with the schema, before a write and after a
 * read, so refinements and transforms always apply. The coordinator does the
 * rest (docs/ARCHITECTURE.md §18.2).
 *
 * ```text
 *   collection.set(key, value) --> schema.safeParse --> toPortable --> coordinator 'set'  --> change event
 *   collection.get(key)        <-- schema.safeParse <-- value      <-- coordinator 'get'
 *   ```
 *
 * @example
 * A cart
 * ```ts
 * const cart = commands.collection({ name: 'cart', schema: z.array(z.string()) });
 * await cart.set('items', ['tea']);
 * await cart.get('items'); // ['tea']
 * ```
 *
 * @author MathAid
 */

import { toPortable } from '@platform/core';

import type { BatchOperation, ListResult, ReadResult, StorageRequest } from './coordinator';
import type { CollectionSpec, Migration } from './pipeline';

/**
 * @summary A schema that can validate a value: a zod schema, or anything with the same `safeParse`.
 * @example
 * Example 1: zod
 * ```ts
 * const schema: SchemaLike<string[]> = z.array(z.string());
 * ```
 * @example
 * Example 2: Without a library
 * ```ts
 * const schema: SchemaLike<number> = { safeParse: (v) => typeof v === 'number' ? { success: true, data: v } : { success: false, error: 'not a number' } };
 * ```
 * @template T The type of a valid value.
 * @public
 */
export interface SchemaLike<T> {
  /**
   * @summary Validates a value.
   * @example
   * Validating
   * ```ts
   * schema.safeParse(['tea']); // { success: true, data: ['tea'] }
   * ```
   * @param {unknown} value The value.
   * @returns The valid value, or the error.
   */
  safeParse(value: unknown): SafeParseResult<T>;
}

/**
 * @summary The result of {@linkcode SchemaLike.safeParse}.
 * @example
 * Example 1: Valid
 * ```ts
 * // { success: true, data: ['tea'] }
 * ```
 * @example
 * Example 2: Not valid
 * ```ts
 * // { success: false, error: ZodError }
 * ```
 * @template T The type of a valid value.
 * @public
 */
export type SafeParseResult<T> =
  | {
      /**
       * @summary The value is valid.
       */
      success: true;
      /**
       * @summary The valid value.
       */
      data: T;
    }
  | {
      /**
       * @summary The value is not valid.
       */
      success: false;
      /**
       * @summary What is wrong, for example a `ZodError`.
       */
      error: unknown;
    };

/**
 * @summary The definition of a collection.
 *
 * @description
 * The functions (`serialize`, `deserialize`, `migrations`) run in the
 * coordinator, maybe in a worker. They must be self-contained: they can use
 * their parameters and the globals of the runtime, but no closure variables
 * or imports (docs/ARCHITECTURE.md §8.8).
 *
 * @example
 * Example 1: A small collection
 * ```ts
 * commands.collection({ name: 'prefs', schema: z.object({ theme: z.enum(['light', 'dark']) }) });
 * ```
 *
 * @example
 * Example 2: Encrypted, at version 2, with a limit
 * ```ts
 * commands.collection({
 *   name: 'drafts',
 *   schema: Draft,
 *   version: 2,
 *   migrations: { 2: (old) => ({ ...(old as object), tags: [] }) },
 *   encrypt: true,
 *   maxEntries: 50,
 * });
 * ```
 *
 * @template T The type of the values.
 * @public
 */
export interface CollectionDefinition<T> {
  /**
   * @summary The name. It is the module segment of the canonical keys.
   */
  readonly name: string;
  /**
   * @summary Validates each value before a write and after a read.
   */
  readonly schema?: SchemaLike<T>;
  /**
   * @summary The schema version of new entries. The default is 1.
   */
  readonly version?: number;
  /**
   * @summary The migration steps, by the version that they make.
   * @description `migrations[2]` turns a version 1 value into a version 2 value.
   */
  readonly migrations?: Readonly<Record<number, Migration>>;
  /**
   * @summary The time to live of an entry, in milliseconds. The default is no expiry.
   */
  readonly ttl?: number | null;
  /**
   * @summary The eviction weight. A higher weight is evicted later. The default is 1.
   */
  readonly weight?: number;
  /**
   * @summary Encrypts the entries with the keys of `@platform/crypto`, and adds an HMAC tag.
   */
  readonly encrypt?: boolean;
  /**
   * @summary Compresses the entries with gzip. Use it for large text values.
   */
  readonly compress?: boolean;
  /**
   * @summary The largest number of entries. A write deletes the oldest entries above it.
   */
  readonly maxEntries?: number;
  /**
   * @summary Turns a value into text. The default is `JSON.stringify`.
   */
  readonly serialize?: (value: T) => string;
  /**
   * @summary Turns text back into a value. The default is `JSON.parse`.
   */
  readonly deserialize?: (text: string) => T;
}

/**
 * @summary A change to stored data, in this tab or in another tab.
 * @example
 * Example 1: A write in this tab
 * ```ts
 * // { collection: 'cart', key: 'items', op: 'set', remote: false }
 * ```
 * @example
 * Example 2: A clear in another tab
 * ```ts
 * // { collection: 'cart', key: null, op: 'clear', remote: true }
 * ```
 * @public
 */
export interface StorageChange {
  /**
   * @summary The collection, or `null` when the whole namespace was cleared.
   */
  readonly collection: string | null;
  /**
   * @summary The key, or `null` for a clear.
   */
  readonly key: string | null;
  /**
   * @summary What happened.
   */
  readonly op: 'set' | 'delete' | 'clear';
  /**
   * @summary Tells if another tab made the change.
   */
  readonly remote: boolean;
}

/**
 * @summary A value failed validation with the schema of its collection.
 * @example
 * Catching it
 * ```ts
 * try { await prefs.set('main', { theme: 'blue' }); } catch (error) { if (error instanceof StorageValidationError) showError(error.issues); }
 * ```
 * @public
 */
export class StorageValidationError extends Error {
  /**
   * @summary The name of the error: `StorageValidationError`.
   */
  override readonly name = 'StorageValidationError';

  /**
   * @summary Makes the error.
   * @param {string} collection The collection.
   * @param {string} key The key.
   * @param {unknown} issues The error of the schema.
   */
  constructor(
    collection: string,
    key: string,
    /**
     * @summary The error of the schema, for example a `ZodError`.
     */
    readonly issues: unknown,
  ) {
    super(`[storage] The value for "${collection}:${key}" does not match the schema.`, {
      cause: issues,
    });
  }
}

/**
 * @summary What a collection needs from the Storage subsystem.
 * @public
 */
export interface CollectionHost {
  /**
   * @summary Sends a request to the coordinator.
   * @example
   * Calling
   * ```ts
   * await host.call({ op: 'count', spec });
   * ```
   * @param {StorageRequest} request The request.
   * @returns {Promise<unknown>} The result.
   */
  call(request: StorageRequest): Promise<unknown>;
  /**
   * @summary Announces a change made in this tab.
   * @example
   * Announcing
   * ```ts
   * host.changed({ collection: 'cart', key: 'items', op: 'set' });
   * ```
   * @param {Omit<StorageChange, 'remote'>} change The change.
   * @returns {void}
   */
  changed(change: Omit<StorageChange, 'remote'>): void;
  /**
   * @summary Announces a corrupt entry.
   * @example
   * Announcing
   * ```ts
   * host.corrupt('vault', 'pin', 'The integrity tag is wrong.');
   * ```
   * @param {string} collection The collection.
   * @param {string} key The key.
   * @param {string} reason Why the entry is corrupt.
   * @returns {void}
   */
  corrupt(collection: string, key: string, reason: string): void;
  /**
   * @summary Listens to the changes of one collection.
   * @example
   * Listening
   * ```ts
   * const stop = host.listen('cart', (change) => render());
   * ```
   * @param {string} collection The collection.
   * @param {Function} listener Gets each change.
   * @returns {() => void} Stops listening.
   */
  listen(collection: string, listener: (change: StorageChange) => void): () => void;
}

/**
 * @summary Options of {@linkcode Collection.entries}.
 * @example
 * Example 1: A page
 * ```ts
 * await orders.entries({ limit: 20, offset: 40 });
 * ```
 * @example
 * Example 2: A filter that runs in the coordinator
 * ```ts
 * await orders.entries({ where: (order) => (order as { open: boolean }).open });
 * ```
 * @template T The type of the values.
 * @public
 */
export interface EntriesOptions<T> {
  /**
   * @summary Keeps the entries for which it returns `true`.
   * @description It runs in the coordinator, before validation, so it must be self-contained.
   */
  readonly where?: (value: T, key: string) => boolean;
  /**
   * @summary The largest number of entries.
   */
  readonly limit?: number;
  /**
   * @summary The number of entries to skip.
   */
  readonly offset?: number;
}

const specs = new WeakMap<object, CollectionSpec>();

/**
 * @summary Returns the spec of a collection, for a batch.
 * @example
 * In a batch
 * ```ts
 * operations.push({ op: 'delete', spec: specOf(cart), key: 'items' });
 * ```
 * @param {Collection<unknown>} collection The collection.
 * @returns {CollectionSpec} The spec.
 * @public
 */
export function specOf(collection: Collection<unknown>): CollectionSpec {
  const spec = specs.get(collection);
  if (!spec) throw new Error('[storage] Not a collection of this Storage subsystem.');
  return spec;
}

/**
 * @summary A named group of values with one schema. `commands.collection(definition)` makes it.
 *
 * @example
 * Example 1: Read and write
 * ```ts
 * const prefs = commands.collection({ name: 'prefs', schema: Prefs });
 * await prefs.set('main', { theme: 'dark' });
 * (await prefs.get('main'))?.theme; // 'dark'
 * ```
 *
 * @example
 * Example 2: React to changes from every tab
 * ```ts
 * prefs.subscribe((change) => change.key === 'main' && applyTheme());
 * ```
 *
 * @template T The type of the values.
 * @public
 */
export class Collection<T> {
  /**
   * @summary The name of the collection.
   */
  readonly name: string;
  readonly #schema: SchemaLike<T> | undefined;
  readonly #spec: CollectionSpec;
  readonly #host: CollectionHost;

  /**
   * @summary Makes a collection. Use `commands.collection(definition)` instead.
   * @param {CollectionDefinition<T>} definition The definition.
   * @param {CollectionHost} host The Storage subsystem.
   */
  constructor(definition: CollectionDefinition<T>, host: CollectionHost) {
    if (!/^[\w.-]+$/.test(definition.name)) {
      throw new Error(
        `[storage] The collection name "${definition.name}" may use only letters, digits, "_", "." and "-".`,
      );
    }
    this.name = definition.name;
    this.#schema = definition.schema;
    this.#host = host;
    this.#spec = {
      name: definition.name,
      version: definition.version ?? 1,
      ttl: definition.ttl ?? null,
      weight: definition.weight ?? 1,
      encrypt: definition.encrypt ?? false,
      compress: definition.compress ?? false,
      maxEntries: definition.maxEntries ?? null,
      ...(definition.serialize
        ? { serialize: definition.serialize as (value: unknown) => string }
        : {}),
      ...(definition.deserialize ? { deserialize: definition.deserialize } : {}),
      ...(definition.migrations ? { migrations: definition.migrations } : {}),
    };
    specs.set(this, this.#spec);
  }

  /**
   * @summary Validates a value with the schema of the collection.
   * @example
   * Validating before a batch
   * ```ts
   * const valid = cart.validate('items', ['tea']);
   * ```
   * @param {string} key The key, for the error message.
   * @param {unknown} value The value.
   * @returns {T} The valid value. A schema with transforms can change it.
   * @throws {StorageValidationError} When the value does not match.
   */
  validate(key: string, value: unknown): T {
    if (!this.#schema) return value as T;
    const result = this.#schema.safeParse(value);
    if (!result.success) throw new StorageValidationError(this.name, key, result.error);
    return result.data;
  }

  async #call<R>(request: StorageRequest): Promise<R> {
    return (await this.#host.call(toPortable(request) as StorageRequest)) as R;
  }

  /**
   * @summary Reads a value.
   * @description A corrupt entry, or a value that fails the schema, gives
   * `undefined` and a `storage:corrupt` broadcast.
   * @example
   * Reading
   * ```ts
   * const items = (await cart.get('items')) ?? [];
   * ```
   * @param {string} key The key.
   * @returns {Promise<T | undefined>} The value, or `undefined` when there is none.
   */
  async get(key: string): Promise<T | undefined> {
    const result = await this.#call<ReadResult>({ op: 'get', spec: this.#spec, key });
    if (result.corrupt) this.#host.corrupt(this.name, key, result.corrupt);
    if (!result.found) return undefined;
    try {
      return this.validate(key, result.value);
    } catch (error) {
      this.#host.corrupt(this.name, key, (error as Error).message);
      return undefined;
    }
  }

  /**
   * @summary Writes a value.
   * @example
   * Writing with a time to live
   * ```ts
   * await cart.set('items', ['tea'], { ttl: 24 * 60 * 60 * 1000 });
   * ```
   * @param {string} key The key.
   * @param {T} value The value.
   * @param {object} [options] The time to live and the eviction weight of this write.
   * @returns {Promise<void>} Resolves when the value is stored.
   * @throws {StorageValidationError} When the value does not match the schema.
   */
  async set(
    key: string,
    value: T,
    options: { ttl?: number | null; weight?: number } = {},
  ): Promise<void> {
    const valid = this.validate(key, value);
    await this.#call({ op: 'set', spec: this.#spec, key, value: valid, ...options });
    this.#host.changed({ collection: this.name, key, op: 'set' });
  }

  /**
   * @summary Deletes a value. A missing key is not an error.
   * @example
   * Deleting
   * ```ts
   * await cart.delete('items');
   * ```
   * @param {string} key The key.
   * @returns {Promise<void>} Resolves when the value is deleted.
   */
  async delete(key: string): Promise<void> {
    await this.#call({ op: 'delete', spec: this.#spec, key });
    this.#host.changed({ collection: this.name, key, op: 'delete' });
  }

  /**
   * @summary Tells if a key has a value.
   * @example
   * Checking
   * ```ts
   * if (!(await cart.has('items'))) await cart.set('items', []);
   * ```
   * @param {string} key The key.
   * @returns {Promise<boolean>} `true` when the key has a readable value.
   */
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  /**
   * @summary Returns the entries, oldest write first.
   * @description Entries that fail the schema are left out and announced as corrupt.
   * @example
   * The open orders
   * ```ts
   * const open = await orders.entries({ where: (order) => order.status === 'open' });
   * ```
   * @param {EntriesOptions<T>} [options] A filter and a page.
   * @returns {Promise<Array<{ key: string; value: T }>>} The entries.
   */
  async entries(options: EntriesOptions<T> = {}): Promise<Array<{ key: string; value: T }>> {
    const result = await this.#call<ListResult>({
      op: 'list',
      spec: this.#spec,
      where: options.where as ((value: unknown, key: string) => boolean) | undefined,
      limit: options.limit,
      offset: options.offset,
    });
    for (const key of result.corrupt)
      this.#host.corrupt(this.name, key, 'The entry does not decode.');
    const entries: Array<{ key: string; value: T }> = [];
    for (const entry of result.entries) {
      try {
        entries.push({ key: entry.key, value: this.validate(entry.key, entry.value) });
      } catch (error) {
        this.#host.corrupt(this.name, entry.key, (error as Error).message);
      }
    }
    return entries;
  }

  /**
   * @summary Returns the keys, oldest write first.
   * @example
   * Listing
   * ```ts
   * await cart.keys(); // ['items', 'coupon']
   * ```
   * @returns {Promise<string[]>} The keys.
   */
  async keys(): Promise<string[]> {
    const result = await this.#call<ListResult>({ op: 'list', spec: this.#spec, keysOnly: true });
    return result.entries.map((entry) => entry.key);
  }

  /**
   * @summary Counts the entries.
   * @example
   * Counting
   * ```ts
   * await orders.count(); // 12
   * ```
   * @returns {Promise<number>} The number of entries.
   */
  count(): Promise<number> {
    return this.#call<number>({ op: 'count', spec: this.#spec });
  }

  /**
   * @summary Deletes every entry of the collection.
   * @example
   * Clearing at sign-out
   * ```ts
   * await cart.clear();
   * ```
   * @returns {Promise<void>} Resolves when the entries are deleted.
   */
  async clear(): Promise<void> {
    await this.#call({ op: 'clear', spec: this.#spec });
    this.#host.changed({ collection: this.name, key: null, op: 'clear' });
  }

  /**
   * @summary Migrates every old entry to the version of the collection now, not at the next read.
   * @example
   * Migrating after an update
   * ```ts
   * const changed = await drafts.migrate();
   * ```
   * @returns {Promise<number>} The number of entries migrated.
   */
  migrate(): Promise<number> {
    return this.#call<number>({ op: 'migrate', spec: this.#spec });
  }

  /**
   * @summary Listens to the changes of the collection, from this tab and other tabs.
   * @example
   * Rendering again
   * ```ts
   * const stop = cart.subscribe(() => renderCart());
   * ```
   * @param {Function} listener Gets each change.
   * @returns {() => void} Stops listening.
   */
  subscribe(listener: (change: StorageChange) => void): () => void {
    return this.#host.listen(this.name, listener);
  }
}

/**
 * @summary Collects the operations of a batch. `commands.batch(build)` gives it.
 * @example
 * Example 1: Move an item
 * ```ts
 * await commands.batch((batch) => {
 *   batch.delete(wishlist, 'tea');
 *   batch.set(cart, 'tea', { quantity: 1 });
 * });
 * ```
 * @example
 * Example 2: Validation happens at once
 * ```ts
 * batch.set(cart, 'x', 'bad value'); // throws StorageValidationError
 * ```
 * @public
 */
export class Batch {
  /**
   * @summary The operations, in order.
   */
  readonly operations: BatchOperation[] = [];

  /**
   * @summary Adds a write. The value is validated at once.
   * @example
   * Adding
   * ```ts
   * batch.set(cart, 'items', ['tea']);
   * ```
   * @param {Collection<T>} collection The collection.
   * @param {string} key The key.
   * @param {T} value The value.
   * @param {object} [options] The time to live of this write.
   * @returns {this} The batch, for chaining.
   * @throws {StorageValidationError} When the value does not match the schema.
   */
  set<T>(
    collection: Collection<T>,
    key: string,
    value: T,
    options: { ttl?: number | null } = {},
  ): this {
    const valid = collection.validate(key, value);
    this.operations.push({ op: 'set', spec: specOf(collection), key, value: valid, ...options });
    return this;
  }

  /**
   * @summary Adds a delete.
   * @example
   * Adding
   * ```ts
   * batch.delete(cart, 'coupon');
   * ```
   * @param {Collection<unknown>} collection The collection.
   * @param {string} key The key.
   * @returns {this} The batch, for chaining.
   */
  delete(collection: Collection<unknown>, key: string): this {
    this.operations.push({ op: 'delete', spec: specOf(collection), key });
    return this;
  }
}
