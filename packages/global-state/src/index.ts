/**
 * @fileoverview
 * @module @platform/global-state
 * @summary The public API of `@platform/global-state`.
 * @description
 * Re-exports the Global State subsystem ({@linkcode createGlobalState}), its
 * status derivation and admission rules (`status.ts`), its environment
 * sources (`environment.ts`) and tab identity (`tab-identity.ts`).
 *
 * ```text
 *   @platform/global-state
 *   +-- createGlobalState        the subsystem (id 'global-state', centralized, tab scope)
 *   +-- derivePlatformStatus     INITIALIZING | IDLE | BUSY | DEGRADED (| STOPPED)
 *   +-- canAccept                admission by importance
 *   +-- createBrowserEnvironment / createStaticEnvironment
 *   +-- resolveTabIdentity       unique per tab, stable across reloads
 *   ```
 *
 * @example
 * Booting the platform with Global State
 * ```ts
 * import { Kernel } from '@platform/core';
 * import { createGlobalState, type GlobalStateControl } from '@platform/global-state';
 *
 * const kernel = new Kernel([createGlobalState(), ...subsystems]);
 * await kernel.start();
 * kernel.unit<GlobalStateControl>('global-state').control?.views.state.getSnapshot().status; // 'IDLE'
 * ```
 *
 * @example
 * Testing a subsystem under a busy platform
 * ```ts
 * import { createStaticEnvironment, createGlobalState } from '@platform/global-state';
 * import { createTestPlatform } from '@platform/core/testing';
 *
 * const platform = createTestPlatform([
 *   createGlobalState({ busyThreshold: 0, environment: createStaticEnvironment(), tabIdentity: false }),
 *   mySubsystem,
 * ]);
 * ```
 *
 * @see [Package README](../README.md)
 * @author MathAid
 */

export * from './environment';
export * from './global-state';
export * from './status';
export * from './tab-identity';
