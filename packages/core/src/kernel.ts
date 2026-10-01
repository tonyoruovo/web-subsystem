/**
 * @fileoverview
 * @summary The kernel: registers subsystems, enforces dependencies and runs every unit.
 * @description
 * Implements docs/ARCHITECTURE.md §3.3 and §7.1:
 *
 * - Validates the dependency graph of every subsystem and feature at construction.
 * - Starts subsystems in dependency order. A unit whose required dependency is
 *   not met waits (`UNINITIALIZED` + `waitingFor`) and starts when it is.
 * - A running unit whose required dependency stops is suspended, and resumed
 *   when the dependency runs again.
 * - Builds each unit's packet port and delivers packets through a pluggable
 *   {@linkcode PacketRouter}. Until the Queue exists (M3), the default
 *   {@linkcode directRouter} delivers in the same realm.
 *
 * ```text
 *   new Kernel(subsystems)   build runtimes, validate the graph (throws on cycles)
 *   kernel.start()           start in boot order, then reconcile until stable
 *   (any status change)      reconcile: start waiting units, suspend or resume dependents
 *   kernel.stop()            destroy in reverse boot order, centralized subsystems included
 *   ```
 *
 * @example
 * Booting, using and stopping the platform
 * ```ts
 * import { Kernel } from '@platform/core';
 *
 * const kernel = new Kernel([storage, auth]);
 * await kernel.start();
 * await kernel.unit<AuthControl>('auth').control?.commands.login(credentials);
 * await kernel.stop();
 * ```
 *
 * @example
 * Showing the platform's state in a status bar
 * ```ts
 * kernel.statuses.subscribe(() => {
 *   const statuses = kernel.statuses.getSnapshot();
 *   const failed = Object.entries(statuses).filter(([, s]) => s.status === 'FAILED');
 *   statusBar.textContent = failed.length ? `${failed.length} part(s) unavailable` : 'All systems running';
 * });
 * ```
 *
 * @throws {DependencyCycleError} From the {@linkcode Kernel} constructor when required dependencies form a cycle.
 * @see [Package README](../README.md)
 * @author MathAid
 */

import { DependencyGraph, isRequired, type DependencyNode } from './dependency';
import type { LifecycleSnapshot } from './lifecycle';
import {
  Packet,
  appendFingerprint,
  createEnvelope,
  makeFingerprint,
  type FingerprintTrail,
  type IdFactory,
  type OutgoingPacket,
  type PacketEnvelope,
} from './packet';
import { UnitRuntime, type RuntimeHost, type StatePersistence } from './runtime';
import { assertSendAllowed, type Scope } from './scope';
import type { ProcessorRunnerOptions } from './supervisor';
import type { ControlInterface, PacketPort, SubsystemDefinition, UnitDefinition } from './unit';
import { createStore, type Schedule, type View } from './view';

export type { StatePersistence } from './runtime';

/**
 * @summary Moves envelopes between subsystems.
 *
 * @description
 * One method, `route`, which delivers an envelope and, for a request
 * (`expectReply: true`), resolves with the reply. A broadcast has
 * `metadata.target === null`.
 *
 * The kernel sends every packet a port produces through its router. The
 * default is {@linkcode directRouter}; the Queue (M3) replaces it to add
 * admission, priorities, retries and cross-realm delivery.
 *
 * @example
 * Example 1: A router that logs, then delivers directly
 * ```ts
 * const kernel = new Kernel(subsystems, {
 *   router: (k) => {
 *     const direct = directRouter(k);
 *     return {
 *       route(envelope, expectReply) {
 *         console.debug('route', envelope.eventId);
 *         return direct.route(envelope, expectReply);
 *       },
 *     };
 *   },
 * });
 * ```
 *
 * @example
 * Example 2: A router that forwards requests to another realm
 * ```ts
 * const router: PacketRouter = {
 *   route: (envelope, expectReply) =>
 *     expectReply ? transport.request(envelope) : Promise.resolve(transport.send(envelope)),
 * };
 * ```
 *
 * @public
 */
export interface PacketRouter {
  /**
   * @summary Routes an envelope.
   * @param {PacketEnvelope} envelope The envelope; `metadata.target` is `null` for a broadcast.
   * @param {boolean} expectReply `true` for a request: resolve with the reply.
   * @returns {Promise<unknown>} The reply for a request; anything for the rest.
   */
  route(envelope: PacketEnvelope, expectReply: boolean): Promise<unknown>;
}

/**
 * @summary Thrown when a packet targets a subsystem that cannot receive it.
 *
 * @description
 * `unitId` is the target and `status` says why: `'unknown'`, `'features are
 * not addressable'`, `'it does not receive packets'`, or its lifecycle status
 * when it is not running.
 *
 * @example
 * Example 1: Retrying once the target runs
 * ```ts
 * try {
 *   await ctx.port.request({ eventId: 'sync:pull', payload: null, target: 'sync' });
 * } catch (error) {
 *   if (error instanceof UnitUnavailableError && error.status === 'SUSPENDED') scheduleRetry();
 * }
 * ```
 *
 * @example
 * Example 2: The message
 * ```ts
 * new UnitUnavailableError('sync', 'FAILED').message; // 'Subsystem "sync" cannot receive packets (FAILED).'
 * ```
 *
 * @public
 */
export class UnitUnavailableError extends Error {
  override readonly name = 'UnitUnavailableError';

  /**
   * @param {string} unitId The target.
   * @param {string} status Why it cannot receive: a status or a short reason.
   */
  constructor(
    readonly unitId: string,
    readonly status: string,
  ) {
    super(`Subsystem "${unitId}" cannot receive packets (${status}).`);
  }
}

/**
 * @summary Thrown when a packet's time to live has passed before delivery.
 *
 * @example
 * Example 1: A request that must be answered quickly
 * ```ts
 * await ctx.port.request({ eventId: 'ui:hint', payload: null, target: 'hints', ttl: 200 });
 * // rejects with PacketExpiredError if it could not be delivered within 200 ms
 * ```
 *
 * @example
 * Example 2: Ignoring stale packets
 * ```ts
 * catch (error) { if (!(error instanceof PacketExpiredError)) throw error; }
 * ```
 *
 * @public
 */
export class PacketExpiredError extends Error {
  override readonly name = 'PacketExpiredError';
}

/**
 * @summary Options for a {@linkcode Kernel}.
 *
 * @description
 * Every option is optional. `router` replaces packet delivery, `persistence`
 * restores and saves unit state, `onError` receives errors that have no caller
 * to throw to, `ids` and `now` replace the id source and the clock (useful in
 * tests), `schedule` replaces view notification scheduling, and `processors`
 * sets the scheduler, worker budget and slice budget shared by every
 * processor.
 *
 * @example
 * Example 1: Production defaults with persistence and error reporting
 * ```ts
 * const kernel = new Kernel(subsystems, {
 *   persistence,
 *   onError: (error, unitId) => errorTracker.capture(error, { unitId }),
 * });
 * ```
 *
 * @example
 * Example 2: A small worker budget on low-end devices
 * ```ts
 * const kernel = new Kernel(subsystems, {
 *   processors: { budget: new WorkerBudget(1), sliceBudgetMs: 4 },
 * });
 * ```
 *
 * @public
 */
export interface KernelOptions {
  /** Builds the packet router. Defaults to {@linkcode directRouter}. */
  readonly router?: (kernel: Kernel) => PacketRouter;
  /** Loads and saves persisted unit state. */
  readonly persistence?: StatePersistence;
  /** Errors with no caller to throw to. Defaults to `console.error`. */
  readonly onError?: (error: unknown, unitId: string) => void;
  /** Id source for packets. Defaults to `crypto.randomUUID`. */
  readonly ids?: IdFactory;
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** View notification scheduling. Defaults to `queueMicrotask`. */
  readonly schedule?: Schedule;
  /** Scheduler, worker budget and slice budget for processors (ARCHITECTURE §8). */
  readonly processors?: ProcessorRunnerOptions;
}

/**
 * @summary A handle on one unit, for applications and the platform.
 *
 * @description
 * Exposes the unit's `id`, its observable `lifecycle`, its `control`
 * interface (only while running), and lifecycle commands: `restart` (from
 * `FAILED`, or a waiting unit), `suspend`, `resume` and `destroy`. Every
 * command resolves after the kernel has reconciled dependencies.
 *
 * Returned by {@linkcode Kernel.unit}. Framework adapters and the
 * orchestrator build on it.
 *
 * @example
 * Example 1: Suspending work while the page is hidden
 * ```ts
 * document.addEventListener('visibilitychange', () => {
 *   const sync = kernel.unit('sync');
 *   void (document.hidden ? sync.suspend('Page hidden.') : sync.resume());
 * });
 * ```
 *
 * @example
 * Example 2: A retry button for a failed unit
 * ```ts
 * retryButton.onclick = () => kernel.unit('storage/idb').restart();
 * ```
 *
 * @template C The unit's control interface type.
 * @public
 */
export interface UnitHandle<C extends ControlInterface = ControlInterface> {
  /** The unit's full id. */
  readonly id: string;
  /** The unit's lifecycle, observable. */
  readonly lifecycle: View<LifecycleSnapshot>;
  /** The control interface while running, otherwise `undefined`. */
  readonly control: C | undefined;
  /** Starts a `FAILED` (or waiting) unit again. */
  restart(): Promise<void>;
  /**
   * @summary Suspends a running unit, for example when the page is hidden.
   * @param {string} [reason='Suspended.'] The lifecycle reason.
   */
  suspend(reason?: string): Promise<void>;
  /** Resumes a suspended unit. */
  resume(): Promise<void>;
  /**
   * @summary Destroys the unit. `DESTROYED` is final.
   * @throws {Error} For a centralized subsystem: only the platform destroys those.
   */
  destroy(): Promise<void>;
}

/**
 * @summary The default router: delivers in the same realm, straight to the kernel.
 *
 * @description
 * Requests go to {@linkcode Kernel.deliver}, broadcasts to
 * {@linkcode Kernel.broadcast}. No queueing, priorities or retries: the
 * Queue (M3) adds those.
 *
 * @example
 * Example 1: Wrapping it
 * ```ts
 * const kernel = new Kernel(subsystems, { router: (k) => withLogging(directRouter(k)) });
 * ```
 *
 * @example
 * Example 2: It is the default
 * ```ts
 * new Kernel(subsystems); // same as { router: directRouter }
 * ```
 *
 * @param {Kernel} kernel The kernel to deliver to.
 * @returns {PacketRouter} The router.
 *
 * @public
 */
export function directRouter(kernel: Kernel): PacketRouter {
  return {
    route: (envelope) =>
      envelope.metadata.target === null ? kernel.broadcast(envelope) : kernel.deliver(envelope),
  };
}

/**
 * @summary The platform kernel.
 *
 * @description
 * Takes the platform's {@linkcode SubsystemDefinition}s and runs them. The
 * constructor builds a runtime for every subsystem and feature and validates
 * the dependency graph. `start` boots in dependency order; `stop` destroys in
 * reverse. While running, the kernel reconciles dependencies after every
 * status change, delivers packets (`deliver`, `broadcast`), and publishes every
 * unit's lifecycle in `statuses`. `unit(id)` returns a {@linkcode UnitHandle}.
 *
 * An application creates exactly one kernel, usually through the platform
 * orchestrator (M10) or a framework adapter. Tests use
 * `createTestPlatform` from `@platform/core/testing`, which wraps one.
 *
 * @example
 * Example 1: Boot and stop
 * ```ts
 * const kernel = new Kernel([storage, auth, sync]);
 * await kernel.start();
 * // ...
 * await kernel.stop();
 * ```
 *
 * @example
 * Example 2: Waiting for a unit that depends on a slow dependency
 * ```ts
 * await kernel.start();
 * kernel.unit('sync').lifecycle.getSnapshot(); // { status: 'UNINITIALIZED', waitingFor: ['network'] }
 * ```
 *
 * @example
 * Example 3: Stopping on page unload
 * ```ts
 * addEventListener('pagehide', (event) => {
 *   if (!event.persisted) void kernel.stop();
 * });
 * ```
 *
 * @public
 */
export class Kernel {
  readonly #runtimes = new Map<string, UnitRuntime>();
  readonly #roots: UnitRuntime[] = [];
  readonly #order: UnitRuntime[];
  readonly #router: PacketRouter;
  readonly #statuses = createStore<Readonly<Record<string, LifecycleSnapshot>>>({});
  readonly #ids: IdFactory;
  readonly #now: () => number;
  readonly #onError: (error: unknown, unitId: string) => void;
  #chain: Promise<void> = Promise.resolve();
  #reconcileQueued = false;
  #started = false;
  #stopping = false;

  /**
   * @param {readonly SubsystemDefinition[]} subsystems Every subsystem of the platform.
   * @param {KernelOptions} [options] Router, persistence, error handling, ids, clock and processor options.
   * @throws {DependencyCycleError} When required dependencies form a cycle.
   * @throws {Error} For duplicate ids, invalid unit ids, or invalid processor definitions.
   */
  constructor(subsystems: readonly SubsystemDefinition[], options: KernelOptions = {}) {
    this.#ids = options.ids ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#onError =
      options.onError ?? ((error, unitId) => console.error(`[kernel] ${unitId}:`, error));

    const host: RuntimeHost = {
      unmet: (runtime) => this.#unmet(runtime),
      runtime: (id) => this.#runtimes.get(id),
      changed: (runtime, reconcile) => this.#changed(runtime, reconcile),
      reportError: (error, unitId) => this.#onError(error, unitId),
      port: (runtime) => this.#port(runtime),
      persistence: options.persistence,
      schedule: options.schedule,
      processors: options.processors,
      statuses: this.#statuses.view,
    };

    const nodes: DependencyNode[] = [];
    const register = (runtime: UnitRuntime) => {
      if (this.#runtimes.has(runtime.id))
        throw new Error(`Unit "${runtime.id}" is registered twice.`);
      this.#runtimes.set(runtime.id, runtime);
      const implicitParent = runtime.parent
        ? [{ target: runtime.parent.id, when: 'INITIALIZING' as const }]
        : [];
      nodes.push({
        id: runtime.id,
        requires: [...implicitParent, ...(runtime.definition.requires ?? [])],
      });
      runtime.features.forEach(register);
    };
    for (const definition of subsystems) {
      const runtime = new UnitRuntime(definition as UnitDefinition, null, host);
      this.#roots.push(runtime);
      register(runtime);
    }

    // Centralized subsystems are infrastructure: they may only require each other.
    for (const runtime of this.#roots) {
      if (runtime.subsystem.kind !== 'centralized') continue;
      for (const dependency of runtime.definition.requires ?? []) {
        const target = this.#runtimes.get(dependency.target);
        if (isRequired(dependency) && target && target.root.subsystem.kind !== 'centralized') {
          throw new Error(
            `Centralized subsystem "${runtime.id}" cannot require "${dependency.target}": it is not centralized.`,
          );
        }
      }
    }

    const order = new DependencyGraph(nodes).order(); // throws on a required cycle
    this.#order = order.map((id) => this.#runtimes.get(id)!);
    this.#statuses.set(Object.fromEntries([...this.#runtimes].map(([id, r]) => [id, r.snapshot])));
    this.#router = (options.router ?? directRouter)(this);
  }

  /**
   * @summary Every unit's lifecycle snapshot, keyed by full id.
   * @returns {View<Readonly<Record<string, LifecycleSnapshot>>>} The view.
   */
  get statuses(): View<Readonly<Record<string, LifecycleSnapshot>>> {
    return this.#statuses.view;
  }

  /**
   * @summary The ids of every registered unit, in boot order.
   * @returns {readonly string[]} Subsystem and feature ids.
   */
  get unitIds(): readonly string[] {
    return this.#order.map((r) => r.id);
  }

  /**
   * @summary Starts every subsystem: centralized ones first, each group in dependency order.
   * @description Calling it again has no effect.
   * @returns {Promise<void>} Resolves once every unit that can start has started.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // Centralized subsystems first (ARCHITECTURE §12), each group in dependency order.
    const roots = this.#order.filter((runtime) => !runtime.parent);
    for (const runtime of roots)
      if (runtime.subsystem.kind === 'centralized') await runtime.start();
    for (const runtime of roots)
      if (runtime.subsystem.kind !== 'centralized') await runtime.start();
    await this.settled();
  }

  /**
   * @summary Destroys every subsystem, centralized ones included, in reverse boot order.
   * @returns {Promise<void>} Resolves once every subsystem is `DESTROYED`.
   */
  async stop(): Promise<void> {
    await this.settled();
    this.#stopping = true;
    for (const runtime of [...this.#order].reverse()) if (!runtime.parent) await runtime.destroy();
  }

  /**
   * @summary Waits until dependency reconciliation has finished.
   * @returns {Promise<void>} Resolves when no reconciliation is pending.
   */
  async settled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.#chain;
      await current;
    } while (current !== this.#chain || this.#reconcileQueued);
  }

  /**
   * @summary Returns a handle on a unit.
   * @template C The unit's control interface type.
   * @param {string} id A subsystem id or `subsystem/feature`.
   * @returns {UnitHandle<C>} The handle.
   * @throws {Error} For an unknown id.
   */
  unit<C extends ControlInterface = ControlInterface>(id: string): UnitHandle<C> {
    const runtime = this.#runtimes.get(id);
    if (!runtime) throw new Error(`Unknown unit "${id}".`);
    return {
      id,
      lifecycle: runtime.lifecycle.view,
      get control() {
        return runtime.control as C | undefined;
      },
      restart: async () => {
        await runtime.start();
        await this.settled();
      },
      suspend: async (reason = 'Suspended.') => {
        await runtime.suspend(reason);
        await this.settled();
      },
      resume: async () => {
        await runtime.resume();
        await this.settled();
      },
      destroy: async () => {
        if (!runtime.parent && runtime.subsystem.kind === 'centralized') {
          throw new Error(`"${id}" is centralized: only the platform can destroy it.`);
        }
        await runtime.destroy();
        runtime.parent?.refresh();
        await this.settled();
      },
    };
  }

  /**
   * @summary Returns a subsystem's scope.
   * @description Routers use it to check the send rule for envelopes they did not build.
   * @param {string} id A subsystem id.
   * @returns {Scope | undefined} The scope, or `undefined` for an unknown id or a feature.
   */
  scopeOf(id: string): Scope | undefined {
    const runtime = this.#runtimes.get(id);
    return runtime && !runtime.parent ? runtime.subsystem.scope : undefined;
  }

  /**
   * @summary Lists the running subsystems that receive an event.
   * @description Running subsystems with a `receive` handler that list
   * `eventId` in `subscribes`, in registration order.
   * @param {string} eventId The event id.
   * @returns {string[]} Their ids.
   */
  subscribers(eventId: string): string[] {
    return this.#roots
      .filter(
        (runtime) =>
          runtime.running &&
          runtime.subsystem.receive !== undefined &&
          runtime.subsystem.subscribes?.includes(eventId) === true,
      )
      .map((runtime) => runtime.id);
  }

  /**
   * @summary Delivers an envelope to one subsystem and resolves with its reply.
   * @description
   * Delivers to `metadata.target`, or to `options.to` (used to hand a
   * broadcast to one subscriber). Stamps a `delivered` fingerprint, calls the
   * subsystem's `receive`, and passes the packet's final trail to
   * `options.onTrail`. With `options.clone`, the subsystem receives its own
   * copy of the payload.
   * @param {PacketEnvelope} envelope The envelope.
   * @param {object} [options] `to`: the subsystem to deliver to; `clone`: give it a copy; `onTrail`: receives the trail after `receive` returns or throws.
   * @returns {Promise<unknown>} The subsystem's reply.
   * @throws {UnitUnavailableError} When the target is unknown, a feature, not running, or has no `receive`.
   * @throws {PacketExpiredError} When the envelope's time to live has passed.
   */
  async deliver(
    envelope: PacketEnvelope,
    options: {
      readonly to?: string;
      readonly clone?: boolean;
      readonly onTrail?: (trail: FingerprintTrail) => void;
    } = {},
  ): Promise<unknown> {
    const targetId = options.to ?? envelope.metadata.target;
    const runtime = targetId === null ? undefined : this.#runtimes.get(targetId);
    if (!runtime || runtime.parent) {
      throw new UnitUnavailableError(
        String(targetId),
        runtime ? 'features are not addressable' : 'unknown',
      );
    }
    if (!runtime.running) throw new UnitUnavailableError(runtime.id, runtime.status);
    this.#assertFresh(envelope);
    const receive = runtime.subsystem.receive;
    if (!receive) throw new UnitUnavailableError(runtime.id, 'it does not receive packets');

    const packet = new Packet(envelope, { clone: options.clone });
    packet.stamp(makeFingerprint(runtime.id, 'delivered', { timestamp: this.#now() }));
    try {
      return await receive.call(runtime.subsystem, packet, runtime.context!);
    } finally {
      options.onTrail?.(packet.header.fingerprints);
    }
  }

  /**
   * @summary Delivers a broadcast to every running subscriber, each with its own payload copy.
   * @description The sender does not receive its own broadcast. A subscriber
   * that throws is reported through `onError`, not propagated to the sender.
   * @param {PacketEnvelope} envelope The envelope, with `metadata.target` `null`.
   * @returns {Promise<void>} Resolves once every subscriber has handled it.
   * @throws {PacketExpiredError} When the envelope's time to live has passed.
   */
  async broadcast(envelope: PacketEnvelope): Promise<void> {
    this.#assertFresh(envelope);
    for (const runtime of this.#roots) {
      const subsystem = runtime.subsystem;
      if (
        runtime.id === envelope.metadata.source ||
        !runtime.running ||
        !subsystem.receive ||
        !subsystem.subscribes?.includes(envelope.eventId)
      ) {
        continue;
      }
      const packet = new Packet(envelope, { clone: true });
      packet.stamp(makeFingerprint(runtime.id, 'delivered', { timestamp: this.#now() }));
      try {
        await subsystem.receive(packet, runtime.context!);
      } catch (error) {
        this.#onError(error, runtime.id);
      }
    }
  }

  /**
   * @summary Rejects envelopes whose time to live has passed.
   * @internal
   */
  #assertFresh(envelope: PacketEnvelope): void {
    const { ttl, timestamp, messageId } = envelope.metadata;
    if (ttl !== undefined && this.#now() > timestamp + ttl) {
      throw new PacketExpiredError(`Packet ${messageId} expired before delivery.`);
    }
  }

  /**
   * @summary Lists a unit's unmet required dependencies (and its parent, for a feature).
   * @internal
   */
  #unmet(runtime: UnitRuntime): string[] {
    const unmet: string[] = [];
    const parent = runtime.parent;
    if (parent && !(parent.status === 'INITIALIZING' || parent.running)) unmet.push(parent.id);
    for (const dependency of runtime.definition.requires ?? []) {
      if (!isRequired(dependency)) continue;
      const target = this.#runtimes.get(dependency.target);
      const met =
        target !== undefined &&
        (target.running ||
          (dependency.when === 'INITIALIZING' && target.status === 'INITIALIZING'));
      if (!met) unmet.push(dependency.target);
    }
    return unmet;
  }

  /**
   * @summary Publishes a unit's new snapshot and, when asked, queues one reconciliation.
   * @internal
   */
  #changed(runtime: UnitRuntime, reconcile: boolean): void {
    this.#statuses.set({ ...this.#statuses.view.getSnapshot(), [runtime.id]: runtime.snapshot });
    if (!reconcile || !this.#started || this.#stopping || this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    this.#chain = this.#chain.then(async () => {
      this.#reconcileQueued = false;
      await this.#reconcile();
    });
  }

  /**
   * @summary Starts waiting units whose dependencies are met, and suspends or resumes on dependency changes.
   * @internal
   */
  async #reconcile(): Promise<void> {
    if (this.#stopping) return;
    for (const runtime of this.#order) {
      const unmet = this.#unmet(runtime);
      // Only units already asked to start (waiting ones): the boot loop owns the rest.
      if (runtime.status === 'UNINITIALIZED' && runtime.startRequested) {
        await runtime.start();
      } else if (runtime.running && unmet.length > 0) {
        await runtime.suspend(`Waiting for ${unmet.join(', ')}.`, true);
      } else if (
        runtime.status === 'SUSPENDED' &&
        runtime.suspendedForDependencies &&
        unmet.length === 0
      ) {
        await runtime.resume();
      }
    }
  }

  /**
   * @summary Builds a unit's packet port: envelope, send rule, `sent` fingerprint, router.
   * @internal
   */
  #port(runtime: UnitRuntime): PacketPort {
    const root = runtime.root;
    const componentId = runtime.parent ? runtime.id.slice(root.id.length + 1) : null;
    const prepare = <P>(draft: OutgoingPacket<P>, correlationId?: string): PacketEnvelope<P> => {
      const { scope } = root.subsystem;
      const envelope = createEnvelope(draft, {
        source: root.id,
        scope,
        ids: this.#ids,
        now: this.#now,
        correlationId,
      });
      assertSendAllowed({
        sender: root.id,
        senderScope: scope,
        packetScope: envelope.metadata.scope,
        target: envelope.metadata.target,
      });
      const sent = makeFingerprint(root.id, 'sent', { componentId, timestamp: this.#now() });
      return { ...envelope, fingerprints: appendFingerprint(envelope.fingerprints, sent) };
    };
    return {
      send: async (draft) => {
        await this.#router.route(prepare(draft), false);
      },
      request: async <R>(draft: OutgoingPacket & { readonly target: string }) =>
        (await this.#router.route(prepare(draft, this.#ids()), true)) as R,
    };
  }
}
