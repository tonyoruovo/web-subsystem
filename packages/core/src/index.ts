/**
 * @fileoverview
 * @module @platform/core
 * @summary The public API of `@platform/core`: the kernel every `@platform/*` package builds on.
 * @description
 * This barrel re-exports every public module of the package. `@platform/core`
 * defines what a subsystem is, runs each subsystem's lifecycle, enforces the
 * dependencies between subsystems, moves packets between them, and runs their
 * processors on the main thread or in workers. It ships no subsystem itself.
 *
 * ```text
 *   Kernel
 *   +-- UnitRuntime        one per subsystem and per feature
 *   |   +-- Lifecycle      status machine              (lifecycle.ts)
 *   |   +-- StateCell      owned, serializable state   (state.ts, view.ts)
 *   |   +-- ProcessorRunner hosts and failover         (supervisor.ts, host.ts)
 *   |   +-- PacketPort     send and request            (unit.ts, packet.ts)
 *   +-- DependencyGraph    boot order and waiting      (dependency.ts)
 *   +-- PacketRouter       direct until the Queue (M3) (kernel.ts, transport.ts)
 *   ```
 *
 * Two more entry points exist: `@platform/core/testing` (an in-memory test
 * platform) and `@platform/core/worker` (`serveProcessor` for worker entry
 * files).
 *
 * @example
 * Booting two subsystems, one depending on the other
 * ```ts
 * import { Kernel, defineSubsystem } from '@platform/core';
 *
 * const storage = defineSubsystem({
 *   id: 'storage',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   state: { initial: { keys: 0 }, policy: { keys: { readable: true } } },
 *   control: (ctx) => ({ commands: {}, views: { state: ctx.state.readable } }),
 * });
 * const auth = defineSubsystem({
 *   id: 'auth',
 *   scope: 'window',
 *   kind: 'featurized',
 *   requires: [{ target: 'storage' }],
 *   state: { initial: {} },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 *
 * const kernel = new Kernel([auth, storage]);
 * await kernel.start(); // storage first, then auth
 * ```
 *
 * @example
 * Sending a request from one subsystem to another
 * ```ts
 * import { defineSubsystem } from '@platform/core';
 *
 * export const client = defineSubsystem({
 *   id: 'client',
 *   scope: 'page',
 *   kind: 'featurized',
 *   requires: [{ target: 'auth' }],
 *   state: { initial: {} },
 *   init: async (ctx) => {
 *     const user = await ctx.port.request({ eventId: 'auth:whoami', payload: null, target: 'auth' });
 *     console.log(user);
 *   },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 * ```
 *
 * @example
 * Binding a unit's view to React without an adapter
 * ```tsx
 * import { useSyncExternalStore } from 'react';
 * import type { Kernel } from '@platform/core';
 *
 * function KeyCount({ kernel }: { kernel: Kernel }) {
 *   const view = kernel.unit('storage').control!.views.state;
 *   const state = useSyncExternalStore(view.subscribe, view.getSnapshot) as { keys: number };
 *   return <span>{state.keys}</span>;
 * }
 * ```
 *
 * @see [Package README](../README.md)
 * @see [Architecture](../../../docs/ARCHITECTURE.md)
 * @author MathAid
 */

export * from './backoff';
export * from './budget';
export * from './correlation';
export * from './dependency';
export * from './host';
export * from './kernel';
export * from './lifecycle';
export * from './packet';
export * from './processor';
export * from './route';
export * from './rpc';
export * from './scheduler';
export * from './scope';
export * from './state';
export * from './supervisor';
export * from './transport';
export * from './unit';
export * from './view';
export * from './wire';
