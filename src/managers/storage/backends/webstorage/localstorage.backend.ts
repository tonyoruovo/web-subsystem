/**
 * @fileoverview `localStorage`-backed storage backend.
 *
 * ## Overview
 * `LocalStorageBackend` is a thin concrete subclass of `WebStorageBackend`.
 * It injects `window.localStorage` and the `'localstorage'` backend kind
 * into the shared abstract implementation. Every behavioural detail — CRUD,
 * transactions, quota estimation, eviction, recovery — is inherited without
 * modification.
 *
 * ## Characteristics
 * - **Persistence**: data survives tab close, window close, and browser restart.
 *   Cleared only by explicit `removeItem` / `clear`, or by the user via
 *   DevTools / browser settings.
 * - **Scope**: shared across all tabs and windows for the same origin.
 *   Cross-tab writes arrive as `storage` events; the SharedWorker scheduler
 *   serializes in-process writes.
 * - **Quota**: typically 5–10 MB per origin (browser-dependent). Shared with
 *   all other `localStorage` consumers on the same origin.
 * - **Availability**: unavailable in Firefox private mode (throws `SecurityError`
 *   on `window.localStorage` access). `probe()` catches this and returns
 *   `{ available: false }`.
 * - **Priority**: 3 in the backend fallback chain — after IndexedDB (0), OPFS
 *   (1), CacheStorage (2), and before SessionStorage (4) and Memory (5).
 *
 * @see {@link WebStorageBackend} for the full implementation.
 * @see {@link SessionStorageBackend} for the session-scoped sibling.
 */

import { WebStorageBackend } from './webstorage.backend';
import type { WebStorageConfig } from './webstorage.types';

/**
 * @summary `localStorage`-backed implementation of `IStorageBackend<string>`.
 *
 * @description
 * `LocalStorageBackend` delegates all storage operations to the shared
 * `WebStorageBackend` abstract class, injecting `window.localStorage` as the
 * underlying `Storage` handle. Construction is the only point of divergence
 * from `SessionStorageBackend`.
 *
 * Instantiate this class directly via the strategy registry or for testing.
 * Do not subclass it further.
 *
 * **Note on `window.localStorage` access**: the property is accessed at
 * construction time and stored in `_storage`. In environments where
 * `localStorage` is unavailable (Firefox private mode, sandboxed iframes),
 * the access itself may throw `SecurityError`. The strategy registry always
 * calls `probe()` before `initialize()`, and `probe()` wraps the `setItem`
 * call in a `try/catch` — but if construction itself throws, the registry
 * should catch that error and skip this backend. Callers that construct
 * `LocalStorageBackend` directly should wrap construction in a `try/catch`
 * in environments where availability is uncertain.
 *
 * @example Default construction
 * ```ts
 * const backend = new LocalStorageBackend()
 * await backend.probe()       // { available: true, latency: ~0 }
 * await backend.initialize()
 * await backend.write(key, envelope)
 * ```
 *
 * @example Isolated namespace with no automatic quota recovery
 * ```ts
 * const backend = new LocalStorageBackend({
 *   keyPrefix:           'myapp__',
 *   quotaRecoveryPolicy: 'none',
 * })
 * ```
 *
 * @see {@link WebStorageBackend} for the full implementation.
 * @see {@link SessionStorageBackend} for the session-scoped counterpart.
 */
export class LocalStorageBackend extends WebStorageBackend {
  /**
   * Priority 3 in the backend fallback chain.
   * After IndexedDB (0), OPFS (1), CacheStorage (2).
   * Before SessionStorage (4) and Memory (5).
   */
  readonly priority = 3;

  /**
   * @param config - Optional configuration. See {@link WebStorageConfig}.
   *
   * @throws {DOMException} `SecurityError` if `window.localStorage` is not
   *   accessible in the current execution environment (e.g., Firefox private
   *   mode, sandboxed iframe without `allow-same-origin`).
   */
  constructor(config: WebStorageConfig = {}) {
    super(window.localStorage, 'localstorage', config);
  }
}
