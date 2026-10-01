import { describe, expect, it, vi } from 'vitest';

import {
  DependencyCycleError,
  DependencyGraph,
  LateBinding,
  isRequired,
  type DependencyNode,
} from '../src';

const node = (id: string, ...requires: DependencyNode['requires']): DependencyNode => ({
  id,
  requires,
});

describe('DependencyGraph — validation', () => {
  it('accepts an acyclic graph', () => {
    expect(() =>
      new DependencyGraph([node('a'), node('b', { target: 'a' })]).validate(),
    ).not.toThrow();
  });

  it('rejects a self-dependency', () => {
    expect(() => new DependencyGraph([node('a', { target: 'a' })]).validate()).toThrow(
      DependencyCycleError,
    );
  });

  it('reports the units along a required cycle', () => {
    const graph = new DependencyGraph([
      node('a', { target: 'b' }),
      node('b', { target: 'c' }),
      node('c', { target: 'a' }),
    ]);
    try {
      graph.validate();
      expect.unreachable();
    } catch (error) {
      expect((error as DependencyCycleError).cycle).toEqual(['a', 'b', 'c', 'a']);
    }
  });

  it('allows a cycle that only exists through optional dependencies', () => {
    const graph = new DependencyGraph([
      node('a', { target: 'b', kind: 'optional' }),
      node('b', { target: 'a' }),
    ]);
    expect(() => graph.validate()).not.toThrow();
  });

  it('allows subsystem-level cycles that are acyclic between units (Auth / Network)', () => {
    const graph = new DependencyGraph([
      node('network'),
      node('network/interceptor', { target: 'network', when: 'INITIALIZING' }, { target: 'auth' }),
      node('auth', { target: 'network' }),
    ]);
    expect(() => graph.validate()).not.toThrow();
    expect(graph.order()).toEqual(['network', 'auth', 'network/interceptor']);
  });

  it('rejects a subsystem that requires its own feature', () => {
    const graph = new DependencyGraph([
      node('storage', { target: 'storage/idb' }),
      node('storage/idb', { target: 'storage', when: 'INITIALIZING' }),
    ]);
    expect(() => graph.validate()).toThrow(DependencyCycleError);
  });

  it('rejects duplicate ids', () => {
    expect(() => new DependencyGraph([node('a'), node('a')])).toThrow('registered twice');
  });
});

describe('DependencyGraph — missing targets', () => {
  it('reports required targets that are not registered, ignoring optional ones', () => {
    const graph = new DependencyGraph([
      node('analytics', { target: 'consent' }, { target: 'storage', kind: 'optional' }),
    ]);
    expect(graph.missing('analytics')).toEqual(['consent']);
    expect(() => graph.validate()).not.toThrow();
    expect(graph.has('consent')).toBe(false);
  });
});

describe('DependencyGraph — order', () => {
  it('puts dependencies first and keeps registration order otherwise', () => {
    const graph = new DependencyGraph([
      node('sync', { target: 'network' }, { target: 'storage' }),
      node('storage'),
      node('logger'),
      node('network'),
    ]);
    expect(graph.order()).toEqual(['storage', 'logger', 'network', 'sync']);
  });

  it('honours optional dependencies when they do not form a cycle', () => {
    const graph = new DependencyGraph([node('a', { target: 'b', kind: 'optional' }), node('b')]);
    expect(graph.order()).toEqual(['b', 'a']);
  });

  it('falls back to required dependencies when optional ones form a cycle', () => {
    const graph = new DependencyGraph([
      node('a', { target: 'b', kind: 'optional' }),
      node('b', { target: 'a' }),
    ]);
    expect(graph.order()).toEqual(['a', 'b']);
  });

  it('throws on a required cycle', () => {
    const graph = new DependencyGraph([node('a', { target: 'b' }), node('b', { target: 'a' })]);
    expect(() => graph.order()).toThrow(DependencyCycleError);
  });

  it('treats dependencies as required by default', () => {
    expect(isRequired({ target: 'x' })).toBe(true);
    expect(isRequired({ target: 'x', kind: 'optional' })).toBe(false);
  });
});

describe('LateBinding', () => {
  it('buffers until bound, then drains in order and passes writes through', async () => {
    const sink = vi.fn();
    const binding = new LateBinding<number>({ capacity: 10 });
    binding.write(1);
    binding.write(2);
    expect(binding.buffered).toBe(2);
    expect(binding.bound).toBe(false);

    await binding.bind(sink);
    binding.write(3);
    expect(sink.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
    expect(binding.bound).toBe(true);
    expect(binding.buffered).toBe(0);
  });

  it('drops the oldest entries on overflow and counts them', () => {
    const onDrop = vi.fn();
    const binding = new LateBinding<number>({ capacity: 2, onDrop });
    for (const n of [1, 2, 3, 4]) binding.write(n);
    expect(binding.buffered).toBe(2);
    expect(binding.dropped).toBe(2);
    expect(onDrop).toHaveBeenNthCalledWith(1, 1, 1);
    expect(onDrop).toHaveBeenNthCalledWith(2, 2, 2);
  });

  it('queues writes made during the drain behind the buffered ones', async () => {
    const seen: number[] = [];
    const binding = new LateBinding<number>({ capacity: 10 });
    binding.write(1);
    await binding.bind(async (n) => {
      seen.push(n);
      if (n === 1) binding.write(2);
    });
    expect(seen).toEqual([1, 2]);
  });

  it('keeps the failed item and unbinds when the sink fails during the drain', async () => {
    const binding = new LateBinding<number>({ capacity: 10 });
    binding.write(1);
    await expect(
      binding.bind(() => {
        throw new Error('storage down');
      }),
    ).rejects.toThrow('storage down');
    expect(binding.buffered).toBe(1);
    expect(binding.bound).toBe(false);
  });

  it('goes back to buffering after unbind', async () => {
    const sink = vi.fn();
    const binding = new LateBinding<number>({ capacity: 10 });
    await binding.bind(sink);
    binding.unbind();
    binding.write(1);
    expect(sink).not.toHaveBeenCalled();
    expect(binding.buffered).toBe(1);
  });

  it('rejects a capacity below 1', () => {
    expect(() => new LateBinding({ capacity: 0 })).toThrow(RangeError);
  });
});
