import {
  NO_CONTROL,
  UnitUnavailableError,
  createEnvelope,
  type PacketEnvelope,
  type SubsystemDefinition,
} from '@platform/core';
import { createTestClock, createTestPlatform } from '@platform/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastRejectedError,
  CircuitBreakers,
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
  type NotificationOptions,
} from '../src';

const listener = (
  id: string,
  received: { id: string; payload: unknown }[],
  extra: Partial<SubsystemDefinition> = {},
): SubsystemDefinition => ({
  id,
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['news'],
  receive: (packet) => {
    const payload = packet.take() as { n: number };
    received.push({ id, payload: { ...payload } });
    payload.n = -1; // must not leak to other subscribers
  },
  control: () => NO_CONTROL,
  ...extra,
});

const broadcast = (source: string, payload: unknown = { n: 1 }, eventId = 'news'): PacketEnvelope =>
  createEnvelope({ eventId, payload }, { source, scope: 'tab' });

async function setup(subsystems: SubsystemDefinition[], options: NotificationOptions = {}) {
  const clock = createTestClock(1_000);
  const notification = createNotificationCenter({ now: clock.now, ...options });
  const platform = createTestPlatform([notification.subsystem, ...subsystems], { clock });
  await platform.start();
  const control = platform.unit<NotificationControl>(NOTIFICATION_ID).control!;
  const fanOut = (envelope: PacketEnvelope) => notification.fanOut(platform.kernel, envelope);
  return { platform, control, fanOut, clock };
}

describe('fanOut', () => {
  it('delivers a copy to every subscriber except the sender, and records one trail', async () => {
    const received: { id: string; payload: unknown }[] = [];
    const { control, fanOut } = await setup([
      listener('a', received),
      listener('b', received),
      listener('source', received),
    ]);
    const heard = vi.fn();
    control.commands.subscribe('news', heard, { subscriber: 'ui' });

    await fanOut(broadcast('source'));

    expect(received).toEqual([
      { id: 'a', payload: { n: 1 } },
      { id: 'b', payload: { n: 1 } },
    ]);
    expect(heard).toHaveBeenCalledWith({ n: 1 }, expect.objectContaining({ eventId: 'news' }));
    const [record] = control.views.history.getSnapshot();
    expect(record).toMatchObject({ outcome: 'fanned-out', source: 'source' });
    expect(record.deliveries.map((d) => [d.subscriber, d.outcome])).toEqual([
      ['a', 'delivered'],
      ['b', 'delivered'],
      ['ui', 'delivered'],
    ]);
    expect(record.trail.entries.map((e) => `${e.actionName}:${e.componentId ?? ''}`)).toEqual([
      'fanned-out:',
      'delivered:a',
      'delivered:b',
      'delivered:ui',
    ]);
    expect(control.views.state.getSnapshot()).toMatchObject({ broadcasts: 1, delivered: 3 });
  });

  it('orders deliveries by priority, higher first', async () => {
    const order: string[] = [];
    const { control, fanOut } = await setup([]);
    control.commands.subscribe('news', () => void order.push('low'), { priority: -1 });
    control.commands.subscribe('news', () => void order.push('high'), { priority: 5 });
    control.commands.subscribe('news', () => void order.push('normal'));
    await fanOut(broadcast('x'));
    expect(order).toEqual(['high', 'normal', 'low']);
  });

  it('refuses unauthorized publishers and, in strict mode, unknown events', async () => {
    const { control, fanOut } = await setup([], {
      strict: true,
      events: [{ eventId: 'news', publishers: ['press'] }],
    });
    await expect(fanOut(broadcast('stranger'))).rejects.toThrow(BroadcastRejectedError);
    await expect(fanOut(broadcast('press', null, 'gossip'))).rejects.toThrow('not registered');
    await expect(fanOut(broadcast('press'))).resolves.toBeUndefined();

    const history = control.views.history.getSnapshot();
    expect(history.map((r) => r.outcome)).toEqual(['rejected', 'rejected', 'fanned-out']);
    expect(history[0].trail.entries.at(-1)).toMatchObject({
      actionName: 'rejected',
      level: 'WARN',
    });
    expect(control.views.state.getSnapshot().rejected).toBe(2);
  });

  it('only delivers to allowed subscribers', async () => {
    const received: { id: string; payload: unknown }[] = [];
    const { control, fanOut } = await setup([listener('a', received), listener('b', received)]);
    control.commands.registerEvent({ eventId: 'news', subscribers: ['b'] });
    await fanOut(broadcast('x'));
    expect(received.map((r) => r.id)).toEqual(['b']);
    expect(control.views.state.getSnapshot().events).toBe(1);
  });

  it('records a failing subscriber without failing the broadcast', async () => {
    const received: { id: string; payload: unknown }[] = [];
    const { control, fanOut } = await setup([
      listener('bad', received, {
        receive: () => {
          throw new Error('handler bug');
        },
      }),
      listener('good', received),
    ]);
    await fanOut(broadcast('x'));
    expect(received.map((r) => r.id)).toEqual(['good']);
    const [record] = control.views.history.getSnapshot();
    expect(record.deliveries).toEqual([
      { subscriber: 'bad', outcome: 'failed', reason: 'handler bug' },
      { subscriber: 'good', outcome: 'delivered', reason: null },
    ]);
    expect(record.trail.entries.find((e) => e.componentId === 'bad')?.level).toBe('ERROR');
  });

  it('skips a subscriber whose circuit is open, and tries it again after the timeout', async () => {
    let fail = true;
    const { control, fanOut, clock } = await setup([], {
      failureThreshold: 2,
      resetTimeoutMs: 100,
    });
    control.commands.subscribe(
      'news',
      () => {
        if (fail) throw new Error('down');
      },
      { subscriber: 'flaky' },
    );
    await fanOut(broadcast('x'));
    await fanOut(broadcast('x'));
    await fanOut(broadcast('x'));
    clock.advance(150);
    fail = false;
    await fanOut(broadcast('x'));

    const outcomes = control.views.history
      .getSnapshot()
      .map(
        (r) =>
          `${r.deliveries[0].outcome}${r.deliveries[0].reason ? ` (${r.deliveries[0].reason})` : ''}`,
      );
    expect(outcomes).toEqual([
      'failed (down)',
      'failed (down)',
      'skipped (circuit open)',
      'delivered',
    ]);
  });

  it('filters payloads, stops after maxExecutions, and unsubscribes', async () => {
    const { control, fanOut } = await setup([]);
    const filtered = vi.fn();
    const once = vi.fn();
    const removed = vi.fn();
    control.commands.subscribe('news', filtered, { filter: (p) => (p as { n: number }).n > 1 });
    control.commands.subscribe('news', once, { maxExecutions: 1 });
    const stop = control.commands.subscribe('news', removed);
    stop();

    await fanOut(broadcast('x', { n: 1 }));
    await fanOut(broadcast('x', { n: 2 }));
    expect(filtered).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(control.views.state.getSnapshot().subscriptions).toBe(1);
  });

  it('keeps a bounded history', async () => {
    const { control, fanOut } = await setup([], { historySize: 2 });
    for (const n of [1, 2, 3]) await fanOut(broadcast('x', { n }));
    const history = control.views.history.getSnapshot();
    expect(history).toHaveLength(2);
    expect(history[0].messageId).not.toBe(history[1].messageId);
  });

  it('refuses to fan out while not running', async () => {
    const notification = createNotificationCenter();
    const platform = createTestPlatform([notification.subsystem]);
    await expect(notification.fanOut(platform.kernel, broadcast('x'))).rejects.toThrow(
      UnitUnavailableError,
    );
  });
});

describe('CircuitBreakers', () => {
  it('opens at the threshold, half-opens after the timeout, and re-opens on a failed trial', () => {
    let t = 0;
    const breakers = new CircuitBreakers({ failureThreshold: 2, resetTimeoutMs: 10, now: () => t });
    breakers.failed('k');
    expect(breakers.state('k').status).toBe('CLOSED');
    breakers.failed('k');
    expect(breakers.allows('k')).toBe(false);
    t = 10;
    expect(breakers.allows('k')).toBe(true);
    expect(breakers.state('k').status).toBe('HALF_OPEN');
    breakers.failed('k');
    expect(breakers.state('k')).toMatchObject({ status: 'OPEN', openedAt: 10 });
    t = 20;
    breakers.allows('k');
    breakers.succeeded('k');
    expect(breakers.state('k')).toEqual({ status: 'CLOSED', failures: 0, openedAt: null });
  });
});
