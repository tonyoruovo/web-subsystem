/**
 * Kernel additions for M3: ctx.statuses, centralized-first boot,
 * subscribers(), deliver() options and scopeOf().
 */
import { describe, expect, it } from 'vitest';

import {
  Kernel,
  NO_CONTROL,
  createEnvelope,
  type FingerprintTrail,
  type LifecycleSnapshot,
  type SubsystemDefinition,
  type View,
} from '../src';
import { createTestPlatform } from '../src/testing';

const subsystem = (id: string, extra: Partial<SubsystemDefinition> = {}): SubsystemDefinition => ({
  id,
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  control: () => NO_CONTROL,
  ...extra,
});

describe('ctx.statuses', () => {
  it('gives every unit a read-only view of every lifecycle', async () => {
    let statuses: View<Readonly<Record<string, LifecycleSnapshot>>> | undefined;
    const platform = createTestPlatform([
      subsystem('observer', {
        init: (ctx) => {
          statuses = ctx.statuses;
        },
      }),
      subsystem('other'),
    ]);
    await platform.start();
    expect(statuses!.getSnapshot().other.status).toBe('READY');
    expect(statuses).toBe(platform.kernel.statuses);
  });
});

describe('centralized subsystems', () => {
  it('boot before featurized ones, whatever the registration order', async () => {
    const order: string[] = [];
    const track = (id: string, kind: 'centralized' | 'featurized') =>
      subsystem(id, { kind, init: () => void order.push(id) });
    const platform = createTestPlatform([
      track('app', 'featurized'),
      track('queue', 'centralized'),
      track('ui', 'featurized'),
      track('global-state', 'centralized'),
    ]);
    await platform.start();
    expect(order).toEqual(['queue', 'global-state', 'app', 'ui']);
  });

  it('may only require other centralized subsystems', () => {
    expect(
      () =>
        new Kernel([
          subsystem('storage'),
          subsystem('queue', { kind: 'centralized', requires: [{ target: 'storage' }] }),
        ]),
    ).toThrow('cannot require "storage"');
    expect(
      () =>
        new Kernel([
          subsystem('storage'),
          subsystem('queue', {
            kind: 'centralized',
            requires: [{ target: 'storage', kind: 'optional' }],
          }),
        ]),
    ).not.toThrow();
  });
});

describe('Kernel routing helpers', () => {
  const listener = (id: string, events: string[]) =>
    subsystem(id, { scope: 'page', subscribes: events, receive: (packet) => packet.take() });

  it('lists running subscribers and reports scopes', async () => {
    const platform = createTestPlatform([
      listener('a', ['x']),
      listener('b', ['y']),
      subsystem('c', { subscribes: ['x'] }), // no receive: not a subscriber
      subsystem('d', { requires: [{ target: 'missing' }], subscribes: ['x'], receive: () => 1 }),
    ]);
    await platform.start();
    expect(platform.kernel.subscribers('x')).toEqual(['a']);
    expect(platform.kernel.scopeOf('a')).toBe('page');
    expect(platform.kernel.scopeOf('ghost')).toBeUndefined();
  });

  it('delivers a broadcast to one subscriber with its own copy, and reports the trail', async () => {
    const platform = createTestPlatform([
      subsystem('target', {
        receive: (packet) => {
          const payload = packet.take() as { n: number };
          payload.n = 99;
          return 'ok';
        },
      }),
    ]);
    await platform.start();
    const payload = { n: 1 };
    const envelope = createEnvelope({ eventId: 'e', payload }, { source: 'src', scope: 'tab' });
    let trail: FingerprintTrail | undefined;
    await expect(
      platform.kernel.deliver(envelope, { to: 'target', clone: true, onTrail: (t) => (trail = t) }),
    ).resolves.toBe('ok');
    expect(payload.n).toBe(1);
    expect(trail!.entries.map((e) => e.actionName)).toEqual(['delivered']);
  });

  it('reports the trail even when receive throws', async () => {
    const platform = createTestPlatform([
      subsystem('target', {
        receive: () => {
          throw new Error('handler bug');
        },
      }),
    ]);
    await platform.start();
    const envelope = createEnvelope(
      { eventId: 'e', payload: null, target: 'target' },
      { source: 'src', scope: 'tab' },
    );
    let trail: FingerprintTrail | undefined;
    await expect(
      platform.kernel.deliver(envelope, { onTrail: (t) => (trail = t) }),
    ).rejects.toThrow('handler bug');
    expect(trail!.entries).toHaveLength(1);
  });
});
