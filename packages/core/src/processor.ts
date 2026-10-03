/**
 * @fileoverview
 * @summary The processor contract: one message-handler module, runnable on any host.
 * @description
 * Implements docs/ARCHITECTURE.md §8.1 and §8.6. A processor module does not
 * know which thread it runs on: the virtual host loads it on the main thread,
 * and a worker entry file serves the same module with `serveProcessor`
 * (`@platform/core/worker`).
 *
 * ```text
 *   sum.processor.ts  -- defineProcessor({ handle })
 *        |                       |
 *        | load()                | import
 *        v                       v
 *   VirtualHost (main thread)   sum.worker.ts -- serveProcessor(module)
 *                                     ^
 *                                     | new Worker(new URL('./sum.worker.ts', import.meta.url))
 *                               ProcessorDef.dedicated / .shared
 *   ```
 *
 * @example
 * A processor that stays within its slice budget
 * ```ts
 * import { defineProcessor } from '@platform/core';
 *
 * export const sum = defineProcessor<number[], number>({
 *   async handle(items, scope) {
 *     let total = 0;
 *     for (const item of items) {
 *       total += item;
 *       if (scope.shouldYield()) await scope.yield();
 *     }
 *     return total;
 *   },
 * });
 * ```
 *
 * @example
 * Declaring it on a unit, with a dedicated worker and the virtual fallback
 * ```ts
 * processors: [
 *   {
 *     id: 'sum',
 *     job: 'sink',
 *     hosts: ['dedicated', 'virtual'],
 *     load: () => import('./sum.processor').then((m) => m.sum),
 *     dedicated: () => new Worker(new URL('./sum.worker.ts', import.meta.url), { type: 'module' }),
 *   },
 * ],
 * ```
 *
 * @throws {Error} From {@linkcode validateProcessorDef} for an invalid definition.
 * @author MathAid
 */

import type { Scheduler } from './scheduler';

/**
 * @summary Where a processor runs.
 * @description
 * - `shared`: a `SharedWorker`, shared by every tab of the origin.
 * - `dedicated`: a `Worker` owned by this tab.
 * - `virtual`: main-thread tasks. Always available; the last-resort fallback.
 *
 * @public
 */
export type HostKind = 'shared' | 'dedicated' | 'virtual';

/**
 * @summary The processor's view of its host.
 *
 * @description
 * Tells the processor which `host` it is on, whether the current slice has
 * used its budget (`shouldYield`), lets it give the thread back
 * (`yield`), and lets it send one-way messages to its unit (`post`).
 *
 * Every `setup` and `handle` call receives one. On the main thread,
 * respecting `shouldYield` is what keeps a processor from causing jank.
 *
 * @example
 * Example 1: Yielding in a long loop
 * ```ts
 * for (const row of rows) {
 *   index(row);
 *   if (scope.shouldYield()) await scope.yield();
 * }
 * ```
 *
 * @example
 * Example 2: Reporting progress
 * ```ts
 * scope.post({ progress: done / total });
 * ```
 *
 * @public
 */
export interface ProcessorScope {
  /**
   * @summary The host that runs the processor: `shared`, `dedicated` or `virtual`.
   */
  readonly host: HostKind;
  /**
   * @summary Tells if the current slice used its time budget (ARCHITECTURE §8.6).
   * @description On a worker host it is always `false`. On the virtual host it
   * becomes `true` after `sliceBudgetMs`, so long work can give the main thread back.
   * @example
   * A loop that stays responsive
   * ```ts
   * for (const item of items) {
   *   work(item);
   *   if (scope.shouldYield()) await scope.yield();
   * }
   * ```
   * @returns {boolean} `true` when the processor should call `yield`.
   */
  shouldYield(): boolean;
  /**
   * @summary Gives the thread back, then continues with a new slice.
   * @example
   * Yielding between batches
   * ```ts
   * await scope.yield();
   * ```
   * @returns {Promise<void>} Resolves when the new slice starts.
   */
  yield(): Promise<void>;
  /**
   * @summary Sends a one-way message to the unit that owns the processor.
   * @description A `Notifier` job uses it for its output. The message must be structured-cloneable.
   * @example
   * Reporting progress
   * ```ts
   * scope.post({ progress: done / total });
   * ```
   * @param {unknown} message The message.
   */
  post(message: unknown): void;
}

/**
 * @summary A processor: the same module on every host.
 *
 * @description
 * `handle` receives one structured-cloneable message and returns (or resolves
 * with) the result. Optional `setup` runs once when the host starts, and
 * optional `teardown` when it stops.
 *
 * Write it once, usually with {@linkcode defineProcessor}, and reference it
 * from both a {@linkcode ProcessorDef}'s `load` and a worker entry file.
 *
 * @example
 * Example 1: A pure transformation
 * ```ts
 * const upper: ProcessorModule<string, string> = { handle: (text) => text.toUpperCase() };
 * ```
 *
 * @example
 * Example 2: With setup and teardown
 * ```ts
 * let index: SearchIndex;
 * const search: ProcessorModule<string, string[]> = {
 *   setup: async () => { index = await buildIndex(); },
 *   handle: (query) => index.search(query),
 *   teardown: () => index.dispose(),
 * };
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export interface ProcessorModule<In = unknown, Out = unknown> {
  /**
   * @summary Prepares the processor. The host calls it one time, when it starts.
   * @description `config` is the `config` of the processor definition
   * (ARCHITECTURE §8.7). A shared worker gets the config of the first tab that
   * connects. When `setup` throws, the host does not start and the runner
   * fails over to the next host: use this to refuse a host that cannot do the job.
   * @example
   * Example 1: Opening a cache
   * ```ts
   * setup: async () => void (cache = await caches.open('thumbnails')),
   * ```
   * @example
   * Example 2: Refusing a host without IndexedDB
   * ```ts
   * setup: (scope, config) => {
   *   if (typeof indexedDB === 'undefined') throw new Error('No IndexedDB on this host.');
   *   database = (config as { database: string }).database;
   * },
   * ```
   * @param {ProcessorScope} scope The scope of the processor.
   * @param {unknown} [config] The configuration from the processor definition.
   * @returns {void | Promise<void>} Resolves when the processor is ready.
   */
  setup?(scope: ProcessorScope, config?: unknown): void | Promise<void>;
  /**
   * @summary Handles one message and returns the result.
   * @description The message and the result must be structured-cloneable,
   * because they can cross a worker boundary.
   * @example
   * Adding numbers
   * ```ts
   * handle: ({ items }) => items.reduce((sum, n) => sum + n, 0),
   * ```
   * @param {In} message The message.
   * @param {ProcessorScope} scope The scope of the processor.
   * @returns {Out | Promise<Out>} The result.
   */
  handle(message: In, scope: ProcessorScope): Out | Promise<Out>;
  /**
   * @summary Releases what `setup` got. The host calls it when it stops.
   * @example
   * Closing a database
   * ```ts
   * teardown: () => db.close(),
   * ```
   * @returns {void | Promise<void>} Resolves when the processor is released.
   */
  teardown?(): void | Promise<void>;
}

/**
 * @summary What a processor does with packets (ARCHITECTURE §8.4).
 * @description
 * - `sink`: consumes and updates state; emits nothing.
 * - `scheduler`: orders internal work and outgoing packets, 1-to-1.
 * - `notifier`: emits broadcasts.
 *
 * @public
 */
export type ProcessorJob = 'sink' | 'scheduler' | 'notifier';

/**
 * @summary Heartbeat settings for a physical host.
 *
 * @description
 * The host pings the worker every `intervalMs`; a ping unanswered after
 * `timeoutMs` fails the host with the `heartbeat-missed` trigger.
 *
 * @example
 * Example 1: A tighter heartbeat for a latency-sensitive worker
 * ```ts
 * heartbeat: { dedicated: { intervalMs: 1_000, timeoutMs: 500 } },
 * ```
 *
 * @example
 * Example 2: Turning the shared-host heartbeat off
 * ```ts
 * heartbeat: { shared: false },
 * ```
 *
 * @public
 */
export interface HeartbeatOptions {
  /**
   * @summary The time between two pings, in milliseconds.
   */
  readonly intervalMs: number;
  /**
   * @summary The longest time to wait for the answer to a ping, in milliseconds.
   * @description A ping without an answer in this time is a missed heartbeat,
   * and the runner fails over to the next host.
   */
  readonly timeoutMs: number;
}

/**
 * @summary How a unit declares a processor.
 *
 * @description
 * Names the processor (`id`) and its `job`, lists its `hosts` in order of
 * preference (ending with `virtual`), and says how to get the module on each:
 * `load` for the virtual host, and `dedicated` and `shared` worker factories
 * for physical hosts. `handshakeTimeoutMs` and `heartbeat` tune failure
 * detection.
 *
 * Units list these in `processors`. The kernel starts them before the
 * unit's `init`, on the first host that works, and moves them down the list
 * when a host fails. The factories must be written at the definition site
 * with `new Worker(new URL(..., import.meta.url))`, because that literal
 * pattern is what bundlers detect.
 *
 * @example
 * Example 1: Shared first, then dedicated, then the main thread
 * ```ts
 * const crypto: ProcessorDef<CryptoRequest, CryptoResult> = {
 *   id: 'crypto',
 *   job: 'sink',
 *   hosts: ['shared', 'dedicated', 'virtual'],
 *   load: () => import('./crypto.processor').then((m) => m.crypto),
 *   shared: () => new SharedWorker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module', name: 'crypto' }),
 *   dedicated: () => new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' }),
 * };
 * ```
 *
 * @example
 * Example 2: Main thread only
 * ```ts
 * const format: ProcessorDef<string, string> = {
 *   id: 'format',
 *   job: 'sink',
 *   hosts: ['virtual'],
 *   load: async () => ({ handle: (text) => text.trim() }),
 * };
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export interface ProcessorDef<In = unknown, Out = unknown> {
  /**
   * @summary The id of the processor. It must be unique in the unit.
   * @description The unit gets the processor with `ctx.processor(id)`.
   */
  readonly id: string;
  /**
   * @summary What the processor does with packets (ARCHITECTURE §8.4).
   */
  readonly job: ProcessorJob;
  /**
   * @summary The hosts to try, in order of preference.
   * @description The list must end with `virtual`, which is always available
   * (ARCHITECTURE §8.3). The runner fails over along this list.
   */
  readonly hosts: readonly HostKind[];
  /**
   * @summary Loads the module for the virtual host.
   * @description Use a dynamic `import()`, so the module loads only when the virtual host runs.
   */
  readonly load: () => Promise<ProcessorModule<In, Out>>;
  /**
   * @summary Makes the dedicated worker.
   * @description Write it as a literal, so bundlers find the worker file:
   * `() => new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`.
   */
  readonly dedicated?: () => Worker;
  /**
   * @summary Makes the shared worker.
   * @description Write it as a literal, as for `dedicated`, with `SharedWorker`.
   */
  readonly shared?: () => SharedWorker;
  /**
   * @summary The longest time for a worker to answer the handshake, in milliseconds.
   * @description The default is 5000. After this time, the runner fails over to the next host.
   */
  readonly handshakeTimeoutMs?: number;
  /**
   * @summary The configuration that every host gives to `setup` (ARCHITECTURE §8.7).
   * @description The value must be structured-cloneable, because a worker
   * host sends it in the handshake. Without it, `setup` gets `undefined`.
   */
  readonly config?: unknown;
  /**
   * @summary The heartbeat for worker hosts.
   * @description By default, shared hosts use {@linkcode DEFAULT_SHARED_HEARTBEAT}
   * and dedicated hosts have no heartbeat. Use `false` to turn a heartbeat off.
   */
  readonly heartbeat?: {
    /**
     * @summary The heartbeat for a shared worker, or `false` for none.
     */
    readonly shared?: HeartbeatOptions | false;
    /**
     * @summary The heartbeat for a dedicated worker, or `false` for none.
     */
    readonly dedicated?: HeartbeatOptions | false;
  };
}

/**
 * @summary The default shared-host heartbeat: a ping every 5 s, answered within 2 s.
 * @constant
 * @public
 */
export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 5_000, timeoutMs: 2_000 };

/**
 * @summary Declares a processor module with type inference.
 *
 * @description
 * Returns `module` unchanged; it only infers `In` and `Out` so `handle`'s
 * message and result are typed.
 *
 * @example
 * Example 1: Typed message and result
 * ```ts
 * export const hash = defineProcessor<ArrayBuffer, string>({
 *   handle: async (buffer) => toHex(await crypto.subtle.digest('SHA-256', buffer)),
 * });
 * ```
 *
 * @example
 * Example 2: Serving it from a worker
 * ```ts
 * serveProcessor(hash);
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @param {ProcessorModule<In, Out>} module The module.
 * @returns {ProcessorModule<In, Out>} The same module.
 *
 * @public
 */
export function defineProcessor<In, Out>(
  module: ProcessorModule<In, Out>,
): ProcessorModule<In, Out> {
  return module;
}

/**
 * @summary Checks a processor definition.
 *
 * @description
 * Requires at least one host, `virtual` as the last host, no host listed
 * twice, and a worker factory for every physical host. The kernel calls it
 * for every processor at construction, so a bad definition fails fast.
 *
 * @example
 * Example 1: A valid definition passes silently
 * ```ts
 * validateProcessorDef({ id: 'p', job: 'sink', hosts: ['virtual'], load });
 * ```
 *
 * @example
 * Example 2: A missing fallback
 * ```ts
 * validateProcessorDef({ id: 'p', job: 'sink', hosts: ['dedicated'], load, dedicated });
 * // throws: hosts must end with 'virtual'
 * ```
 *
 * @param {ProcessorDef<never, unknown>} def The definition.
 * @throws {Error} When the hosts are empty, repeated, do not end with `virtual`, or a physical host has no worker factory.
 *
 * @public
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
 * @summary Creates a {@linkcode ProcessorScope} that measures slices against a time budget.
 *
 * @description
 * Hosts call `startSlice()` before each message. `shouldYield()` is `true`
 * once `budgetMs` has passed since then (or since the last `yield()`).
 *
 * @example
 * Example 1: In a host
 * ```ts
 * const scope = createSliceScope('virtual', scheduler, 5, (m) => emit(m));
 * scope.startSlice();
 * await module.handle(message, scope);
 * ```
 *
 * @example
 * Example 2: With a fake clock in a test
 * ```ts
 * let t = 0;
 * const scope = createSliceScope('virtual', scheduler, 5, () => {}, () => t);
 * t = 10;
 * scope.shouldYield(); // true
 * ```
 *
 * @param {HostKind} host The host the scope belongs to.
 * @param {Scheduler} scheduler Used to yield.
 * @param {number} budgetMs The slice budget (ARCHITECTURE §8.6).
 * @param {(message: unknown) => void} post Delivers one-way messages.
 * @param {() => number} [now] Clock. Defaults to `performance.now`.
 * @returns {ProcessorScope & { startSlice(): void }} The scope, plus `startSlice`.
 *
 * @public
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
