import { describe, expect, it } from 'vitest';

import type { PendingToken, SubsystemStatus } from '../src';
import { GlobalState } from '../src';

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

function makeSubsystem(
  id: string,
  importance: SubsystemStatus['importance'],
  healthScore = 100,
  status: SubsystemStatus['status'] = 'READY',
): SubsystemStatus {
  return {
    subsystemId: id,
    type: 'CENTRALIZED',
    status,
    importance,
    lastHeartbeat: 0,
    errorCount: 0,
    dependencies: [],
    healthScore,
    startedAt: 0,
  };
}

describe('GlobalState', () => {
  it('starts INITIALIZING and becomes IDLE after markReady', () => {
    const state = new GlobalState();
    expect(state.getPlatformStatus()).toBe('INITIALIZING');

    state.markReady();
    expect(state.getPlatformStatus()).toBe('IDLE');
  });

  it('tracks pending work and rejects LOW work while BUSY', () => {
    const state = new GlobalState({ busyThreshold: 1 });
    state.markReady();

    expect(state.registerPendingToken(makeToken('t1', 'LOW'))).toBe(true);
    expect(state.getPlatformStatus()).toBe('IDLE');

    expect(state.registerPendingToken(makeToken('t2', 'HIGH'))).toBe(true);
    expect(state.getPlatformStatus()).toBe('BUSY');

    expect(state.registerPendingToken(makeToken('t3', 'LOW'))).toBe(false);
    expect(state.registerPendingToken(makeToken('t4', 'CRITICAL'))).toBe(true);

    expect(state.getPendingWorkCount()).toBe(3);

    state.completePendingToken('t4');
    expect(state.getPendingWorkCount()).toBe(2);
  });

  it('reports a manager unhealthy on error, low score, or stale heartbeat', () => {
    let now = 0;
    const state = new GlobalState({ now: () => now });

    state.registerSubsystem(makeSubsystem('a', 'HIGH', 100, 'READY'));
    expect(state.isSubsystemHealthy('a')).toBe(true);

    state.registerSubsystem(makeSubsystem('b', 'HIGH', 100, 'ERROR'));
    expect(state.isSubsystemHealthy('b')).toBe(false);

    state.registerSubsystem(makeSubsystem('c', 'HIGH', 10, 'READY'));
    expect(state.isSubsystemHealthy('c')).toBe(false);

    state.registerSubsystem(makeSubsystem('d', 'HIGH', 100, 'READY'));
    now = 40_000; // heartbeat 0 is stale past the 30s timeout
    expect(state.isSubsystemHealthy('d')).toBe(false);
  });

  it('enters DEGRADED when a CRITICAL manager is unhealthy', () => {
    const state = new GlobalState({ now: () => 0 });
    state.markReady();
    state.registerSubsystem(makeSubsystem('critical', 'CRITICAL', 100, 'READY'));
    expect(state.getPlatformStatus()).toBe('IDLE');

    state.updateSubsystemStatus('critical', 'ERROR');
    expect(state.getPlatformStatus()).toBe('DEGRADED');

    state.updateSubsystemStatus('critical', 'READY');
    expect(state.getPlatformStatus()).toBe('IDLE');
  });

  it('blocks all work after stop and crash', () => {
    const stopped = new GlobalState();
    stopped.markReady();
    stopped.stop();
    expect(stopped.getPlatformStatus()).toBe('STOPPED');
    expect(stopped.registerPendingToken(makeToken('t1', 'CRITICAL'))).toBe(false);

    const crashed = new GlobalState();
    crashed.markReady();
    crashed.crash();
    expect(crashed.getPlatformStatus()).toBe('CRASHED');
    expect(crashed.registerPendingToken(makeToken('t2', 'CRITICAL'))).toBe(false);
  });
});
