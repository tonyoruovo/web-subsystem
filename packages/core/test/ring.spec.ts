import { describe, expect, it, vi } from 'vitest';

import { createRingBuffer } from '../src';

describe('createRingBuffer', () => {
  it('keeps the newest items, counts evictions, and freezes items', () => {
    const ring = createRingBuffer<{ n: number }>(2);
    expect(ring.push({ n: 1 })).toBeUndefined();
    ring.push({ n: 2 });
    expect(ring.push({ n: 3 })).toEqual({ n: 1 });
    expect(ring.toArray()).toEqual([{ n: 2 }, { n: 3 }]);
    expect(ring).toMatchObject({ size: 2, dropped: 1, capacity: 2 });
    expect(Object.isFrozen(ring.toArray()[0])).toBe(true);
  });

  it('returns the same snapshot until a change, then notifies once per task', async () => {
    const ring = createRingBuffer<number>(5);
    const listener = vi.fn();
    ring.view.subscribe(listener);
    const empty = ring.view.getSnapshot();
    expect(ring.view.getSnapshot()).toBe(empty);

    ring.push(1);
    ring.push(2);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = ring.view.getSnapshot();
    expect(snapshot).toEqual([1, 2]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(ring.view.getSnapshot()).toBe(snapshot);

    ring.clear();
    ring.clear();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(ring.view.getSnapshot()).toEqual([]);
  });

  it('unsubscribes, survives a throwing listener, and rejects a bad capacity', async () => {
    vi.useFakeTimers();
    try {
      const ring = createRingBuffer<number>(1, (flush) => flush());
      const quiet = vi.fn();
      const stop = ring.view.subscribe(quiet);
      ring.view.subscribe(() => {
        throw new Error('listener bug');
      });
      stop();
      ring.push(1);
      expect(quiet).not.toHaveBeenCalled();
      expect(() => vi.runAllTimers()).toThrow('listener bug');
    } finally {
      vi.useRealTimers();
    }
    expect(() => createRingBuffer(0)).toThrow(RangeError);
  });
});
