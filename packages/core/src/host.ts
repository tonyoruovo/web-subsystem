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
 * On failure, the worker is terminated and every pending call is rejected
 * with the same {@linkcode HostFailureError}, so the supervisor can move the
 * work to the next host.
 *
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

/** @summary Why a host was given up. */
export type FailoverTrigger =
  'unavailable' | 'error' | 'handshake-timeout' | 'heartbeat-missed' | 'budget';

/** @summary A host failed and its work must move to the next host. */
export class HostFailureError extends Error {
  override readonly name = 'HostFailureError';
  constructor(
    readonly host: HostKind,
    readonly trigger: FailoverTrigger,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${host} host] ${trigger}: ${message}`, options);
  }
}

/** @summary A running place for one processor. */
export interface Host<In = unknown, Out = unknown> {
  readonly kind: HostKind;
  /** @throws {HostFailureError} When the host cannot start. */
  start(): Promise<void>;
  call(message: In): Promise<Out>;
  /** One-way messages from the processor. */
  onPost(listener: (message: unknown) => void): () => void;
  /** Fired once if the host fails after starting. */
  onFailure(listener: (error: HostFailureError) => void): () => void;
  stop(): Promise<void>;
}

/** @summary Listener sets with a one-call emitter. */
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
 */
export class VirtualHost<In, Out> implements Host<In, Out> {
  readonly kind = 'virtual';
  readonly #posts = listeners<unknown>();
  readonly #scope;
  #module: ProcessorModule<In, Out> | null = null;

  constructor(
    private readonly load: () => Promise<ProcessorModule<In, Out>>,
    private readonly scheduler: Scheduler,
    sliceBudgetMs: number,
  ) {
    this.#scope = createSliceScope('virtual', scheduler, sliceBudgetMs, (m) => this.#posts.emit(m));
  }

  async start(): Promise<void> {
    this.#module = await this.load();
    await this.#module.setup?.(this.#scope);
  }

  call(message: In): Promise<Out> {
    const module = this.#module;
    if (!module) return Promise.reject(new Error('The virtual host is not started.'));
    return this.scheduler.postTask(() => {
      this.#scope.startSlice();
      return module.handle(message, this.#scope);
    });
  }

  onPost(listener: (message: unknown) => void): () => void {
    return this.#posts.add(listener);
  }

  onFailure(): () => void {
    return () => {}; // the main thread is the last resort; it does not fail over
  }

  async stop(): Promise<void> {
    const module = this.#module;
    this.#module = null;
    await module?.teardown?.();
  }
}

/** @summary Options for a {@linkcode WorkerHost}. */
export interface WorkerHostOptions {
  readonly processorId: string;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeat?: HeartbeatOptions | false;
}

/**
 * @summary Runs the processor in a dedicated or shared worker.
 */
export class WorkerHost<In, Out> implements Host<In, Out> {
  readonly #posts = listeners<unknown>();
  readonly #failures = listeners<HostFailureError>();
  #worker: Worker | SharedWorker | null = null;
  #endpoint: RpcEndpoint | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #failure: HostFailureError | null = null;
  #onFailureDuringStart: ((error: HostFailureError) => void) | null = null;

  constructor(
    readonly kind: 'dedicated' | 'shared',
    private readonly factory: () => Worker | SharedWorker,
    private readonly options: WorkerHostOptions,
  ) {}

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

    worker.addEventListener('error', (event) =>
      this.#fail('error', (event as ErrorEvent).message || 'The worker reported an error.'),
    );
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

  call(message: In): Promise<Out> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#endpoint) return Promise.reject(new Error(`The ${this.kind} host is not started.`));
    return this.#endpoint.request<Out>('call', message);
  }

  onPost(listener: (message: unknown) => void): () => void {
    return this.#posts.add(listener);
  }

  onFailure(listener: (error: HostFailureError) => void): () => void {
    return this.#failures.add(listener);
  }

  async stop(): Promise<void> {
    clearInterval(this.#heartbeat);
    this.#endpoint?.notify('close');
    this.#endpoint?.close();
    this.#terminate();
  }

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

  /** Fails the host once: terminates it, rejects pending calls, and notifies listeners. */
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
