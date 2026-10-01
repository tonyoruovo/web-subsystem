/**
 * @fileoverview
 * @summary The Storage facade: schema-validated persistence over a backend.
 * @description
 * Implements the facade and pipeline that the existing storage types describe
 * but do not yet build. It sits on top of any {@linkcode IStorageBackend} and
 * applies the ordered transform chain per write and read. Encryption and
 * compression are gated by one `secure` flag: when `true`, every write is
 * compressed and encrypted; when `false`, none are.
 *
 * ```text
 *   WRITE:  validate -> serialize -> compress -> encrypt -> envelope -> backend.write
 *   READ:   backend.read -> decrypt -> decompress -> deserialize -> migrate -> validate
 *   ```
 *
 * A read never throws on encrypted or compressed data it cannot decode. It
 * warns through the logger and returns `null`. This matches the reliability
 * contract in the architecture.
 *
 * @see {@linkcode IStorageBackend}
 * @see {@linkcode StorageSchema}
 * @author MathAid
 */

import type { ZodType, z } from 'zod';

import { MigrationRunner } from './migration/runner';
import type {
  BackendKind,
  CanonicalKey,
  ICanonicalKeySegments,
  IStorageBackend,
  QueryResult,
  ReadOptions,
  StorageChangeEvent,
  StorageEnvelope,
  StorageFacadeConfig,
  StorageQuery,
  StorageSchema,
  WriteOptions,
} from './storage.types';
import { buildCanonicalKey, parseCanonicalKey } from './storage.util';

/**
 * @summary The string-to-string codec for encryption and compression.
 * @description
 * Both directions are plain strings so the envelope payload stays a string for
 * disk-backed backends. The encryption hook is a {@linkcode CryptoManager}
 * adapter that base64-encodes the encrypted blob.
 */
export interface StorageCodec {
  /** Encrypt a plain string. */
  encrypt(plain: string): Promise<string>;
  /** Decrypt a cipher string. */
  decrypt(cipher: string): Promise<string>;
  /** Compress a plain string. */
  compress(plain: string): Promise<string>;
  /** Decompress a compressed string. */
  decompress(compressed: string): Promise<string>;
  /** Optional: sign a string, returning a base64 tag. */
  sign?(data: string): Promise<string>;
  /** Optional: verify a base64 tag against data. */
  verify?(tag: string, data: string): Promise<boolean>;
}

/**
 * @summary A scoped transaction surface inside a {@linkcode StorageFacade.transaction} block.
 * @description
 * `get` reads committed state (read-your-own-writes is not yet implemented).
 * `set` and `delete` buffer through the backend's transaction id. Nothing is
 * written until the block returns normally.
 */
export interface FacadeTransaction {
  /** The backend transaction id. */
  readonly id: string;
  /** Read a value, as in {@linkcode StorageFacade.get}. */
  get<TSchema extends ZodType>(
    key: string,
    schema: StorageSchema<TSchema>,
    options?: ReadOptions,
  ): Promise<z.infer<TSchema> | null>;
  /** Buffer a write, applied on commit. */
  set<TSchema extends ZodType>(
    key: string,
    value: z.infer<TSchema>,
    schema: StorageSchema<TSchema>,
    options?: WriteOptions,
  ): Promise<void>;
  /** Buffer a delete, applied on commit. */
  delete(key: string): Promise<void>;
}

/**
 * @summary A warn-only logger surface.
 * @description
 * The facade warns here on a decode failure instead of throwing. Defaults to
 * `console.warn`. The Logger manager plugs in later.
 */
export interface WarnSink {
  /** Emit a warning. */
  warn(message: string): void;
}

/**
 * @summary Options for constructing a {@linkcode StorageFacade}.
 */
export interface StorageFacadeOptions {
  /** The backend to persist through. */
  backend: IStorageBackend<string>;
  /** The canonical key config. */
  config: StorageFacadeConfig;
  /** Encrypt and compress every write when `true`. Defaults to `false`. */
  secure?: boolean;
  /** The codec. Required when `secure` is `true`. */
  codec?: StorageCodec;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Warn sink. Defaults to `console`. */
  warn?: WarnSink;
  /** Worker id stamped on change events. Defaults to `main`. */
  workerId?: string;
  /** Optional change-event sink, called after each mutation. */
  emit?: (event: StorageChangeEvent) => void;
}

/**
 * @summary The Storage facade.
 * @description
 * Resolves canonical keys from `actualKey`, applies the pipeline, and forwards
 * to the backend. It is the public surface components and managers use.
 *
 * @example
 * Example 1: Persist and read a typed value
 * ```ts
 * const facade = new StorageFacade({ backend, config });
 * const schema: StorageSchema<z.ZodObject<{ n: z.ZodNumber }>> = { shape: z.object({ n: z.number() }), version: 1 };
 * await facade.set('count', { n: 1 }, schema);
 * const value = await facade.get('count', schema); // { n: 1 }
 * ```
 */
export class StorageFacade {
  /** @internal The backend. */
  private readonly backend: IStorageBackend<string>;

  /** @internal The canonical key config. */
  private readonly config: StorageFacadeConfig;

  /** @internal The secure flag. */
  private readonly secure: boolean;

  /** @internal The codec. */
  private readonly codec?: StorageCodec;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The warn sink. */
  private readonly warn: WarnSink;

  /** @internal The worker id. */
  private readonly workerId: string;

  /** @internal The change-event sink. */
  private readonly emit?: (event: StorageChangeEvent) => void;

  /** @internal The migration runner. */
  private readonly migration = new MigrationRunner();

  /**
   * @summary Creates a StorageFacade.
   * @param {StorageFacadeOptions} options The backend, config, and codec.
   * @throws {Error} When `secure` is `true` but no `codec` is provided.
   */
  constructor(options: StorageFacadeOptions) {
    this.backend = options.backend;
    this.config = options.config;
    this.secure = options.secure ?? false;
    this.codec = options.codec;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? { warn: (m) => console.warn(m) };
    this.workerId = options.workerId ?? 'main';
    this.emit = options.emit;

    if (this.secure && !this.codec) {
      throw new Error('[StorageFacade] secure mode requires a codec');
    }
  }

  /**
   * @summary Builds the canonical key for an `actualKey`.
   * @param {string} actualKey The user-facing key segment.
   * @returns {CanonicalKey} The full canonical key.
   */
  resolveKey(actualKey: string): CanonicalKey {
    return buildCanonicalKey({ ...this.config, actualKey });
  }

  /**
   * @summary Parses a canonical key into its segments.
   * @param {CanonicalKey} key The canonical key.
   * @returns {ICanonicalKeySegments | null} The segments, or `null` when invalid.
   */
  parseKey(key: CanonicalKey): ICanonicalKeySegments | null {
    return parseCanonicalKey(key);
  }

  /**
   * @summary Stores a value under a key.
   * @description
   * Validates, serializes, then compresses and encrypts when secure, wraps in
   * an envelope, and writes to the backend.
   *
   * @param {string} key The `actualKey` segment.
   * @param {z.infer<TSchema>} value The value to store.
   * @param {StorageSchema<TSchema>} schema The schema.
   * @param {WriteOptions} [options] Write options.
   * @returns {Promise<void>}
   */
  async set<TSchema extends ZodType>(
    key: string,
    value: z.infer<TSchema>,
    schema: StorageSchema<TSchema>,
    options?: WriteOptions,
  ): Promise<void> {
    const envelope = await this.encode(value, schema, options);
    const canonical = this.resolveKey(key);
    await this.backend.write(canonical, envelope, options);
    this.emitChange(canonical, 'set', schema.version);
  }

  /**
   * @summary Reads a value by key.
   * @description
   * Reads the raw envelope, decrypts and decompresses when secure, deserializes,
   * migrates when stale, validates, and returns the typed value. Returns `null`
   * when absent or when decoding fails (with a warning).
   *
   * @param {string} key The `actualKey` segment.
   * @param {StorageSchema<TSchema>} schema The schema.
   * @param {ReadOptions} [options] Read options.
   * @returns {Promise<z.infer<TSchema> | null>} The value, or `null`.
   */
  async get<TSchema extends ZodType>(
    key: string,
    schema: StorageSchema<TSchema>,
    options?: ReadOptions,
  ): Promise<z.infer<TSchema> | null> {
    const envelope = await this.backend.read(this.resolveKey(key), options);
    if (!envelope) return null;

    try {
      return await this.decode(envelope, schema);
    } catch (error) {
      this.warn.warn(`[StorageFacade] decode failed for "${key}": ${String(error)}`);
      return null;
    }
  }

  /**
   * @summary Deletes a value by key.
   * @param {string} key The `actualKey` segment.
   * @param {{ signal?: AbortSignal }} [options] Options.
   * @returns {Promise<void>}
   */
  async delete(key: string, options?: { signal?: AbortSignal }): Promise<void> {
    const canonical = this.resolveKey(key);
    await this.backend.delete(canonical, options);
    this.emitChange(canonical, 'delete', 0);
  }

  /**
   * @summary Deletes all entries under a prefix, or everything when omitted.
   * @param {string} [prefix] The prefix to clear.
   * @returns {Promise<void>}
   */
  async clear(prefix?: string): Promise<void> {
    await this.backend.clear(prefix);
    this.emitChange((prefix ?? '') as CanonicalKey, 'clear', 0);
  }

  /**
   * @summary Queries entries and decodes each result.
   * @param {StorageQuery} q The query.
   * @param {StorageSchema<TSchema>} schema The schema to decode with.
   * @param {ReadOptions} [options] Read options.
   * @returns {Promise<Array<QueryResult<z.infer<TSchema>>>>} The decoded results.
   */
  async query<TSchema extends ZodType>(
    q: StorageQuery,
    schema: StorageSchema<TSchema>,
    options?: ReadOptions,
  ): Promise<Array<QueryResult<z.infer<TSchema>>>> {
    const raw = await this.backend.query(q, options);
    const results: Array<QueryResult<z.infer<TSchema>>> = [];

    for (const { key, envelope } of raw) {
      try {
        const value = await this.decode(envelope, schema);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { payload: _payload, ...meta } = envelope;
        results.push({ key, value, envelope: meta });
      } catch (error) {
        this.warn.warn(`[StorageFacade] decode failed during query: ${String(error)}`);
      }
    }

    return results;
  }

  /**
   * @summary Runs a group of writes atomically.
   * @description
   * Begins a backend transaction, runs the block against a scoped transaction,
   * then commits. On any error it rolls back and rethrows. `get` inside the
   * block reads committed state only.
   *
   * @param {(tx: FacadeTransaction) => Promise<void>} block The transaction block.
   * @returns {Promise<void>}
   * @throws {Error} Rethrows the block's error after rolling back.
   */
  async transaction(block: (tx: FacadeTransaction) => Promise<void>): Promise<void> {
    const backendTx = await this.backend.beginTransaction();
    const txId = backendTx.id;

    const tx: FacadeTransaction = {
      id: txId,
      get: (key, schema, options) => this.get(key, schema, options),
      set: async (key, value, schema, options) => {
        const envelope = await this.encode(value, schema, options);
        await this.backend.write(this.resolveKey(key), envelope, {
          ...options,
          transactionId: txId,
        });
      },
      delete: async (key) => {
        await this.backend.delete(this.resolveKey(key), { transactionId: txId });
      },
    };

    try {
      await block(tx);
      await backendTx.commit();
    } catch (error) {
      await backendTx.rollback();
      throw error;
    }
  }

  /**
   * @summary Emits a change event after a mutation.
   * @param {CanonicalKey} key The canonical key (or prefix for a clear).
   * @param {'set' | 'delete' | 'clear'} op The operation.
   * @param {number} schemaVersion The schema version, or 0 when unknown.
   * @returns {void}
   * @internal
   */
  private emitChange(key: CanonicalKey, op: StorageChangeEvent['op'], schemaVersion: number): void {
    if (!this.emit) return;
    this.emit({
      key,
      op,
      schema_version: schemaVersion,
      timestamp: this.now(),
      backend: this.backend.kind as BackendKind,
      workerId: this.workerId,
    });
  }

  /**
   * @summary Encodes a value into a storage envelope.
   * @description
   * Applies the write pipeline: validate, serialize, then compress and encrypt
   * when secure.
   *
   * @param {z.infer<TSchema>} value The value.
   * @param {StorageSchema<TSchema>} schema The schema.
   * @param {WriteOptions} [options] Write options.
   * @returns {Promise<StorageEnvelope<string>>} The envelope.
   * @internal
   */
  private async encode<TSchema extends ZodType>(
    value: z.infer<TSchema>,
    schema: StorageSchema<TSchema>,
    options?: WriteOptions,
  ): Promise<StorageEnvelope<string>> {
    const parsed = schema.shape.parse(value);
    let payload = schema.serialize ? schema.serialize(parsed) : JSON.stringify(parsed);
    let integrity: string | undefined;

    if (this.secure && this.codec) {
      payload = await this.codec.compress(payload);
      payload = await this.codec.encrypt(payload);
      if (this.codec.sign) {
        integrity = await this.codec.sign(payload);
      }
    }

    const ttl = options?.ttl !== undefined ? options.ttl : schema.ttl;
    const expiresAt = ttl === undefined || ttl === null ? null : this.now() + ttl;

    return {
      payload,
      schema_version: schema.version,
      written_at: this.now(),
      expires_at: expiresAt,
      weight: options?.weight ?? schema.weight ?? 1,
      backend: this.backend.kind as BackendKind,
      integrity,
    };
  }

  /**
   * @summary Decodes an envelope into a typed value.
   * @description
   * Applies the read pipeline: decrypt and decompress when secure, deserialize,
   * migrate when stale, then validate.
   *
   * @param {StorageEnvelope<string>} envelope The envelope.
   * @param {StorageSchema<TSchema>} schema The schema.
   * @returns {Promise<z.infer<TSchema>>} The typed value.
   * @throws {Error} When decryption, deserialization, migration, or validation fails.
   * @internal
   */
  private async decode<TSchema extends ZodType>(
    envelope: StorageEnvelope<string>,
    schema: StorageSchema<TSchema>,
  ): Promise<z.infer<TSchema>> {
    let payload = envelope.payload;

    if (this.secure && this.codec) {
      if (this.codec.verify && envelope.integrity) {
        const valid = await this.codec.verify(envelope.integrity, envelope.payload);
        if (!valid) {
          throw new Error('[StorageFacade] integrity mismatch');
        }
      }
      payload = await this.codec.decrypt(payload);
      payload = await this.codec.decompress(payload);
    }

    let data: unknown = schema.deserialize ? schema.deserialize(payload) : JSON.parse(payload);

    if (envelope.schema_version < schema.version) {
      data = this.migration.migrate(data, envelope.schema_version, schema);
    }

    return schema.shape.parse(data) as z.infer<TSchema>;
  }
}
