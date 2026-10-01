import { describe, expect, it } from 'vitest';

import type { EventDefinition, Importance } from '../src';
import { NotificationCenter } from '../src';

function makeEvent(eventId: string, importance: Importance): EventDefinition {
  return {
    eventId,
    eventName: eventId,
    subsystemId: 'test',
    category: 'STATE',
    importance,
    description: 'test event',
    payloadSchema: null,
    registeredAt: 0,
    usageCount: 0,
    lastFiredAt: null,
    averageHandlerCount: 0,
  };
}

describe('NotificationCenter', () => {
  it('delivers a fired event to a subscriber', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:event', 'HIGH'));

    const seen: Array<{ payload: unknown }> = [];
    center.subscribe('test:event', async (payload) => {
      seen.push({ payload });
    });

    center.fireEvent('test:event', { userId: 'abc' });
    await center.dispatchOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ userId: 'abc' });
    expect(center.getQueueDepth()).toBe(0);
  });

  it('runs higher-priority handlers first', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:order', 'HIGH'));

    const order: number[] = [];
    center.subscribe(
      'test:order',
      async () => {
        order.push(1);
      },
      { priority: 1 },
    );
    center.subscribe(
      'test:order',
      async () => {
        order.push(3);
      },
      { priority: 3 },
    );
    center.subscribe(
      'test:order',
      async () => {
        order.push(2);
      },
      { priority: 2 },
    );

    center.fireEvent('test:order', {});
    await center.dispatchOnce();

    expect(order).toEqual([3, 2, 1]);
  });

  it('skips a handler when the filter returns false', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:filter', 'HIGH'));

    let calls = 0;
    center.subscribe(
      'test:filter',
      async () => {
        calls += 1;
      },
      { filterPredicate: (p) => (p as { ok: boolean }).ok },
    );

    center.fireEvent('test:filter', { ok: false });
    await center.dispatchOnce();

    expect(calls).toBe(0);
  });

  it('drops an unknown event id without throwing', async () => {
    const center = new NotificationCenter();

    expect(() => center.fireEvent('missing:event', {})).not.toThrow();
    expect(center.getQueueDepth()).toBe(0);
  });

  it('opens a circuit breaker after the failure threshold and skips the handler', async () => {
    const center = new NotificationCenter({ now: () => 0 });

    center.registerEvent(makeEvent('test:boom', 'HIGH'));
    const subId = center.subscribe('test:boom', async () => {
      throw new Error('boom');
    });

    for (let i = 0; i < 3; i++) {
      center.fireEvent('test:boom', {});
      await center.dispatchOnce();
    }

    expect(center.getBreaker(subId)?.status).toBe('OPEN');

    // The next dispatch fails fast and does not run the handler.
    center.fireEvent('test:boom', {});
    await center.dispatchOnce();

    const subscription = center.getSubscriptions('test:boom')[0];
    expect(subscription.executionCount).toBe(3); // unchanged after open
  });

  it('recovers on a successful half-open test', async () => {
    let now = 0;
    let calls = 0;
    const center = new NotificationCenter({ now: () => now, failureThreshold: 2 });

    center.registerEvent(makeEvent('test:recover', 'HIGH'));
    const subId = center.subscribe('test:recover', async () => {
      calls += 1;
      if (calls <= 2) throw new Error('boom');
    });

    center.fireEvent('test:recover', {});
    await center.dispatchOnce();
    center.fireEvent('test:recover', {});
    await center.dispatchOnce();

    expect(center.getBreaker(subId)?.status).toBe('OPEN');

    now = 31_000; // past the reset timeout
    center.fireEvent('test:recover', {});
    await center.dispatchOnce();

    expect(center.getBreaker(subId)?.status).toBe('CLOSED');
    expect(calls).toBe(3);
  });

  it('dispatches many events without loss', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:soak', 'HIGH'));
    let calls = 0;
    center.subscribe('test:soak', () => {
      calls += 1;
    });

    for (let i = 0; i < 500; i++) {
      center.fireEvent('test:soak', { i });
    }
    await center.drain();

    expect(calls).toBe(500);
  });
});
