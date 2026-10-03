/**
 * @fileoverview Barrel export for the CacheStorage storage backend module.
 *
 * ## Overview
 * Re-exports the public surface of the cache backend in three categories:
 *
 * - **Types** — interfaces, configuration shapes, and discriminated unions that
 *   external modules (the strategy registry, migration runner, pipeline layer)
 *   may reference without importing implementation files.
 * - **Implementations** — the `CacheBackend` class and `CacheTransaction`
 *   class that are instantiated at runtime.
 * - **Constants** — `CACHE_KEY_NAMESPACE`, used by callers that need to
 *   construct or inspect synthetic cache-entry URLs independently of the
 *   backend class (e.g., DevTools inspection utilities or cache-busting tools).
 *
 * ## What is intentionally NOT exported
 * - `CacheIndexEntry` (private to `cache.ts`; not part of the public contract)
 * - `canonicalKeyToURL` / `urlToCanonicalKey` (internal helpers; use
 *   `CacheBackend` methods instead)
 * - `_putEntry`, `_deleteEntry`, `_applyCommit` and other private methods
 *
 * ## Usage
 * ```ts
 * // Strategy registry - probe and instantiate
 * import { CacheBackend } from './backends/cache'
 *
 * const backend = new CacheBackend({ cacheName: 'app-storage', maxEntries: 500 })
 * const probe   = await backend.probe()
 * if (probe.available) await backend.initialize()
 *
 * // Types only - for type annotations in the pipeline layer
 * import type { CacheBackendConfig, ICacheTransaction } from './backends/cache'
 * ```
 *
 * @author MathAid
 */
export * from './cache';
export * from './cache.const';
export * from './cache.transaction';
export * from './cache.types';
export * from './cache.util';
