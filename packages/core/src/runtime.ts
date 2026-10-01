/**
 * @fileoverview
 * @summary Runs one unit: its lifecycle, context, features and teardown.
 * @description
 * Internal to the kernel. One {@linkcode UnitRuntime} exists per subsystem
 * and per feature. It implements the lifecycle rules of
 * docs/ARCHITECTURE.md §3 and §4:
 *
 * - `init`, then the features, then `control`. Any throw fails the unit.
 * - A feature that fails leaves its parent `DEGRADED`, never `FAILED`.
 * - Teardown runs disposers in reverse, aborts the unit's signal, and
 *   stops its features.
 *
 * @author MathAid
 */

import { Lifecycle, RUNNING_STATUSES, type LifecycleSnapshot, type UnitStatus } from './lifecycle';
import { createStateCell, type PersistedState, type StateCell } from './state';
import type {
  ControlInterface,
  Disposer,
  PacketPort,
  SubsystemDefinition,
  UnitContext,
  UnitDefinition,
} from './unit';
import type { Schedule } from './view';

/** @summary Loads and saves units' persisted state (§5). */
export interface StatePersistence {
  load(
    unitId: string,
  ): PersistedState<object> | undefined | Promise<PersistedState<object> | undefined>;
  save(unitId: string, state: PersistedState<object>): void | Promise<void>;
}

/** @summary What a runtime needs from the kernel. */
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
  readonly persistence?: StatePersistence;
  readonly schedule?: Schedule;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** @summary The live instance of one unit definition. */
export class UnitRuntime {
  readonly id: string;
  readonly lifecycle: Lifecycle;
  readonly state: StateCell<object>;
  readonly features: readonly UnitRuntime[];

  #control: ControlInterface | undefined;
  #context: UnitContext<object> | null = null;
  #disposers: Disposer[] = [];
  #abort: AbortController | null = null;
  #suspendedForDependencies = false;
  #initialized = false;

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
  }

  /** @summary The subsystem this unit belongs to (itself, for a subsystem). */
  get root(): UnitRuntime {
    return this.parent ? this.parent.root : this;
  }

  get status(): UnitStatus {
    return this.lifecycle.status;
  }

  get snapshot(): LifecycleSnapshot {
    return this.lifecycle.view.getSnapshot();
  }

  /** @summary True in `READY`, `BUSY` and `DEGRADED`. */
  get running(): boolean {
    return RUNNING_STATUSES.has(this.status);
  }

  /** @summary The control interface while running, otherwise `undefined`. */
  get control(): ControlInterface | undefined {
    return this.running ? this.#control : undefined;
  }

  /** @summary The context while initialized, otherwise `null`. */
  get context(): UnitContext<object> | null {
    return this.#context;
  }

  /** @summary True when the kernel suspended this unit because a dependency stopped. */
  get suspendedForDependencies(): boolean {
    return this.#suspendedForDependencies;
  }

  /** @summary The subsystem definition. Only valid on a root runtime. */
  get subsystem(): SubsystemDefinition {
    return this.root.definition as SubsystemDefinition;
  }

  /**
   * @summary Starts (or restarts, from `FAILED`) the unit when its dependencies are met.
   * @description Never throws: a failing initializer leaves the unit `FAILED`.
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
   * @summary Fails the running unit (from `ctx.fail`). Ignored when it is not running or suspended.
   */
  async fail(error: unknown): Promise<void> {
    if (!this.running && this.status !== 'SUSPENDED') return;
    await this.#teardown();
    this.#transition('FAILED', { reason: describeError(error) });
    this.host.reportError(error, this.id);
    this.parent?.refresh();
  }

  /** @summary Stops a running feature because its parent stopped. */
  async halt(reason: string): Promise<void> {
    if (!this.running && this.status !== 'SUSPENDED') return;
    await this.#teardown();
    this.#transition('FAILED', { reason });
  }

  /** @summary `READY` <-> `BUSY`. */
  busy(isBusy: boolean): void {
    if (isBusy && this.status === 'READY') this.#transition('BUSY');
    else if (!isBusy && this.status === 'BUSY') this.#settle(true);
  }

  /**
   * @summary Suspends the unit and its running features.
   * @param {string} reason Why.
   * @param {boolean} [byDependency] True when the kernel suspends it because a dependency stopped.
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

  /** @summary Resumes a suspended unit and its suspended features. */
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

  /** @summary Re-derives `READY` / `DEGRADED` after a feature changed. */
  refresh(): void {
    if (this.running) this.#settle();
  }

  /** @summary Destroys the unit and its features, runs disposers, and saves persisted state. */
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

  /** Moves to READY or DEGRADED from the current running or suspended status. */
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
    this.#abort?.abort();
    this.#abort = null;
    this.#control = undefined;
    this.#context = null;
    this.#suspendedForDependencies = false;
  }

  #transition(
    to: UnitStatus,
    details?: { reason?: string | null; offFeatures?: readonly string[] },
  ) {
    this.lifecycle.transition(to, details);
    this.host.changed(this, true);
  }

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
    };
  }
}
