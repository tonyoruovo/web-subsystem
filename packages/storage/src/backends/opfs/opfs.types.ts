/**
 * @fileoverview OPFS backend domain types.
 *
 * ## Overview
 * This module defines every type that is exclusive to the OPFS backend.
 * Types shared across all backends (envelopes, canonical keys, etc.) live in
 * `storage.types.ts`; this file only introduces OPFS-specific concepts:
 * execution context, the on-disk manifest format, the write-ahead log (WAL),
 * the file I/O adapter abstraction, backend configuration, and the OPFS
 * transaction interface.
 *
 * ## Dependency graph (within the OPFS module)
 * ```
 * opfs.types  <==  opfs.io
 *             <==  opfs.helpers
 *             <==  opfs.transaction
 *             <==  opfs.backend
 * ```
 * `opfs.types` is a leaf - it imports nothing from the OPFS module itself.
 */

import type {
  BackendKind,
  CanonicalKey,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  EvictionPolicy,
  ITransaction,
  ITransactionOp,
  TransactionStrength,
} from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Execution context
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Identifies the JavaScript execution context in which the OPFS backend is
 * running.
 *
 * @remarks
 * The distinction matters because `FileSystemSyncAccessHandle` - the fastest
 * OPFS IO path - is only available inside Worker contexts (SharedWorker,
 * DedicatedWorker, ServiceWorker). On the main UI thread the only available
 * IO path is the fully async `FileSystemWritableFileStream`.
 *
 * The backend detects the context automatically at construction time via
 * {@link detectIOAdapterFactory}, but callers can override it through
 * {@link OPFSBackendConfig.context} (useful in tests).
 *
 * @see {@link IIOAdapterFactory}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle | MDN: FileSystemSyncAccessHandle}
 */
export type OPFSExecutionContext = 'worker' | 'main-thread';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Per-entry metadata record stored in the in-memory manifest index.
 *
 * @remarks
 * The manifest deliberately excludes `payload`. Payload bytes live exclusively
 * in individual data files on OPFS. This separation means that `count()`,
 * prefix-filtered `query()`, TTL sweeps, and quota estimates all run against
 * the in-memory `Map<CanonicalKey, ManifestEntry>` with zero file I/O.
 * Data files are only opened when a caller explicitly needs the payload
 * (i.e., `read()` or a full `query()`).
 *
 * @example
 * ```ts
 * const entry: ManifestEntry = {
 *   schema_version: 2,
 *   written_at:     Date.now(),
 *   expires_at:     Date.now() + 60_000,
 *   weight:         5,
 *   backend:        'opfs',
 *   filePath:       'myapp/chrome/130/auth/user-session',
 *   byteLength:     412,
 * }
 * ```
 */
export interface ManifestEntry {
  /**
   * @summary Schema version stamped at write time. Used to detect stale entries needing migration.
   */
  schema_version: number;
  /**
   * @summary Unix timestamp (ms) when this entry was written. Used for LRU/FIFO eviction.
   */
  written_at: number;
  /**
   * @summary Unix timestamp (ms) after which this entry is considered expired. `null` = no expiry.
   */
  expires_at: number | null;
  /**
   * @summary User-defined eviction weight. Higher = more important = evicted last. Primary sort key during eviction; tie-broken by {@link EvictionPolicy}.
   */
  weight: number;
  /**
   * @summary Which backend wrote this entry. Always `'opfs'` for entries written by this backend.
   */
  backend: BackendKind;
  /**
   * @summary Relative path within the OPFS root directory where the payload file lives.
   * @description
   * Derived from the canonical key via {@link keyToFilePath}:
   * `"myapp:chrome:130:auth:user-session"` -> `"myapp/chrome/130/auth/user-session"`
   */
  filePath: string;
  /**
   * @summary Byte length of the stored payload. Used for quota estimation without opening the file.
   */
  byteLength: number;
  /**
   * @summary The HMAC tag of the payload, when the collection is encrypted.
   */
  integrity?: string;
}

/**
 * The full in-memory manifest.
 *
 * @remarks
 * Loaded once from `_manifest.json` during {@link OPFSBackend.initialize} and
 * kept in memory for the lifetime of the backend instance. Rewritten to disk
 * after every successful mutation (direct or transactional).
 *
 * On-disk format is {@link ManifestWire} (a plain JSON array, since
 * `JSON.stringify(Map)` produces `{}`).
 */
export type Manifest = Map<CanonicalKey, ManifestEntry>;

/**
 * Wire format of the manifest file (`_manifest.json`).
 *
 * @remarks
 * `Map` cannot be directly JSON-serialized, so the manifest is written as an
 * array of `[key, entry]` tuples and reconstructed via `new Map(wire)` on
 * read.
 *
 * @example On-disk content
 * ```json
 * [
 *   ["myapp:chrome:130:auth:session", { "schema_version": 1, ... }],
 *   ["myapp:chrome:130:prefs:theme",  { "schema_version": 3, ... }]
 * ]
 * ```
 */
export type ManifestWire = Array<[CanonicalKey, ManifestEntry]>;

// ─────────────────────────────────────────────────────────────────────────────
// Write-ahead log (WAL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of mutation kinds that can appear in the WAL.
 *
 * @remarks
 * **Reads are intentionally absent.** The WAL records mutations only -
 * things that change stored state and therefore need to be recoverable.
 * A `read` inside a transaction does not change state, so there is nothing
 * to log or replay.
 *
 * Read-your-own-writes semantics (reading an uncommitted write within the
 * same transaction) is a pipeline-layer concern, not a WAL concern.
 */
export type WALOpKind = 'write' | 'delete' | 'clear';

/**
 * A WAL op that records the intent to write a new entry (or overwrite an
 * existing one).
 *
 * @remarks
 * `payloadB64` is the payload bytes encoded as base64 so the entire WAL can
 * be serialized to JSON without binary escaping issues. Decoded back to
 * `Uint8Array` during {@link OPFSBackend._applyWALOps}.
 */
export interface WALWriteOp extends ITransactionOp {
  /**
   * @summary The kind of operation: `write`.
   */
  kind: 'write';
  /**
   * @summary The key to write.
   */
  key: CanonicalKey;
  /**
   * @summary Relative path within the OPFS root. Stored here so replay does not need to re-derive it.
   */
  filePath: string;
  /**
   * @summary Base64-encoded payload bytes (post-encrypt, pre-decode).
   */
  payloadB64: string;
  /**
   * @summary Manifest metadata to persist alongside the payload.
   */
  meta: ManifestEntry;
}

/**
 * A WAL op that records the intent to delete a single entry.
 *
 * @remarks
 * `filePath` is stored so that replay can locate and remove the data file
 * even if the in-memory manifest has already been cleared (e.g., on crash
 * recovery before the manifest is loaded).
 */
export interface WALDeleteOp extends ITransactionOp {
  /**
   * @summary The kind of operation: `delete`.
   */
  kind: 'delete';
  /**
   * @summary The key to delete.
   */
  key: CanonicalKey;
  /**
   * @summary The path of the data file, relative to the OPFS root. Replay uses it when the manifest is not loaded.
   */
  filePath: string;
}

/**
 * A WAL op that records the intent to clear all entries matching an optional
 * key prefix, or the entire store if `prefix` is omitted.
 */
export interface WALClearOp extends ITransactionOp {
  /**
   * @summary The kind of operation: `clear`.
   */
  kind: 'clear';
  /**
   * @summary If present, only entries whose canonical key starts with this string are cleared.
   */
  prefix?: string;
}

/**
 * @summary Discriminated union of all WAL operation types
 *
 * @description
 * The WAL (write-ahead log) is a durability primitive, not a query primitive. It
 * records **mutations only** - the three things that can change stored state:
 * writing a value, deleting a key, and clearing a prefix. The sequence is:
 *
 * 1. Before touching any file, serialize the full list of intended mutations to
 * `_wal.json`
 * 2. Apply each mutation to OPFS files and the in-memory manifest
 * 3. Rewrite `_manifest.json` to reflect the new state
 * 4. Truncate `_wal.json` to signal completion
 *
 * If the process dies at step 2 or 3, the WAL is still on disk. `initialize()`
 * finds it, replays the ops (which are idempotent), rewrites the manifest, then
 * clears the WAL. This is crash recovery - the store always ends up consistent
 * regardless of when power is lost.
 *
 * ---
 *
 * ### No GET in WAL - correct by design
 *
 * Reads have no place in a WAL. The WAL's only job is to make mutations durable
 * and recoverable. A read inside a transaction does not change any state, so there
 * is nothing to log, replay, or roll back. What a transactional read *does* need is
 * **read-your-own-writes**: if you write key `A` inside a transaction and then read
 * key `A` in the same transaction before committing, you should see the uncommitted
 * value. That is a transaction-scope concern, not a WAL concern, and it is not yet
 * implemented - the current `read()` path ignores `transactionId` entirely and always
 * reads from committed state. This is a known gap that belongs in the pipeline layer
 * (which will maintain a per-transaction read buffer).
 *
 * ---
 *
 * ### What OPFS receives and stores
 *
 * `OPFSBackend` is typed `IStorageBackend<string>` - the `string` is the
 * **already-encrypted, already-serialized payload**. The pipeline will have already
 * run: `zod.parse -> user serializer -> encrypt -> wrap in envelope`. By the time
 * `write(key, envelope)` reaches the backend, `envelope.payload` is an opaque
 * encrypted string. The backend encodes it to UTF-8 bytes (`encodeString(envelope.payload)`),
 * writes those bytes to the data file, and on read decodes them back to a string and
 * returns it. The backend never knows what the string contains. Encryption and schema
 * are entirely the pipeline's concern.
 */
export type WALOp = WALWriteOp | WALDeleteOp | WALClearOp;

/**
 * The complete contents of the `_wal.json` file.
 *
 * @remarks
 * Written atomically (as a single JSON string) before any mutation is applied
 * to OPFS data files. Presence of a non-empty WAL file on {@link OPFSBackend.initialize}
 * indicates a crash occurred mid-commit; the ops are replayed to restore
 * consistency.
 *
 * **Crash recovery guarantee:**
 * ```
 * State at crash          | Recovery action
 * ------------------------|--------------------------------------------------------
 * Before WAL written      | Nothing applied -> no recovery needed
 * WAL written, no ops     | Replay WAL -> reach intended final state
 * Ops partial, no manifest│ Replay WAL (ops are idempotent) -> consistent
 * Manifest written        | Replay WAL -> manifest already up-to-date -> consistent
 * WAL cleared             | Nothing to recover
 * ```
 */
export interface WALFile {
  /**
   * @summary ID of the transaction that generated these ops. Used for diagnostics/logging.
   */
  transactionId: string;
  /**
   * @summary The operations to replay, in order.
   */
  ops: WALOp[];
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal read/write contract for a single OPFS file.
 *
 * @remarks
 * Implementations differ by execution context:
 * - {@link SyncFileIOAdapter} - uses `FileSystemSyncAccessHandle` (Worker only).
 *   Synchronous kernel-level reads and writes; lowest latency.
 * - {@link AsyncFileIOAdapter} - uses `FileSystemWritableFileStream` (any context).
 *   Fully async; slightly higher overhead per operation.
 *
 * Both implementations expose the same async interface to the backend so
 * {@link OPFSBackend} is context-agnostic.
 *
 * @example
 * ```ts
 * const factory = detectIOAdapterFactory()
 * const handle  = await dir.getFileHandle('my-file', { create: true })
 * const io      = await factory.open(handle)
 *
 * await io.writeAll(encodeString('hello'))
 * const bytes = await io.readAll()   // Uint8Array
 * await io.close()
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle | MDN: FileSystemSyncAccessHandle}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream | MDN: FileSystemWritableFileStream}
 */
export interface IFileIOAdapter {
  /**
   * @summary Reads all the bytes of the file.
   * @example
   * Reading
   * ```ts
   * const bytes = await io.readAll();
   * ```
   * @returns {Promise<Uint8Array>} The contents of the file.
   */
  readAll(): Promise<Uint8Array>;
  /**
   * @summary Replaces the contents of the file with `data`.
   * @description After the call, the length of the file is `data.byteLength`.
   * @example
   * Writing
   * ```ts
   * await io.writeAll(new TextEncoder().encode('hello'));
   * ```
   * @param {Uint8Array} data The new contents.
   * @returns {Promise<void>} Resolves when the bytes are written.
   */
  writeAll(data: Uint8Array): Promise<void>;
  /**
   * @summary Truncate the file to zero bytes. Used to clear the WAL and manifest.
   */
  truncate(): Promise<void>;
  /**
   * @summary Flush OS write buffers and release any lock held on the file.
   * @remarks
   * For the sync adapter this closes the `FileSystemSyncAccessHandle`, which
   * releases the exclusive lock. **Always call `close()` after each operation
   * sequence** - failing to do so will prevent other tabs or contexts from
   * opening a sync handle on the same file.
   *
   * For the async adapter this is a no-op (no persistent handle is held).
   */
  close(): Promise<void>;
}

/**
 * Factory that creates {@link IFileIOAdapter} instances for a given
 * `FileSystemFileHandle`.
 *
 * @remarks
 * The factory is selected once at backend construction time based on the
 * detected (or configured) execution context. All subsequent IO operations
 * go through adapters created by this factory, ensuring consistent IO
 * semantics across the lifetime of the backend.
 */
export interface IIOAdapterFactory {
  /**
   * @summary The execution context this factory targets.
   */
  readonly context: OPFSExecutionContext;
  /**
   * @summary Opens an adapter on a file.
   * @example
   * Opening
   * ```ts
   * const io = await factory.open(await dir.getFileHandle('data', { create: true }));
   * ```
   * @param {FileSystemFileHandle} handle The file.
   * @returns {Promise<IFileIOAdapter>} The adapter. Close it after use.
   */
  open(handle: FileSystemFileHandle): Promise<IFileIOAdapter>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construction-time configuration for {@link OPFSBackend}.
 *
 * All fields are optional; defaults are documented per field.
 *
 * @example
 * ```ts
 * // SharedWorker - use sync IO, isolate under 'app-cache' directory
 * const backend = new OPFSBackend({
 *   rootDirName:   'app-cache',
 *   context:       'worker',
 *   lockTimeoutMs: 3_000,
 * })
 *
 * // Main thread - auto-detect, default directory
 * const backend = new OPFSBackend()
 * ```
 */
export interface OPFSBackendConfig {
  /**
   * @summary Name of the root directory created inside the OPFS origin root.
   * @description
   * Different `rootDirName` values isolate independent stores within the same
   * origin. Useful when running multiple logical storage domains from a single
   * app without key-space collisions.
   * @defaultValue `'storage'`
   */
  rootDirName?: string;

  /**
   * @summary Override the automatic execution context detection.
   * @remarks
   * Primarily useful in unit tests where the detection heuristic
   * (`typeof window === 'undefined'`) may not reflect the intended test
   * environment. In production, leave this unset and let
   * {@link detectIOAdapterFactory} decide.
   *
   * @defaultValue auto-detected via {@link detectIOAdapterFactory}
   */
  context?: OPFSExecutionContext;

  /**
   * @summary Maximum time in milliseconds to wait for a `FileSystemSyncAccessHandle` lock before aborting the operation.
   * @remarks
   * Relevant only in Worker context. A sync handle holds an exclusive lock
   * on the file; if another handle for the same file is already open (e.g.,
   * a bug left a handle unclosed), subsequent open attempts will queue.
   * This timeout prevents indefinite blocking.
   *
   * @defaultValue `5000`
   */
  lockTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPFS transaction interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The OPFS-specific transaction handle.
 *
 * @remarks
 * Extends {@link ITransaction} with the op-buffering methods that
 * {@link OPFSBackend} calls internally when a `transactionId` is present on
 * a write/delete/clear call.
 *
 * Callers who obtain a transaction via {@link OPFSBackend.beginTransaction}
 * receive this typed as the narrower {@link ITransaction} - the buffer
 * methods are an internal contract between the backend and its transaction
 * objects, not part of the public API.
 *
 * Transaction strength is permanently fixed at `'compensating'`:
 * - Ops are buffered in memory until `commit()`.
 * - `commit()` writes the WAL then applies ops - recoverable on crash.
 * - `rollback()` discards the buffer - zero filesystem changes.
 *
 * @see {@link OPFSTransaction} for the concrete implementation.
 */
export interface IOPFSTransaction extends ITransaction {
  /**
   * @summary Always `'compensating'` - OPFS cannot provide serializable transactions.
   */
  readonly strength: Extract<TransactionStrength, 'compensating'>;
  /**
   * @summary The accumulated op buffer. Exposed for inspection; do not mutate externally.
   */
  readonly operations: readonly WALOp[];
  /**
   * @summary Buffer a write op. Called by {@link OPFSBackend.write} when a `transactionId` is present in `WriteOptions`.
   * @param {CanonicalKey} key The key.
   * @param {string} filePath The path of the data file.
   * @param {string} payloadB64 The payload bytes, in base64.
   * @param {ManifestEntry} meta The manifest metadata of the entry.
   * @returns {void}
   */
  bufferWrite(key: CanonicalKey, filePath: string, payloadB64: string, meta: ManifestEntry): void;
  /**
   * @summary Buffer a delete op. Called by {@link OPFSBackend.delete} when a `transactionId` is present.
   * @param {CanonicalKey} key The key.
   * @param {string} filePath The path of the data file.
   * @returns {void}
   */
  bufferDelete(key: CanonicalKey, filePath: string): void;
  /**
   * @summary Buffer a clear op. Called by {@link OPFSBackend.clear} when a `transactionId` is present.
   * @param {string} [prefix] The prefix. Without it, the commit clears every entry.
   * @returns {void}
   */
  bufferClear(prefix?: string): void;
}
