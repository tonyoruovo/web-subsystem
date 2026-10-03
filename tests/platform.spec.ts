import { describe, expect, it } from 'vitest';

import type { PendingToken } from '../src';
import { createPlatform } from '../src';

function makeToken(id: string, importance: PendingToken['importance']): PendingToken {
  return {
    id,
    subsystemId: 'test',
    importance,
    createdAt: 0,
    estimatedDuration: null,
    category: 'SYNC',
  };
}

describe('createPlatform', () => {
  it('assembles all managers and reaches IDLE on markReady', async () => {
    const platform = await createPlatform({});

    expect(platform.globalState.getPlatformStatus()).toBe('INITIALIZING');
    platform.markReady();
    expect(platform.globalState.getPlatformStatus()).toBe('IDLE');

    expect(platform.queue).toBeDefined();
    expect(platform.notifications).toBeDefined();
    expect(platform.network).toBeDefined();
    expect(platform.auth).toBeDefined();
    expect(platform.sync).toBeDefined();
    expect(platform.translation).toBeDefined();
    expect(platform.analytics).toBeDefined();
  });

  it('wires the queue admission gate to Global State', async () => {
    const platform = await createPlatform({
      busyThreshold: 0,
    });
    platform.markReady();

    platform.globalState.registerPendingToken(makeToken('t1', 'HIGH'));
    expect(platform.globalState.getPlatformStatus()).toBe('BUSY');

    const low = platform.queue.enqueue({
      eventId: 'x',
      actionName: 'X',
      payload: {},
      importance: 'LOW',
      metadata: { messageId: 'low', sourceSubsystem: 'a', targetSubsystem: 'b', timestamp: 0 },
      fingerprints: [],
    });
    expect(low).toBeNull();
  });

  it('gates analytics on consent', async () => {
    let granted = false;
    const platform = await createPlatform({
      analyticsConsent: () => granted,
    });

    platform.analytics.increment('page.view');
    expect(platform.analytics.getMetrics().counters).toEqual({});

    granted = true;
    platform.analytics.increment('page.view');
    expect(platform.analytics.getMetrics().counters).toEqual({ 'page.view': 1 });
  });
});
