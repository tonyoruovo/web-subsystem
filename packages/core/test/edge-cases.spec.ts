/**
 * Error paths and small APIs not exercised by the scenario tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CorrelationRegistry,
  DependencyGraph,
  Kernel,
  Lifecycle,
  NO_CONTROL,
  defineUnit,
  type SubsystemDefinition,
  type UnitDefinition,
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

const feature = (id: string, extra: Partial<UnitDefinition> = {}): UnitDefinition => ({
  id,
  state: { initial: {} },
  control: () => NO_CONTROL,
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Lifecycle.describe', () => {
  it('updates details without changing status, keeping unspecified ones', () => {
    const lifecycle = new Lifecycle('unit');
    lifecycle.transition('INITIALIZING');
    lifecycle.transition('DEGRADED', { reason: 'a off', offFeatures: ['a'] });
    lifecycle.describe({ offFeatures: ['a', 'b'] });
    expect(lifecycle.view.getSnapshot()).toMatchObject({
      status: 'DEGRADED',
      reason: 'a off',
      offFeatures: ['a', 'b'],
    });
    lifecycle.describe({ reason: 'b off' });
    expect(lifecycle.view.getSnapshot().offFeatures).toEqual(['a', 'b']);
  });
});

describe('DependencyGraph.missing', () => {
  it('returns nothing for an unknown unit', () => {
    expect(new DependencyGraph([]).missing('ghost')).toEqual([]);
  });
});

describe('defineUnit', () => {
  it('returns the definition unchanged', () => {
    const definition = feature('codec');
    expect(defineUnit(definition)).toBe(definition);
  });
});

describe('CorrelationRegistry defaults', () => {
  it('rethrows a callback error asynchronously by default', () => {
    vi.useFakeTimers();
    const registry = new CorrelationRegistry();
    registry.register('c1', {
      onComplete: () => {
        throw new Error('callback bug');
      },
      onError: vi.fn(),
    });
    expect(registry.has('c1')).toBe(true);
    registry.resolve('c1', null);
    expect(registry.has('c1')).toBe(false);
    expect(() => vi.runAllTimers()).toThrow('callback bug');
  });
});

describe('Kernel defaults', () => {
  it('logs errors to the console by default and lists unit ids in boot order', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kernel = new Kernel([
      subsystem('b', { requires: [{ target: 'a' }] }),
      subsystem('a', {
        init: () => {
          throw new Error('init failed');
        },
      }),
    ]);
    expect(kernel.unitIds).toEqual(['a', 'b']);
    await kernel.start();
    expect(error).toHaveBeenCalledWith('[kernel] a:', expect.any(Error));
    expect(() => kernel.unit('ghost')).toThrow('Unknown unit');
  });
});

describe('UnitRuntime error paths', () => {
  it('reports a throwing suspend hook and still suspends', async () => {
    const platform = createTestPlatform([
      subsystem('sync', {
        suspend: () => {
          throw new Error('suspend failed');
        },
      }),
    ]);
    await platform.start();
    await platform.unit('sync').suspend();
    expect(platform.status('sync')).toBe('SUSPENDED');
    expect(platform.errors.map((e) => (e.error as Error).message)).toEqual(['suspend failed']);
  });

  it('fails the unit when its resume hook throws', async () => {
    const platform = createTestPlatform([
      subsystem('sync', {
        resume: () => {
          throw new Error('resume failed');
        },
      }),
    ]);
    await platform.start();
    await platform.unit('sync').suspend();
    await platform.unit('sync').resume();
    expect(platform.unit('sync').lifecycle.getSnapshot()).toMatchObject({
      status: 'FAILED',
      reason: 'resume failed',
    });
  });

  it('reports a failing persistence save and still destroys the unit', async () => {
    const platform = createTestPlatform([subsystem('prefs')], {
      persistence: {
        load: () => undefined,
        save: () => {
          throw new Error('quota exceeded');
        },
      },
    });
    await platform.start();
    await platform.stop();
    expect(platform.status('prefs')).toBe('DESTROYED');
    expect(platform.errors.map((e) => (e.error as Error).message)).toEqual(['quota exceeded']);
  });

  it('updates the off features when a second feature fails while already DEGRADED', async () => {
    const fails: Record<string, (error: unknown) => void> = {};
    const capture = (id: string) =>
      feature(id, {
        init: (ctx) => {
          fails[id] = ctx.fail;
        },
      });
    const platform = createTestPlatform([
      subsystem('storage', { features: [capture('a'), capture('b')] }),
    ]);
    await platform.start();

    fails.a(new Error('a down'));
    await platform.settle();
    expect(platform.unit('storage').lifecycle.getSnapshot().offFeatures).toEqual(['a']);

    fails.b(new Error('b down'));
    await platform.settle();
    expect(platform.unit('storage').lifecycle.getSnapshot()).toMatchObject({
      status: 'DEGRADED',
      offFeatures: ['a', 'b'],
    });
  });

  it('ignores fail() on a unit that is not running', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const platform = createTestPlatform([
      subsystem('sync', {
        init: (ctx) => {
          fail = ctx.fail;
        },
      }),
    ]);
    await platform.start();
    await platform.stop();
    fail!(new Error('late'));
    await platform.settle();
    expect(platform.status('sync')).toBe('DESTROYED');
  });
});
