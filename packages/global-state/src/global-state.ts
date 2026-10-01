/**
 * @fileoverview
 * @summary The Global State subsystem: derived platform status, admission, pending work, environment and tab identity.
 * @description
 * Implements Global State as described in docs/ARCHITECTURE.md §10.1 and the
 * amended `proposals/global_PROPOSAL.md`. It is a centralized, tab-scoped
 * subsystem with the id `global-state`.
 *
 * ```text
 *   ctx.statuses ----+
 *   pending work ----+--> derivePlatformStatus --> state.status --> canAccept()
 *   environment -----+                                               (the Queue's admission)
 *   tab identity ---------------------------------> state.tabId
 *   ```
 *
 * Other units read it through `ctx.dependency('global-state')`; applications
 * through `kernel.unit('global-state').control`.
 *
 * @example
 * Registering it with the kernel
 * ```ts
 * import { Kernel } from '@platform/core';
 * import { createGlobalState } from '@platform/global-state';
 *
 * const kernel = new Kernel([createGlobalState(), ...otherSubsystems]);
 * await kernel.start();
 * ```
 *
 * @example
 * Showing the platform status and pending work
 * ```ts
 * const state = kernel.unit<GlobalStateControl>('global-state').control!.views.state;
 * state.subscribe(() => {
 *   const { status, pending, online } = state.getSnapshot();
 *   statusBar.textContent = `${status}, ${pending?.length ?? 0} pending${online ? '' : ', offline'}`;
 * });
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  type Importance,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import { createBrowserEnvironment, type EnvironmentSource } from './environment';
import {
  canAccept,
  derivePlatformStatus,
  summarizeUnits,
  type PlatformStatus,
  type UnitSummary,
} from './status';
import { resolveTabIdentity, type TabIdentityOptions } from './tab-identity';

/**
 * @summary The id Global State registers under.
 * @constant {'global-state'}
 * @public
 */
export const GLOBAL_STATE_ID = 'global-state';

/**
 * @summary One piece of work in progress.
 *
 * @description
 * `id` identifies it (the Queue uses packet message ids), `subsystemId` says
 * who is doing it, `importance` is its priority, `label` describes it for a
 * UI (for packets: the event id), and `startedAt` is when it began.
 *
 * @example
 * Example 1: A packet in flight
 * ```ts
 * // { id: 'm-1', subsystemId: 'auth', importance: 'HIGH', label: 'auth:refresh', startedAt: 1700000000000 }
 * ```
 *
 * @example
 * Example 2: Listing pending work for the user
 * ```ts
 * list.replaceChildren(...state.getSnapshot().pending!.map((w) => item(w.label ?? w.subsystemId)));
 * ```
 *
 * @public
 */
export interface PendingWork {
  readonly id: string;
  readonly subsystemId: string;
  readonly importance: Importance;
  readonly label: string | null;
  readonly startedAt: number;
}

/**
 * @summary Global State's state.
 *
 * @description
 * `status` is the derived {@linkcode PlatformStatus}; `units` the
 * {@linkcode UnitSummary} it was derived from; `pending` the work in
 * progress; `online` and `visible` the environment; `tabId` this tab's
 * identity. Every key is readable; none is persisted (all of it describes
 * this session).
 *
 * @example
 * Example 1: A healthy, idle tab
 * ```ts
 * // { status: 'IDLE', tabId: 'tab_...', online: true, visible: true, pending: [], units: { ... } }
 * ```
 *
 * @example
 * Example 2: Reacting to going offline
 * ```ts
 * if (!state.getSnapshot().online) showOfflineBanner();
 * ```
 *
 * @public
 */
export interface GlobalStateData {
  status: PlatformStatus;
  tabId: string;
  online: boolean;
  visible: boolean;
  pending: PendingWork[];
  units: UnitSummary;
}

/**
 * @summary Global State's control interface.
 *
 * @description
 * `canAccept(importance)` answers admission for the current status.
 * `beginWork(work)` registers work in progress (refused, returning `false`,
 * when its importance is not admitted); `endWork(id)` removes it. `views.state`
 * is the readable {@linkcode GlobalStateData}.
 *
 * The Queue calls `canAccept`, `beginWork` and `endWork` for every packet.
 *
 * @example
 * Example 1: Admission
 * ```ts
 * if (!control.commands.canAccept('LOW')) postpone(task);
 * ```
 *
 * @example
 * Example 2: Tracking a long task outside the Queue
 * ```ts
 * if (control.commands.beginWork({ id: 'import', subsystemId: 'sync', importance: 'MEDIUM', label: 'Import' })) {
 *   try { await importAll(); } finally { control.commands.endWork('import'); }
 * }
 * ```
 *
 * @public
 */
export interface GlobalStateControl {
  readonly commands: {
    canAccept(importance: Importance): boolean;
    beginWork(
      work: Omit<PendingWork, 'startedAt' | 'label'> & { readonly label?: string },
    ): boolean;
    endWork(id: string): void;
  };
  readonly views: { readonly state: View<Partial<GlobalStateData>> };
}

/**
 * @summary Options for {@linkcode createGlobalState}.
 *
 * @description
 * `busyThreshold` is the pending work above which the platform is `BUSY`
 * (default 50). `environment` replaces the browser environment.
 * `tabIdentity` configures tab identity, or `false` turns it off (the id is
 * then `'tab'`). `now` replaces the clock.
 *
 * @example
 * Example 1: A lower busy threshold
 * ```ts
 * createGlobalState({ busyThreshold: 20 });
 * ```
 *
 * @example
 * Example 2: In a test
 * ```ts
 * createGlobalState({ environment: createStaticEnvironment(), tabIdentity: false });
 * ```
 *
 * @public
 */
export interface GlobalStateOptions {
  readonly busyThreshold?: number;
  readonly environment?: EnvironmentSource;
  readonly tabIdentity?: TabIdentityOptions | false;
  readonly now?: () => number;
}

/**
 * @summary Creates the Global State subsystem.
 *
 * @description
 * Returns a centralized, tab-scoped {@linkcode SubsystemDefinition} with the
 * id {@linkcode GLOBAL_STATE_ID}. On start it resolves the tab identity, then
 * re-derives the platform status whenever any unit's lifecycle, the pending
 * work, or the environment changes. On shutdown its status becomes `STOPPED`.
 *
 * @example
 * Example 1: With defaults
 * ```ts
 * const kernel = new Kernel([createGlobalState(), ...subsystems]);
 * ```
 *
 * @example
 * Example 2: Reading the status from another unit
 * ```ts
 * requires: [{ target: 'global-state', kind: 'optional' }],
 * init: (ctx) => {
 *   const status = ctx.dependency<GlobalStateControl>('global-state')?.views.state.getSnapshot().status;
 * },
 * ```
 *
 * @param {GlobalStateOptions} [options] Busy threshold, environment, tab identity and clock.
 * @returns {SubsystemDefinition<GlobalStateData, GlobalStateControl>} The subsystem.
 *
 * @public
 */
export function createGlobalState(
  options: GlobalStateOptions = {},
): SubsystemDefinition<GlobalStateData, GlobalStateControl> {
  const busyThreshold = options.busyThreshold ?? 50;
  const now = options.now ?? Date.now;
  const environment = options.environment ?? createBrowserEnvironment();
  const readable = { readable: true } as const;

  return defineSubsystem({
    id: GLOBAL_STATE_ID,
    scope: 'tab',
    kind: 'centralized',
    state: {
      initial: {
        status: 'INITIALIZING',
        tabId: '',
        online: environment.online(),
        visible: environment.visible(),
        pending: [],
        units: summarizeUnits({}),
      } as GlobalStateData,
      policy: {
        status: readable,
        tabId: readable,
        online: readable,
        visible: readable,
        pending: readable,
        units: readable,
      },
    },
    async init(ctx) {
      const identity =
        options.tabIdentity === false
          ? { id: 'tab', close: () => {} }
          : await resolveTabIdentity(options.tabIdentity);

      const recompute = () =>
        ctx.state.update((s) => {
          s.tabId = identity.id;
          s.online = environment.online();
          s.visible = environment.visible();
          s.units = summarizeUnits(ctx.statuses.getSnapshot(), ctx.id);
          s.status = derivePlatformStatus(s.units, s.pending.length, busyThreshold);
        });

      recompute();
      const stopStatuses = ctx.statuses.subscribe(recompute);
      const stopEnvironment = environment.subscribe(recompute);
      return () => {
        stopStatuses();
        stopEnvironment();
        identity.close();
        ctx.state.update((s) => void (s.status = 'STOPPED'));
      };
    },
    control: (ctx) => {
      const recomputeStatus = (s: GlobalStateData) => {
        s.status = derivePlatformStatus(s.units, s.pending.length, busyThreshold);
      };
      return {
        commands: {
          canAccept: (importance: Importance) => canAccept(ctx.state.get().status, importance),
          beginWork(work) {
            if (!canAccept(ctx.state.get().status, work.importance)) return false;
            ctx.state.update((s) => {
              s.pending = s.pending.filter((p) => p.id !== work.id);
              s.pending.push({ ...work, label: work.label ?? null, startedAt: now() });
              recomputeStatus(s);
            });
            return true;
          },
          endWork(id: string) {
            if (!ctx.state.get().pending.some((p) => p.id === id)) return;
            ctx.state.update((s) => {
              s.pending = s.pending.filter((p) => p.id !== id);
              recomputeStatus(s);
            });
          },
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
