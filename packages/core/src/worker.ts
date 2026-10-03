/**
 * @fileoverview
 * @module @platform/core/worker
 * @summary `@platform/core/worker`: serve a processor module from a worker entry file.
 * @description
 * The entry point worker files import. A worker entry file is two lines:
 * import the processor module, and pass it to {@linkcode serveProcessor}.
 *
 * It works in dedicated workers (messages on the worker scope) and shared
 * workers (one port per connecting tab). `setup` runs once per worker, on the
 * first handshake; in a shared worker, one-way posts go to every connected
 * tab.
 *
 * ```text
 *   tab (WorkerHost)                       worker (serveProcessor)
 *   'hello' ------------------------------> setup() once, reply { ok, host }
 *   'call'  message ----------------------> module.handle(message), reply result
 *   'ping'  n -----------------------------> reply n
 *   <-------------------------------------- 'post' notes from scope.post()
 *   'close' ------------------------------> teardown() (dedicated workers)
 *   ```
 *
 * @example
 * A dedicated or shared worker entry file
 * ```ts
 * // sync.worker.ts
 * import { serveProcessor } from '@platform/core/worker';
 * import { syncProcessor } from './sync.processor';
 *
 * serveProcessor(syncProcessor);
 * ```
 *
 * @example
 * A larger slice budget for a worker that may block its own thread
 * ```ts
 * serveProcessor(indexProcessor, { sliceBudgetMs: 50 });
 * ```
 *
 * @see [Package README](../README.md#processors-and-workers)
 * @author MathAid
 */

import { createSliceScope, type HostKind, type ProcessorModule } from './processor';
import { RpcEndpoint, type PortLike } from './rpc';
import { createScheduler } from './scheduler';

/**
 * @summary The parts of a worker global scope that {@linkcode serveProcessor} uses.
 *
 * @description
 * A dedicated worker scope is used as a port. A shared worker scope (which
 * has `onconnect`) provides one port per connecting tab through `connect`
 * events. Tests pass a fake scope.
 *
 * @example
 * Example 1: The real scope, inside a worker
 * ```ts
 * serveProcessor(module, { scope: self as unknown as WorkerScopeLike });
 * ```
 *
 * @example
 * Example 2: A MessagePort as a fake dedicated scope in a test
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * serveProcessor(module, { scope: port2 as unknown as WorkerScopeLike });
 * ```
 *
 * @public
 */
export type WorkerScopeLike = PortLike & {
  /**
   * @summary Listens to the connections of a shared worker.
   * @description Each `connect` event carries the port of one new client in `event.ports[0]`.
   * @param {'connect'} type The event type.
   * @param {(event: MessageEvent) => void} listener Called for each connection.
   */
  addEventListener(type: 'connect', listener: (event: MessageEvent) => void): void;
};

/**
 * @summary Answers handshakes, calls and heartbeats for a processor module, inside a worker.
 *
 * @description
 * Detects the worker kind (a shared worker scope has `onconnect`), then
 * serves every connection with the shared request/response protocol:
 * `hello` runs `setup` once and replies, `call` runs `module.handle` with a
 * fresh slice, `ping` echoes heartbeats, and `close` ends the connection
 * (and runs `teardown` in a dedicated worker). The module's `scope.post`
 * sends one-way messages to every connected tab.
 *
 * Call it once, at the top level of a worker entry file, with the same
 * module the processor's virtual host loads.
 *
 * @example
 * Example 1: The whole worker entry file
 * ```ts
 * import { serveProcessor } from '@platform/core/worker';
 * import { sum } from './sum.processor';
 *
 * serveProcessor(sum);
 * ```
 *
 * @example
 * Example 2: Serving over a custom scope in a test
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * serveProcessor(sum, { scope: port2 as unknown as WorkerScopeLike });
 * const endpoint = new RpcEndpoint(port1);
 * await endpoint.request('hello');
 * await endpoint.request('call', [1, 2]); // 3
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @param {ProcessorModule<In, Out>} module The processor, the same module the virtual host loads.
 * @param {object} [options] `scope`: the worker scope (defaults to `globalThis`); `sliceBudgetMs`: the slice budget (default 5).
 *
 * @public
 */
export function serveProcessor<In, Out>(
  module: ProcessorModule<In, Out>,
  options: { readonly scope?: WorkerScopeLike; readonly sliceBudgetMs?: number } = {},
): void {
  const scope = options.scope ?? (globalThis as unknown as WorkerScopeLike);
  const scheduler = createScheduler();
  const isShared = 'onconnect' in scope;
  const kind: HostKind = isShared ? 'shared' : 'dedicated';
  const endpoints = new Set<RpcEndpoint>();

  // One processor scope per worker; posts go to every connected tab.
  const processorScope = createSliceScope(
    kind,
    scheduler,
    options.sliceBudgetMs ?? 5,
    (message) => {
      for (const endpoint of endpoints) endpoint.notify('post', message);
    },
  );
  let ready: Promise<void> | null = null;
  // The first hello brings the config (ARCHITECTURE §8.7). A failed setup fails every handshake.
  const setup = (config?: unknown) =>
    (ready ??= Promise.resolve().then(() => module.setup?.(processorScope, config)));

  const serve = (port: PortLike) => {
    const endpoint = new RpcEndpoint(port);
    endpoints.add(endpoint);
    endpoint.handle('hello', async (data) => {
      await setup((data as { config?: unknown } | undefined)?.config);
      return { ok: true, host: kind };
    });
    endpoint.handle('call', async (message) => {
      await setup();
      processorScope.startSlice();
      return module.handle(message as In, processorScope);
    });
    endpoint.handle('ping', (beat) => beat);
    endpoint.onNote('close', () => {
      endpoints.delete(endpoint);
      endpoint.close();
      if (!isShared) void module.teardown?.();
    });
  };

  if (isShared)
    scope.addEventListener('connect', (event) => serve(event.ports[0] as unknown as PortLike));
  else serve(scope);
}
