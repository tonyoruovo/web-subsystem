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
 *   {@linkcode PacketRouter}. Until the Queue exists (M3), the default router
 *   delivers directly in-realm.
 *
 * ```ts
 * const kernel = new Kernel([storage, auth]);
 * await kernel.start();
 * kernel.unit<AuthControl>('auth').control?.commands.login(credentials);
 * await kernel.stop();
 * ```
 *
 * @author MathAid
 */

import { DependencyGraph, isRequired, type DependencyNode } from './dependency';
import type { LifecycleSnapshot } from './lifecycle';
import {
  Packet,
  appendFingerprint,
  createEnvelope,
  makeFingerprint,
  type IdFactory,
  type OutgoingPacket,
  type PacketEnvelope,
} from './packet';
import { UnitRuntime, type RuntimeHost, type StatePersistence } from './runtime';
import { assertSendAllowed } from './scope';
import type { ControlInterface, PacketPort, SubsystemDefinition, UnitDefinition } from './unit';
import { createStore, type Schedule, type View } from './view';

export type { StatePersistence } from './runtime';

/** @summary Moves envelopes between subsystems. The Queue implements this from M3. */
export interface PacketRouter {
  /**
   * @summary Routes an envelope.
   * @param {PacketEnvelope} envelope The envelope; `metadata.target` is `null` for a broadcast.
   * @param {boolean} expectReply True for a request: resolve with the reply.
   */
  route(envelope: PacketEnvelope, expectReply: boolean): Promise<unknown>;
}

/** @summary Thrown when a packet targets a subsystem that is missing or not running. */
export class UnitUnavailableError extends Error {
  override readonly name = 'UnitUnavailableError';
  constructor(
    readonly unitId: string,
    readonly status: string,
  ) {
    super(`Subsystem "${unitId}" cannot receive packets (${status}).`);
  }
}

/** @summary Thrown when a packet's time to live has passed before delivery. */
export class PacketExpiredError extends Error {
  override readonly name = 'PacketExpiredError';
}

/** @summary Options for a {@linkcode Kernel}. */
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
}

/** @summary A handle on one unit, for its owner and for the platform. */
export interface UnitHandle<C extends ControlInterface = ControlInterface> {
  readonly id: string;
  /** The unit's lifecycle, observable. */
  readonly lifecycle: View<LifecycleSnapshot>;
  /** The control interface while running, otherwise `undefined`. */
  readonly control: C | undefined;
  /** Starts a `FAILED` (or waiting) unit again. */
  restart(): Promise<void>;
  /** Suspends a running unit, for example when the page is hidden. */
  suspend(reason?: string): Promise<void>;
  /** Resumes a suspended unit. */
  resume(): Promise<void>;
  /**
   * @summary Destroys the unit.
   * @throws {Error} For a centralized subsystem: only the platform destroys those.
   */
  destroy(): Promise<void>;
}

/**
 * @summary The default router: delivers in the same realm, straight to the kernel.
 * @param {Kernel} kernel The kernel.
 * @returns {PacketRouter} The router.
 */
export function directRouter(kernel: Kernel): PacketRouter {
  return {
    route: (envelope) =>
      envelope.metadata.target === null ? kernel.broadcast(envelope) : kernel.deliver(envelope),
  };
}

/** @summary The platform kernel. */
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

    const order = new DependencyGraph(nodes).order(); // throws on a required cycle
    this.#order = order.map((id) => this.#runtimes.get(id)!);
    this.#statuses.set(Object.fromEntries([...this.#runtimes].map(([id, r]) => [id, r.snapshot])));
    this.#router = (options.router ?? directRouter)(this);
  }

  /** @summary Every unit's lifecycle snapshot, keyed by full id. */
  get statuses(): View<Readonly<Record<string, LifecycleSnapshot>>> {
    return this.#statuses.view;
  }

  /** @summary The ids of every registered unit, in boot order. */
  get unitIds(): readonly string[] {
    return this.#order.map((r) => r.id);
  }

  /** @summary Starts every subsystem in dependency order, and resolves once all settled. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const runtime of this.#order) if (!runtime.parent) await runtime.start();
    await this.settled();
  }

  /** @summary Destroys every subsystem, centralized ones included, in reverse boot order. */
  async stop(): Promise<void> {
    await this.settled();
    this.#stopping = true;
    for (const runtime of [...this.#order].reverse()) if (!runtime.parent) await runtime.destroy();
  }

  /** @summary Resolves once dependency reconciliation has finished. */
  async settled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.#chain;
      await current;
    } while (current !== this.#chain || this.#reconcileQueued);
  }

  /**
   * @summary A handle on a unit.
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
   * @summary Delivers a 1-to-1 envelope to its target and resolves with the reply.
   * @throws {UnitUnavailableError} When the target is unknown, a feature, or not running.
   * @throws {PacketExpiredError} When the envelope's time to live has passed.
   */
  async deliver(envelope: PacketEnvelope): Promise<unknown> {
    const targetId = envelope.metadata.target;
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

    const packet = new Packet(envelope);
    packet.stamp(makeFingerprint(runtime.id, 'delivered', { timestamp: this.#now() }));
    return receive.call(runtime.subsystem, packet, runtime.context!);
  }

  /**
   * @summary Delivers a broadcast to every running subscriber, each with its own payload copy.
   * @description A subscriber that throws is reported, not propagated to the sender.
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

  #assertFresh(envelope: PacketEnvelope): void {
    const { ttl, timestamp, messageId } = envelope.metadata;
    if (ttl !== undefined && this.#now() > timestamp + ttl) {
      throw new PacketExpiredError(`Packet ${messageId} expired before delivery.`);
    }
  }

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

  #changed(runtime: UnitRuntime, reconcile: boolean): void {
    this.#statuses.set({ ...this.#statuses.view.getSnapshot(), [runtime.id]: runtime.snapshot });
    if (!reconcile || !this.#started || this.#stopping || this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    this.#chain = this.#chain.then(async () => {
      this.#reconcileQueued = false;
      await this.#reconcile();
    });
  }

  /** Starts waiting units whose dependencies are met; suspends and resumes on dependency changes. */
  async #reconcile(): Promise<void> {
    if (this.#stopping) return;
    for (const runtime of this.#order) {
      const unmet = this.#unmet(runtime);
      if (runtime.status === 'UNINITIALIZED') {
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
