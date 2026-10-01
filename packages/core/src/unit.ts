/**
 * @fileoverview
 * @summary Unit and subsystem definitions: what a unit declares, and what the kernel gives it.
 * @description
 * Implements docs/ARCHITECTURE.md §3. Subsystems and features share one
 * shape, the unit. A subsystem additionally has a scope, a kind and a packet
 * port. Definitions are plain data plus functions; the kernel creates the
 * state cell, the context and the port, and runs the lifecycle.
 *
 * ```text
 *   SubsystemDefinition = UnitDefinition + scope + kind + subscribes + receive
 *   UnitDefinition      = id, requires, state, init, suspend, resume,
 *                         processors, features, control
 *   UnitContext         = what init / control / receive get from the kernel
 *   ```
 *
 * @example
 * A subsystem with a command, a view and an optional dependency
 * ```ts
 * import { defineSubsystem } from '@platform/core';
 *
 * export const consent = defineSubsystem({
 *   id: 'consent',
 *   scope: 'window',
 *   kind: 'featurized',
 *   requires: [{ target: 'storage', kind: 'optional' }],
 *   state: {
 *     initial: { granted: [] as string[] },
 *     policy: { granted: { readable: true, persisted: true } },
 *   },
 *   control: (ctx) => ({
 *     commands: {
 *       grant: (purpose: string) => ctx.state.update((s) => void s.granted.push(purpose)),
 *     },
 *     views: { state: ctx.state.readable },
 *   }),
 * });
 * ```
 *
 * @example
 * A feature that can fail without failing its subsystem
 * ```ts
 * import { defineUnit } from '@platform/core';
 *
 * export const idb = defineUnit({
 *   id: 'idb',
 *   state: { initial: {} },
 *   init: async () => {
 *     const db = await openDatabase();
 *     return () => db.close();
 *   },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 * ```
 *
 * @author MathAid
 */

import type { Dependency } from './dependency';
import type { OutgoingPacket, Packet } from './packet';
import type { ProcessorDef } from './processor';
import type { Scope } from './scope';
import type { StateCell, StateDefinition } from './state';
import type { ProcessorHandle } from './supervisor';
import type { View } from './view';

/**
 * @summary The "off" switch returned by an initializer (ARCHITECTURE §3.2).
 * @description The kernel runs a unit's disposers in reverse order during
 * teardown: when the unit fails, is destroyed, or its parent stops.
 *
 * @example
 * Returning a disposer from `init`
 * ```ts
 * init: () => {
 *   const timer = setInterval(poll, 30_000);
 *   return () => clearInterval(timer);
 * },
 * ```
 *
 * @public
 */
export type Disposer = () => void | Promise<void>;

/**
 * @summary A unit's public surface: commands it performs on itself, and read-only views (ARCHITECTURE §6).
 *
 * @description
 * `commands` are functions the unit runs on its own behalf; "setters" are
 * commands too, so the unit validates and applies every change itself.
 * `views` are {@linkcode View}s of state the unit chooses to expose. Callers
 * never get a mutable reference to the unit's state.
 *
 * A unit builds it in `control(ctx)`. Other units reach it through
 * `ctx.dependency(id)` and `ctx.sibling(id)`; applications reach it through
 * `kernel.unit(id).control`.
 *
 * @example
 * Example 1: A settings control interface
 * ```ts
 * control: (ctx) => ({
 *   commands: {
 *     setTheme: (theme: 'light' | 'dark') => ctx.state.update((s) => void (s.theme = theme)),
 *   },
 *   views: { state: ctx.state.readable },
 * }),
 * ```
 *
 * @example
 * Example 2: Using another unit's control interface
 * ```ts
 * const storage = ctx.dependency<StorageControl>('storage');
 * await storage?.commands.put('theme', 'dark');
 * ```
 *
 * @public
 * @see {@linkcode NO_CONTROL}
 */
export interface ControlInterface {
  /** Commands the unit performs on itself. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly commands: Readonly<Record<string, (...args: any[]) => unknown>>;
  /** Read-only views of the unit's state. */
  readonly views: Readonly<Record<string, View<unknown>>>;
}

/**
 * @summary How a unit sends packets. Features use their parent subsystem's port.
 *
 * @description
 * `send` routes a broadcast (no `target`) or a fire-and-forget packet, and
 * resolves once it has been routed. `request` sends a 1-to-1 packet and
 * resolves with the target's reply. The kernel fills in the envelope (ids,
 * source, scope, time, trace) and stamps a `sent` fingerprint.
 *
 * Every running unit gets one as `ctx.port`. A feature's packets carry its
 * parent's identity, with the feature recorded as the fingerprint's
 * `componentId`.
 *
 * @example
 * Example 1: A broadcast
 * ```ts
 * await ctx.port.send({ eventId: 'consent:changed', payload: { analytics: true } });
 * ```
 *
 * @example
 * Example 2: A request with a typed reply
 * ```ts
 * const user = await ctx.port.request<{ id: string }>({
 *   eventId: 'auth:whoami',
 *   payload: null,
 *   target: 'auth',
 * });
 * ```
 *
 * @public
 */
export interface PacketPort {
  /**
   * @summary Sends a broadcast (no `target`) or a fire-and-forget packet.
   * @template P The payload type.
   * @param {OutgoingPacket<P>} packet The packet.
   * @returns {Promise<void>} Resolves once the packet was routed.
   */
  send<P>(packet: OutgoingPacket<P>): Promise<void>;
  /**
   * @summary Sends a 1-to-1 request and resolves with the reply.
   * @template R The reply type.
   * @template P The payload type.
   * @param {OutgoingPacket<P>} packet The packet, with its `target`.
   * @returns {Promise<R>} The target's reply.
   */
  request<R = unknown, P = unknown>(
    packet: OutgoingPacket<P> & { readonly target: string },
  ): Promise<R>;
}

/**
 * @summary What the kernel gives a unit while it runs.
 *
 * @description
 * Holds the unit's full `id`, its own {@linkcode StateCell} (`state`), an
 * `AbortSignal` aborted on teardown (`signal`), and its packet `port`. Its
 * methods reach other units (`dependency`, `sibling`) and processors
 * (`processor`), and report the unit's condition (`busy`, `fail`).
 *
 * The kernel passes it to `init`, `suspend`, `resume`, `control` and
 * `receive`. It is the only way a unit touches the platform, which keeps
 * units testable with `@platform/core/testing`.
 *
 * @example
 * Example 1: Cancelling work on teardown
 * ```ts
 * init: (ctx) => {
 *   void fetch('/config', { signal: ctx.signal }).then(applyConfig);
 * },
 * ```
 *
 * @example
 * Example 2: Reporting a runtime failure
 * ```ts
 * init: (ctx) => {
 *   socket.addEventListener('error', (event) => ctx.fail(new Error('socket failed')));
 * },
 * ```
 *
 * @example
 * Example 3: Signalling heavy work
 * ```ts
 * ctx.busy(true);
 * try { await reindex(); } finally { ctx.busy(false); }
 * ```
 *
 * @template S The unit's state shape.
 * @public
 */
export interface UnitContext<S> {
  /** The full id: `subsystem` or `subsystem/feature`. */
  readonly id: string;
  /** The unit's own state. Only this unit can update it. */
  readonly state: StateCell<S>;
  /** Aborted when the unit is torn down: destroyed, failed, or its parent stopped. */
  readonly signal: AbortSignal;
  /** The packet port. Features share their parent's. */
  readonly port: PacketPort;
  /**
   * @summary Returns the control interface of a declared dependency.
   * @template C The dependency's control interface type.
   * @param {string} target A target listed in this unit's `requires`.
   * @returns {C | undefined} The control interface, or `undefined` while the dependency is not running.
   * @throws {Error} When `target` is not one of this unit's declared dependencies.
   */
  dependency<C extends ControlInterface = ControlInterface>(target: string): C | undefined;
  /**
   * @summary Returns a sibling feature's control interface (ARCHITECTURE §3.1).
   * @template C The sibling's control interface type.
   * @param {string} featureId The sibling's id inside the parent.
   * @returns {C | undefined} The control interface, or `undefined` while the sibling is not running.
   * @throws {Error} When called from a subsystem, or for an unknown sibling.
   */
  sibling<C extends ControlInterface = ControlInterface>(featureId: string): C | undefined;
  /**
   * @summary Marks the unit busy or idle (`READY` <-> `BUSY`).
   * @param {boolean} isBusy `true` while doing heavy work.
   */
  busy(isBusy: boolean): void;
  /**
   * @summary Reports a failure at runtime.
   * @description The unit is torn down and moves to `FAILED`; a failed
   * feature leaves its parent `DEGRADED` (ARCHITECTURE §3.1). Ignored when
   * the unit is not running. During `init`, throw instead.
   * @param {unknown} error What went wrong. Its message becomes the lifecycle reason.
   */
  fail(error: unknown): void;
  /**
   * @summary Returns one of this unit's processors (ARCHITECTURE §8).
   * @template In The processor's message type.
   * @template Out The processor's result type.
   * @param {string} id The processor's id.
   * @returns {ProcessorHandle<In, Out>} The processor handle.
   * @throws {Error} For an id the unit does not declare.
   */
  processor<In = unknown, Out = unknown>(id: string): ProcessorHandle<In, Out>;
}

/**
 * @summary A unit: a subsystem or a feature.
 *
 * @description
 * Declares a unit's `id`, its dependencies (`requires`), its `state`, its
 * lifecycle hooks (`init` with its {@linkcode Disposer}, `suspend`,
 * `resume`), its `processors` and its `features`, and `control`, which
 * builds its {@linkcode ControlInterface} once `init` succeeds.
 *
 * Features are written as unit definitions (usually with
 * {@linkcode defineUnit}) and listed in a subsystem's `features`. Startup
 * order is processors, `init`, features, then `control`; a throw anywhere
 * fails the unit.
 *
 * @example
 * Example 1: A feature with a disposer
 * ```ts
 * const poller: UnitDefinition = {
 *   id: 'poller',
 *   state: { initial: {} },
 *   init: () => {
 *     const timer = setInterval(poll, 60_000);
 *     return () => clearInterval(timer);
 *   },
 *   control: () => NO_CONTROL,
 * };
 * ```
 *
 * @example
 * Example 2: Pausing work while suspended
 * ```ts
 * const poller: UnitDefinition = {
 *   id: 'poller',
 *   state: { initial: {} },
 *   suspend: () => pausePolling(),
 *   resume: () => resumePolling(),
 *   control: () => NO_CONTROL,
 * };
 * ```
 *
 * @template S The state shape.
 * @template C The control interface type.
 * @public
 */
export interface UnitDefinition<
  S extends object = object,
  C extends ControlInterface = ControlInterface,
> {
  /** Stable id. For features: unique inside the parent, without `/`. */
  readonly id: string;
  /** What must be present for this unit to turn on (ARCHITECTURE §7). */
  readonly requires?: readonly Dependency[];
  /** Initial state, exposure policy and schema version (ARCHITECTURE §5). */
  readonly state: StateDefinition<S>;
  /** The "on" switch. May return the "off" switch. Throwing fails the unit. */
  init?(ctx: UnitContext<S>): Disposer | void | Promise<Disposer | void>;
  /** Pauses work: the page is hidden or cached, or a dependency stopped (ARCHITECTURE §4). */
  suspend?(ctx: UnitContext<S>): void | Promise<void>;
  /** Resumes work after `suspend`. Throwing fails the unit. */
  resume?(ctx: UnitContext<S>): void | Promise<void>;
  /** Work done off (or on) the main thread (ARCHITECTURE §8). Started before `init`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly processors?: readonly ProcessorDef<any, any>[];
  /** Child units (ARCHITECTURE §3.1). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly features?: readonly UnitDefinition<any, any>[];
  /** Builds the commands and views. Called after `init` and the features succeed. */
  control(ctx: UnitContext<S>): C;
}

/**
 * @summary A subsystem: a unit with an identity, a scope and a packet port.
 *
 * @description
 * Adds to {@linkcode UnitDefinition} the subsystem's `scope` (how far its
 * broadcasts reach), its `kind` (`centralized` subsystems are destroyed only
 * by the platform), the event ids it `subscribes` to, and `receive`, which
 * handles packets addressed or broadcast to it and returns the reply.
 *
 * Every package that provides a subsystem exports one, usually written with
 * {@linkcode defineSubsystem}. The kernel takes a list of them.
 *
 * @example
 * Example 1: A subsystem that answers requests
 * ```ts
 * const echo: SubsystemDefinition = {
 *   id: 'echo',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   state: { initial: {} },
 *   receive: (packet) => packet.take(),
 *   control: () => NO_CONTROL,
 * };
 * ```
 *
 * @example
 * Example 2: A subsystem that listens to broadcasts
 * ```ts
 * const audit: SubsystemDefinition = {
 *   id: 'audit',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   subscribes: ['auth:login', 'auth:logout'],
 *   state: { initial: {} },
 *   receive: (packet) => record(packet.header.eventId, packet.take()),
 *   control: () => NO_CONTROL,
 * };
 * ```
 *
 * @template S The state shape.
 * @template C The control interface type.
 * @public
 */
export interface SubsystemDefinition<
  S extends object = object,
  C extends ControlInterface = ControlInterface,
> extends UnitDefinition<S, C> {
  /** How far the subsystem's broadcasts reach (ARCHITECTURE §11). */
  readonly scope: Scope;
  /** Centralized subsystems are destroyed only by the platform (ARCHITECTURE §2). */
  readonly kind: 'centralized' | 'featurized';
  /** Event ids of broadcasts this subsystem receives. */
  readonly subscribes?: readonly string[];
  /**
   * @summary Handles a packet addressed to (or broadcast to) this subsystem.
   * @param {Packet} packet The packet. Its payload can be taken once.
   * @param {UnitContext<S>} ctx The subsystem's context.
   * @returns {unknown} The reply, for a request. Ignored for broadcasts.
   */
  receive?(packet: Packet, ctx: UnitContext<S>): unknown;
}

/**
 * @summary Declares a feature (or any unit) with full type inference.
 *
 * @description
 * Returns `definition` unchanged. Its only job is to infer `S` (from
 * `state.initial`) and `C` (from `control`) so that `ctx.state` and the
 * returned control interface are typed without annotations.
 *
 * @example
 * Example 1: An inferred state type
 * ```ts
 * const cache = defineUnit({
 *   id: 'cache',
 *   state: { initial: { hits: 0 } },
 *   control: (ctx) => ({
 *     commands: { hit: () => ctx.state.update((s) => void s.hits++) }, // s.hits is a number
 *     views: {},
 *   }),
 * });
 * ```
 *
 * @example
 * Example 2: Listing it as a feature
 * ```ts
 * defineSubsystem({ id: 'storage', scope: 'tab', kind: 'featurized', state: { initial: {} }, features: [cache], control: () => NO_CONTROL });
 * ```
 *
 * @template S The state shape, inferred from `state.initial`.
 * @template C The control interface, inferred from `control`.
 * @param {UnitDefinition<S, C>} definition The definition.
 * @returns {UnitDefinition<S, C>} The same definition.
 *
 * @public
 */
export function defineUnit<S extends object, C extends ControlInterface>(
  definition: UnitDefinition<S, C>,
): UnitDefinition<S, C> {
  return definition;
}

/**
 * @summary Declares a subsystem with full type inference.
 *
 * @description
 * Returns `definition` unchanged, inferring `S` and `C` like
 * {@linkcode defineUnit}. Use `ReturnType<typeof subsystem.control>` to type
 * `kernel.unit(id).control` elsewhere.
 *
 * @example
 * Example 1: Declaring and typing a subsystem's control interface
 * ```ts
 * export const counter = defineSubsystem({
 *   id: 'counter',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   state: { initial: { count: 0 }, policy: { count: { readable: true } } },
 *   control: (ctx) => ({
 *     commands: { increment: () => ctx.state.update((s) => void s.count++) },
 *     views: { state: ctx.state.readable },
 *   }),
 * });
 * export type CounterControl = ReturnType<typeof counter.control>;
 * ```
 *
 * @example
 * Example 2: Using the typed control interface
 * ```ts
 * kernel.unit<CounterControl>('counter').control?.commands.increment();
 * ```
 *
 * @template S The state shape, inferred from `state.initial`.
 * @template C The control interface, inferred from `control`.
 * @param {SubsystemDefinition<S, C>} definition The definition.
 * @returns {SubsystemDefinition<S, C>} The same definition.
 *
 * @public
 */
export function defineSubsystem<S extends object, C extends ControlInterface>(
  definition: SubsystemDefinition<S, C>,
): SubsystemDefinition<S, C> {
  return definition;
}

/**
 * @summary A frozen, empty control interface, for units that expose nothing.
 *
 * @example
 * A unit with no commands or views
 * ```ts
 * defineUnit({ id: 'warmup', state: { initial: {} }, init: preload, control: () => NO_CONTROL });
 * ```
 *
 * @constant
 * @public
 */
export const NO_CONTROL: ControlInterface = Object.freeze({
  commands: Object.freeze({}),
  views: Object.freeze({}),
});
