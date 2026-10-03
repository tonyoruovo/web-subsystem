/**
 * @fileoverview
 * @summary The backend contract of Storage: canonical keys, envelopes, queries, transactions and quota.
 * @description
 * Every backend (IndexedDB, OPFS, Cache, Web Storage, memory) implements
 * {@linkcode IStorageBackend}. The coordinator processor of Storage
 * (docs/ARCHITECTURE.md §18.2) talks to the active backend only through this
 * contract, so it can switch backends without code changes.
 *
 * ```text
 *   coordinator --write(key, envelope)--> backend      key:      <domain>:<platform>:<version>:<module>:<key>
 *               --read(key)------------->              envelope: { payload, schema_version, written_at,
 *               --query(q) / count()---->                          expires_at, weight, backend, integrity? }
 *               --beginTransaction()---->  ITransaction: buffer ops, then commit() or rollback()
 *               --estimateQuota() / evict(targetBytes, policy)
 *   ```
 *
 * A backend stores **already processed** data: the coordinator serializes,
 * compresses and encrypts the payload before a write, and reverses it after a
 * read. A backend never validates or migrates.
 *
 * @example
 * Writing through any backend
 * ```ts
 * const key = buildCanonicalKey({ domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'cart', actualKey: 'items' });
 * await backend.write(key, { payload: '[]', schema_version: 1, written_at: Date.now(), expires_at: null, weight: 1, backend: backend.kind });
 * ```
 *
 * @example
 * An atomic batch
 * ```ts
 * const tx = await backend.beginTransaction();
 * await backend.write(keyA, envelopeA, { transactionId: tx.id });
 * await backend.delete(keyB, { transactionId: tx.id });
 * await tx.commit();
 * ```
 *
 * @author MathAid
 */

/**
 * @summary The platform segment of a canonical key.
 * @description `browser` fits most web apps. The others let one domain keep
 * separate data for native shells or browsers.
 * @public
 */
export type UnderlyingPlatform =
  | 'android'
  | 'ios'
  | 'win'
  | 'unix'
  | 'mac'
  | 'safari'
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'opera'
  | 'browser'
  | 'iot';

/**
 * @summary The parts of a canonical key, before {@linkcode buildCanonicalKey} joins them.
 *
 * @description
 * A canonical key is `<domain>:<platform>:<platformVersion>:<callingModule>:<actualKey>`.
 * The first four parts are the namespace of one module of one app. Keeping
 * the parts separate lets code build prefixes and check keys without string splitting.
 *
 * @example
 * Example 1: The cart of a shop
 * ```ts
 * const segments: ICanonicalKeySegments = { domain: 'shop', platform: 'browser', platformVersion: 1, callingModule: 'cart', actualKey: 'items' };
 * ```
 *
 * @example
 * Example 2: The prefix of a module
 * ```ts
 * buildModulePrefix({ ...segments, actualKey: '' }); // 'shop:browser:1:cart:'
 * ```
 *
 * @public
 */
export interface ICanonicalKeySegments {
  /**
   * @summary The name of the app or site, for example `shop`.
   */
  domain: string;
  /**
   * @summary The platform of the data.
   */
  platform: UnderlyingPlatform;
  /**
   * @summary The version of the platform data, a positive number.
   * @description Increase it to start with a new namespace after an incompatible change.
   */
  platformVersion: number;
  /**
   * @summary The module that owns the entry, for example `cart` or `logger`.
   */
  callingModule: string;
  /**
   * @summary The key that the module chose, for example `items`.
   */
  actualKey: string;
}

/**
 * @summary A full canonical key: `<domain>:<platform>:<platformVersion>:<callingModule>:<actualKey>`.
 * @public
 */
export type CanonicalKey = `${string}:${UnderlyingPlatform}:${number}:${string}:${string}`;

/**
 * @summary The kinds of backend.
 * @public
 */
export type BackendKind =
  'indexeddb' | 'localstorage' | 'sessionstorage' | 'memory' | 'opfs' | 'cache';

/**
 * @summary The atomicity that a backend can give to a transaction.
 * @description
 * - `serializable`: a real transaction (IndexedDB).
 * - `compensating`: the backend restores a snapshot after a failure. Another tab can see the middle state (Web Storage, OPFS, Cache).
 * - `best-effort`: in-process only, with no durability (memory).
 * @public
 */
export type TransactionStrength = 'serializable' | 'compensating' | 'best-effort';

/**
 * @summary The wrapper of every stored value.
 *
 * @description
 * The coordinator puts the processed value in `payload` and adds the
 * metadata that reads, migrations, expiry and eviction need. Callers of
 * Storage never see the envelope.
 *
 * @example
 * Example 1: An encrypted entry
 * ```ts
 * // { payload: 'v1.3f9a…', schema_version: 2, written_at: 1700000000000, expires_at: null, weight: 1, backend: 'indexeddb', integrity: 'b2…' }
 * ```
 *
 * @example
 * Example 2: Checking expiry
 * ```ts
 * const expired = envelope.expires_at !== null && envelope.expires_at <= Date.now();
 * ```
 *
 * @template T The type of the stored payload: a string for most backends.
 * @public
 */
export interface StorageEnvelope<T = unknown> {
  /**
   * @summary The stored value, already processed by the coordinator.
   * @description For most backends it is a string: serialized, and maybe compressed and encrypted.
   */
  payload: T;
  /**
   * @summary The schema version of the collection when the entry was written.
   * @description A read migrates an entry with an older version.
   */
  schema_version: number;
  /**
   * @summary The time of the write, in Unix milliseconds.
   */
  written_at: number;
  /**
   * @summary The time when the entry expires, in Unix milliseconds, or `null` for never.
   */
  expires_at: number | null;
  /**
   * @summary The eviction weight. A higher weight is evicted later.
   */
  weight: number;
  /**
   * @summary The backend that wrote the entry.
   */
  backend: BackendKind;
  /**
   * @summary An HMAC tag over `payload`, when the collection uses integrity checks.
   */
  integrity?: string;
}

/**
 * @summary An estimate of the storage use of the origin.
 *
 * @example
 * Example 1: Half full
 * ```ts
 * // { used: 52428800, available: 52428800, ratio: 0.5 }
 * ```
 *
 * @example
 * Example 2: A warning level
 * ```ts
 * if (estimate.ratio >= 0.8) warnUser();
 * ```
 *
 * @public
 */
export interface QuotaEstimate {
  /**
   * @summary The bytes in use.
   */
  used: number;
  /**
   * @summary The bytes that are still available.
   */
  available: number;
  /**
   * @summary The part in use, from 0 to 1.
   */
  ratio: number;
}

/**
 * @summary How an eviction chooses between entries of the same weight.
 * @description
 * - `lru`: the entry that was written longest ago first.
 * - `lfu`: the entry that was read the least first (backends that count reads).
 * - `fifo`: the oldest `written_at` first.
 * - `user`: the comparator that the caller gives.
 * @public
 */
export type EvictionPolicy = 'lru' | 'lfu' | 'fifo' | 'user';

/**
 * @summary The result of the probe of a backend.
 *
 * @example
 * Example 1: Available
 * ```ts
 * // { available: true, latency: 3 }
 * ```
 *
 * @example
 * Example 2: Not available in a worker
 * ```ts
 * // { available: false, reason: 'localStorage is not defined' }
 * ```
 *
 * @public
 */
export interface CapabilityResult {
  /**
   * @summary Tells if the backend works here.
   */
  available: boolean;
  /**
   * @summary The time of the write-read-delete smoke test, in milliseconds.
   */
  latency?: number;
  /**
   * @summary Why the backend does not work, when `available` is `false`.
   */
  reason?: string;
}

/**
 * @summary Criteria for `query` and `count`.
 *
 * @example
 * Example 1: The first page of a module
 * ```ts
 * backend.query({ prefix: 'shop:browser:1:orders:', limit: 20 });
 * ```
 *
 * @example
 * Example 2: Including expired entries, for a cleanup
 * ```ts
 * backend.query({ prefix, excludeExpired: false });
 * ```
 *
 * @public
 */
export interface StorageQuery {
  /**
   * @summary Keeps the keys that start with this text.
   */
  prefix?: string;
  /**
   * @summary Keeps the entries with this schema version.
   */
  schema_version?: number;
  /**
   * @summary Leaves out the expired entries.
   * @description The default is `true`.
   */
  excludeExpired?: boolean;
  /**
   * @summary The largest number of results.
   */
  limit?: number;
  /**
   * @summary The number of results to skip, for pagination.
   */
  offset?: number;
}

/**
 * @summary Options of a write.
 *
 * @example
 * Example 1: A write in a transaction
 * ```ts
 * await backend.write(key, envelope, { transactionId: tx.id });
 * ```
 *
 * @example
 * Example 2: A cancellable write
 * ```ts
 * await backend.write(key, envelope, { signal: controller.signal });
 * ```
 *
 * @public
 */
export interface WriteOptions {
  /**
   * @summary The time to live of this write, in milliseconds, or `null` for no expiry.
   */
  ttl?: number | null;
  /**
   * @summary The eviction weight of this write.
   */
  weight?: number;
  /**
   * @summary The transaction that this write belongs to.
   * @description The backend buffers the write until the transaction commits.
   */
  transactionId?: string;
  /**
   * @summary Aborts the write.
   */
  signal?: AbortSignal;
}

/**
 * @summary Options of a read.
 *
 * @example
 * Example 1: Reading an expired entry for diagnostics
 * ```ts
 * await backend.read(key, { respectTtl: false });
 * ```
 *
 * @example
 * Example 2: A cancellable read
 * ```ts
 * await backend.read(key, { signal: controller.signal });
 * ```
 *
 * @public
 */
export interface ReadOptions {
  /**
   * @summary Deletes an expired entry and returns `null`.
   * @description The default is `true`.
   */
  respectTtl?: boolean;
  /**
   * @summary Aborts the read.
   */
  signal?: AbortSignal;
}

/**
 * @summary The kinds of operation in a transaction.
 * @public
 */
export type TransactionOpKind = 'write' | 'delete' | 'clear';

/**
 * @summary A transaction of a backend: buffered operations that commit together.
 *
 * @description
 * `beginTransaction()` returns it. Writes and deletes with its `id` as
 * `transactionId` go to a buffer. `commit()` applies them, and `rollback()`
 * drops them. The other `rollback` forms remove some buffered operations and
 * keep the transaction open.
 *
 * @example
 * Example 1: Commit or roll back
 * ```ts
 * const tx = await backend.beginTransaction();
 * try {
 *   await backend.write(key, envelope, { transactionId: tx.id });
 *   await tx.commit();
 * } catch {
 *   await tx.rollback();
 * }
 * ```
 *
 * @example
 * Example 2: Removing the deletes before a commit
 * ```ts
 * await tx.rollback((op) => op.kind === 'delete');
 * await tx.commit();
 * ```
 *
 * @public
 */
export interface ITransaction {
  /**
   * @summary The id of the transaction. Pass it as `transactionId`.
   */
  readonly id: string;
  /**
   * @summary The atomicity of the transaction.
   */
  readonly strength: TransactionStrength;
  /**
   * @summary The buffered operations, oldest first.
   */
  readonly operations: readonly ITransactionOp[];
  /**
   * @summary Applies all buffered operations and closes the transaction.
   * @example
   * Committing
   * ```ts
   * await tx.commit();
   * ```
   * @returns {Promise<void>} Resolves when the operations are applied.
   * @throws {Error} When the backend refuses an operation. The backend then restores the old state as its strength allows.
   */
  commit(): Promise<void>;
  /**
   * @summary Drops all buffered operations and closes the transaction.
   * @description It does not throw.
   * @example
   * Rolling back after a failure
   * ```ts
   * catch { await tx.rollback(); }
   * ```
   * @returns {Promise<void>} Resolves when the transaction is closed.
   */
  rollback(): Promise<void>;
  /**
   * @summary Removes one buffered operation by its position. The transaction stays open.
   * @example
   * Removing the second operation
   * ```ts
   * const [removed] = await tx.rollback(1);
   * ```
   * @param {number} index The position of the operation, from 0.
   * @returns {Promise<Readonly<[ITransactionOp | undefined]>>} The removed operation, or `undefined` for a position that does not exist.
   */
  rollback(index: number): Promise<Readonly<[ITransactionOp | undefined]>>;
  /**
   * @summary Removes the buffered operations on one key. The transaction stays open.
   * @example
   * Cancelling the changes to one entry
   * ```ts
   * await tx.rollback(key);
   * ```
   * @param {CanonicalKey} canonicalKey The key.
   * @returns {Promise<ReadonlyArray<ITransactionOp>>} The removed operations.
   */
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<ITransactionOp>>;
  /**
   * @summary Removes the buffered operations under a key or a module prefix. The transaction stays open.
   * @description Without `actualKey`, the segments name a module prefix, and
   * the operations on every key of that module are removed.
   * @example
   * Cancelling the changes of one module
   * ```ts
   * await tx.rollback({ ...segments, actualKey: '' });
   * ```
   * @param {ICanonicalKeySegments} path The segments of the key or the prefix.
   * @returns {Promise<ReadonlyArray<ITransactionOp>>} The removed operations.
   */
  rollback(path: ICanonicalKeySegments): Promise<ReadonlyArray<ITransactionOp>>;
  /**
   * @summary Removes the buffered operations that match a predicate. The transaction stays open.
   * @example
   * Removing every delete
   * ```ts
   * await tx.rollback((op) => op.kind === 'delete');
   * ```
   * @param {ITxOpPredicate} predicate Returns `true` for an operation to remove.
   * @returns {Promise<ReadonlyArray<ITransactionOp>>} The removed operations.
   */
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<ITransactionOp>>;
}

/**
 * @summary One buffered operation of a transaction.
 *
 * @example
 * Example 1: A write
 * ```ts
 * // { kind: 'write', key: 'shop:browser:1:cart:items' }
 * ```
 *
 * @example
 * Example 2: A clear of a module
 * ```ts
 * // { kind: 'clear', prefix: 'shop:browser:1:cart:' }
 * ```
 *
 * @public
 */
export interface ITransactionOp {
  /**
   * @summary The kind of operation.
   */
  kind: TransactionOpKind;
  /**
   * @summary The key of a write or a delete.
   */
  key?: CanonicalKey;
  /**
   * @summary The prefix of a clear.
   */
  prefix?: string;
}

/**
 * @summary Chooses buffered operations for `rollback(predicate)`.
 * @public
 */
export type ITxOpPredicate = (op: ITransactionOp) => boolean;

/**
 * @summary The contract of every storage backend.
 *
 * @description
 * The coordinator of Storage probes each backend of its chain, initializes
 * the first one that works, and uses only these methods. A backend stores
 * already processed envelopes: it never validates, decrypts or migrates.
 *
 * ```text
 *   probe --> initialize --> write / read / delete / clear / query / count
 *                            beginTransaction --> commit | rollback
 *                            estimateQuota / evict
 *                       --> close
 *   ```
 *
 * @example
 * Example 1: Choosing the first backend that works
 * ```ts
 * for (const backend of chain) {
 *   if ((await backend.probe()).available) { await backend.initialize(); return backend; }
 * }
 * ```
 *
 * @example
 * Example 2: Freeing 5 MB
 * ```ts
 * const removed = await backend.evict(5 * 1024 * 1024, 'lru');
 * ```
 *
 * @template TRaw The type of the stored payload: a string for most backends.
 * @public
 */
export interface IStorageBackend<TRaw = string> {
  /**
   * @summary The kind of the backend.
   */
  readonly kind: BackendKind;
  /**
   * @summary The strongest transaction that the backend can give.
   * @description A caller can ask for a weaker one, never a stronger one.
   */
  readonly transactionStrength: TransactionStrength;
  /**
   * @summary Tests the backend with a write, a read and a delete.
   * @description The coordinator calls it one time, before `initialize`.
   * @example
   * Probing
   * ```ts
   * const { available, reason } = await backend.probe();
   * ```
   * @returns {Promise<CapabilityResult>} Whether the backend works here.
   */
  probe(): Promise<CapabilityResult>;
  /**
   * @summary Prepares the backend, for example opens its database.
   * @description The coordinator calls it one time, after a successful probe.
   * @example
   * Initializing with a timeout
   * ```ts
   * await backend.initialize(AbortSignal.timeout(5000));
   * ```
   * @param {AbortSignal} [signal] Aborts the initialization.
   * @returns {Promise<void>} Resolves when the backend is ready.
   */
  initialize(signal?: AbortSignal): Promise<void>;
  /**
   * @summary Closes the backend: flushes pending writes and releases connections and locks.
   * @example
   * Closing at teardown
   * ```ts
   * await backend.close();
   * ```
   * @returns {Promise<void>} Resolves when the backend is closed.
   */
  close(): Promise<void>;
  /**
   * @summary Writes an envelope under a key.
   * @example
   * Writing
   * ```ts
   * await backend.write(key, envelope);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {StorageEnvelope<TRaw>} envelope The envelope.
   * @param {WriteOptions} [options] The transaction and the signal of the write.
   * @returns {Promise<void>} Resolves when the write is done, or buffered in a transaction.
   */
  write(key: CanonicalKey, envelope: StorageEnvelope<TRaw>, options?: WriteOptions): Promise<void>;
  /**
   * @summary Reads the envelope under a key.
   * @description By default, an expired entry is deleted and the result is `null`.
   * @example
   * Reading
   * ```ts
   * const envelope = await backend.read(key);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {ReadOptions} [options] Expiry handling and the signal of the read.
   * @returns {Promise<StorageEnvelope<TRaw> | null>} The envelope, or `null` when the key has no entry.
   */
  read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<TRaw> | null>;
  /**
   * @summary Deletes one entry. A missing key is not an error.
   * @example
   * Deleting
   * ```ts
   * await backend.delete(key);
   * ```
   * @param {CanonicalKey} key The key.
   * @param {object} [options] The transaction and the signal of the delete.
   * @returns {Promise<void>} Resolves when the delete is done, or buffered in a transaction.
   */
  delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void>;
  /**
   * @summary Deletes the entries whose key starts with a prefix, or all entries.
   * @example
   * Clearing one module
   * ```ts
   * await backend.clear('shop:browser:1:cart:');
   * ```
   * @param {string} [prefix] The prefix. Without it, the backend is emptied.
   * @param {object} [options] The signal of the clear.
   * @returns {Promise<void>} Resolves when the entries are deleted.
   */
  clear(prefix?: string, options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * @summary Returns the keys and envelopes that match a query.
   * @example
   * Listing a module
   * ```ts
   * const rows = await backend.query({ prefix: 'shop:browser:1:orders:' });
   * ```
   * @param {StorageQuery} q The criteria.
   * @param {object} [options] The signal of the query.
   * @returns {Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<TRaw> }>>} The matching entries.
   */
  query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<TRaw> }>>;
  /**
   * @summary Counts the entries, or the entries under a prefix.
   * @example
   * Counting a module
   * ```ts
   * await backend.count('shop:browser:1:orders:');
   * ```
   * @param {string} [prefix] The prefix. Without it, all entries count.
   * @returns {Promise<number>} The number of entries.
   */
  count(prefix?: string): Promise<number>;
  /**
   * @summary Opens a transaction.
   * @example
   * An atomic batch
   * ```ts
   * const tx = await backend.beginTransaction();
   * ```
   * @param {TransactionStrength} [strength] The atomicity to ask for.
   * @returns {Promise<ITransaction>} The transaction.
   * @throws {Error} When the backend cannot give the asked strength.
   */
  beginTransaction(strength?: TransactionStrength): Promise<ITransaction>;
  /**
   * @summary Tells if a transaction is open, or if one specific transaction is open.
   * @example
   * Waiting until the transactions end
   * ```ts
   * if (backend.isTransactionActive()) await later();
   * ```
   * @param {string} [txId] The id of the transaction.
   * @returns {boolean} `true` when the transaction (or any transaction) is open.
   */
  isTransactionActive(txId?: string): boolean;
  /**
   * @summary Estimates the use and the free space of the backend.
   * @example
   * Checking the quota
   * ```ts
   * const { ratio } = await backend.estimateQuota();
   * ```
   * @returns {Promise<QuotaEstimate>} The estimate.
   */
  estimateQuota(): Promise<QuotaEstimate>;
  /**
   * @summary Deletes entries until about `targetBytes` are free.
   * @description Expired entries go first. Then entries with the lowest
   * weight go first, and the policy (or the comparator) breaks ties.
   * @example
   * Freeing 5 MB
   * ```ts
   * const removed = await backend.evict(5 * 1024 * 1024, 'lru');
   * ```
   * @param {number} targetBytes The bytes to free.
   * @param {EvictionPolicy} policy How to break ties between entries of the same weight.
   * @param {Function} [comparator] The order for the `user` policy: a negative result evicts `a` first.
   * @returns {Promise<number>} The number of entries removed.
   */
  evict(
    targetBytes: number,
    policy: EvictionPolicy,
    comparator?: (
      a: { key: CanonicalKey; envelope: StorageEnvelope<TRaw> },
      b: { key: CanonicalKey; envelope: StorageEnvelope<TRaw> },
    ) => number,
  ): Promise<number>;
}
