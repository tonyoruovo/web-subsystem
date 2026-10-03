/**
 * @fileoverview Barrel export for the IndexedDB storage backend module.
 *
 * ## Overview
 * Re-exports the public surface in three categories:
 *
 * - **Types** — interfaces, configuration shapes, and discriminated unions
 *   for use in the strategy registry, pipeline layer, and tests without
 *   importing implementation files directly.
 * - **Utilities** — IDB Promise wrappers and cursor helpers exported for
 *   test harnesses that need to mock or inspect individual IDB operations.
 * - **Implementations** — `IDBBackend` and `IDBTransaction`, the two classes
 *   instantiated at runtime.
 *
 * ## What is intentionally NOT exported
 * - `IDBRecord` private helper methods (`_assertInitialized`, `_recordToEnvelope`,
 *   `_approximateBytes`, etc.)
 * - `DB_VERSION` is exported from `idb.utils` for test introspection but is
 *   not part of the primary public API.
 *
 * ## Usage
 * ```ts
 * // Strategy registry — probe and instantiate
 * import { IDBBackend } from './backends/indexeddb'
 *
 * const backend = new IDBBackend({ dbName: 'my-app' })
 * const probe   = await backend.probe()
 * if (probe.available) await backend.initialize()
 *
 * // Types only — pipeline layer annotations
 * import type { IDBBackendConfig, IDBRecord, IIDBTransaction } from './backends/indexeddb'
 * ```
 *
 * @author MathAid
 */
export * from './idb.backend';
export * from './idb.transaction';
export * from './idb.types';
export * from './idb.utils';
