/**
 * @fileoverview
 * @module @platform/core/testing
 * @summary `@platform/core/testing`: boot real units in tests, without browser APIs.
 * @description
 * The entry point for tests. {@linkcode createTestPlatform} wraps a real
 * `Kernel` with the direct router (recording every routed envelope),
 * deterministic ids (`id-1`, `id-2`, ...), a controllable clock, captured
 * errors instead of console output, and optional in-memory persistence.
 * `createMemoryRouteSource` is re-exported for Page-scope tests.
 *
 * ```text
 *   createTestPlatform(subsystems)
 *   +-- kernel     a real Kernel
 *   +-- routed     every envelope, in order
 *   +-- errors     every reported error, with its unit id
 *   +-- clock      now() / advance(ms), starting at 1000
 *   +-- settle()   waits for reconciliation and view notifications
 *   ```
 *
 * @example
 * Testing a subsystem's boot and its packets
 * ```ts
 * import { createTestPlatform } from '@platform/core/testing';
 *
 * const platform = createTestPlatform([storage, auth]);
 * await platform.start();
 * expect(platform.status('auth')).toBe('READY');
 * expect(platform.routed.map((e) => e.eventId)).toEqual(['storage:get']);
 * expect(platform.errors).toEqual([]);
 * await platform.stop();
 * ```
 *
 * @example
 * Testing persistence and time to live
 * ```ts
 * import { createMemoryPersistence, createTestPlatform } from '@platform/core/testing';
 *
 * const persistence = createMemoryPersistence({ prefs: { version: 1, data: { theme: 'dark' } } });
 * const platform = createTestPlatform([prefs], { persistence });
 * await platform.start();
 * platform.clock.advance(60_000); // packets with a shorter ttl now expire
 * ```
 *
 * @see [Package README](../../README.md#testing)
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

/**
 * @summary A clock tests can move forward.
 *
 * @example
 * Example 1: Reading it
 * ```ts
 * platform.clock.now(); // 1000
 * ```
 *
 * @example
 * Example 2: Expiring packets
 * ```ts
 * platform.clock.advance(5_000);
 * ```
 *
 * @public
 */
export interface TestClock {
  /**
   * @summary Returns the current test time, in milliseconds.
   * @description Pass it as the `now` option of the code under test.
   * @example
   * Giving the clock to a subsystem
   * ```ts
   * createLogger({ now: clock.now });
   * ```
   * @returns {number} The current time.
   */
  now(): number;
  /**
   * @summary Moves the clock forward.
   * @description Only `now` changes. Timers do not run: use fake timers for them.
   * @example
   * Letting a circuit breaker reset
   * ```ts
   * clock.advance(30_000);
   * ```
   * @param {number} ms The number of milliseconds to add.
   */
  advance(ms: number): void;
}

/**
 * @summary Creates a {@linkcode TestClock}.
 *
 * @example
 * Example 1: Starting at zero
 * ```ts
 * const clock = createTestClock();
 * ```
 *
 * @example
 * Example 2: Sharing a clock with the platform
 * ```ts
 * const clock = createTestClock(Date.UTC(2026, 0, 1));
 * const platform = createTestPlatform(subsystems, { clock });
 * ```
 *
 * @param {number} [start=0] The starting time in milliseconds.
 * @returns {TestClock} The clock.
 *
 * @public
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

/**
 * @summary In-memory {@linkcode StatePersistence} that exposes what was saved.
 *
 * @example
 * Example 1: Asserting what a unit persisted
 * ```ts
 * await platform.stop();
 * expect(persistence.saved.get('prefs')).toEqual({ version: 1, data: { theme: 'sepia' } });
 * ```
 *
 * @example
 * Example 2: Starting from saved state
 * ```ts
 * const persistence = createMemoryPersistence({ prefs: { version: 1, data: { theme: 'dark' } } });
 * ```
 *
 * @public
 */
export interface MemoryPersistence extends StatePersistence {
  /**
   * @summary All saved and pre-filled states, by unit id.
   * @description Tests read it to check what a unit persisted.
   */
  readonly saved: ReadonlyMap<string, PersistedState<object>>;
}

/**
 * @summary Creates in-memory persistence, optionally pre-filled.
 *
 * @description
 * `load` returns what is in `saved`; `save` stores a structured clone, so a
 * test cannot accidentally share references with the unit.
 *
 * @example
 * Example 1: Empty
 * ```ts
 * const persistence = createMemoryPersistence();
 * ```
 *
 * @example
 * Example 2: Pre-filled for a restore test
 * ```ts
 * const persistence = createMemoryPersistence({ auth: { version: 2, data: { user: 'ada' } } });
 * ```
 *
 * @param {Record<string, PersistedState<object>>} [initial={}] State to load, by unit id.
 * @returns {MemoryPersistence} The persistence.
 *
 * @public
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

/**
 * @summary An in-memory platform for tests.
 *
 * @description
 * Wraps a real {@linkcode Kernel} (`kernel`) and records what tests need to
 * assert: every routed envelope (`routed`) and every reported error
 * (`errors`). `clock` controls time, `settle` waits for reconciliation and
 * view notifications, and `unit` and `status` read units.
 *
 * Returned by {@linkcode createTestPlatform}.
 *
 * @example
 * Example 1: Asserting statuses
 * ```ts
 * expect(platform.status('storage')).toBe('DEGRADED');
 * expect(platform.unit('storage').lifecycle.getSnapshot().offFeatures).toEqual(['idb']);
 * ```
 *
 * @example
 * Example 2: Waiting after a runtime change
 * ```ts
 * fail(new Error('offline'));
 * await platform.settle();
 * expect(platform.status('sync')).toBe('SUSPENDED');
 * ```
 *
 * @public
 */
export interface TestPlatform {
  /**
   * @summary The real kernel that runs the units.
   */
  readonly kernel: Kernel;
  /**
   * @summary The clock of the platform.
   */
  readonly clock: TestClock;
  /**
   * @summary All envelopes that the router got, oldest first.
   */
  readonly routed: readonly PacketEnvelope[];
  /**
   * @summary All errors that the kernel reported, oldest first.
   * @description The platform keeps them here instead of writing them to the console.
   */
  readonly errors: readonly {
    /**
     * @summary The error.
     */
    readonly error: unknown;
    /**
     * @summary The id of the unit that reported it.
     */
    readonly unitId: string;
  }[];
  /**
   * @summary Starts the kernel and waits until it settles.
   * @example
   * Booting the units of a test
   * ```ts
   * await platform.start();
   * ```
   * @returns {Promise<void>} Resolves after the boot.
   */
  start(): Promise<void>;
  /**
   * @summary Stops the kernel.
   * @example
   * Testing what a unit persists
   * ```ts
   * await platform.stop();
   * expect(persistence.saved.get('logger')).toBeDefined();
   * ```
   * @returns {Promise<void>} Resolves after all units are destroyed.
   */
  stop(): Promise<void>;
  /**
   * @summary Waits for the dependency reconciliation and the pending view notifications.
   * @example
   * Checking a status after a change
   * ```ts
   * fail(new Error('crash'));
   * await platform.settle();
   * ```
   * @returns {Promise<void>} Resolves when nothing is pending.
   */
  settle(): Promise<void>;
  /**
   * @summary Returns a handle on a unit.
   * @example
   * Reading a control interface
   * ```ts
   * const logger = platform.unit<LoggerControl>('logger').control!;
   * ```
   * @template C The control interface type.
   * @param {string} id The full id of the unit.
   * @returns {UnitHandle<C>} The handle.
   */
  unit<C extends ControlInterface = ControlInterface>(id: string): UnitHandle<C>;
  /**
   * @summary Returns the current status of a unit.
   * @example
   * Checking a status
   * ```ts
   * expect(platform.status('storage/idb')).toBe('FAILED');
   * ```
   * @param {string} id The full id of the unit.
   * @returns {UnitStatus} The status.
   */
  status(id: string): UnitStatus;
}

/**
 * @summary Creates an in-memory test platform.
 *
 * @description
 * Builds a {@linkcode Kernel} with a recording direct router, deterministic
 * ids, the test clock (a new one starting at 1000, or `options.clock`), and
 * an `onError` that records errors. Any other kernel option (persistence,
 * processors, schedule, ids) can be passed through.
 *
 * @example
 * Example 1: Boot, assert, stop
 * ```ts
 * const platform = createTestPlatform([storage, auth]);
 * await platform.start();
 * expect(platform.status('auth')).toBe('READY');
 * await platform.stop();
 * ```
 *
 * @example
 * Example 2: Synchronous view notifications
 * ```ts
 * const platform = createTestPlatform(subsystems, { schedule: (flush) => flush() });
 * ```
 *
 * @param {readonly SubsystemDefinition[]} subsystems The subsystems to register.
 * @param {object} [options] Kernel options except `router`, `onError` and `now`, plus an optional `clock`.
 * @returns {TestPlatform} The platform. Call `start()` to boot it.
 * @throws {DependencyCycleError} When required dependencies form a cycle.
 *
 * @public
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
