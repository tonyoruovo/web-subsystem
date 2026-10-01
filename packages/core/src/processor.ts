/**
 * @fileoverview
 * @summary The processor contract: one message-handler module, runnable on any host.
 * @description
 * Implements docs/ARCHITECTURE.md §8.1 and §8.6. A processor module does not
 * know which thread it runs on: the virtual host loads it on the main thread,
 * and a worker entry file serves the same module with `serveProcessor`.
 *
 * @author MathAid
 */

import type { Scheduler } from './scheduler';

/** @summary Where a processor runs. */
export type HostKind = 'shared' | 'dedicated' | 'virtual';

/** @summary The processor's view of its host. */
export interface ProcessorScope {
  readonly host: HostKind;
  /** True when the current slice has used up its budget (§8.6). */
  shouldYield(): boolean;
  /** Gives the thread back, then continues with a fresh slice. */
  yield(): Promise<void>;
  /** Sends a one-way message to the owning unit (a Notifier's output). */
  post(message: unknown): void;
}

/** @summary A processor: the same module on every host. */
export interface ProcessorModule<In = unknown, Out = unknown> {
  setup?(scope: ProcessorScope): void | Promise<void>;
  /** Handles one structured-cloneable message and returns the result. */
  handle(message: In, scope: ProcessorScope): Out | Promise<Out>;
  teardown?(): void | Promise<void>;
}

/** @summary What a processor does with packets (§8.4). */
export type ProcessorJob = 'sink' | 'scheduler' | 'notifier';

/** @summary Heartbeat settings for a physical host. */
export interface HeartbeatOptions {
  readonly intervalMs: number;
  /** How long a ping may stay unanswered. */
  readonly timeoutMs: number;
}

/** @summary How a unit declares a processor. */
export interface ProcessorDef<In = unknown, Out = unknown> {
  /** Unique inside the unit. */
  readonly id: string;
  readonly job: ProcessorJob;
  /** Hosts in order of preference. Must end with `virtual` (§8.3). */
  readonly hosts: readonly HostKind[];
  /** Loads the module for the virtual host. */
  readonly load: () => Promise<ProcessorModule<In, Out>>;
  /**
   * Creates the dedicated worker. Write it literally, so bundlers detect it:
   * `() => new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`.
   */
  readonly dedicated?: () => Worker;
  /** Creates the shared worker, the same way. */
  readonly shared?: () => SharedWorker;
  /** How long a worker may take to answer the handshake. Default 5000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Heartbeat for physical hosts. Default: on for shared hosts, off for dedicated hosts. */
  readonly heartbeat?: {
    readonly shared?: HeartbeatOptions | false;
    readonly dedicated?: HeartbeatOptions | false;
  };
}

/** @summary The default shared-host heartbeat. */
export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 5_000, timeoutMs: 2_000 };

/**
 * @summary Declares a processor module with type inference.
 * @param {ProcessorModule<In, Out>} module The module.
 * @returns The same module.
 */
export function defineProcessor<In, Out>(
  module: ProcessorModule<In, Out>,
): ProcessorModule<In, Out> {
  return module;
}

/**
 * @summary Checks a processor definition.
 * @throws {Error} When the hosts are empty, repeated, do not end with `virtual`,
 * or a physical host has no worker factory.
 */
export function validateProcessorDef(def: ProcessorDef<never, unknown>): void {
  const where = `Processor "${def.id}"`;
  if (def.hosts.length === 0 || def.hosts.at(-1) !== 'virtual') {
    throw new Error(`${where}: hosts must end with 'virtual' (the fallback).`);
  }
  if (new Set(def.hosts).size !== def.hosts.length) {
    throw new Error(`${where}: a host is listed twice.`);
  }
  for (const kind of def.hosts) {
    if (kind !== 'virtual' && !def[kind]) {
      throw new Error(`${where}: the '${kind}' host needs a '${kind}' worker factory.`);
    }
  }
}

/**
 * @summary Creates a processor scope that measures slices against a time budget.
 * @param {HostKind} host The host the scope belongs to.
 * @param {Scheduler} scheduler Used to yield.
 * @param {number} budgetMs The slice budget (§8.6).
 * @param {(message: unknown) => void} post Delivers one-way messages.
 * @param {() => number} [now] Clock. Defaults to `performance.now`.
 * @returns The scope, plus `startSlice` to call before each message.
 */
export function createSliceScope(
  host: HostKind,
  scheduler: Scheduler,
  budgetMs: number,
  post: (message: unknown) => void,
  now: () => number = () => performance.now(),
): ProcessorScope & { startSlice(): void } {
  let sliceStart = now();
  return {
    host,
    shouldYield: () => now() - sliceStart >= budgetMs,
    async yield() {
      await scheduler.yield();
      sliceStart = now();
    },
    post,
    startSlice() {
      sliceStart = now();
    },
  };
}
