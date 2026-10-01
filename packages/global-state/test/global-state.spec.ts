import { NO_CONTROL, type SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_STATE_ID,
  canAccept,
  createGlobalState,
  createStaticEnvironment,
  derivePlatformStatus,
  resolveTabIdentity,
  summarizeUnits,
  type GlobalStateControl,
  type TabIdStorage,
} from '../src';

const healthy = summarizeUnits({});

const subsystem = (id: string, extra: Partial<SubsystemDefinition> = {}): SubsystemDefinition => ({
  id,
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  control: () => NO_CONTROL,
  ...extra,
});

function memoryStorage(): TabIdStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe('derivePlatformStatus', () => {
  it('applies initializing, degraded, busy and idle in that order', () => {
    expect(derivePlatformStatus({ ...healthy, initializing: 1, failed: 1 }, 0, 10)).toBe(
      'INITIALIZING',
    );
    expect(derivePlatformStatus({ ...healthy, failed: 1, busy: 1 }, 0, 10)).toBe('DEGRADED');
    expect(derivePlatformStatus({ ...healthy, waiting: 1 }, 0, 10)).toBe('DEGRADED');
    expect(derivePlatformStatus({ ...healthy, degraded: 1 }, 0, 10)).toBe('DEGRADED');
    expect(derivePlatformStatus({ ...healthy, busy: 1 }, 0, 10)).toBe('BUSY');
    expect(derivePlatformStatus(healthy, 11, 10)).toBe('BUSY');
    expect(derivePlatformStatus(healthy, 10, 10)).toBe('IDLE');
  });

  it('summarizes lifecycles, leaving out one unit and destroyed ones', () => {
    const snapshot = (status: string, waitingFor: string[] = []) =>
      ({ status, reason: null, waitingFor, offFeatures: [] }) as never;
    expect(
      summarizeUnits(
        {
          self: snapshot('INITIALIZING'),
          a: snapshot('READY'),
          b: snapshot('BUSY'),
          c: snapshot('UNINITIALIZED', ['x']),
          d: snapshot('UNINITIALIZED'),
          e: snapshot('DESTROYED'),
          f: snapshot('SUSPENDED'),
        },
        'self',
      ),
    ).toEqual({
      total: 5,
      running: 2,
      busy: 1,
      degraded: 0,
      failed: 0,
      waiting: 1,
      initializing: 1,
    });
  });
});

describe('canAccept', () => {
  it.each([
    ['IDLE', 'LOW', true],
    ['BUSY', 'CRITICAL', true],
    ['BUSY', 'HIGH', false],
    ['DEGRADED', 'LOW', false],
    ['DEGRADED', 'MEDIUM', true],
    ['STOPPED', 'CRITICAL', false],
  ] as const)('%s admits %s: %s', (status, importance, expected) => {
    expect(canAccept(status, importance)).toBe(expected);
  });
});

describe('createStaticEnvironment', () => {
  it('reports and notifies changes', () => {
    const environment = createStaticEnvironment();
    const seen: boolean[] = [];
    const stop = environment.subscribe(() => seen.push(environment.online()));
    environment.set({ online: false });
    stop();
    environment.set({ online: true });
    expect(seen).toEqual([false]);
    expect(environment.visible()).toBe(true);
  });
});

describe('resolveTabIdentity', () => {
  // Node's BroadcastChannel takes tens of milliseconds for a first delivery; browsers about 1 ms.
  const fast = { probeTimeoutMs: 200 };

  it('keeps the stored id across a reload when no other tab claims it', async () => {
    const storage = memoryStorage();
    const first = await resolveTabIdentity({ ...fast, storage });
    first.close(); // the tab reloads: the old document is gone
    const reloaded = await resolveTabIdentity({ ...fast, storage });
    expect(reloaded.id).toBe(first.id);
    reloaded.close();
  });

  it('gives a duplicated tab its own id', async () => {
    const original = memoryStorage();
    const first = await resolveTabIdentity({ ...fast, storage: original });

    // Duplicating a tab copies sessionStorage.
    const copy = memoryStorage();
    copy.setItem('platform:tab-id', first.id);
    const duplicate = await resolveTabIdentity({ ...fast, storage: copy });

    expect(duplicate.id).not.toBe(first.id);
    expect(copy.getItem('platform:tab-id')).toBe(duplicate.id);
    expect(original.getItem('platform:tab-id')).toBe(first.id);
    first.close();
    duplicate.close();
  });

  it('works without a channel', async () => {
    let n = 0;
    const identity = await resolveTabIdentity({
      storage: memoryStorage(),
      channel: () => null,
      ids: () => `tab_${++n}`,
    });
    expect(identity.id).toBe('tab_1');
    identity.close();
  });
});

describe('Global State subsystem', () => {
  const create = (extra = {}) =>
    createGlobalState({ environment: createStaticEnvironment(), tabIdentity: false, ...extra });
  const control = (platform: ReturnType<typeof createTestPlatform>) =>
    platform.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;

  it('derives IDLE once every unit runs, and DEGRADED while one waits', async () => {
    const platform = createTestPlatform([
      create(),
      subsystem('app'),
      subsystem('reports', { requires: [{ target: 'missing' }] }),
    ]);
    await platform.start();
    expect(control(platform).views.state.getSnapshot()).toMatchObject({
      status: 'DEGRADED',
      tabId: 'tab',
      units: { total: 2, running: 1, waiting: 1 },
    });
  });

  it('becomes BUSY past the threshold and refuses non-critical work', async () => {
    const platform = createTestPlatform([create({ busyThreshold: 1 }), subsystem('app')]);
    await platform.start();
    const { commands, views } = control(platform);
    expect(views.state.getSnapshot().status).toBe('IDLE');

    expect(commands.beginWork({ id: 'a', subsystemId: 'app', importance: 'LOW' })).toBe(true);
    expect(
      commands.beginWork({ id: 'b', subsystemId: 'app', importance: 'LOW', label: 'Upload' }),
    ).toBe(true);
    expect(views.state.getSnapshot().status).toBe('BUSY');
    expect(commands.canAccept('HIGH')).toBe(false);
    expect(commands.beginWork({ id: 'c', subsystemId: 'app', importance: 'HIGH' })).toBe(false);
    expect(commands.beginWork({ id: 'd', subsystemId: 'app', importance: 'CRITICAL' })).toBe(true);

    commands.endWork('a');
    commands.endWork('b');
    commands.endWork('d');
    commands.endWork('unknown');
    expect(views.state.getSnapshot()).toMatchObject({ status: 'IDLE', pending: [] });
  });

  it('follows unit failures and the environment', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const environment = createStaticEnvironment();
    const platform = createTestPlatform([
      createGlobalState({ environment, tabIdentity: false }),
      subsystem('app', {
        init: (ctx) => {
          fail = ctx.fail;
        },
      }),
    ]);
    await platform.start();
    const { views } = control(platform);

    fail!(new Error('crash'));
    await platform.settle();
    expect(views.state.getSnapshot()).toMatchObject({ status: 'DEGRADED', units: { failed: 1 } });

    environment.set({ online: false, visible: false });
    expect(views.state.getSnapshot()).toMatchObject({ online: false, visible: false });
  });

  it('is STOPPED after shutdown', async () => {
    const platform = createTestPlatform([create()]);
    await platform.start();
    const { views } = control(platform);
    const state = views.state;
    await platform.stop();
    expect(state.getSnapshot().status).toBe('STOPPED');
  });
});
