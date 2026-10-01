import { describe, expect, it, vi } from 'vitest';

import { StateSerializationError, createStateCell, createStore, deriveView } from '../src';

const tick = () => Promise.resolve();

describe('createStore', () => {
  it('keeps the snapshot identity until the value changes', () => {
    const store = createStore({ n: 1 });
    const first = store.view.getSnapshot();
    expect(store.view.getSnapshot()).toBe(first);
    store.set(first);
    expect(store.view.getSnapshot()).toBe(first);
  });

  it('freezes snapshots deeply', () => {
    const store = createStore({ nested: { n: 1 } });
    expect(Object.isFrozen(store.view.getSnapshot().nested)).toBe(true);
  });

  it('batches notifications per task', async () => {
    const store = createStore(0);
    const listener = vi.fn();
    store.view.subscribe(listener);
    store.set(1);
    store.set(2);
    store.set(3);
    expect(listener).not.toHaveBeenCalled();
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.view.getSnapshot()).toBe(3);
  });

  it('stops notifying after unsubscribe', async () => {
    const store = createStore(0);
    const listener = vi.fn();
    const unsubscribe = store.view.subscribe(listener);
    unsubscribe();
    store.set(1);
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying other listeners when one throws', async () => {
    vi.useFakeTimers();
    try {
      const store = createStore(0, (flush) => flush());
      const good = vi.fn();
      store.view.subscribe(() => {
        throw new Error('listener failed');
      });
      store.view.subscribe(good);
      store.set(1);
      expect(good).toHaveBeenCalledTimes(1);
      expect(() => vi.runAllTimers()).toThrow('listener failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deriveView', () => {
  it('keeps identity when the derived value is equal, and notifies only on change', async () => {
    const store = createStore({ a: 1, b: 1 });
    const onlyA = deriveView(
      store.view,
      (s) => ({ a: s.a }),
      (x, y) => x.a === y.a,
    );
    const first = onlyA.getSnapshot();
    const listener = vi.fn();
    onlyA.subscribe(listener);

    store.set({ a: 1, b: 2 });
    await tick();
    expect(onlyA.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();

    store.set({ a: 2, b: 2 });
    await tick();
    expect(onlyA.getSnapshot()).toEqual({ a: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('createStateCell', () => {
  const definition = {
    initial: { user: null as string | null, token: '', visits: 0 },
    policy: {
      user: { readable: true, persisted: true },
      visits: { persisted: true },
    },
    version: 2,
  };

  it('updates through a draft and freezes the result', () => {
    const cell = createStateCell('auth', definition);
    const before = cell.get();
    cell.update((s) => {
      s.user = 'ada';
    });
    expect(before.user).toBeNull();
    expect(cell.get().user).toBe('ada');
    expect(Object.isFrozen(cell.get())).toBe(true);
  });

  it('exposes only readable keys, with stable identity', async () => {
    const cell = createStateCell('auth', definition);
    const readable = cell.readable.getSnapshot();
    expect(readable).toEqual({ user: null });
    cell.update((s) => {
      s.token = 'secret';
    });
    expect(cell.readable.getSnapshot()).toBe(readable);
  });

  it('rejects non-serializable state', () => {
    const cell = createStateCell('auth', definition);
    expect(() =>
      cell.update((s) => {
        (s as Record<string, unknown>).fn = () => {};
      }),
    ).toThrow(StateSerializationError);
    expect(() =>
      createStateCell('bad', { initial: { s: Symbol('x') } as Record<string, unknown> }),
    ).toThrow(StateSerializationError);
  });

  it('persists only persisted keys, tagged with the version', () => {
    const cell = createStateCell('auth', definition);
    cell.update((s) => {
      s.user = 'ada';
      s.token = 'secret';
      s.visits = 3;
    });
    expect(cell.persist()).toEqual({ version: 2, data: { user: 'ada', visits: 3 } });
  });

  it('restores persisted keys only from the same version', () => {
    const cell = createStateCell('auth', definition);
    expect(cell.restore({ version: 1, data: { user: 'old' } })).toBe(false);
    expect(cell.get().user).toBeNull();

    expect(cell.restore({ version: 2, data: { user: 'ada', token: 'leaked' } })).toBe(true);
    expect(cell.get().user).toBe('ada');
    expect(cell.get().token).toBe(''); // not a persisted key, never restored
  });

  it('does not share references with the initial value', () => {
    const initial = { list: [1] };
    const cell = createStateCell('unit', { initial });
    initial.list.push(2);
    expect(cell.get().list).toEqual([1]);
  });
});
