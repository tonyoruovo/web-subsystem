/**
 * @fileoverview OPFS file I/O adapter implementations.
 *
 * ## Overview
 * This module provides two concrete implementations of {@link IFileIOAdapter}
 * and their corresponding factories:
 *
 * - {@link SyncFileIOAdapter} / {@link SyncIOAdapterFactory}
 *   Wraps `FileSystemSyncAccessHandle`. Available **only in Worker contexts**
 *   (SharedWorker, DedicatedWorker, ServiceWorker). Synchronous at the OS
 *   level - no promise scheduling on every byte transfer. This is the
 *   preferred IO path when the backend runs in a SharedWorker.
 *
 * - {@link AsyncFileIOAdapter} / {@link AsyncIOAdapterFactory}
 *   Wraps `FileSystemWritableFileStream`. Available in all contexts including
 *   the main UI thread. Fully async. Used as the fallback when sync handles
 *   are unavailable.
 *
 * ## Context detection
 * {@link detectIOAdapterFactory} probes the runtime environment and returns
 * the most capable factory. The test for "Worker context" is:
 * ```
 * typeof window === 'undefined'                       // not the main thread
 * && typeof FileSystemFileHandle !== 'undefined'      // OPFS available
 * && 'createSyncAccessHandle' in FileSystemFileHandle.prototype
 * ```
 *
 * ## Quirks
 * ### ArrayBuffer vs SharedArrayBuffer
 * `FileSystemSyncAccessHandle.write()` and `FileSystemWritableFileStream.write()`
 * both require `ArrayBufferView<ArrayBuffer>` - they reject views backed by a
 * `SharedArrayBuffer`. `encodeString()` produces a `Uint8Array` whose `.buffer`
 * may be a `SharedArrayBuffer` in certain environments (e.g., when
 * `crossOriginIsolated` is true and the runtime uses shared memory for
 * TextEncoder output). Both adapters defensively copy the buffer to a plain
 * `ArrayBuffer` before writing:
 * ```ts
 * const plain = data.buffer instanceof ArrayBuffer
 *   ? data.buffer
 *   : (data.buffer.slice(0) as unknown) as ArrayBuffer
 * ```
 *
 * ### Exclusive lock (sync adapter)
 * A `FileSystemSyncAccessHandle` holds an **exclusive lock** on the file
 * for its entire lifetime. {@link SyncFileIOAdapter.close} must always be
 * called after use. The backend achieves this by calling `close()` in a
 * `finally` block in every helper that opens an adapter.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle | MDN: FileSystemSyncAccessHandle}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream | MDN: FileSystemWritableFileStream}
 */

import type { IFileIOAdapter, IIOAdapterFactory, OPFSExecutionContext } from './opfs.types';

// ─────────────────────────────────────────────────────────────────────────────
// Encoding utilities
// ─────────────────────────────────────────────────────────────────────────────

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/**
 * Encode a UTF-8 string to bytes.
 *
 * @remarks
 * Module-level encoder instance is reused to avoid repeated allocations.
 * The returned `Uint8Array` may share an `ArrayBuffer` with the encoder's
 * internal buffer in some runtimes - see the fileoverview note on
 * `SharedArrayBuffer` for why adapters defensively copy before writing.
 */
export function encodeString(s: string): Uint8Array {
  return _encoder.encode(s);
}

/**
 * Decode a UTF-8 byte array back to a string.
 *
 * @remarks
 * Module-level decoder instance is reused to avoid repeated allocations.
 */
export function decodeBytes(b: Uint8Array): string {
  return _decoder.decode(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync adapter - Worker context only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IO adapter backed by `FileSystemSyncAccessHandle`.
 *
 * @remarks
 * ### When to use
 * Use inside a SharedWorker or DedicatedWorker where synchronous filesystem
 * access is permitted. This is the preferred adapter because:
 * - Reads and writes are synchronous at the OS level (no event-loop re-entry).
 * - No async scheduling overhead between operations in a hot path.
 *
 * ### Locking
 * Acquiring a `FileSystemSyncAccessHandle` takes an exclusive lock on the
 * file. No other tab, worker, or context can open a second sync handle until
 * this one is closed. Always call {@link close} after each use.
 *
 * ### Usage
 * Obtain via {@link SyncIOAdapterFactory.open}, not directly.
 */
class SyncFileIOAdapter implements IFileIOAdapter {
  constructor(private readonly _handle: FileSystemSyncAccessHandle) {}

  async readAll(): Promise<Uint8Array> {
    const size = this._handle.getSize();
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    this._handle.read(view, { at: 0 });
    return new Uint8Array(buffer);
  }

  async writeAll(data: Uint8Array): Promise<void> {
    // Truncate first - guarantees no stale bytes beyond the new content length
    this._handle.truncate(0);
    // Copy to plain ArrayBuffer if needed (guards against SharedArrayBuffer)
    const plain = data.buffer instanceof ArrayBuffer ? data : new Uint8Array(data.buffer.slice(0));
    this._handle.write(plain, { at: 0 });
    // flush() persists bytes to disk synchronously
    this._handle.flush();
  }

  async truncate(): Promise<void> {
    this._handle.truncate(0);
    this._handle.flush();
  }

  async close(): Promise<void> {
    // Releases the exclusive lock on the file
    this._handle.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async adapter - main thread (and Worker fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IO adapter backed by `FileSystemWritableFileStream`.
 *
 * @remarks
 * ### When to use
 * Use on the main UI thread (where `createSyncAccessHandle` is unavailable)
 * or in any context where the sync adapter cannot be obtained.
 *
 * ### No persistent handle
 * Unlike the sync adapter, this class does not hold a persistent handle
 * between operations. Each {@link writeAll} and {@link truncate} call opens
 * a fresh `FileSystemWritableFileStream` and closes it before returning.
 * This means:
 * - No exclusive lock is held between calls (safe for concurrent readers).
 * - Each write incurs the overhead of opening and closing a stream.
 *
 * ### Usage
 * Obtain via {@link AsyncIOAdapterFactory.open}, not directly.
 */
class AsyncFileIOAdapter implements IFileIOAdapter {
  constructor(private readonly _handle: FileSystemFileHandle) {}

  async readAll(): Promise<Uint8Array> {
    // getFile() returns a snapshot - safe to call multiple times
    const file = await this._handle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeAll(data: Uint8Array): Promise<void> {
    // keepExistingData: false truncates the file before writing
    const writable = await this._handle.createWritable({ keepExistingData: false });
    // Copy to plain ArrayBuffer if needed (guards against SharedArrayBuffer)
    const plain =
      data.buffer instanceof ArrayBuffer
        ? data.buffer
        : (data.buffer.slice(0) as unknown as ArrayBuffer);
    await writable.write(plain);
    await writable.close();
  }

  async truncate(): Promise<void> {
    const writable = await this._handle.createWritable({ keepExistingData: false });
    await writable.truncate(0);
    await writable.close();
  }

  /** No-op - async adapter holds no persistent handle between calls. */
  async close(): Promise<void> {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates {@link SyncFileIOAdapter} instances.
 *
 * @remarks
 * Only instantiate this inside a Worker context. On the main thread,
 * `createSyncAccessHandle()` throws `InvalidStateError`.
 *
 * @example
 * ```ts
 * // Inside a SharedWorker
 * const factory = new SyncIOAdapterFactory()
 * const handle  = await rootDir.getFileHandle('data', { create: true })
 * const io      = await factory.open(handle)
 * await io.writeAll(bytes)
 * await io.close()
 * ```
 */
export class SyncIOAdapterFactory implements IIOAdapterFactory {
  readonly context: OPFSExecutionContext = 'worker';

  /**
   * @param lockTimeoutMs - Maximum time to wait for the file's exclusive sync
   * handle (see `OPFSBackendConfig.lockTimeoutMs`). Defaults to 5000.
   */
  constructor(private readonly lockTimeoutMs: number = 5_000) {}

  /**
   * @throws {DOMException} `TimeoutError` when the file's lock is not acquired
   * within `lockTimeoutMs`. A handle that arrives after the timeout is closed,
   * so the lock is not leaked.
   */
  async open(handle: FileSystemFileHandle): Promise<IFileIOAdapter> {
    const pending = handle.createSyncAccessHandle();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new DOMException(
              `[OPFS] Timed out after ${this.lockTimeoutMs} ms waiting for the file lock.`,
              'TimeoutError',
            ),
          ),
        this.lockTimeoutMs,
      );
    });
    try {
      const syncHandle = await Promise.race([pending, timeout]);
      return new SyncFileIOAdapter(syncHandle);
    } catch (error) {
      // Release a handle that is acquired after we gave up waiting.
      pending.then((late) => late.close()).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Creates {@link AsyncFileIOAdapter} instances.
 *
 * @remarks
 * Safe to use in any context - main thread, SharedWorker, DedicatedWorker.
 * Falls back automatically when sync handles are not available.
 *
 * @example
 * ```ts
 * // Main thread or worker fallback
 * const factory = new AsyncIOAdapterFactory()
 * const handle  = await rootDir.getFileHandle('data', { create: true })
 * const io      = await factory.open(handle)
 * await io.writeAll(bytes)
 * // close() is a no-op for the async adapter
 * await io.close()
 * ```
 */
export class AsyncIOAdapterFactory implements IIOAdapterFactory {
  readonly context: OPFSExecutionContext = 'main-thread';

  async open(handle: FileSystemFileHandle): Promise<IFileIOAdapter> {
    return new AsyncFileIOAdapter(handle);
  }
}

/**
 * Detect the current execution context and return the most capable
 * {@link IIOAdapterFactory}.
 *
 * @remarks
 * Detection criteria for Worker context (sync adapter):
 * 1. `typeof window === 'undefined'` - not the main thread.
 * 2. `typeof FileSystemFileHandle !== 'undefined'` - OPFS is available.
 * 3. `'createSyncAccessHandle' in FileSystemFileHandle.prototype` - sync handles exist.
 *
 * If any condition fails, the async factory is returned as the safe default.
 *
 * @example
 * ```ts
 * // Automatically picks the right factory for the current context
 * const factory = detectIOAdapterFactory()
 * console.log(factory.context) // 'worker' or 'main-thread'
 * ```
 */
export function detectIOAdapterFactory(lockTimeoutMs?: number): IIOAdapterFactory {
  const isWorker =
    typeof window === 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createSyncAccessHandle' in FileSystemFileHandle.prototype;

  return isWorker ? new SyncIOAdapterFactory(lockTimeoutMs) : new AsyncIOAdapterFactory();
}
