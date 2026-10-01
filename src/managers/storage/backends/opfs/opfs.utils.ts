/**
 * @fileoverview OPFS backend filesystem helpers.
 *
 * ## Overview
 * Pure helper functions for the OPFS backend. Grouped into four concerns:
 *
 * 1. **Manifest helpers** - read/write `_manifest.json`.
 * 2. **WAL helpers** - read/write/clear `_wal.json`.
 * 3. **Data file helpers** - derive file paths from canonical keys,
 *    open/create data files, delete data files with directory pruning.
 * 4. **Base64 helpers** - encode/decode payload bytes for WAL JSON serialization.
 *
 * ## Why helpers are separated from the backend class
 * {@link OPFSBackend} already carries the complexity of lifecycle management,
 * transaction coordination, eviction, and quota. Extracting pure filesystem
 * operations into this module keeps each unit small, independently testable,
 * and free of `this` binding issues.
 *
 * Every function in this module is stateless and pure with respect to the
 * in-memory manifest - callers (i.e., OPFSBackend) are responsible for
 * updating the manifest after calling helpers.
 */
import type { CanonicalKey } from '../../storage.types';

import { decodeBytes, encodeString } from './opfs.io';
import type {
  IFileIOAdapter,
  IIOAdapterFactory,
  Manifest,
  ManifestWire,
  WALFile,
} from './opfs.types';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Filename of the manifest inside the OPFS root directory. */
export const MANIFEST_FILENAME = '_manifest.json';

/**
 * Read and deserialize `_manifest.json` from the OPFS root directory.
 *
 * @remarks
 * Returns an empty `Map` when the file does not exist yet, is empty, or
 * contains malformed JSON. The backend treats an empty manifest as a fresh
 * store - the WAL replay step in {@link OPFSBackend.initialize} runs before
 * this function is called in the main boot sequence, so a corrupt manifest
 * after a crash is recovered via WAL replay before this reads it.
 *
 * Adapter is always closed in a `finally` block, releasing any exclusive lock.
 *
 * @param dir     - The OPFS root directory handle.
 * @param factory - IO adapter factory for the current execution context.
 * @returns       The deserialized in-memory manifest.
 */
export async function readManifest(
  dir: FileSystemDirectoryHandle,
  factory: IIOAdapterFactory,
): Promise<Manifest> {
  let adapter: IFileIOAdapter | null = null;
  try {
    const handle = await dir.getFileHandle(MANIFEST_FILENAME, { create: true });
    adapter = await factory.open(handle);
    const bytes = await adapter.readAll();
    if (bytes.byteLength === 0) return new Map();
    const wire = JSON.parse(decodeBytes(bytes)) as ManifestWire;
    return new Map(wire);
  } catch {
    // Corrupt or unreadable manifest - start fresh; WAL replay handles recovery
    return new Map();
  } finally {
    await adapter?.close();
  }
}

/**
 * Serialize and write the in-memory manifest to `_manifest.json`.
 *
 * @remarks
 * Called after every successful mutation (non-transactional) and after
 * every successful transaction commit. The manifest file is fully replaced
 * on each write - no partial updates.
 *
 * `Map` is serialized as a `ManifestWire` array because `JSON.stringify(map)`
 * produces `{}`.
 *
 * @param dir      - The OPFS root directory handle.
 * @param factory  - IO adapter factory.
 * @param manifest - The current in-memory manifest to persist.
 */
export async function writeManifest(
  dir: FileSystemDirectoryHandle,
  factory: IIOAdapterFactory,
  manifest: Manifest,
): Promise<void> {
  const wire: ManifestWire = [...manifest.entries()];
  const bytes: Uint8Array = encodeString(JSON.stringify(wire));
  let adapter: IFileIOAdapter | null = null;
  try {
    const handle = await dir.getFileHandle(MANIFEST_FILENAME, { create: true });
    adapter = await factory.open(handle);
    await adapter.writeAll(bytes);
  } finally {
    await adapter?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WAL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Filename of the WAL inside the OPFS root directory. */
export const WAL_FILENAME = '_wal.json';

/**
 * Read and deserialize `_wal.json` from the OPFS root directory.
 *
 * @remarks
 * Returns `null` when the WAL file does not exist, is empty, or is
 * malformed. A `null` return means "no pending ops to replay" - the backend
 * treats this as a clean state.
 *
 * A non-null return during {@link OPFSBackend.initialize} indicates the
 * previous session crashed mid-commit. The returned ops are replayed by
 * {@link OPFSBackend._replayWALIfPresent}.
 *
 * @param dir     - The OPFS root directory handle.
 * @param factory - IO adapter factory.
 * @returns       The WAL file contents, or `null` if absent/empty.
 */
export async function readWAL(
  dir: FileSystemDirectoryHandle,
  factory: IIOAdapterFactory,
): Promise<WALFile | null> {
  let adapter: IFileIOAdapter | null = null;
  try {
    const handle = await dir.getFileHandle(WAL_FILENAME, { create: true });
    adapter = await factory.open(handle);
    const bytes = await adapter.readAll();
    if (bytes.byteLength === 0) return null;
    return JSON.parse(decodeBytes(bytes)) as WALFile;
  } catch {
    return null;
  } finally {
    await adapter?.close();
  }
}

/**
 * Serialize and write a {@link WALFile} to `_wal.json`.
 *
 * @remarks
 * This is always the **first** step of a transaction commit. Writing the WAL
 * before touching any data file ensures that if the process dies at any
 * subsequent step, the ops can be replayed on next boot.
 *
 * @param dir     - The OPFS root directory handle.
 * @param factory - IO adapter factory.
 * @param wal     - The WAL contents to persist.
 */
export async function writeWAL(
  dir: FileSystemDirectoryHandle,
  factory: IIOAdapterFactory,
  wal: WALFile,
): Promise<void> {
  const bytes = encodeString(JSON.stringify(wal));
  let adapter: IFileIOAdapter | null = null;
  try {
    const handle = await dir.getFileHandle(WAL_FILENAME, { create: true });
    adapter = await factory.open(handle);
    await adapter.writeAll(bytes);
  } finally {
    await adapter?.close();
  }
}

/**
 * Truncate `_wal.json` to zero bytes, signalling a completed commit.
 *
 * @remarks
 * Called as the **last** step of a successful transaction commit, after the
 * manifest has been fully rewritten. A truncated WAL means "nothing to
 * replay" - the store is in a consistent state.
 *
 * @param dir     - The OPFS root directory handle.
 * @param factory - IO adapter factory.
 */
export async function clearWAL(
  dir: FileSystemDirectoryHandle,
  factory: IIOAdapterFactory,
): Promise<void> {
  let adapter: IFileIOAdapter | null = null;
  try {
    const handle = await dir.getFileHandle(WAL_FILENAME, { create: true });
    adapter = await factory.open(handle);
    await adapter.truncate();
  } finally {
    await adapter?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data file helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a stable OPFS-relative file path from a canonical storage key.
 *
 * @remarks
 * ### Mapping rule
 * The first four colon-delimited segments of the canonical key become a
 * directory hierarchy. The `actualKey` (everything after the 4th colon) is
 * percent-encoded to make colons filesystem-safe, then used as the filename.
 *
 * ```
 * "myapp:chrome:130:auth:user-session"
 *                              ↓
 * "myapp/chrome/130/auth/user-session"
 *
 * "myapp:chrome:130:prefs:theme:dark"   (actualKey contains a colon)
 *                              ↓
 * "myapp/chrome/130/prefs/theme%3Adark"
 * ```
 *
 * ### Why a hierarchy
 * Storing all files in a flat directory makes `query()` with prefix
 * filtering degrade to O(n) directory traversal. The hierarchy means a
 * prefix like `"myapp:chrome:130:auth:"` maps naturally to the directory
 * `myapp/chrome/130/auth/`, which can be listed directly.
 *
 * @param key - A valid canonical key string.
 * @returns   The OPFS-relative path (no leading slash).
 * @throws    If `key` has fewer than 5 colon-delimited segments.
 */
export function keyToFilePath(key: CanonicalKey): string {
  const parts = key.split(':');
  if (parts.length < 5) {
    throw new Error(`[OPFS] Cannot derive file path from malformed canonical key: "${key}"`);
  }
  const [domain, platform, version, module, ...rest] = parts;
  // actualKey may contain colons - percent-encode them for filesystem safety
  const encodedActual = rest.join(':').replace(/:/g, '%3A');
  return [domain, platform, version, module, encodedActual].join('/');
}

/**
 * Open (or optionally create) the data file for `filePath` inside `rootDir`.
 *
 * @remarks
 * Creates any missing intermediate subdirectories when `create` is `true`.
 * This is always safe to call before a write, and should be called with
 * `create: false` before a read so that a missing file throws rather than
 * silently creating an empty file.
 *
 * @param rootDir  - The OPFS backend root directory handle.
 * @param filePath - Relative path returned by {@link keyToFilePath}.
 * @param create   - When `true`, intermediate directories and the file are
 *   created if absent. Defaults to `false`.
 * @returns        A handle to the data file.
 * @throws         If `create` is `false` and the file (or any intermediate
 *   directory) does not exist.
 */
export async function openDataFile(
  rootDir: FileSystemDirectoryHandle,
  filePath: string,
  create: boolean = false,
): Promise<FileSystemFileHandle> {
  const parts = filePath.split('/');
  const fileName = parts.pop()!;

  let dir: FileSystemDirectoryHandle = rootDir;
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir.getFileHandle(fileName, { create });
}

/**
 * Delete the data file at `filePath` and prune any empty parent directories.
 *
 * @remarks
 * Silently ignores missing files (`DOMException: NotFoundError`) to make
 * delete operations idempotent - safe to call during WAL replay.
 *
 * ### Directory pruning
 * After removing the file, walks back up the directory hierarchy and removes
 * any directory that is now empty. This prevents accumulating ghost
 * directories after many deletes. The pruning is best-effort - if any step
 * fails (e.g., the directory is non-empty or a race removes it first), the
 * walk stops silently.
 *
 * @param rootDir  - The OPFS backend root directory handle.
 * @param filePath - Relative path of the file to delete.
 */
export async function deleteDataFile(
  rootDir: FileSystemDirectoryHandle,
  filePath: string,
): Promise<void> {
  try {
    const parts = filePath.split('/');
    const fileName = parts.pop()!;
    const dirStack: FileSystemDirectoryHandle[] = [rootDir];
    let dir = rootDir;

    for (const segment of parts) {
      dir = await dir.getDirectoryHandle(segment);
      dirStack.push(dir);
    }

    await dir.removeEntry(fileName);

    // Prune empty parent directories bottom-up (best-effort)
    for (let i = dirStack.length - 1; i >= 1; i--) {
      const parent = dirStack[i - 1];
      const childName = parts[i - 1];
      try {
        const child = await parent.getDirectoryHandle(childName);
        // Peek at the first entry - if there is one, directory is non-empty
        for await (const _ of child.keys()) {
          return; // Non-empty; stop pruning
        }
        await parent.removeEntry(childName);
      } catch {
        return; // Directory gone or unreadable; stop pruning
      }
    }
  } catch {
    // File didn't exist or couldn't be deleted - idempotent, ignore
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a `Uint8Array` to a base64 string.
 *
 * @remarks
 * Used to embed binary payload bytes inside the WAL's JSON format.
 * The WAL is a JSON file; raw bytes cannot be safely embedded in JSON
 * without encoding. Base64 is the standard choice because:
 * - It is 100% ASCII-safe.
 * - It is reversible without loss via {@link base64ToBytes}.
 * - `btoa` and `atob` are available in all browser and Worker contexts.
 *
 * @param bytes - Raw payload bytes to encode.
 * @returns     Base64-encoded string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string produced by {@link bytesToBase64} back to bytes.
 *
 * @remarks
 * Called during WAL application ({@link OPFSBackend._applyWALOps}) to
 * convert the stored `payloadB64` string back to the `Uint8Array` that
 * gets written to the data file.
 *
 * @param b64 - Base64-encoded string.
 * @returns   Decoded `Uint8Array`.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
