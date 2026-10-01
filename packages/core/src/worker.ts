/**
 * @fileoverview
 * @summary `@platform/core/worker`: serve a processor module from a worker entry file.
 * @description
 * A worker entry file is two lines:
 *
 * ```ts
 * // sync.worker.ts
 * import { serveProcessor } from '@platform/core/worker';
 * import { syncProcessor } from './sync.processor';
 * serveProcessor(syncProcessor);
 * ```
 *
 * It works in dedicated workers (messages on the worker scope) and shared
 * workers (one port per connecting tab). `setup` runs once per worker, on the
 * first handshake.
 *
 * @author MathAid
 */

import { createSliceScope, type HostKind, type ProcessorModule } from './processor';
import { RpcEndpoint, type PortLike } from './rpc';
import { createScheduler } from './scheduler';

/** @summary The parts of a worker global scope `serveProcessor` uses. */
export type WorkerScopeLike = PortLike & {
  addEventListener(type: 'connect', listener: (event: MessageEvent) => void): void;
};

/**
 * @summary Answers handshakes, calls and heartbeats for `module`.
 * @param {ProcessorModule<In, Out>} module The processor, the same module the virtual host loads.
 * @param {object} [options] The worker scope (defaults to `globalThis`) and the slice budget.
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
  const setup = () => (ready ??= Promise.resolve(module.setup?.(processorScope)));

  const serve = (port: PortLike) => {
    const endpoint = new RpcEndpoint(port);
    endpoints.add(endpoint);
    endpoint.handle('hello', async () => {
      await setup();
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
