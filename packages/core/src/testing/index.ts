/**
 * @fileoverview
 * @summary `@platform/core/testing`: boot real units in tests, without browser APIs.
 * @description
 * An in-memory platform around the {@linkcode Kernel}: the direct router
 * (recording every routed envelope), deterministic ids, a controllable
 * clock, captured errors, and in-memory persistence.
 *
 * ```ts
 * const platform = createTestPlatform([storage, auth]);
 * await platform.start();
 * expect(platform.status('auth')).toBe('READY');
 * await platform.stop();
 * ```
 *
 * @author MathAid
 */

import {
  Kernel,
  directRouter,
  type KernelOptions,
  type StatePersistence,
  type UnitHandle,
} from '../kernel';
import type { UnitStatus } from '../lifecycle';
import type { PacketEnvelope } from '../packet';
import type { PersistedState } from '../state';
import type { ControlInterface, SubsystemDefinition } from '../unit';

export { createMemoryRouteSource, type MemoryRouteSource } from '../route';

/** @summary A clock tests can move forward. */
export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

/**
 * @summary Creates a {@linkcode TestClock}.
 * @param {number} [start] The starting time in milliseconds. Defaults to 0.
 */
export function createTestClock(start = 0): TestClock {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

/** @summary In-memory {@linkcode StatePersistence} that exposes what was saved. */
export interface MemoryPersistence extends StatePersistence {
  readonly saved: ReadonlyMap<string, PersistedState<object>>;
}

/**
 * @summary Creates in-memory persistence, optionally pre-filled.
 * @param {Record<string, PersistedState<object>>} [initial] State to load, by unit id.
 */
export function createMemoryPersistence(
  initial: Record<string, PersistedState<object>> = {},
): MemoryPersistence {
  const saved = new Map(Object.entries(initial));
  return {
    saved,
    load: (unitId) => saved.get(unitId),
    save(unitId, state) {
      saved.set(unitId, structuredClone(state));
    },
  };
}

/** @summary An in-memory platform for tests. */
export interface TestPlatform {
  readonly kernel: Kernel;
  readonly clock: TestClock;
  /** Every envelope routed so far, in order. */
  readonly routed: readonly PacketEnvelope[];
  /** Every error reported by the kernel, instead of logging it. */
  readonly errors: readonly { readonly error: unknown; readonly unitId: string }[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Waits for dependency reconciliation and pending view notifications. */
  settle(): Promise<void>;
  unit<C extends ControlInterface = ControlInterface>(id: string): UnitHandle<C>;
  /** The current status of a unit. */
  status(id: string): UnitStatus;
}

/**
 * @summary Creates an in-memory test platform.
 * @param {readonly SubsystemDefinition[]} subsystems The subsystems to register.
 * @param {object} [options] Kernel options; `router` and `onError` are provided by the platform.
 * @returns {TestPlatform} The platform. Call `start()` to boot it.
 */
export function createTestPlatform(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subsystems: readonly SubsystemDefinition<any, any>[],
  options: Omit<KernelOptions, 'router' | 'onError' | 'now'> & { readonly clock?: TestClock } = {},
): TestPlatform {
  const routed: PacketEnvelope[] = [];
  const errors: { error: unknown; unitId: string }[] = [];
  const clock = options.clock ?? createTestClock(1_000);
  let counter = 0;

  const kernel = new Kernel(subsystems as readonly SubsystemDefinition[], {
    ids: () => `id-${++counter}`,
    ...options,
    now: clock.now,
    onError: (error, unitId) => errors.push({ error, unitId }),
    router: (k) => {
      const direct = directRouter(k);
      return {
        route(envelope, expectReply) {
          routed.push(envelope);
          return direct.route(envelope, expectReply);
        },
      };
    },
  });

  const settle = async () => {
    await kernel.settled();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    kernel,
    clock,
    routed,
    errors,
    start: async () => {
      await kernel.start();
      await settle();
    },
    stop: () => kernel.stop(),
    settle,
    unit: (id) => kernel.unit(id),
    status: (id) => kernel.unit(id).lifecycle.getSnapshot().status,
  };
}
