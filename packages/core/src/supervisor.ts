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
 * @author MathAid
 */

import { WorkerBudget } from './budget';
import { HostFailureError, createHost, type FailoverTrigger, type Host } from './host';
import { validateProcessorDef, type HostKind, type ProcessorDef } from './processor';
import { createScheduler, type Scheduler } from './scheduler';
import { createStore, type View } from './view';

/** @summary A processor's current host and the failovers so far. */
export interface ProcessorStatus {
  /** The running host, or `null` before start and after stop. */
  readonly host: HostKind | null;
  readonly failovers: readonly {
    readonly host: HostKind;
    readonly trigger: FailoverTrigger;
    readonly message: string;
  }[];
}

/** @summary What a unit holds for one of its processors (`ctx.processor(id)`). */
export interface ProcessorHandle<In = unknown, Out = unknown> {
  readonly id: string;
  readonly status: View<ProcessorStatus>;
  /** Runs one message on the current host. Re-run on the next host if the current one fails. */
  call(message: In): Promise<Out>;
  /** One-way messages from the processor. */
  onPost(listener: (message: unknown) => void): () => void;
}

/** @summary Options shared by every runner. */
export interface ProcessorRunnerOptions {
  readonly scheduler?: Scheduler;
  readonly budget?: WorkerBudget;
  /** Slice budget for virtual hosts (§8.6). Default 5 ms. */
  readonly sliceBudgetMs?: number;
  /** Replaces host creation, for tests. */
  readonly createHost?: typeof createHost;
}

/** @summary Thrown when no host, not even the virtual one, could start. */
export class ProcessorStartError extends Error {
  override readonly name = 'ProcessorStartError';
}

/** @summary Runs one processor with hybrid failover. */
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

  constructor(
    readonly def: ProcessorDef<In, Out>,
    private readonly options: ProcessorRunnerOptions = {},
  ) {
    validateProcessorDef(def as ProcessorDef<never, unknown>);
    this.#scheduler = options.scheduler ?? createScheduler();
    this.#budget = options.budget ?? defaultBudget();
    this.#create = options.createHost ?? createHost;
  }

  get id(): string {
    return this.def.id;
  }

  get status(): View<ProcessorStatus> {
    return this.#store.view;
  }

  /**
   * @summary Starts on the first host that works.
   * @throws {ProcessorStartError} When even the virtual host fails to start.
   */
  async start(): Promise<void> {
    await this.#startFrom(0);
  }

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

  onPost(listener: (message: unknown) => void): () => void {
    this.#posts.add(listener);
    return () => this.#posts.delete(listener);
  }

  async stop(): Promise<void> {
    await this.#switching;
    const host = this.#host;
    this.#detach();
    await host?.stop();
    this.#store.set({ ...this.#store.view.getSnapshot(), host: null });
  }

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

  #detach(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    this.#release?.();
    this.#release = null;
    this.#host = null;
  }

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

let sharedBudget: WorkerBudget | null = null;

/** @summary The process-wide worker budget, sized for this device. */
export function defaultBudget(): WorkerBudget {
  return (sharedBudget ??= WorkerBudget.forDevice());
}
