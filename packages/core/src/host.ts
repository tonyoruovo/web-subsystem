/**
 * @fileoverview
 * @summary Hosts: where a processor runs (main thread, dedicated worker, shared worker).
 * @description
 * Implements docs/ARCHITECTURE.md §8.2 and the failover triggers of §8.3.
 * A physical host reports a {@linkcode HostFailureError} when:
 *
 * 1. `unavailable`: the worker type does not exist, or the factory throws.
 * 2. `error`: the worker fires `error`, or the port fires `messageerror`.
 * 3. `handshake-timeout`: the worker does not answer the handshake in time.
 * 4. `heartbeat-missed`: a ping stays unanswered.
 *
 * On failure the worker is terminated and every pending call is rejected
 * with the same error, so the supervisor can move the work to the next host.
 *
 * ```text
 *   WorkerHost.start()
 *   +-- worker type missing / factory throws -----> unavailable
 *   +-- 'hello' handshake
 *   |     +-- no reply in time ------------------> handshake-timeout
 *   |     +-- 'error' / 'messageerror' event ----> error
 *   +-- heartbeat (shared hosts by default)
 *         +-- ping unanswered -------------------> heartbeat-missed
 *   ```
 *
 * @example
 * Hosts are normally created by a ProcessorRunner; creating one by hand
 * ```ts
 * import { createHost, createScheduler } from '@platform/core';
 *
 * const host = createHost('dedicated', processorDef, { scheduler: createScheduler(), sliceBudgetMs: 5 });
 * host.onFailure((failure) => console.warn(failure.trigger));
 * await host.start();
 * await host.call(message);
 * ```
 *
 * @example
 * Running a processor on the main thread directly
 * ```ts
 * const host = new VirtualHost(() => import('./sum.processor').then((m) => m.sum), createScheduler(), 5);
 * await host.start();
 * await host.call([1, 2, 3]); // 6
 * ```
 *
 * @throws {HostFailureError} From {@linkcode WorkerHost.start}, and for calls pending when a host fails.
 * @author MathAid
 */

import {
  DEFAULT_HEARTBEAT,
  createSliceScope,
  type HeartbeatOptions,
  type HostKind,
  type ProcessorDef,
  type ProcessorModule,
} from './processor';
import { RpcEndpoint, RpcTimeoutError, type PortLike } from './rpc';
import type { Scheduler } from './scheduler';

/**
 * @summary Why a host was given up.
 * @description
 * The four triggers of ARCHITECTURE §8.3 (`unavailable`, `error`,
 * `handshake-timeout`, `heartbeat-missed`), plus `budget`: the worker budget
 * was used up, so the host was skipped without being tried.
 *
 * @public
 */
export type FailoverTrigger =
  'unavailable' | 'error' | 'handshake-timeout' | 'heartbeat-missed' | 'budget';

/**
 * @summary A host failed and its work must move to the next host.
 *
 * @description
 * Carries the `host` kind and the {@linkcode FailoverTrigger}. Pending calls
 * on a failed host are rejected with it, which is how a supervisor knows to
 * re-run them elsewhere instead of reporting them as failures.
 *
 * @example
 * Example 1: Telling host failures apart from processor errors
 * ```ts
 * try {
 *   await host.call(message);
 * } catch (error) {
 *   if (error instanceof HostFailureError) await switchHost(error.trigger);
 *   else throw error;
 * }
 * ```
 *
 * @example
 * Example 2: The message
 * ```ts
 * new HostFailureError('shared', 'heartbeat-missed', 'No reply').message;
 * // '[shared host] heartbeat-missed: No reply'
 * ```
 *
 * @public
 */
export class HostFailureError extends Error {
  override readonly name = 'HostFailureError';

  /**
   * @param {HostKind} host The host that failed.
   * @param {FailoverTrigger} trigger Why.
   * @param {string} message Details.
   * @param {object} [options] `cause`: the underlying error.
   */
  constructor(
    readonly host: HostKind,
    readonly trigger: FailoverTrigger,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${host} host] ${trigger}: ${message}`, options);
  }
}

/**
 * @summary A place where one processor runs.
 *
 * @description
 * `start` brings the host up (loading the module or starting the worker),
 * `call` runs one message, `onPost` receives the processor's one-way
 * messages, `onFailure` reports a failure after start, and `stop` shuts it
 * down. A `virtual` host never fails over; physical hosts do.
 *
 * {@linkcode VirtualHost} and {@linkcode WorkerHost} implement it; a
 * `ProcessorRunner` drives them. Tests implement it to script failures.
 *
 * @example
 * Example 1: Driving a host
 * ```ts
 * await host.start();
 * const result = await host.call(input);
 * await host.stop();
 * ```
 *
 * @example
 * Example 2: A scripted host for tests
 * ```ts
 * const flaky: Host<number, number> = {
 *   kind: 'dedicated',
 *   start: async () => {},
 *   call: async () => { throw new HostFailureError('dedicated', 'error', 'scripted'); },
 *   onPost: () => () => {},
 *   onFailure: () => () => {},
 *   stop: async () => {},
 * };
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export interface Host<In = unknown, Out = unknown> {
  /** Where this host runs the processor. */
  readonly kind: HostKind;
  /**
   * @summary Brings the host up.
   * @throws {HostFailureError} When the host cannot start.
   */
  start(): Promise<void>;
  /**
   * @summary Runs one message on the processor.
   * @param {In} message The message.
   * @returns {Promise<Out>} The processor's result.
   */
  call(message: In): Promise<Out>;
  /** One-way messages from the processor. Returns the unsubscribe function. */
  onPost(listener: (message: unknown) => void): () => void;
  /** Fired once if the host fails after starting. Returns the unsubscribe function. */
  onFailure(listener: (error: HostFailureError) => void): () => void;
  /** Shuts the host down. */
  stop(): Promise<void>;
}

/**
 * @summary A listener set with an emitter.
 * @internal
 */
function listeners<T>() {
  const set = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit(value: T) {
      for (const listener of [...set]) listener(value);
    },
  };
}

/**
 * @summary Runs the processor on the main thread, one task per message.
 *
 * @description
 * Loads the module with the definition's `load`, runs `setup`, and runs each
 * `call` as a separate scheduler task with a fresh slice. It never fails
 * over: it is the last resort for every processor.
 *
 * @example
 * Example 1: Running a processor without workers
 * ```ts
 * const host = new VirtualHost(async () => sum, createScheduler(), 5);
 * await host.start();
 * await host.call([1, 2, 3]); // 6
 * ```
 *
 * @example
 * Example 2: Receiving progress posts
 * ```ts
 * host.onPost((message) => updateProgress(message));
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export class VirtualHost<In, Out> implements Host<In, Out> {
  readonly kind = 'virtual';
  readonly #posts = listeners<unknown>();
  readonly #scope;
  #module: ProcessorModule<In, Out> | null = null;

  /**
   * @param {() => Promise<ProcessorModule<In, Out>>} load Loads the processor module.
   * @param {Scheduler} scheduler Runs each message as a task, and yields.
   * @param {number} sliceBudgetMs The slice budget (ARCHITECTURE §8.6).
   */
  constructor(
    private readonly load: () => Promise<ProcessorModule<In, Out>>,
    private readonly scheduler: Scheduler,
    sliceBudgetMs: number,
  ) {
    this.#scope = createSliceScope('virtual', scheduler, sliceBudgetMs, (m) => this.#posts.emit(m));
  }

  /**
   * @summary Loads the module and runs its `setup`.
   * @returns {Promise<void>} Resolves once ready. Rejects with whatever `load` or `setup` throws.
   */
  async start(): Promise<void> {
    this.#module = await this.load();
    await this.#module.setup?.(this.#scope);
  }

  /**
   * @summary Runs one message as a main-thread task.
   * @param {In} message The message.
   * @returns {Promise<Out>} The result. Rejects when not started, or with what `handle` throws.
   */
  call(message: In): Promise<Out> {
    const module = this.#module;
    if (!module) return Promise.reject(new Error('The virtual host is not started.'));
    return this.scheduler.postTask(() => {
      this.#scope.startSlice();
      return module.handle(message, this.#scope);
    });
  }

  /**
   * @summary Listens to the processor's one-way messages.
   * @param {(message: unknown) => void} listener Receives each message.
   * @returns {() => void} Removes the listener.
   */
  onPost(listener: (message: unknown) => void): () => void {
    return this.#posts.add(listener);
  }

  /**
   * @summary Never fires: the main thread is the last resort and does not fail over.
   * @returns {() => void} A no-op unsubscribe function.
   */
  onFailure(): () => void {
    return () => {}; // the main thread is the last resort; it does not fail over
  }

  /**
   * @summary Runs the module's `teardown` and forgets the module.
   * @returns {Promise<void>} Resolves after teardown.
   */
  async stop(): Promise<void> {
    const module = this.#module;
    this.#module = null;
    await module?.teardown?.();
  }
}

/**
 * @summary Options for a {@linkcode WorkerHost}.
 *
 * @example
 * Example 1: A shared host with the default heartbeat
 * ```ts
 * const options: WorkerHostOptions = { processorId: 'crypto' };
 * ```
 *
 * @example
 * Example 2: A dedicated host with a heartbeat and a short handshake
 * ```ts
 * const options: WorkerHostOptions = {
 *   processorId: 'sync',
 *   handshakeTimeoutMs: 2_000,
 *   heartbeat: { intervalMs: 1_000, timeoutMs: 500 },
 * };
 * ```
 *
 * @public
 */
export interface WorkerHostOptions {
  /** The processor's id, sent in the handshake. */
  readonly processorId: string;
  /** How long the worker may take to answer the handshake. Default 5000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Heartbeat settings. Default: on for shared hosts, off for dedicated hosts. */
  readonly heartbeat?: HeartbeatOptions | false;
}

/**
 * @summary Runs the processor in a dedicated or shared worker.
 *
 * @description
 * Creates the worker with the definition's factory, performs the `hello`
 * handshake, then sends each `call` over the request/response protocol.
 * Watches for the four failover triggers; on the first one it terminates the
 * worker, rejects pending calls with a {@linkcode HostFailureError}, and
 * reports the failure. A worker `error` event it handles this way is marked
 * handled (`preventDefault`), so the page does not report it as uncaught.
 *
 * @example
 * Example 1: A dedicated worker
 * ```ts
 * const host = new WorkerHost('dedicated', () => new Worker(new URL('./sum.worker.ts', import.meta.url), { type: 'module' }), {
 *   processorId: 'sum',
 * });
 * await host.start();
 * ```
 *
 * @example
 * Example 2: Reacting to a failure
 * ```ts
 * host.onFailure((failure) => console.warn(`worker lost: ${failure.trigger}`));
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export class WorkerHost<In, Out> implements Host<In, Out> {
  readonly #posts = listeners<unknown>();
  readonly #failures = listeners<HostFailureError>();
  #worker: Worker | SharedWorker | null = null;
  #endpoint: RpcEndpoint | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #failure: HostFailureError | null = null;
  #onFailureDuringStart: ((error: HostFailureError) => void) | null = null;

  /**
   * @param {'dedicated' | 'shared'} kind The worker kind.
   * @param {() => Worker | SharedWorker} factory Creates the worker.
   * @param {WorkerHostOptions} options The processor id, handshake timeout and heartbeat.
   */
  constructor(
    readonly kind: 'dedicated' | 'shared',
    private readonly factory: () => Worker | SharedWorker,
    private readonly options: WorkerHostOptions,
  ) {}

  /**
   * @summary Creates the worker and completes the handshake.
   * @returns {Promise<void>} Resolves once the worker answered the handshake.
   * @throws {HostFailureError} `unavailable`, `error` or `handshake-timeout`.
   */
  async start(): Promise<void> {
    const constructorName = this.kind === 'dedicated' ? 'Worker' : 'SharedWorker';
    if (typeof (globalThis as Record<string, unknown>)[constructorName] !== 'function') {
      throw new HostFailureError(
        this.kind,
        'unavailable',
        `${constructorName} is not available here.`,
      );
    }
    let worker: Worker | SharedWorker;
    try {
      worker = this.factory();
    } catch (cause) {
      throw new HostFailureError(this.kind, 'unavailable', 'The worker could not be created.', {
        cause,
      });
    }
    this.#worker = worker;
    const port = (this.kind === 'dedicated'
      ? worker
      : (worker as SharedWorker).port) as unknown as PortLike;

    worker.addEventListener('error', (event) => {
      // The host handles it by failing over, so the page does not report it as uncaught.
      event.preventDefault();
      this.#fail('error', (event as ErrorEvent).message || 'The worker reported an error.');
    });
    port.addEventListener('messageerror', () =>
      this.#fail('error', 'A message could not be deserialized.'),
    );

    const endpoint = new RpcEndpoint(port);
    this.#endpoint = endpoint;
    endpoint.onNote('post', (message) => this.#posts.emit(message));

    // The handshake fails on whichever comes first: a timeout or a failure event.
    const failedDuringStart = new Promise<never>((_, reject) => {
      this.#onFailureDuringStart = reject;
    });
    const timeoutMs = this.options.handshakeTimeoutMs ?? 5_000;
    try {
      await Promise.race([
        endpoint.request('hello', { processor: this.options.processorId }, { timeoutMs }),
        failedDuringStart,
      ]);
    } catch (error) {
      if (error instanceof HostFailureError) throw error;
      const trigger = error instanceof RpcTimeoutError ? 'handshake-timeout' : 'error';
      const failure = this.#fail(trigger, (error as Error).message, error);
      throw failure;
    } finally {
      this.#onFailureDuringStart = null;
    }

    const heartbeat =
      this.options.heartbeat === undefined
        ? this.kind === 'shared'
          ? DEFAULT_HEARTBEAT
          : false
        : this.options.heartbeat;
    if (heartbeat) this.#startHeartbeat(heartbeat);
  }

  /**
   * @summary Runs one message in the worker.
   * @param {In} message The message. Must be structured-cloneable.
   * @returns {Promise<Out>} The result.
   * @throws {HostFailureError} When the host has failed, or fails while the call is pending.
   */
  call(message: In): Promise<Out> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#endpoint) return Promise.reject(new Error(`The ${this.kind} host is not started.`));
    return this.#endpoint.request<Out>('call', message);
  }

  /**
   * @summary Listens to the processor's one-way messages.
   * @param {(message: unknown) => void} listener Receives each message.
   * @returns {() => void} Removes the listener.
   */
  onPost(listener: (message: unknown) => void): () => void {
    return this.#posts.add(listener);
  }

  /**
   * @summary Listens for a failure after start.
   * @param {(error: HostFailureError) => void} listener Called once, with the failure.
   * @returns {() => void} Removes the listener.
   */
  onFailure(listener: (error: HostFailureError) => void): () => void {
    return this.#failures.add(listener);
  }

  /**
   * @summary Stops the heartbeat, tells the worker to close, and terminates it.
   * @returns {Promise<void>} Resolves once stopped.
   */
  async stop(): Promise<void> {
    clearInterval(this.#heartbeat);
    this.#endpoint?.notify('close');
    this.#endpoint?.close();
    this.#terminate();
  }

  /**
   * @summary Pings the worker every `intervalMs`; an unanswered ping fails the host.
   * @internal
   */
  #startHeartbeat({ intervalMs, timeoutMs }: HeartbeatOptions): void {
    let beat = 0;
    this.#heartbeat = setInterval(() => {
      this.#endpoint?.request('ping', ++beat, { timeoutMs }).catch((error) => {
        if (error instanceof RpcTimeoutError) {
          this.#fail('heartbeat-missed', `No reply to a ping within ${timeoutMs} ms.`, error);
        }
      });
    }, intervalMs);
  }

  /**
   * @summary Fails the host once: terminates it, rejects pending calls, and notifies listeners.
   * @returns {HostFailureError} The failure (the first one, if already failed).
   * @internal
   */
  #fail(trigger: FailoverTrigger, message: string, cause?: unknown): HostFailureError {
    if (this.#failure) return this.#failure;
    const failure = new HostFailureError(this.kind, trigger, message, { cause });
    this.#failure = failure;
    clearInterval(this.#heartbeat);
    this.#endpoint?.close(failure);
    this.#terminate();
    if (this.#onFailureDuringStart) this.#onFailureDuringStart(failure);
    else this.#failures.emit(failure);
    return failure;
  }

  /**
   * @summary Terminates a dedicated worker, or closes a shared worker's port.
   * @internal
   */
  #terminate(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;
    if ('terminate' in worker) worker.terminate();
    else worker.port.close();
  }
}

/**
 * @summary Creates the host of `kind` for a processor definition.
 *
 * @description
 * A {@linkcode VirtualHost} from the definition's `load`, or a
 * {@linkcode WorkerHost} from its `dedicated` or `shared` factory, with the
 * definition's handshake timeout and heartbeat. It is the default host
 * factory of `ProcessorRunner`.
 *
 * @example
 * Example 1: A dedicated host
 * ```ts
 * const host = createHost('dedicated', def, { scheduler, sliceBudgetMs: 5 });
 * ```
 *
 * @example
 * Example 2: Wrapping it to record which hosts were created
 * ```ts
 * const created: HostKind[] = [];
 * new ProcessorRunner(def, { createHost: (kind, d, c) => (created.push(kind), createHost(kind, d, c)) });
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @param {HostKind} kind The host to create.
 * @param {ProcessorDef<In, Out>} def The processor definition. Must have a factory for physical kinds.
 * @param {object} context The scheduler and the slice budget, for virtual hosts.
 * @returns {Host<In, Out>} The host, not yet started.
 *
 * @public
 */
export function createHost<In, Out>(
  kind: HostKind,
  def: ProcessorDef<In, Out>,
  context: { readonly scheduler: Scheduler; readonly sliceBudgetMs: number },
): Host<In, Out> {
  if (kind === 'virtual')
    return new VirtualHost(def.load, context.scheduler, context.sliceBudgetMs);
  return new WorkerHost(kind, def[kind]!, {
    processorId: def.id,
    handshakeTimeoutMs: def.handshakeTimeoutMs,
    heartbeat: def.heartbeat?.[kind],
  });
}
