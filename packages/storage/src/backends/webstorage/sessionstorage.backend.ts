/**
 * @fileoverview `sessionStorage`-backed storage backend.
 *
 * ## Overview
 * `SessionStorageBackend` is a thin concrete subclass of `WebStorageBackend`.
 * It injects `window.sessionStorage` and the `'sessionstorage'` backend kind
 * into the shared abstract implementation. Every behavioural detail — CRUD,
 * transactions, quota estimation, eviction, recovery — is inherited without
 * modification.
 *
 * ## Characteristics
 * - **Persistence**: data is cleared when the tab is closed. Each tab has its
 *   own independent `sessionStorage` — entries written in one tab are invisible
 *   to all other tabs, even within the same origin.
 * - **Scope**: tab-isolated. There is no cross-tab sharing and no `storage`
 *   event for session storage writes from the same tab.
 * - **Quota**: same 5–10 MB limit as `localStorage`, per-tab.
 * - **Availability**: generally available in all contexts including private
 *   browsing (unlike `localStorage` in Firefox private mode). An embedded
 *   `iframe` without `allow-same-origin` still raises `SecurityError`.
 * - **Priority**: 4 in the backend fallback chain — after LocalStorage (3).
 *   Before Memory (5).
 *
 * ## When to prefer SessionStorageBackend over LocalStorageBackend
 * - When the stored data should not persist across page navigations or
 *   tab reloads (e.g., ephemeral auth challenge state, wizard step data).
 * - When tab-isolation is a feature rather than a limitation (e.g., each
 *   browser tab maintains its own independent workflow state).
 * - As a fallback when `localStorage` is unavailable (Firefox private mode),
 *   since `sessionStorage` remains accessible.
 *
 * @see {@link WebStorageBackend} for the full implementation.
 * @see {@link LocalStorageBackend} for the persistent-across-sessions sibling.
 */

import { WebStorageBackend } from './webstorage.backend';
import type { WebStorageConfig } from './webstorage.types';

/**
 * @summary `sessionStorage`-backed implementation of `IStorageBackend<string>`.
 *
 * @description
 * `SessionStorageBackend` delegates all storage operations to the shared
 * `WebStorageBackend` abstract class, injecting `window.sessionStorage` as the
 * underlying `Storage` handle. Construction is the only point of divergence
 * from `LocalStorageBackend`.
 *
 * Because `sessionStorage` is tab-isolated, the SharedWorker scheduler may
 * receive ops from multiple tab connections while only the initiating tab's
 * `sessionStorage` is visible to the scheduler's own execution context. In
 * practice, the SharedWorker's `sessionStorage` is an independent namespace
 * from that of any tab. For cross-tab or cross-worker use cases, prefer
 * `LocalStorageBackend`, `CacheBackend`, `OPFSBackend`, or `IndexedDB`.
 *
 * @example Default construction
 * ```ts
 * const backend = new SessionStorageBackend()
 * await backend.probe()       // { available: true, latency: ~0 }
 * await backend.initialize()
 * await backend.write(key, envelope)
 * ```
 *
 * @example Explicit namespace prefix
 * ```ts
 * const backend = new SessionStorageBackend({ keyPrefix: 'wizard__' })
 * ```
 *
 * @see {@link WebStorageBackend} for the full implementation.
 * @see {@link LocalStorageBackend} for the persistent-across-sessions counterpart.
 */
export class SessionStorageBackend extends WebStorageBackend {
  /**
   * @summary Priority 4 in the backend fallback chain. After IndexedDB (0), OPFS (1), CacheStorage (2), LocalStorage (3). Before Memory (5).
   */
  readonly priority = 4;

  /**
   * @summary Makes a `SessionStorageBackend`.
   * @param config - Optional configuration. See {@link WebStorageConfig}.
   *
   * @throws {DOMException} `SecurityError` if `window.sessionStorage` is not
   *   accessible in the current execution environment (e.g., sandboxed iframe
   *   without `allow-same-origin`).
   */
  constructor(config: WebStorageConfig = {}) {
    super(window.sessionStorage, 'sessionstorage', config);
  }
}
