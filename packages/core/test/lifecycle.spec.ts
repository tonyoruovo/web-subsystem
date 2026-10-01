import { describe, expect, it, vi } from 'vitest';

import {
  IllegalTransitionError,
  Lifecycle,
  TRANSITIONS,
  UNIT_STATUSES,
  canTransition,
  type UnitStatus,
} from '../src';

/** Shortest path of transitions from UNINITIALIZED to `target`. */
function pathTo(target: UnitStatus): UnitStatus[] {
  const previous = new Map<UnitStatus, UnitStatus | null>([['UNINITIALIZED', null]]);
  const queue: UnitStatus[] = ['UNINITIALIZED'];
  while (queue.length) {
    const status = queue.shift()!;
    if (status === target) break;
    for (const next of TRANSITIONS[status]) {
      if (!previous.has(next)) {
        previous.set(next, status);
        queue.push(next);
      }
    }
  }
  const path: UnitStatus[] = [];
  for (let s: UnitStatus | null = target; s && s !== 'UNINITIALIZED'; s = previous.get(s)!) {
    path.unshift(s);
  }
  return path;
}

function lifecycleAt(status: UnitStatus): Lifecycle {
  const lifecycle = new Lifecycle('unit');
  for (const step of pathTo(status)) lifecycle.transition(step);
  return lifecycle;
}

describe('Lifecycle — every transition', () => {
  it('reaches every status from UNINITIALIZED', () => {
    for (const status of UNIT_STATUSES) expect(lifecycleAt(status).status).toBe(status);
  });

  const pairs = UNIT_STATUSES.flatMap((from) => UNIT_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s -> %s follows the transition table', (from, to) => {
    const lifecycle = lifecycleAt(from);
    if (TRANSITIONS[from].includes(to)) {
      expect(canTransition(from, to)).toBe(true);
      lifecycle.transition(to);
      expect(lifecycle.status).toBe(to);
    } else {
      expect(canTransition(from, to)).toBe(false);
      expect(() => lifecycle.transition(to)).toThrow(IllegalTransitionError);
      expect(lifecycle.status).toBe(from);
    }
  });

  it('makes DESTROYED final', () => {
    expect(TRANSITIONS.DESTROYED).toEqual([]);
  });
});

describe('Lifecycle — snapshot', () => {
  it('records the reason and the off features', () => {
    const lifecycle = lifecycleAt('READY');
    lifecycle.transition('DEGRADED', { reason: 'feature failed', offFeatures: ['idb'] });
    expect(lifecycle.view.getSnapshot()).toEqual({
      status: 'DEGRADED',
      reason: 'feature failed',
      waitingFor: [],
      offFeatures: ['idb'],
    });
  });

  it('records what an uninitialized unit waits for, and clears it on transition', () => {
    const lifecycle = new Lifecycle('unit');
    lifecycle.wait(['storage']);
    expect(lifecycle.view.getSnapshot().waitingFor).toEqual(['storage']);
    expect(lifecycle.status).toBe('UNINITIALIZED');
    lifecycle.transition('INITIALIZING');
    expect(lifecycle.view.getSnapshot().waitingFor).toEqual([]);
  });

  it('notifies subscribers once per task', async () => {
    const lifecycle = new Lifecycle('unit');
    const listener = vi.fn();
    lifecycle.view.subscribe(listener);
    lifecycle.transition('INITIALIZING');
    lifecycle.transition('READY');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(lifecycle.view.getSnapshot().status).toBe('READY');
  });
});
