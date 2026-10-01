/**
 * @fileoverview
 * @summary Unit and subsystem definitions: what a unit declares, and what the kernel gives it.
 * @description
 * Implements docs/ARCHITECTURE.md §3. Subsystems and features share one shape,
 * the unit. A subsystem additionally has a scope, a kind and a packet port.
 * Definitions are plain data plus functions; the kernel creates the state
 * cell, the context and the port, and runs the lifecycle.
 *
 * ```ts
 * const consent = defineSubsystem({
 *   id: 'consent',
 *   scope: 'window',
 *   kind: 'featurized',
 *   requires: [{ target: 'storage', kind: 'optional' }],
 *   state: { initial: { granted: [] as string[] }, policy: { granted: { readable: true, persisted: true } } },
 *   control: (ctx) => ({
 *     commands: { grant: (purpose: string) => ctx.state.update((s) => { s.granted.push(purpose); }) },
 *     views: { state: ctx.state.readable },
 *   }),
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

/** @summary The "off" switch returned by an initializer (§3.2). */
export type Disposer = () => void | Promise<void>;

/**
 * @summary A unit's public surface: commands it performs on itself, and read-only views (§6).
 */
export interface ControlInterface {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly commands: Readonly<Record<string, (...args: any[]) => unknown>>;
  readonly views: Readonly<Record<string, View<unknown>>>;
}

/** @summary How a unit sends packets. Features use their parent subsystem's port. */
export interface PacketPort {
  /**
   * @summary Sends a broadcast (no `target`) or a fire-and-forget packet.
   * @returns Resolves once the packet was routed.
   */
  send<P>(packet: OutgoingPacket<P>): Promise<void>;
  /**
   * @summary Sends a 1-to-1 request and resolves with the reply.
   */
  request<R = unknown, P = unknown>(
    packet: OutgoingPacket<P> & { readonly target: string },
  ): Promise<R>;
}

/** @summary What the kernel gives a unit while it runs. */
export interface UnitContext<S> {
  /** The full id: `subsystem` or `subsystem/feature`. */
  readonly id: string;
  /** The unit's own state. Only this unit can update it. */
  readonly state: StateCell<S>;
  /** Aborted when the unit is destroyed or fails. */
  readonly signal: AbortSignal;
  /** The packet port. Features share their parent's. */
  readonly port: PacketPort;
  /**
   * @summary The control interface of a declared dependency, or `undefined` while it is not running.
   * @throws {Error} When `target` is not one of this unit's declared dependencies.
   */
  dependency<C extends ControlInterface = ControlInterface>(target: string): C | undefined;
  /**
   * @summary A sibling feature's control interface, or `undefined` while it is not running (§3.1).
   * @throws {Error} When called from a subsystem, or for an unknown sibling.
   */
  sibling<C extends ControlInterface = ControlInterface>(featureId: string): C | undefined;
  /** @summary Marks the unit busy or idle (`READY` <-> `BUSY`). */
  busy(isBusy: boolean): void;
  /**
   * @summary Reports a failure at runtime. The unit moves to `FAILED`; a failed
   * feature leaves its parent `DEGRADED` (§3.1).
   */
  fail(error: unknown): void;
  /**
   * @summary One of this unit's processors (§8).
   * @throws {Error} For an id the unit does not declare.
   */
  processor<In = unknown, Out = unknown>(id: string): ProcessorHandle<In, Out>;
}

/** @summary A unit: a subsystem or a feature. */
export interface UnitDefinition<
  S extends object = object,
  C extends ControlInterface = ControlInterface,
> {
  /** Stable id. For features: unique inside the parent, without `/`. */
  readonly id: string;
  /** What must be present for this unit to turn on (§7). */
  readonly requires?: readonly Dependency[];
  /** Initial state, exposure policy and schema version (§5). */
  readonly state: StateDefinition<S>;
  /** The "on" switch. May return the "off" switch. Throwing fails the unit. */
  init?(ctx: UnitContext<S>): Disposer | void | Promise<Disposer | void>;
  /** Pause work: the page is hidden or cached, or a dependency stopped (§4). */
  suspend?(ctx: UnitContext<S>): void | Promise<void>;
  /** Resume work after `suspend`. */
  resume?(ctx: UnitContext<S>): void | Promise<void>;
  /** Work done off (or on) the main thread (§8). Started before `init`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly processors?: readonly ProcessorDef<any, any>[];
  /** Child units (§3.1). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly features?: readonly UnitDefinition<any, any>[];
  /** Builds the commands and views. Called after `init` succeeds. */
  control(ctx: UnitContext<S>): C;
}

/** @summary A subsystem: a unit with an identity, a scope and a packet port. */
export interface SubsystemDefinition<
  S extends object = object,
  C extends ControlInterface = ControlInterface,
> extends UnitDefinition<S, C> {
  readonly scope: Scope;
  /** Centralized subsystems are destroyed only by the platform (§2). */
  readonly kind: 'centralized' | 'featurized';
  /** Event ids of broadcasts this subsystem receives. */
  readonly subscribes?: readonly string[];
  /**
   * @summary Handles a packet addressed to (or broadcast to) this subsystem.
   * @returns The reply, for a request.
   */
  receive?(packet: Packet, ctx: UnitContext<S>): unknown;
}

/**
 * @summary Declares a feature (or any unit) with full type inference.
 * @param {UnitDefinition<S, C>} definition The definition.
 * @returns The same definition.
 */
export function defineUnit<S extends object, C extends ControlInterface>(
  definition: UnitDefinition<S, C>,
): UnitDefinition<S, C> {
  return definition;
}

/**
 * @summary Declares a subsystem with full type inference.
 * @param {SubsystemDefinition<S, C>} definition The definition.
 * @returns The same definition.
 */
export function defineSubsystem<S extends object, C extends ControlInterface>(
  definition: SubsystemDefinition<S, C>,
): SubsystemDefinition<S, C> {
  return definition;
}

/** @summary A control interface with nothing in it, for units that expose nothing. */
export const NO_CONTROL: ControlInterface = Object.freeze({
  commands: Object.freeze({}),
  views: Object.freeze({}),
});
