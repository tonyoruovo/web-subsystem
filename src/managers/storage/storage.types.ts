import type { ZodType, z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { buildModulePrefix, parseCanonicalKey } from './storage.util';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical key
// ─────────────────────────────────────────────────────────────────────────────

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
 * Canonical key segments before they are joined into a string.
 * Keeping them parsed lets the facade validate and reconstruct without
 * splitting strings at call sites.
 */
export interface ICanonicalKeySegments {
  domain: string;
  platform: UnderlyingPlatform;
  platformVersion: number;
  callingModule: string;
  actualKey: string;
}

/** Fully-qualified canonical key string. */
export type CanonicalKey = `${string}:${UnderlyingPlatform}:${number}:${string}:${string}`;

// ─────────────────────────────────────────────────────────────────────────────
// Storage lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type StorageLifecycle = 'idle' | 'booting' | 'running' | 'winding_down';

// ─────────────────────────────────────────────────────────────────────────────
// Backend identity
// ─────────────────────────────────────────────────────────────────────────────

export type BackendKind =
  'indexeddb' | 'localstorage' | 'sessionstorage' | 'memory' | 'opfs' | 'cache';

// ─────────────────────────────────────────────────────────────────────────────
// Transaction strength
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Describes the atomicity guarantee a backend can provide.
 *
 * - `serializable`  - Full ACID transactions (IndexedDB only).
 * - `compensating`  - Snapshot + restore; not truly atomic (LS / SS).
 * - `best-effort`   - No durability guarantee; in-process only (Memory).
 */
export type TransactionStrength = 'serializable' | 'compensating' | 'best-effort';

/**
 * ### Storage envelope
 * Every value stored in any backend is wrapped in this envelope.
 * The caller never sees it; the pipeline attaches and strips it.
 */
export interface StorageEnvelope<T = unknown> {
  /** The actual stored value (already serialised + encrypted as a string for
   *  disk-backed backends; kept as-is for Memory). */
  payload: T;
  schema_version: number;
  written_at: number; // Unix ms
  expires_at: number | null;
  /** User-defined eviction weight. Higher = more important = evicted last. */
  weight: number;
  /** Which backend originally wrote this entry. */
  backend: BackendKind;
  /** Optional base64 HMAC integrity tag over `payload`. */
  integrity?: string;
}

/**
 * Quota
 */
export interface QuotaEstimate {
  used: number; // bytes
  available: number; // bytes
  ratio: number; // 0–1
}

// ─────────────────────────────────────────────────────────────────────────────
// Eviction policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Controls tie-breaking when multiple entries share the same weight during
 * an eviction sweep.
 */
export type EvictionPolicy =
  | 'lru' // Least recently written
  | 'lfu' // Least frequently read (requires read-count tracking)
  | 'fifo' // Oldest written_at
  | 'user'; // Custom comparator supplied in StorageSchema

/**
 * Change events (emitted via BroadcastChannel after every mutating op)
 */
export type StorageOp = 'set' | 'delete' | 'clear' | 'evict';

export interface StorageChangeEvent {
  key: CanonicalKey;
  op: StorageOp;
  schema_version: number;
  timestamp: number;
  backend: BackendKind;
  /** Identifies which SharedWorker instance emitted this. */
  workerId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability probe result
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityResult {
  available: boolean;
  /** Round-trip latency from the smoke test, ms. */
  latency?: number;
  /** Human-readable reason if unavailable. */
  reason?: string;
}

/**
 * Op types flowing through the scheduler
 */
export type OpKind = 'read' | 'write' | 'delete' | 'clear' | 'transaction' | 'migration';

export interface ScheduledOp<R = unknown> {
  kind: OpKind;
  key?: CanonicalKey;
  transactionId?: string;
  priority: number; // lower = higher priority
  signal?: AbortSignal;
  execute: () => Promise<R>;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageQuery {
  /** Key prefix to filter on (supports partial canonical key). */
  prefix?: string;
  /** Only return entries whose schema_version matches. */
  schema_version?: number;
  /** Only return non-expired entries (default: true). */
  excludeExpired?: boolean;
  /** Maximum number of results. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
}

export interface QueryResult<T = unknown> {
  key: CanonicalKey;
  value: T;
  envelope: Omit<StorageEnvelope, 'payload'>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single migration step.
 *
 * `fromVersion` is the schema_version of the stored data going *in*.
 * The transform must return data valid for `fromVersion + 1`.
 *
 * @example
 * ```ts
 * const v1_to_v2: MigrationStep = {
 *   fromVersion: 1,
 *   transform: (old) => ({ ...old, newField: 'default' }),
 * }
 * ```
 */
export interface MigrationStep {
  fromVersion: number;
  /**
   * Pure function. Receives the raw deserialized (but un-validated) data from
   * the previous schema version and must return data compatible with the next.
   * Throw to abort the migration.
   */
  transform: (data: unknown) => unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-defined schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full schema definition for a logical storage domain.
 *
 * Type parameter `T` is the *application-level* type (what the caller works
 * with). The pipeline bridges `T` <=> `string` (serialized) <=> encrypted blob.
 */
export interface StorageSchema<TSchema extends ZodType = ZodType> {
  /** Zod schema for the current version of the stored value. */
  shape: TSchema;

  /**
   * Monotonically increasing version counter.
   * Increment this whenever you change `shape` in a breaking way and add a
   * corresponding entry to `migrations`.
   */
  version: number;

  /**
   * Ordered list of migration steps that bring stored data up to `version`.
   * Must cover every gap: if stored version is 2 and current is 4 you need
   * steps for 2=>3 and 3=>4.
   */
  migrations?: MigrationStep[];

  /**
   * Custom serializer. Runs *before* encryption on the write path.
   * Defaults to `JSON.stringify`.
   *
   * Return value must be a string - the pipeline will encrypt this string.
   */
  serialize?: (value: z.infer<TSchema>) => string;

  /**
   * Custom deserializer. Runs *after* decryption on the read path.
   * Defaults to `JSON.parse`.
   *
   * Receives the raw decrypted string and must return something that will
   * pass the Zod `shape` validator.
   */
  deserialize?: (raw: string) => unknown;

  /**
   * TTL in milliseconds from write time. `null` means the entry never expires.
   * Can be overridden per write call.
   */
  ttl?: number | null;

  /**
   * Default eviction weight for entries written with this schema.
   * Higher weight = more important = evicted last.
   * Must be a positive number. Defaults to `1`.
   */
  weight?: number;

  /**
   * Tie-breaking eviction policy when weights are equal.
   * Defaults to `'lru'`.
   */
  evictionPolicy?: EvictionPolicy;

  /**
   * Custom eviction comparator. Only used when `evictionPolicy === 'user'`.
   * Return negative if `a` should be evicted before `b`.
   */
  evictionComparator?: (a: QueryResult, b: QueryResult) => number;
}

/**
 * A strategy wraps a backend with the additional metadata the registry needs
 * to select and rank backends at boot time.
 *
 * In most cases a strategy IS a backend - this interface exists to make the
 * registry's concerns explicit without polluting IStorageBackend.
 */
export interface IStorageStrategy<TRaw = string> extends IStorageBackend<TRaw> {
  /**
   * Priority in the fallback chain. Lower = tried first.
   * Registry default: indexeddb=0, localstorage=1, sessionstorage=2, memory=3
   */
  readonly priority: number;

  /**
   * Last probe result, populated after the boot capability check.
   * `null` before `probe()` has been called.
   */
  readonly lastProbe: CapabilityResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline context - threaded through every stage so stages can read metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface WritePipelineContext<TSchema extends ZodType> {
  key: CanonicalKey;
  value: z.infer<TSchema>;
  schema: StorageSchema<TSchema>;
  options: WriteOptions;
}

export interface ReadPipelineContext<TSchema extends ZodType> {
  key: CanonicalKey;
  schema: StorageSchema<TSchema>;
  options: ReadOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owns the ordered transformation chain for reads and writes.
 *
 * Implementations MUST apply stages in the documented order.
 *
 * WRITE order:
 *   1. Zod validate (shape + version check)
 *   2. User serializer (value => string)
 *   3. Encrypt (string => encrypted string)
 *   4. Attach metadata envelope
 *   5. Backend write
 *
 * READ order:
 *   1. Backend read (raw envelope)
 *   2. TTL / expiry check => delete + return null if expired
 *   3. Decrypt (encrypted string => string)
 *   4. schema_version check => run migrations if stale
 *   5. User deserializer (string => unknown)
 *   6. Zod validate
 *   7. Return typed value
 */
export interface IStoragePipeline {
  /**
   * Full write pipeline.
   * Resolves once the backend has durably (or best-effort) stored the value.
   */
  write<TSchema extends ZodType>(ctx: WritePipelineContext<TSchema>): Promise<void>;

  /**
   * Full read pipeline.
   * Returns `null` if the key does not exist or the entry has expired.
   */
  read<TSchema extends ZodType>(
    ctx: ReadPipelineContext<TSchema>,
  ): Promise<z.infer<TSchema> | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facade configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageFacadeConfig {
  /** App/site identifier - becomes the `domain` segment of the canonical key. */
  domain: string;
  platform: UnderlyingPlatform;
  platformVersion: number;
  /**
   * Logical module name for the calling context.
   * Automatically appended to every key written from this facade instance.
   */
  callingModule: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-write / per-read overrides
// ─────────────────────────────────────────────────────────────────────────────

export interface FacadeWriteOptions extends Omit<WriteOptions, 'transactionId'> {
  /** Explicit TTL override in ms. Falls back to schema default. */
  ttl?: number | null;
  weight?: number;
}

export interface FacadeReadOptions extends ReadOptions {
  /**
   * When `true`, a stale (versioned) entry is migrated lazily and written
   * back before being returned. Defaults to `true`.
   */
  lazyMigrate?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription
// ─────────────────────────────────────────────────────────────────────────────

export type StorageChangeHandler = (event: StorageChangeEvent) => void;

export interface ISubscription {
  /** Stop receiving events. */
  unsubscribe(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Callback supplied to `transaction()`.
 * All operations performed on `tx` are part of the transaction.
 * Throw to trigger rollback; return normally to commit.
 */
export type TransactionBlock = (tx: IFacadeTransaction) => Promise<void>;

/**
 * The scoped transaction object passed inside a `TransactionBlock`.
 * Has the same read/write/delete surface as the main facade but scoped to one
 * transaction id.
 */
export interface IFacadeTransaction {
  readonly id: string;
  get<TSchema extends ZodType>(
    key: string,
    schema: StorageSchema<TSchema>,
    options?: FacadeReadOptions,
  ): Promise<z.infer<TSchema> | null>;

  set<TSchema extends ZodType>(
    key: string,
    value: z.infer<TSchema>,
    schema: StorageSchema<TSchema>,
    options?: FacadeWriteOptions,
  ): Promise<void>;

  delete(key: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main facade interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The public API surface exposed to any framework (or plain JavaScript).
 *
 * The facade:
 *  - Resolves canonical keys automatically from config + `actualKey`.
 *  - Forwards ops to the SharedWorker via MessageChannel.
 *  - Hides which backend is active.
 *  - Exposes a mutable `state` slice (a host framework may wrap it for reactivity).
 */
export interface IStorageFacade {
  readonly config: StorageFacadeConfig;

  // ── Core operations ────────────────────────────────────────────────────────

  /**
   * Retrieve a value by its `actualKey` segment.
   * Returns `null` when not found or when the entry has expired.
   *
   * The `schema` drives: Zod validation, migration, and deserialization.
   */
  get<TSchema extends ZodType>(
    key: string,
    schema: StorageSchema<TSchema>,
    options?: FacadeReadOptions,
  ): Promise<z.infer<TSchema> | null>;

  /**
   * Store `value` under `key`.
   * The `schema` drives: Zod validation, serialization, versioning, and TTL.
   */
  set<TSchema extends ZodType>(
    key: string,
    value: z.infer<TSchema>,
    schema: StorageSchema<TSchema>,
    options?: FacadeWriteOptions,
  ): Promise<void>;

  /**
   * Delete the entry identified by `key`.
   * Resolves without error if the key does not exist.
   */
  delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Delete all entries whose canonical key begins with the supplied prefix.
   * If `prefix` is omitted, clears every entry written by this facade instance
   * (i.e., keys matching `domain:platform:version:callingModule:*`).
   */
  clear(prefix?: string, options?: { signal?: AbortSignal }): Promise<void>;

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Query entries. Results are decrypted, validated, and migrated before
   * being returned to the caller - identical pipeline to `get()`.
   */
  query<TSchema extends ZodType>(
    q: StorageQuery,
    schema: StorageSchema<TSchema>,
    options?: FacadeReadOptions,
  ): Promise<Array<QueryResult<z.infer<TSchema>>>>;

  // ── Transactions ───────────────────────────────────────────────────────────

  /**
   * Run a group of ops atomically.
   *
   * ```ts
   * await storage.transaction(async (tx) => {
   *   const user = await tx.get('user', userSchema)
   *   await tx.set('user', { ...user, name: 'Alice' }, userSchema)
   * })
   * ```
   *
   * The block commits on normal return and rolls back if it throws.
   * If the active backend changes mid-transaction, the transaction is aborted.
   */
  transaction(block: TransactionBlock, signal?: AbortSignal): Promise<void>;

  // ── Change events ──────────────────────────────────────────────────────────

  /**
   * Subscribe to storage change events for keys matching `keyOrPrefix`.
   *
   * Events arrive from other tabs (via BroadcastChannel) and from the current
   * tab (forwarded from the SharedWorker).
   *
   * Returns an `ISubscription` - call `.unsubscribe()` to stop listening.
   */
  subscribe(keyOrPrefix: string, handler: StorageChangeHandler): ISubscription;

  // ── Quota ──────────────────────────────────────────────────────────────────

  /** Estimate storage usage for the active backend. */
  quota(): Promise<QuotaEstimate>;

  // ── Key helpers ────────────────────────────────────────────────────────────

  /**
   * Build the full canonical key string from an `actualKey`.
   * Useful when you need to pass a key to lower-level APIs.
   */
  resolveKey(actualKey: string): CanonicalKey;

  /**
   * Parse a canonical key string back into its segments.
   * Returns `null` if the string does not conform to the canonical format.
   */
  parseKey(key: CanonicalKey): ICanonicalKeySegments | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write options
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteOptions {
  /**
   * Per-write TTL override in milliseconds.
   * `null` means no expiry. Falls back to `StorageSchema.ttl` if omitted.
   */
  ttl?: number | null;
  /**
   * Per-write weight override.
   * Falls back to `StorageSchema.weight` if omitted.
   */
  weight?: number;
  /** If provided, this write is part of the named transaction. */
  transactionId?: string;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read options
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadOptions {
  /**
   * When `true` an expired entry is deleted and `null` is returned.
   * Defaults to `true`.
   */
  respectTtl?: boolean;
  signal?: AbortSignal;
}

/**
 * Buffered op (used by compensating + best-effort transactions)
 */
export type TransactionOpKind = 'write' | 'delete' | 'clear';

// ─────────────────────────────────────────────────────────────────────────────
// Transaction handle
// Returned by beginTransaction(); callers hold it until commit/rollback.
// ─────────────────────────────────────────────────────────────────────────────

export interface ITransaction {
  readonly id: string;
  readonly strength: TransactionStrength;
  /** An ordered list of all the operations to be (or already/potentially) performed */
  readonly operations: readonly ITransactionOp[];
  /** Commit all ops buffered under this transaction. */
  commit(): Promise<void>;
  /**
   * @summary Roll back **all** ops buffered under this transaction
   *
   * @description Rolls back **all** ops buffered under this transaction and
   * effectively closes this transaction, releasing all resources allocated
   * to it
   *
   * It is expected that this must not throw
   *
   * @example
   * Simple use case
   * ```
   * const keySegments = getSegments();
   * const backend = getBackend();
   * const tx = await backend.beginTransaction();
   * // { value: number; key: string; }[]
   * const items = await fetchItems();
   * for(let i = 0; i < items.length; i++) {
   *   const item = items[i];
   *   try {
   *     const key = buildCanonicalKey({ ...keySegments, actualKey: item.key });
   *     const envelope = buildEnvelopeFrom(item);
   *     await backend.write(key, envelope, { transactionId: tx.id })
   *   } catch {
   *    x.rollback(); // Kills this transaction
   *  }
   * }
   * ```
   *
   * @returns {Promise<void>} `void` and closes this transaction, invalidating it
   */
  rollback(): Promise<void>;
  /**
   * @description Removes a single transaction operation specified by the
   * index argument. The index is ordered from the initial operation (first,
   * index 0) to the latest (last, n - 1).
   *
   * This does **not** close the transaction neither does it invalidate it.
   * This is meant for the convenience of cancelling a single operation
   * before a commit is executed on this transaction.
   *
   * @example
   * Simple use case
   * ```
   * const keySegments = getSegments();
   * const backend = getBackend();
   * const tx = await backend.beginTransaction();
   * // { value: number; key: string; }[]
   * const items = await fetchItems();
   * for(let i = 0; i < items.length; i++) {
   *   const item = items[i];
   *   try {
   *     const key = buildCanonicalKey({ ...keySegments, actualKey: item.key });
   *     const envelope = buildEnvelopeFrom(item);
   *     await backend.write(key, envelope, { transactionId: tx.id })
   *   } catch { tx.rollback(); }
   * }
   *
   * // ...sometime later
   * await tx.rollback(1); // Removes the 2nd operation from a live transaction
   * ```
   * @param {number} index the placement of the operation to be removed
   *
   * @returns {Readonly<[ITransactionOp | undefined]>} a tuple with the removed
   * operation. This may not throw, instead should return an `undefined` element.
   * See implementation note
   *
   * @see {@linkcode commit} within the implementation itself as this may cause
   * it's behaviour to be undefined
   * @see {@linkcode rollback} (no-arg) within the implementation itself as this
   * may cause it's behaviour to be undefined
   */
  rollback(index: number): Promise<Readonly<[ITransactionOp | undefined]>>;
  /**
   * @description Removes all transaction operations whose canonical key
   * matches the argument and returns them in a readonly array. This does
   * **not** close the transaction neither does it invalidate it.
   *
   * This is meant for the convenience of cancelling operation(s) before a commit
   * is executed on this transaction
   *
   * @example
   * Simple use case
   * ```
   * const keySegments = getSegments();
   * const backend = getBackend();
   * const tx = await backend.beginTransaction();
   * // { value: number; key: string; }[]
   * const items = await fetchItems();
   * for(let i = 0; i < items.length; i++) {
   *   const item = items[i];
   *   try {
   *     const key = buildCanonicalKey({ ...keySegments, actualKey: item.key });
   *     const envelope = buildEnvelopeFrom(item);
   *     await backend.write(key, envelope, { transactionId: tx.id })
   *   } catch { tx.rollback(); }
   * }
   *
   * // ...sometime later
   * await tx.rollback(someCanonicalKey); // Removes all uncommitted
   *                                     // operations from a live transaction
   * ```
   * @param {CanonicalKey} canonicalKey the key to match internal operations
   *
   * @returns {ReadonlyArray<ITransactionOp>} a tuple of all removed operations
   * This may not throw, but return an empty array. See implementation note
   *
   * @see {@linkcode commit} within the implementation itself as this may cause
   * it's behaviour to be undefined
   * @see {@linkcode rollback} (no-arg) within the implementation itself as this
   * may cause it's behaviour to be undefined
   */
  rollback(canonicalKey: CanonicalKey): Promise<ReadonlyArray<ITransactionOp>>;
  /**
   * @description Removes all transaction operations whose canonical key
   * matches/begins-with the argument and returns them in a readonly array. When
   * the {@linkcode ICanonicalKeySegments.actualKey} is omitted, all operations
   * whose prefix match the prefix generated from the argument are removed. This
   * does **not** close the transaction neither does it invalidate it.
   *
   * This is meant for the convenience of cancelling operation(s) before a commit
   * is executed on this transaction
   *
   * @example
   * Simple use case
   * ```
   * const keySegments = getSegments();
   * const backend = getBackend();
   * const tx = await backend.beginTransaction();
   * // { value: number; key: string; }[]
   * const items = await fetchItems();
   * for(let i = 0; i < items.length; i++) {
   *   const item = items[i];
   *   try {
   *     const key = buildCanonicalKey({ ...keySegments, actualKey: item.key });
   *     const envelope = buildEnvelopeFrom(item);
   *     await backend.write(key, envelope, { transactionId: tx.id })
   *   } catch { tx.rollback(); }
   * }
   *
   * // ...sometime later
   * await tx.rollback(omit(keySegments, ['actualKey'])); // Removes all operations
   *                                                      // from this live transaction
   * ```
   * @param {ICanonicalKeySegments} path the key segments defining the absolute
   * path for key/prefix
   *
   * @returns {ReadonlyArray<ITransactionOp>} a tuple of all removed operations
   * This may not throw, but return an empty array. See implementation note
   *
   * @see {@linkcode buildModulePrefix} for how prefixes are formed
   * @see {@linkcode parseCanonicalKey} for how prefixes are formed
   * @see {@linkcode ICanonicalKeySegments}
   * @see {@linkcode CanonicalKey}
   * @see {@linkcode commit} within the implementation itself as this may cause
   * it's behaviour to be undefined
   * @see {@linkcode rollback} (no-arg) within the implementation itself as this
   * may cause it's behaviour to be undefined
   */
  rollback(path: ICanonicalKeySegments): Promise<ReadonlyArray<ITransactionOp>>;
  /**
   * @description Removes all transaction operations matching the condition in the
   * predicate. This does **not** close the transaction neither does it invalidate
   * it.
   *
   * This is meant for the convenience of cancelling operation(s) before a commit
   * is executed on this transaction
   *
   * @example
   * Simple use case
   * ```
   * const keySegments = getSegments();
   * const backend = getBackend();
   * const tx = await backend.beginTransaction();
   * // { value: number; key: string; }[]
   * const items = await fetchItems();
   * for(let i = 0; i < items.length; i++) {
   *   const item = items[i];
   *   try {
   *     const key = buildCanonicalKey({ ...keySegments, actualKey: item.key });
   *     const envelope = buildEnvelopeFrom(item);
   *     await backend.write(key, envelope, { transactionId: tx.id })
   *   } catch { tx.rollback(); }
   * }
   *
   * // ...sometime later
   * await tx.rollback(op => op.kind === 'delete'); // Removes all delete operations
   *                                                // from this live transaction
   * ```
   * @param {ITxOpPredicate} predicate the key segments defining the absolute
   * path for key/prefix
   *
   * @returns {ReadonlyArray<ITransactionOp>} a tuple of all removed operations
   * This may not throw, but return an empty array. See implementation note
   *
   * @see {@linkcode buildModulePrefix} for how prefixes are formed
   * @see {@linkcode parseCanonicalKey} for how prefixes are formed
   * @see {@linkcode ICanonicalKeySegments}
   * @see {@linkcode CanonicalKey}
   * @see {@linkcode commit} within the implementation itself as this may cause
   * it's behaviour to be undefined
   * @see {@linkcode rollback} (no-arg) within the implementation itself as this
   * may cause it's behaviour to be undefined
   */
  rollback(predicate: ITxOpPredicate): Promise<ReadonlyArray<ITransactionOp>>;
  /*
   * @summary Roll back all (or specified) ops buffered under this transaction
   *
   * @description When no argument is provided, rolls back **all** ops buffered
   * under this transaction. When a string is provided, then all ops whose
   * canonical key equals the argument will be removed from operations to be
   * committed. When a number is provided, then the op at that index is removed
   * from operations to be committed. When a predicate is provided, then all ops
   * for which the predicate returns truthy are removed from operations to be
   * committed
   *
   * Note: If `token` is provided, {@linkcode commit} and {@linkcode rollback} may
   * be destabilized and behaviour undefined. This happens because, internally, the
   * operation pipeline has been mutated by this action, hence behaviour changed.
   * See the doc of the implementation in use. This may never rollback (close)
   * this transaction  even if all pending ops are removed by this action. To
   * perform a complete rollback, call this without the argument
   *
   * @param {ITxOpPredicate | string | number} [token] the token used to increase
   * the precision of this removal
   *
   * @returns {Promise<void | Readonly<ITransactionOp>>[]} `void`, when no argument
   * is provided, else returns the cancelled operation(s)
   */
  // rollback(token?: ITxOpPredicate | string | number): Promise<void | Readonly<ITransactionOp>[]>;
}

/**
 * An entry within a transaction
 */
export interface ITransactionOp {
  kind: TransactionOpKind;
  key?: CanonicalKey;
  prefix?: string;
}

export type ITxOpPredicate = (op: ITransactionOp) => boolean;

// ─────────────────────────────────────────────────────────────────────────────
// The unified backend interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every storage backend (Memory, SessionStorage, LocalStorage, IndexedDB)
 * must implement this interface.
 *
 * **Storage - Workflow**
 * ```txt
 * +-------------------------------------------------------------------------+
 * |                          VUE 3.3+ APPLICATION                           |
 * |                                                                         |
 * |  +-------------+   +-------------+   +-------------+   +-------------+  |
 * |  |   Page / Component A          |   |  Page / Component B           |  |
 * |  |                               |   |                               |  |
 * |  |  useStorage('domain:chrome…') |   |  useStorage('domain:chrome…') |  |
 * |  +--------------|----------------+   +---------------|---------------+  |
 * |                 |  Composable (Facade)               |                  |
 * |                 +------------------|-----------------+                  |
 * |                                    |                                    |
 * |             +---------------------\/-----------------------+            |
 * |             |              FACADE LAYER                    |            |
 * |             |                                              |            |
 * |             |  - Resolves canonical key                    |            |
 * |             |  - Attaches calling-module segment           |            |
 * |             |  - Exposes: get / set / delete / query /     |            |
 * |             |             transaction / subscribe          |            |
 * |             |  - Reads capabilities from global state      |            |
 * |             |  - Forwards all ops to SharedWorker via      |            |
 * |             |    MessageChannel (request/response pairs)   |            |
 * |             +----------------------|-----------------------+            |
 * |                                    |                                    |
 * |             +---------------------\/------------------------+           |
 * |             |           PINIA GLOBAL STATE                  |           |
 * |             |                                               |           |
 * |             |  storageState: {                              |           |
 * |             |    lifecycle: idle|booting|running|           |           |
 * |             |               winding_down                    |           |
 * |             |    activeBackend: IndexedDB|LS|SS|Memory      |           |
 * |             |    capabilities: { idb, ls, ss, sw, crypto }  |           |
 * |             |    encryptionReady: boolean                   |           |
 * |             |    pendingOps: Op[]          (drain queue)    |           |
 * |             |    changeLog: ChangeEvent[]  (audit feed)     |           |
 * |             |  }                                            |           |
 * |             +-----------------------------------------------+           |
 * +-------------------------------------------------------------------------+
 *                                      |
 *                     MessageChannel / postMessage
 *                                      |
 * +-----------------------------------\/------------------------------------+
 * |                         SHARED WORKER                                   |
 * |                     (single coordinator thread)                         |
 * |                                                                         |
 * |  +-----------------------------------------------------------------+    |
 * |  |                     LIFECYCLE MANAGER                           |    |
 * |  |                                                                 |    |
 * |  |   idle ==> booting ==> running ==> winding_down ==> idle        |    |
 * |  |               |            |             |                      |    |
 * |  |            abort()      abort()       abort()   (all states     |    |
 * |  |               |            |             |       implement      |    |
 * |  |               +------------┴-------------+       AbortSignal)   |    |
 * |  |                                                                 |    |
 * |  |   Boot sequence:                                                |    |
 * |  |     1. Run capability probes (write/read/delete smoke tests)    |    |
 * |  |     2. Fetch encryption key from remote (with timeout + abort)  |    |
 * |  |     3. Init SubtleCrypto with key, mark encryptionReady         |    |
 * |  |     4. Select active backend strategy via fallback chain        |    |
 * |  |     5. Run schema migrations on active backend                  |    |
 * |  |     6. Drain pendingOps queue                                   |    |
 * |  |     7. Transition to running                                    |    |
 * |  +-----------------------------------------------------------------+    |
 * |                                                                         |
 * |  +-----------------------------------------------------------------+    |
 * |  |                      OP SCHEDULER                               |    |
 * |  |                                                                 |    |
 * |  |   Incoming ops ==> priority queue ==> serial execution          |    |
 * |  |                                                                 |    |
 * |  |   Op types: Read | Write | Delete | Transaction | Migration     |    |
 * |  |   Each op carries: AbortSignal, priority, transactionId?,       |    |
 * |  |                                                                 |    |
 * |  |   Scheduler rules:                                              |    |
 * |  |   - One active transaction at a time (others wait in queue)     |    |
 * |  |   - Backend switch during transaction ==> abort transaction     |    |
 * |  |   - winding_down ==> drain current op, reject rest              |    |
 * |  +-------------------------------|---------------------------------+    |
 * |                                  |                                      |
 * |  +------------------------------\/-----------------------------------+  |
 * |  |                    TRANSACTION MANAGER                            |  |
 * |  |                                                                   |  |
 * |  |   begin() ==> snapshot pre-state ==> execute ops                  |  |
 * |  |                                         |                         |  |
 * |  |                               success? -┤                         |  |
 * |  |                                  yes ==> commit, emit change      |  |
 * |  |                                  no  ==> restore snapshot         |  |
 * |  |                                         (compensating rollback    |  |
 * |  |                                          on LS/SS; native on IDB) |  |
 * |  |                                                                   |  |
 * |  |   Transaction strength levels:                                    |  |
 * |  |     serializable  -- IDB only                                     |  |
 * |  |     compensating  -- LS / SS                                      |  |
 * |  |     best-effort   -- Memory                                       |  |
 * |  |   (strength exposed to caller; mismatch rejects the transaction)  |  |
 * |  +-------------------------------|-----------------------------------+  |
 * |                                  |                                      |
 * |  +------------------------------\/-----------------------------------+  |
 * |  |                      DATA PIPELINE                                |  |
 * |  |              (ordered, applied per op)                            |  |
 * |  |                                                                   |  |
 * |  |   WRITE path:                                                     |  |
 * |  |     validate (Zod) ==> user serializer ==> encrypt                |  |
 * |  |     ==> attach metadata ==> backend write                         |  |
 * |  |                                                                   |  |
 * |  |   READ path:                                                      |  |
 * |  |     backend read ==> check TTL/expiry ==> decrypt                 |  |
 * |  |     ==> check schema_version ==> migrate if stale                 |  |
 * |  |     ==> user deserializer ==> validate (Zod) ==> return           |  |
 * |  |                                                                   |  |
 * |  |   Metadata envelope (stored alongside every entry):               |  |
 * |  |   {                                                               |  |
 * |  |     schema_version: number                                        |  |
 * |  |     written_at:     timestamp                                     |  |
 * |  |     expires_at:     timestamp | null                              |  |
 * |  |     weight:         number    (user-defined, for eviction)        |  |
 * |  |     backend:        string    (which strategy wrote this)         |  |
 * |  |   }                                                               |  |
 * |  +-------------------------------|-----------------------------------+  |
 * |                                  |                                      |
 * |  +------------------------------\/-----------------------------------+  |
 * |  |                    STRATEGY REGISTRY                              |  |
 * |  |                                                                   |  |
 * |  |   Fallback chain (resolved at boot from capability probe):        |  |
 * |  |                                                                   |  |
 * |  |   IndexedDB ==> LocalStorage ==> SessionStorage ==> Memory        |  |
 * |  |      |               |                |               |           |  |
 * |  |   serializable   compensating    compensating    best-effort      |  |
 * |  |   transactions   transactions    transactions    transactions     |  |
 * |  |                                                                   |  |
 * |  |   Each strategy implements:                                       |  |
 * |  |     probe() -> CapabilityResult                                    |  |
 * |  |     read(key) / write(key, envelope) / delete(key)                |  |
 * |  |     beginTx() / commitTx() / rollbackTx()                         |  |
 * |  |     estimateQuota() / evict(policy)                               |  |
 * |  |     close()   <- called during winding_down                        |  |
 * |  |                                                                   |  |
 * |  |   User may override chain order via Facade config                 |  |
 * |  +-------------------------------|-----------------------------------+  |
 * |                                  |                                      |
 * |  +------------------------------\/-----------------------------------+  |
 * |  |                      QUOTA MANAGER                                |  |
 * |  |                                                                   |  |
 * |  |   Monitors: navigator.storage.estimate() on interval              |  |
 * |  |   On pressure:                                                    |  |
 * |  |     1. Evict expired entries first (TTL sweep)                    |  |
 * |  |     2. Sort remaining by user-defined weight                      |  |
 * |  |     3. Apply user eviction policy for tie-breaking                |  |
 * |  |     4. Emit quota warning event to all connected tabs             |  |
 * |  +-------------------------------------------------------------------+  |
 * |                                                                         |
 * |  +------------------------------------------------------------------+   |
 * |  |                   MIGRATION RUNNER                               |   |
 * |  |                                                                  |   |
 * |  |   At boot, per backend:                                          |   |
 * |  |     - Read current stored schema_version                         |   |
 * |  |     - Compare against registered migrations[]                    |   |
 * |  |     - Run transforms sequentially, version by version            |   |
 * |  |     - Each migration: (oldData, oldSchema) => newData            |   |
 * |  |     - Wrap entire migration sequence in a transaction            |   |
 * |  |     - On failure: rollback, surface error, halt boot             |   |
 * |  |                                                                  |   |
 * |  |   Per-entry lazy migration (on READ):                            |   |
 * |  |     - If entry.schema_version < current: migrate that entry      |   |
 * |  |     - Write migrated entry back before returning to caller       |   |
 * |  +------------------------------------------------------------------+   |
 * +-------------------------------------------------------------------------+
 *                                      |
 *                     BroadcastChannel('storage-sync')
 *                                      |
 *               +---------------------\/------------------------+
 *               |          ALL CONNECTED TABS / WINDOWS         |
 *               |                                               |
 *               |  Receives: ChangeEvent {                      |
 *               |    key, op, schema_version, timestamp,        |
 *               |    backend, workerId                          |
 *               |  }                                            |
 *               |                                               |
 *               |  Facade subscribes, updates its state, and    |
 *               |  notifies the host framework                  |
 *               +-----------------------------------------------+
 * ```
 *
 * The methods here operate on **already-processed** data - validation,
 * serialization, encryption, and envelope attachment all happen in the
 * pipeline layer *before* calling the backend. The backend only deals with
 * strings (disk-backed) or arbitrary values (Memory).
 *
 * @template TRaw The raw form that this backend stores internally.
 *   - `string` for LS / SS (they store JSON strings post-encryption).
 *   - `StorageEnvelope` for Memory and IDB (they skip the string encoding step).
 */
export interface IStorageBackend<TRaw = string> {
  /** Human-readable identifier for this backend. */
  readonly kind: BackendKind;

  /**
   * The strongest transaction guarantee this backend can offer.
   * Callers may request a weaker level but never a stronger one.
   */
  readonly transactionStrength: TransactionStrength;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Perform a write/read/delete smoke-test to confirm the backend is actually
   * usable in this environment. Called once at boot.
   */
  probe(): Promise<CapabilityResult>;

  /**
   * Run any backend-level initialisation (open IDB connection, etc.).
   * Called once after `probe()` returns `available: true`.
   */
  initialize(signal?: AbortSignal): Promise<void>;

  /**
   * Gracefully wind down this backend - flush pending writes, close
   * connections, release locks.
   */
  close(): Promise<void>;

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  /**
   * Write `envelope` under `key`.
   *
   * For disk-backed backends, `envelope.payload` is already an encrypted
   * string. For Memory, it is the raw deserialized value.
   */
  write(key: CanonicalKey, envelope: StorageEnvelope<TRaw>, options?: WriteOptions): Promise<void>;

  /**
   * Read the raw envelope stored under `key`, or `null` if absent.
   *
   * Does **not** decrypt, validate, or migrate - the pipeline layer owns that.
   */
  read(key: CanonicalKey, options?: ReadOptions): Promise<StorageEnvelope<TRaw> | null>;

  /**
   * Delete a single entry. Resolves without error if the key does not exist.
   */
  delete(
    key: CanonicalKey,
    options?: { transactionId?: string; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Delete all entries whose key matches `prefix`.
   * If `prefix` is omitted, clears the entire backend.
   */
  clear(prefix?: string, options?: { signal?: AbortSignal }): Promise<void>;

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Return all raw envelopes matching the query criteria.
   * The pipeline layer will decrypt and validate each entry before
   * handing results to the caller.
   */
  query(
    q: StorageQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ key: CanonicalKey; envelope: StorageEnvelope<TRaw> }>>;

  /**
   * Return the total number of entries currently stored.
   */
  count(prefix?: string): Promise<number>;

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * Open a new transaction.
   *
   * @param strength - The requested strength. If the backend cannot satisfy
   *   it, the returned promise rejects.
   */
  beginTransaction(strength?: TransactionStrength): Promise<ITransaction>;

  /**
   * Checks if there is any active transaction or (if argument is provided)
   * if the specified transaction is currently active
   *
   * @param {string} [txId] the transaction (if known) identifier
   *
   * @return {boolean}
   */
  isTransactionActive(txId?: string): boolean;

  // ── Quota ─────────────────────────────────────────────────────────────────

  /**
   * Estimate current usage and remaining capacity.
   */
  estimateQuota(): Promise<QuotaEstimate>;

  /**
   * Evict entries to reclaim space, using the provided policy and optional
   * comparator for tie-breaking.
   *
   * Returns the number of entries removed.
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
/**
 * Pluggable encryption contract.
 *
 * The default implementation uses SubtleCrypto (AES-GCM).
 * Tests can supply a no-op provider to avoid async key setup.
 *
 * The provider is initialized once at boot with the remote-fetched UUID key
 * and lives for the lifetime of the SharedWorker.
 */
export interface IEncryptionProvider {
  /**
   * Whether the provider has been initialized with a key and is ready to use.
   */
  readonly ready: boolean;

  /**
   * Initialize with the raw key material fetched from the remote key server.
   * Must be called before `encrypt` or `decrypt`.
   *
   * @param keyMaterial - UUID string or raw key bytes from the remote endpoint.
   * @param signal      - Abort the initialization (e.g. key-fetch timeout).
   */
  initialize(keyMaterial: string, signal?: AbortSignal): Promise<void>;

  /**
   * Encrypt a plaintext string.
   * Returns a base64-encoded ciphertext string safe to store in any backend.
   */
  encrypt(plaintext: string, signal?: AbortSignal): Promise<string>;

  /**
   * Decrypt a ciphertext string produced by `encrypt`.
   * Returns the original plaintext string.
   *
   * Throws if the ciphertext is malformed or the key does not match.
   */
  decrypt(ciphertext: string, signal?: AbortSignal): Promise<string>;

  /**
   * Release key material from memory.
   * Called during `winding_down`.
   */
  dispose(): void;
}
