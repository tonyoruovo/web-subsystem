/**
 * @fileoverview
 * @summary Runs one unit: its lifecycle, context, processors, features and teardown.
 * @description
 * Internal to the kernel; only {@linkcode StatePersistence} is public (it is
 * re-exported from `kernel.ts`). One {@linkcode UnitRuntime} exists per
 * subsystem and per feature. It implements the lifecycle rules of
 * docs/ARCHITECTURE.md §3 and §4:
 *
 * ```text
 *   start():  INITIALIZING --> restore persisted state (first start only)
 *                          --> start processors
 *                          --> init(ctx)            (may return a disposer)
 *                          --> start features       (a failing feature does not fail the parent)
 *                          --> control(ctx)
 *                          --> READY, or DEGRADED when a feature is off
 *             any throw    --> teardown --> FAILED
 *
 *   teardown: halt features (reverse) --> disposers (reverse)
 *             --> stop processors (reverse) --> abort ctx.signal
 *   ```
 *
 * @example
 * Persisting unit state to localStorage
 * ```ts
 * import { Kernel, type StatePersistence } from '@platform/core';
 *
 * const persistence: StatePersistence = {
 *   load: (id) => JSON.parse(localStorage.getItem(`unit:${id}`) ?? 'null') ?? undefined,
 *   save: (id, state) => localStorage.setItem(`unit:${id}`, JSON.stringify(state)),
 * };
 * const kernel = new Kernel(subsystems, { persistence });
 * ```
 *
 * @author MathAid
 */

import { Lifecycle, RUNNING_STATUSES, type LifecycleSnapshot, type UnitStatus } from './lifecycle';
import { validateProcessorDef } from './processor';
import { createStateCell, type PersistedState, type StateCell } from './state';
import { ProcessorRunner, type ProcessorRunnerOptions } from './supervisor';
import type {
  ControlInterface,
  Disposer,
  PacketPort,
  SubsystemDefinition,
  UnitContext,
  UnitDefinition,
} from './unit';
import type { Schedule } from './view';

/**
 * @summary Loads and saves units' persisted state (ARCHITECTURE §5).
 *
 * @description
 * `load` returns a unit's {@linkcode PersistedState} (or `undefined`) and is
 * called once, before the unit's first start. `save` receives the state when
 * the unit is destroyed. Both may be asynchronous. Only keys marked
 * `persisted` are ever saved or restored, and only from a matching schema
 * version.
 *
 * Pass one to the kernel as `persistence`. Until the Storage subsystem is
 * ported (M6), a simple adapter over `localStorage` or IndexedDB will do.
 *
 * @example
 * Example 1: localStorage
 * ```ts
 * const persistence: StatePersistence = {
 *   load: (id) => JSON.parse(localStorage.getItem(`unit:${id}`) ?? 'null') ?? undefined,
 *   save: (id, state) => localStorage.setItem(`unit:${id}`, JSON.stringify(state)),
 * };
 * ```
 *
 * @example
 * Example 2: In memory, for tests
 * ```ts
 * import { createMemoryPersistence } from '@platform/core/testing';
 * const persistence = createMemoryPersistence({ prefs: { version: 1, data: { theme: 'dark' } } });
 * ```
 *
 * @public
 */
export interface StatePersistence {
  /**
   * @summary Returns a unit's persisted state.
   * @param {string} unitId The unit's full id.
   * @returns The persisted state, or `undefined` when there is none.
   */
  load(
    unitId: string,
  ): PersistedState<object> | undefined | Promise<PersistedState<object> | undefined>;
  /**
   * @summary Saves a unit's persisted state.
   * @param {string} unitId The unit's full id.
   * @param {PersistedState<object>} state The persisted keys and their schema version.
   */
  save(unitId: string, state: PersistedState<object>): void | Promise<void>;
}

/**
 * @summary What a {@linkcode UnitRuntime} needs from the kernel.
 *
 * @description
 * Dependency checks (`unmet`), lookups (`runtime`), change notification
 * (`changed`, which can ask for dependency reconciliation), error reporting
 * (`reportError`), packet ports (`port`), and the shared options for
 * persistence, processors and view scheduling.
 *
 * @example
 * Example 1: The kernel implements it
 * ```ts
 * const host: RuntimeHost = { unmet, runtime, changed, reportError, port, persistence };
 * ```
 *
 * @example
 * Example 2: A minimal host for a runtime test
 * ```ts
 * const host: RuntimeHost = {
 *   unmet: () => [], runtime: () => undefined, changed: () => {},
 *   reportError: console.error, port: () => fakePort,
 * };
 * ```
 *
 * @internal
 */
export interface RuntimeHost {
  /** Required dependencies (and the parent, for features) that are not met. */
  unmet(runtime: UnitRuntime): string[];
  /** Looks up any unit by full id. */
  runtime(id: string): UnitRuntime | undefined;
  /** Called after every change; `reconcile` asks the kernel to re-check dependencies. */
  changed(runtime: UnitRuntime, reconcile: boolean): void;
  /** Reports an error that has no caller to throw to. */
  reportError(error: unknown, unitId: string): void;
  /** The packet port for this runtime. */
  port(runtime: UnitRuntime): PacketPort;
  /** Loads and saves persisted state. */
  readonly persistence?: StatePersistence;
  /** Scheduler, worker budget and slice budget shared by every processor. */
  readonly processors?: ProcessorRunnerOptions;
  /** View notification scheduling. */
  readonly schedule?: Schedule;
}

/**
 * @summary Turns a thrown value into a lifecycle reason.
 * @internal
 */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * @summary The live instance of one unit definition.
 *
 * @description
 * Owns the unit's {@linkcode Lifecycle}, {@linkcode StateCell}, processor
 * runners, feature runtimes, disposers and context, and implements every
 * lifecycle operation: `start` (or restart), `fail`, `halt`, `busy`,
 * `suspend`, `resume`, `refresh` and `destroy`. None of them throw: failures
 * end in `FAILED` and are reported to the host.
 *
 * The kernel creates one per subsystem (with `parent: null`) and one per
 * feature, and is its only caller. Applications see it through
 * `kernel.unit(id)`.
 *
 * @example
 * Example 1: How the kernel builds runtimes
 * ```ts
 * const runtime = new UnitRuntime(definition, null, host);
 * runtime.features; // one runtime per feature, built recursively
 * ```
 *
 * @example
 * Example 2: Starting and destroying
 * ```ts
 * await runtime.start();   // READY, DEGRADED, FAILED, or still waiting
 * await runtime.destroy(); // DESTROYED, persisted state saved
 * ```
 *
 * @internal
 */
export class UnitRuntime {
  /** The full id: `subsystem` or `subsystem/feature`. */
  readonly id: string;
  /** The unit's lifecycle. */
  readonly lifecycle: Lifecycle;
  /** The unit's state. Kept across restarts. */
  readonly state: StateCell<object>;
  /** One runtime per feature, in declaration order. */
  readonly features: readonly UnitRuntime[];

  #control: ControlInterface | undefined;
  #processors = new Map<string, ProcessorRunner>();
  #context: UnitContext<object> | null = null;
  #disposers: Disposer[] = [];
  #abort: AbortController | null = null;
  #suspendedForDependencies = false;
  #initialized = false;

  /**
   * @param {UnitDefinition} definition The unit's definition.
   * @param {UnitRuntime | null} parent The parent runtime, or `null` for a subsystem.
   * @param {RuntimeHost} host The kernel.
   * @throws {Error} For an empty id, an id containing `/`, an invalid processor definition, or duplicate processor ids.
   */
  constructor(
    readonly definition: UnitDefinition,
    readonly parent: UnitRuntime | null,
    private readonly host: RuntimeHost,
  ) {
    if (definition.id.includes('/') || definition.id === '') {
      throw new Error(
        `Invalid unit id "${definition.id}": it must be non-empty and contain no "/".`,
      );
    }
    this.id = parent ? `${parent.id}/${definition.id}` : definition.id;
    this.lifecycle = new Lifecycle(this.id);
    this.state = createStateCell(this.id, definition.state, host.schedule);
    this.features = (definition.features ?? []).map((f) => new UnitRuntime(f, this, host));
    const processorIds = (definition.processors ?? []).map((def) => {
      validateProcessorDef(def);
      return def.id;
    });
    if (new Set(processorIds).size !== processorIds.length) {
      throw new Error(`[${this.id}] Processor ids must be unique.`);
    }
  }

  /**
   * @summary The subsystem this unit belongs to (itself, for a subsystem).
   * @returns {UnitRuntime} The root runtime.
   */
  get root(): UnitRuntime {
    return this.parent ? this.parent.root : this;
  }

  /**
   * @summary The current status.
   * @returns {UnitStatus} The lifecycle's status.
   */
  get status(): UnitStatus {
    return this.lifecycle.status;
  }

  /**
   * @summary The current lifecycle snapshot.
   * @returns {LifecycleSnapshot} The snapshot.
   */
  get snapshot(): LifecycleSnapshot {
    return this.lifecycle.view.getSnapshot();
  }

  /**
   * @summary Tells whether the unit is running (`READY`, `BUSY` or `DEGRADED`).
   * @returns {boolean} `true` while running.
   */
  get running(): boolean {
    return RUNNING_STATUSES.has(this.status);
  }

  /**
   * @summary The control interface while running.
   * @returns {ControlInterface | undefined} The control interface, or `undefined` when not running.
   */
  get control(): ControlInterface | undefined {
    return this.running ? this.#control : undefined;
  }

  /**
   * @summary The context while initialized.
   * @returns {UnitContext<object> | null} The context, or `null` before start and after teardown.
   */
  get context(): UnitContext<object> | null {
    return this.#context;
  }

  /**
   * @summary Tells whether the kernel suspended this unit because a dependency stopped.
   * @returns {boolean} `true` when the suspension should end once the dependency runs again.
   */
  get suspendedForDependencies(): boolean {
    return this.#suspendedForDependencies;
  }

  /**
   * @summary The subsystem definition this unit belongs to.
   * @returns {SubsystemDefinition} The root's definition.
   */
  get subsystem(): SubsystemDefinition {
    return this.root.definition as SubsystemDefinition;
  }

  /**
   * @summary Starts (or restarts, from `FAILED`) the unit when its dependencies are met.
   * @description Records `waitingFor` when they are not. Never throws: a
   * failing processor, initializer, or control factory leaves the unit
   * `FAILED`, after a full teardown.
   * @returns {Promise<void>} Resolves when the start attempt is over.
   */
  async start(): Promise<void> {
    if (this.status !== 'UNINITIALIZED' && this.status !== 'FAILED') return;

    const unmet = this.host.unmet(this);
    if (unmet.length > 0) {
      if (this.status === 'UNINITIALIZED') {
        const current = this.snapshot.waitingFor;
        if (current.join() !== unmet.join()) {
          this.lifecycle.wait(unmet);
          this.host.changed(this, false);
        }
      }
      return;
    }

    this.#transition('INITIALIZING');
    this.#abort = new AbortController();
    const context = this.#createContext(this.#abort.signal);
    this.#context = context;
    try {
      if (!this.#initialized) {
        const persisted = await this.host.persistence?.load(this.id);
        if (persisted) this.state.restore(persisted);
      }
      for (const def of this.definition.processors ?? []) {
        const runner = new ProcessorRunner(def, this.host.processors);
        this.#processors.set(def.id, runner);
        await runner.start();
      }
      const disposer = await this.definition.init?.(context);
      if (typeof disposer === 'function') this.#disposers.push(disposer);
      for (const feature of this.features) await feature.start();
      this.#control = this.definition.control(context);
      this.#initialized = true;
      this.#settle();
    } catch (error) {
      await this.#teardown();
      this.#transition('FAILED', { reason: describeError(error) });
      this.host.reportError(error, this.id);
    }
    // A feature that starts (or fails) after its parent is running changes the parent's status.
    this.parent?.refresh();
  }

  /**
   * @summary Fails the unit at runtime (from `ctx.fail`).
   * @description Ignored unless the unit is running or suspended. Tears it
   * down, moves it to `FAILED`, reports the error, and lets the parent
   * re-derive its status.
   * @param {unknown} error What went wrong.
   * @returns {Promise<void>} Resolves after teardown.
   */
  async fail(error: unknown): Promise<void> {
    if (!this.running && this.status !== 'SUSPENDED') return;
    await this.#teardown();
    this.#transition('FAILED', { reason: describeError(error) });
    this.host.reportError(error, this.id);
    this.parent?.refresh();
  }

  /**
   * @summary Stops a running feature because its parent stopped.
   * @param {string} reason The lifecycle reason.
   * @returns {Promise<void>} Resolves after teardown.
   */
  async halt(reason: string): Promise<void> {
    if (!this.running && this.status !== 'SUSPENDED') return;
    await this.#teardown();
    this.#transition('FAILED', { reason });
  }

  /**
   * @summary Moves between `READY` and `BUSY`. Ignored in other statuses.
   * @param {boolean} isBusy `true` for `BUSY`.
   */
  busy(isBusy: boolean): void {
    if (isBusy && this.status === 'READY') this.#transition('BUSY');
    else if (!isBusy && this.status === 'BUSY') this.#settle(true);
  }

  /**
   * @summary Suspends the unit and its running features.
   * @description A throwing `suspend` hook is reported, and the unit is suspended anyway.
   * @param {string} reason The lifecycle reason.
   * @param {boolean} [byDependency=false] `true` when the kernel suspends it because a dependency stopped.
   * @returns {Promise<void>} Resolves once suspended.
   */
  async suspend(reason: string, byDependency = false): Promise<void> {
    if (!this.running) return;
    for (const feature of this.features) await feature.suspend(reason, byDependency);
    try {
      await this.definition.suspend?.(this.#context!);
    } catch (error) {
      this.host.reportError(error, this.id);
    }
    this.#suspendedForDependencies = byDependency;
    this.#transition('SUSPENDED', { reason });
  }

  /**
   * @summary Resumes a suspended unit and its suspended features.
   * @description A throwing `resume` hook fails the unit.
   * @returns {Promise<void>} Resolves once resumed (or failed).
   */
  async resume(): Promise<void> {
    if (this.status !== 'SUSPENDED') return;
    try {
      await this.definition.resume?.(this.#context!);
    } catch (error) {
      await this.fail(error);
      return;
    }
    this.#suspendedForDependencies = false;
    for (const feature of this.features) await feature.resume();
    this.#settle(true);
  }

  /** @summary Re-derives `READY` or `DEGRADED` after a feature changed. Ignored unless running. */
  refresh(): void {
    if (this.running) this.#settle();
  }

  /**
   * @summary Destroys the unit and its features, runs disposers, and saves persisted state.
   * @description A throwing disposer or `save` is reported; destruction always completes.
   * @returns {Promise<void>} Resolves once `DESTROYED`.
   */
  async destroy(): Promise<void> {
    if (this.status === 'DESTROYING' || this.status === 'DESTROYED') return;
    this.#transition('DESTROYING');
    for (const feature of [...this.features].reverse()) await feature.destroy();
    await this.#teardown();
    if (this.#initialized && this.host.persistence) {
      try {
        await this.host.persistence.save(this.id, this.state.persist());
      } catch (error) {
        this.host.reportError(error, this.id);
      }
    }
    this.#transition('DESTROYED');
  }

  /**
   * @summary Moves to `READY` or `DEGRADED` from the current running or suspended status.
   * @param {boolean} [leaveBusy=false] `true` to leave `BUSY` even when no feature is off.
   * @internal
   */
  #settle(leaveBusy = false): void {
    const off = this.features.filter((f) => !f.running).map((f) => f.definition.id);
    const status = this.status;
    if (status === 'BUSY' && off.length === 0 && !leaveBusy) return;
    const target: UnitStatus = off.length > 0 ? 'DEGRADED' : 'READY';
    const reason = off.length > 0 ? `Features not running: ${off.join(', ')}.` : null;
    if (status === target) {
      this.lifecycle.describe({ reason, offFeatures: off });
      this.host.changed(this, false);
    } else {
      this.#transition(target, { reason, offFeatures: off });
    }
  }

  /**
   * @summary Halts features, runs disposers, stops processors and aborts the signal, in that order.
   * @internal
   */
  async #teardown(): Promise<void> {
    for (const feature of [...this.features].reverse()) {
      await feature.halt(`Parent ${this.id} stopped.`);
    }
    for (const disposer of this.#disposers.reverse()) {
      try {
        await disposer();
      } catch (error) {
        this.host.reportError(error, this.id);
      }
    }
    this.#disposers = [];
    for (const runner of [...this.#processors.values()].reverse()) {
      try {
        await runner.stop();
      } catch (error) {
        this.host.reportError(error, this.id);
      }
    }
    this.#processors = new Map();
    this.#abort?.abort();
    this.#abort = null;
    this.#control = undefined;
    this.#context = null;
    this.#suspendedForDependencies = false;
  }

  /**
   * @summary Transitions the lifecycle and asks the kernel to reconcile.
   * @internal
   */
  #transition(
    to: UnitStatus,
    details?: { reason?: string | null; offFeatures?: readonly string[] },
  ) {
    this.lifecycle.transition(to, details);
    this.host.changed(this, true);
  }

  /**
   * @summary Builds the {@linkcode UnitContext} for one start.
   * @internal
   */
  #createContext(signal: AbortSignal): UnitContext<object> {
    const declared = new Set((this.definition.requires ?? []).map((d) => d.target));
    return {
      id: this.id,
      state: this.state,
      signal,
      port: this.host.port(this),
      dependency: <C extends ControlInterface>(target: string) => {
        if (!declared.has(target)) {
          throw new Error(`[${this.id}] "${target}" is not a declared dependency.`);
        }
        return this.host.runtime(target)?.control as C | undefined;
      },
      sibling: <C extends ControlInterface>(featureId: string) => {
        if (!this.parent) throw new Error(`[${this.id}] Only features have siblings.`);
        const sibling = this.parent.features.find((f) => f.definition.id === featureId);
        if (!sibling || sibling === this) {
          throw new Error(`[${this.id}] "${featureId}" is not a sibling feature.`);
        }
        return sibling.control as C | undefined;
      },
      busy: (isBusy) => this.busy(isBusy),
      fail: (error) => void this.fail(error),
      processor: <In, Out>(processorId: string) => {
        const runner = this.#processors.get(processorId);
        if (!runner) throw new Error(`[${this.id}] No processor "${processorId}".`);
        return runner as unknown as ProcessorRunner<In, Out>;
      },
    };
  }
}
