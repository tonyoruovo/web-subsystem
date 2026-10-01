/**
 * @fileoverview
 * @summary Hybrid failover: runs a processor on its preferred host, moving down the list on failure.
 * @description
 * Implements docs/ARCHITECTURE.md §8.3 and §8.5. A {@linkcode ProcessorRunner}
 * tries the hosts in order, skipping ones over the worker budget. When the
 * running host fails, the runner switches to the next host and re-runs the
 * calls that were in flight. A failed host is not retried until the runner
 * restarts. The last host is always `virtual`.
 *
 * ```text
 *   hosts: [shared, dedicated, virtual]
 *
 *   start   shared --x unavailable --> dedicated (ok)          failovers: [shared]
 *   call    dedicated --x heartbeat-missed --> virtual          failovers: [shared, dedicated]
 *           the in-flight call is re-run on virtual
 *   ```
 *
 * @example
 * Running a processor outside the kernel
 * ```ts
 * import { ProcessorRunner } from '@platform/core';
 *
 * const runner = new ProcessorRunner(sumDef);
 * await runner.start();
 * await runner.call([1, 2, 3]); // 6, on the best available host
 * runner.status.getSnapshot();  // { host: 'dedicated', failovers: [] }
 * await runner.stop();
 * ```
 *
 * @example
 * Showing failovers in a diagnostics panel
 * ```ts
 * const sum = ctx.processor('sum');
 * sum.status.subscribe(() => {
 *   const { host, failovers } = sum.status.getSnapshot();
 *   panel.textContent = `${host} (${failovers.map((f) => `${f.host}: ${f.trigger}`).join(', ')})`;
 * });
 * ```
 *
 * @throws {ProcessorStartError} From {@linkcode ProcessorRunner.start} when no host can start.
 * @author MathAid
 */

import { WorkerBudget } from './budget';
import { HostFailureError, createHost, type FailoverTrigger, type Host } from './host';
import { validateProcessorDef, type HostKind, type ProcessorDef } from './processor';
import { createScheduler, type Scheduler } from './scheduler';
import { createStore, type View } from './view';

/**
 * @summary A processor's current host and the failovers so far.
 *
 * @description
 * `host` is the running host (`null` before start, after stop, or when no
 * host could start). `failovers` lists every host given up, in order, with
 * its {@linkcode FailoverTrigger} and message, including hosts skipped for
 * the worker budget.
 *
 * @example
 * Example 1: Healthy on a dedicated worker
 * ```ts
 * // { host: 'dedicated', failovers: [] }
 * ```
 *
 * @example
 * Example 2: Fell back to the main thread
 * ```ts
 * // { host: 'virtual', failovers: [{ host: 'dedicated', trigger: 'heartbeat-missed', message: '...' }] }
 * ```
 *
 * @public
 */
export interface ProcessorStatus {
  /** The running host, or `null` before start and after stop. */
  readonly host: HostKind | null;
  /** Every host given up, in order. */
  readonly failovers: readonly {
    readonly host: HostKind;
    readonly trigger: FailoverTrigger;
    readonly message: string;
  }[];
}

/**
 * @summary What a unit holds for one of its processors (`ctx.processor(id)`).
 *
 * @description
 * `call` runs one message on the current host (re-running it on the next
 * host if the current one fails), `onPost` receives the processor's one-way
 * messages, and `status` is a {@linkcode View} of the
 * {@linkcode ProcessorStatus}.
 *
 * Units get it from `ctx.processor(id)`; it hides which host is running.
 *
 * @example
 * Example 1: Calling a processor
 * ```ts
 * const total = await ctx.processor<number[], number>('sum').call([1, 2, 3]);
 * ```
 *
 * @example
 * Example 2: Forwarding a notifier's posts as broadcasts
 * ```ts
 * ctx.processor('watcher').onPost((change) => ctx.port.send({ eventId: 'storage:changed', payload: change }));
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export interface ProcessorHandle<In = unknown, Out = unknown> {
  /** The processor's id. */
  readonly id: string;
  /** The current host and the failovers so far. */
  readonly status: View<ProcessorStatus>;
  /** Runs one message on the current host. Re-run on the next host if the current one fails. */
  call(message: In): Promise<Out>;
  /** One-way messages from the processor. Returns the unsubscribe function. */
  onPost(listener: (message: unknown) => void): () => void;
}

/**
 * @summary Options shared by every {@linkcode ProcessorRunner}.
 *
 * @description
 * The `scheduler` for virtual hosts (default: a new one), the worker
 * `budget` (default: one per process, sized for the device), the virtual
 * hosts' `sliceBudgetMs` (default 5), and `createHost`, which replaces host
 * creation in tests.
 *
 * Pass them to the kernel as `processors`; every unit's runners share them.
 *
 * @example
 * Example 1: Sharing settings across the platform
 * ```ts
 * new Kernel(subsystems, { processors: { budget: new WorkerBudget(2), sliceBudgetMs: 8 } });
 * ```
 *
 * @example
 * Example 2: Scripted hosts in a test
 * ```ts
 * new ProcessorRunner(def, { createHost: (kind) => scriptedHost(kind) });
 * ```
 *
 * @public
 */
export interface ProcessorRunnerOptions {
  /** Runs virtual hosts' tasks. */
  readonly scheduler?: Scheduler;
  /** Limits physical workers. */
  readonly budget?: WorkerBudget;
  /** Slice budget for virtual hosts (ARCHITECTURE §8.6). Default 5 ms. */
  readonly sliceBudgetMs?: number;
  /** Replaces host creation, for tests. */
  readonly createHost?: typeof createHost;
}

/**
 * @summary Thrown when no host, not even the virtual one, could start.
 *
 * @description
 * The usual cause is a `load` that fails (the processor module could not be
 * imported). The processor's status lists every host that was tried. When it
 * happens while a unit starts, the unit is `FAILED`.
 *
 * @example
 * Example 1: A module that fails to load
 * ```ts
 * await new ProcessorRunner({ ...def, load: () => Promise.reject(new Error('404')) }).start();
 * // rejects with ProcessorStartError
 * ```
 *
 * @example
 * Example 2: Seeing it on a unit
 * ```ts
 * kernel.unit('search').lifecycle.getSnapshot().reason; // 'Processor "index" could not start on any host.'
 * ```
 *
 * @public
 */
export class ProcessorStartError extends Error {
  override readonly name = 'ProcessorStartError';
}

/**
 * @summary Runs one processor with hybrid failover.
 *
 * @description
 * Implements {@linkcode ProcessorHandle}. `start` tries the definition's
 * hosts in order, taking a worker-budget slot for physical ones, and keeps
 * the first that starts. When that host fails (a rejected call or a failure
 * event), it releases the slot, records the failover, starts the next host,
 * and re-runs calls that were in flight. `stop` shuts the current host down.
 *
 * The kernel creates one per declared processor, before the unit's `init`,
 * and stops it during teardown.
 *
 * @example
 * Example 1: Start, call, stop
 * ```ts
 * const runner = new ProcessorRunner(def, { budget: new WorkerBudget(2) });
 * await runner.start();
 * await runner.call(input);
 * await runner.stop();
 * ```
 *
 * @example
 * Example 2: Observing where it runs
 * ```ts
 * runner.status.subscribe(() => console.log('now on', runner.status.getSnapshot().host));
 * ```
 *
 * @template In The message type.
 * @template Out The result type.
 * @public
 */
export class ProcessorRunner<In = unknown, Out = unknown> implements ProcessorHandle<In, Out> {
  readonly #store = createStore<ProcessorStatus>({ host: null, failovers: [] });
  readonly #posts = new Set<(message: unknown) => void>();
  readonly #scheduler: Scheduler;
  readonly #budget: WorkerBudget;
  readonly #create: typeof createHost;
  #host: Host<In, Out> | null = null;
  #index = -1;
  #release: (() => void) | null = null;
  #unsubscribe: (() => void)[] = [];
  #switching: Promise<void> | null = null;

  /**
   * @param {ProcessorDef<In, Out>} def The processor definition.
   * @param {ProcessorRunnerOptions} [options] Scheduler, budget, slice budget and host factory.
   * @throws {Error} When the definition is invalid (see `validateProcessorDef`).
   */
  constructor(
    readonly def: ProcessorDef<In, Out>,
    private readonly options: ProcessorRunnerOptions = {},
  ) {
    validateProcessorDef(def as ProcessorDef<never, unknown>);
    this.#scheduler = options.scheduler ?? createScheduler();
    this.#budget = options.budget ?? defaultBudget();
    this.#create = options.createHost ?? createHost;
  }

  /**
   * @summary The processor's id.
   * @returns {string} The definition's id.
   */
  get id(): string {
    return this.def.id;
  }

  /**
   * @summary The current host and the failovers so far.
   * @returns {View<ProcessorStatus>} The view.
   */
  get status(): View<ProcessorStatus> {
    return this.#store.view;
  }

  /**
   * @summary Starts on the first host that works.
   * @returns {Promise<void>} Resolves once a host is running.
   * @throws {ProcessorStartError} When even the virtual host fails to start.
   */
  async start(): Promise<void> {
    await this.#startFrom(0);
  }

  /**
   * @summary Runs one message, re-running it on the next host if the current one fails.
   * @param {In} message The message.
   * @returns {Promise<Out>} The result.
   * @throws {Error} When the runner is not running, or with what the processor throws.
   * @throws {ProcessorStartError} When every remaining host fails during the call.
   */
  async call(message: In): Promise<Out> {
    for (;;) {
      await this.#switching;
      const host = this.#host;
      if (!host) throw new Error(`Processor "${this.id}" is not running.`);
      try {
        return await host.call(message);
      } catch (error) {
        if (!(error instanceof HostFailureError)) throw error;
        // Switch (unless another caller already did), then re-run on the next host.
        if (host === this.#host) await this.#failover(error);
      }
    }
  }

  /**
   * @summary Listens to the processor's one-way messages, whatever the host.
   * @param {(message: unknown) => void} listener Receives each message.
   * @returns {() => void} Removes the listener.
   */
  onPost(listener: (message: unknown) => void): () => void {
    this.#posts.add(listener);
    return () => this.#posts.delete(listener);
  }

  /**
   * @summary Stops the current host and releases its budget slot.
   * @returns {Promise<void>} Resolves once stopped.
   */
  async stop(): Promise<void> {
    await this.#switching;
    const host = this.#host;
    this.#detach();
    await host?.stop();
    this.#store.set({ ...this.#store.view.getSnapshot(), host: null });
  }

  /**
   * @summary Switches to the next host, once, however many callers report the failure.
   * @internal
   */
  #failover(error: HostFailureError): Promise<void> {
    this.#switching ??= (async () => {
      this.#record(error);
      this.#detach();
      await this.#startFrom(this.#index + 1);
    })().finally(() => {
      this.#switching = null;
    });
    return this.#switching;
  }

  /**
   * @summary Starts the first working host from index `first` on.
   * @throws {ProcessorStartError} When none starts.
   * @internal
   */
  async #startFrom(first: number): Promise<void> {
    const hosts = this.def.hosts;
    for (let index = first; index < hosts.length; index++) {
      const kind = hosts[index];
      let release: (() => void) | null = null;
      if (kind !== 'virtual') {
        release = this.#budget.tryAcquire(kind, `${kind}:${this.id}`);
        if (!release) {
          this.#record(new HostFailureError(kind, 'budget', 'The worker budget is used up.'));
          continue;
        }
      }
      const host = this.#create(kind, this.def, {
        scheduler: this.#scheduler,
        sliceBudgetMs: this.options.sliceBudgetMs ?? 5,
      });
      try {
        await host.start();
      } catch (error) {
        release?.();
        this.#record(
          error instanceof HostFailureError
            ? error
            : new HostFailureError(kind, 'error', (error as Error)?.message ?? String(error), {
                cause: error,
              }),
        );
        continue;
      }
      this.#host = host;
      this.#index = index;
      this.#release = release;
      this.#unsubscribe = [
        // No caller to throw to: if no host can start, the status shows `host: null`.
        host.onFailure((failure) => void this.#failover(failure).catch(() => {})),
        host.onPost((message) => {
          for (const listener of [...this.#posts]) listener(message);
        }),
      ];
      this.#store.set({ ...this.#store.view.getSnapshot(), host: kind });
      return;
    }
    this.#store.set({ ...this.#store.view.getSnapshot(), host: null });
    throw new ProcessorStartError(`Processor "${this.id}" could not start on any host.`);
  }

  /**
   * @summary Unsubscribes from the current host and releases its budget slot.
   * @internal
   */
  #detach(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    this.#release?.();
    this.#release = null;
    this.#host = null;
  }

  /**
   * @summary Appends a failover to the status.
   * @internal
   */
  #record(error: HostFailureError): void {
    const current = this.#store.view.getSnapshot();
    this.#store.set({
      ...current,
      failovers: [
        ...current.failovers,
        { host: error.host, trigger: error.trigger, message: error.message },
      ],
    });
  }
}

/**
 * @summary The process-wide worker budget, created on first use.
 * @internal
 */
let sharedBudget: WorkerBudget | null = null;

/**
 * @summary Returns the process-wide worker budget, sized for this device.
 *
 * @description
 * Created on first use with `WorkerBudget.forDevice()`, then shared by every
 * runner that is not given its own budget, so workers stay bounded across
 * the whole platform.
 *
 * @example
 * Example 1: Inspecting usage
 * ```ts
 * defaultBudget().used; // physical workers currently running
 * ```
 *
 * @example
 * Example 2: Runners share it by default
 * ```ts
 * new ProcessorRunner(a); new ProcessorRunner(b); // both count against defaultBudget()
 * ```
 *
 * @returns {WorkerBudget} The shared budget.
 *
 * @public
 */
export function defaultBudget(): WorkerBudget {
  return (sharedBudget ??= WorkerBudget.forDevice());
}
