import { describe, expect, it, vi } from 'vitest';

import {
  DependencyCycleError,
  Kernel,
  NO_CONTROL,
  PacketExpiredError,
  UnitUnavailableError,
  defineSubsystem,
  type Dependency,
  type SubsystemDefinition,
  type UnitDefinition,
} from '../src';
import { createMemoryPersistence, createTestPlatform } from '../src/testing';

/** A minimal subsystem with optional overrides. */
function subsystem(
  id: string,
  overrides: Partial<SubsystemDefinition> & { requires?: Dependency[] } = {},
): SubsystemDefinition {
  return {
    id,
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    control: () => NO_CONTROL,
    ...overrides,
  };
}

function feature(id: string, overrides: Partial<UnitDefinition> = {}): UnitDefinition {
  return { id, state: { initial: {} }, control: () => NO_CONTROL, ...overrides };
}

describe('Kernel — boot', () => {
  it('starts subsystems in dependency order and makes their control available', async () => {
    const order: string[] = [];
    const counter = defineSubsystem({
      id: 'counter',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: { n: 0 }, policy: { n: { readable: true } } },
      init: () => {
        order.push('counter');
      },
      control: (ctx) => ({
        commands: { increment: () => ctx.state.update((s) => void s.n++) },
        views: { state: ctx.state.readable },
      }),
    });
    const user = subsystem('user', {
      requires: [{ target: 'counter' }],
      init: () => {
        order.push('user');
      },
    });

    const platform = createTestPlatform([user, counter]);
    await platform.start();

    expect(order).toEqual(['counter', 'user']);
    expect(platform.status('counter')).toBe('READY');
    const control = platform.unit<ReturnType<typeof counter.control>>('counter').control!;
    control.commands.increment();
    expect(control.views.state.getSnapshot()).toEqual({ n: 1 });
    expect(platform.kernel.statuses.getSnapshot().user.status).toBe('READY');
  });

  it('rejects a cycle of required dependencies at construction', () => {
    expect(
      () =>
        new Kernel([
          subsystem('a', { requires: [{ target: 'b' }] }),
          subsystem('b', { requires: [{ target: 'a' }] }),
        ]),
    ).toThrow(DependencyCycleError);
  });

  it('rejects duplicate and invalid ids', () => {
    expect(() => new Kernel([subsystem('a'), subsystem('a')])).toThrow('registered twice');
    expect(() => new Kernel([subsystem('a/b')])).toThrow('Invalid unit id');
  });
});

describe('Kernel — dependencies', () => {
  it('keeps a unit waiting while a required dependency is not registered', async () => {
    const platform = createTestPlatform([
      subsystem('analytics', { requires: [{ target: 'consent' }] }),
    ]);
    await platform.start();
    expect(platform.unit('analytics').lifecycle.getSnapshot()).toMatchObject({
      status: 'UNINITIALIZED',
      waitingFor: ['consent'],
    });
  });

  it('starts a unit without its optional dependencies', async () => {
    const platform = createTestPlatform([
      subsystem('analytics', { requires: [{ target: 'storage', kind: 'optional' }] }),
    ]);
    await platform.start();
    expect(platform.status('analytics')).toBe('READY');
  });

  it('starts a waiting unit once its dependency recovers', async () => {
    let fail = true;
    const platform = createTestPlatform([
      subsystem('storage', {
        init: () => {
          if (fail) throw new Error('quota exceeded');
        },
      }),
      subsystem('auth', { requires: [{ target: 'storage' }] }),
    ]);
    await platform.start();
    expect(platform.status('storage')).toBe('FAILED');
    expect(platform.unit('storage').lifecycle.getSnapshot().reason).toBe('quota exceeded');
    expect(platform.unit('auth').lifecycle.getSnapshot().waitingFor).toEqual(['storage']);
    expect(platform.errors).toHaveLength(1);

    fail = false;
    await platform.unit('storage').restart();
    expect(platform.status('storage')).toBe('READY');
    expect(platform.status('auth')).toBe('READY');
  });

  it('suspends dependents when a dependency fails at runtime, and resumes them on recovery', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const suspend = vi.fn();
    const resume = vi.fn();
    const platform = createTestPlatform([
      subsystem('network', {
        init: (ctx) => {
          fail = ctx.fail;
        },
      }),
      subsystem('sync', { requires: [{ target: 'network' }], suspend, resume }),
    ]);
    await platform.start();

    fail!(new Error('offline'));
    await platform.settle();
    expect(platform.status('network')).toBe('FAILED');
    expect(platform.unit('sync').lifecycle.getSnapshot()).toMatchObject({
      status: 'SUSPENDED',
      reason: 'Waiting for network.',
    });
    expect(suspend).toHaveBeenCalledTimes(1);

    await platform.unit('network').restart();
    expect(platform.status('sync')).toBe('READY');
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('only exposes declared dependencies, and only while they run', async () => {
    let lookup: ((target: string) => unknown) | undefined;
    const platform = createTestPlatform([
      subsystem('storage'),
      subsystem('logger'),
      subsystem('auth', {
        requires: [{ target: 'storage' }],
        init: (ctx) => {
          lookup = (target) => ctx.dependency(target);
        },
      }),
    ]);
    await platform.start();
    expect(lookup!('storage')).toBe(NO_CONTROL);
    expect(() => lookup!('logger')).toThrow('not a declared dependency');
  });

  it('follows a late dependency as it starts, stops and restarts (ctx.watch)', async () => {
    const seen: unknown[] = [];
    let watch: ((target: string) => () => void) | undefined;
    const storageControl = () => ({ commands: {}, views: {} });
    const platform = createTestPlatform([
      subsystem('logger', {
        kind: 'centralized',
        requires: [{ target: 'storage', kind: 'optional' }],
        init: (ctx) => {
          watch = (target) => ctx.watch(target, (control) => seen.push(control ?? 'off'));
          ctx.watch('storage', (control) => seen.push(control ? 'on' : 'off'));
        },
      }),
      subsystem('storage', { control: storageControl }),
    ]);
    await platform.start();
    await platform.settle();
    expect(seen).toEqual(['off', 'on']);

    await platform.unit('storage').suspend();
    await platform.settle();
    await platform.unit('storage').resume();
    await platform.settle();
    expect(seen).toEqual(['off', 'on', 'off', 'on']);

    expect(() => watch!('auth')).toThrow('not a declared dependency');
    await platform.stop();
    expect(seen).toHaveLength(4); // stopped following on teardown
  });

  it('reports listener errors and recovered errors without failing the unit', async () => {
    const platform = createTestPlatform([
      subsystem('logger', {
        requires: [{ target: 'storage', kind: 'optional' }],
        init: (ctx) => {
          ctx.watch('storage', () => {
            throw new Error('listener bug');
          });
          ctx.report(new Error('recovered'));
        },
      }),
    ]);
    await platform.start();
    expect(platform.errors.map((e) => [e.unitId, (e.error as Error).message])).toEqual([
      ['logger', 'listener bug'],
      ['logger', 'recovered'],
    ]);
    expect(platform.status('logger')).toBe('READY');
  });
});

describe('Kernel — features', () => {
  it('leaves the parent DEGRADED when a feature fails, and READY once it recovers', async () => {
    let broken = true;
    const platform = createTestPlatform([
      subsystem('storage', {
        features: [
          feature('memory'),
          feature('idb', {
            init: () => {
              if (broken) throw new Error('IndexedDB blocked');
            },
          }),
        ],
      }),
    ]);
    await platform.start();
    expect(platform.unit('storage').lifecycle.getSnapshot()).toMatchObject({
      status: 'DEGRADED',
      offFeatures: ['idb'],
    });
    expect(platform.status('storage/memory')).toBe('READY');
    expect(platform.status('storage/idb')).toBe('FAILED');

    broken = false;
    await platform.unit('storage/idb').restart();
    expect(platform.unit('storage').lifecycle.getSnapshot()).toMatchObject({
      status: 'READY',
      offFeatures: [],
    });
  });

  it('degrades the parent when a running feature fails', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const platform = createTestPlatform([
      subsystem('storage', {
        features: [
          feature('opfs', {
            init: (ctx) => {
              fail = ctx.fail;
            },
          }),
        ],
      }),
    ]);
    await platform.start();
    fail!(new Error('disk full'));
    await platform.settle();
    expect(platform.status('storage')).toBe('DEGRADED');
    expect(platform.status('storage/opfs')).toBe('FAILED');
  });

  it('starts a feature when its own dependency becomes ready', async () => {
    const platform = createTestPlatform([
      subsystem('network', {
        features: [feature('interceptor', { requires: [{ target: 'auth' }] })],
      }),
      subsystem('auth', { requires: [{ target: 'network' }] }),
    ]);
    await platform.start();
    expect(platform.status('auth')).toBe('READY');
    expect(platform.status('network/interceptor')).toBe('READY');
    expect(platform.status('network')).toBe('READY');
  });

  it('lets features reach their siblings, but not subsystems', async () => {
    const seen: unknown[] = [];
    const platform = createTestPlatform([
      subsystem('storage', {
        init: (ctx) => {
          expect(() => ctx.sibling('x')).toThrow('Only features have siblings');
        },
        features: [
          feature('codec', {
            control: () => ({ commands: { encode: (s: string) => s.toUpperCase() }, views: {} }),
          }),
          feature('writer', {
            init: (ctx) => {
              seen.push(ctx.sibling('codec'));
              expect(() => ctx.sibling('missing')).toThrow('not a sibling');
            },
          }),
        ],
      }),
    ]);
    await platform.start();
    expect(seen).toHaveLength(1);
    expect(platform.status('storage')).toBe('READY');
  });

  it('halts features when the parent fails', async () => {
    let fail: ((error: unknown) => void) | undefined;
    const disposed = vi.fn();
    const platform = createTestPlatform([
      subsystem('storage', {
        init: (ctx) => {
          fail = ctx.fail;
        },
        features: [feature('idb', { init: () => disposed })],
      }),
    ]);
    await platform.start();
    fail!(new Error('boom'));
    await platform.settle();
    expect(platform.status('storage/idb')).toBe('FAILED');
    expect(disposed).toHaveBeenCalledTimes(1);

    await platform.unit('storage').restart();
    expect(platform.status('storage')).toBe('READY');
    expect(platform.status('storage/idb')).toBe('READY');
  });
});

describe('Kernel — lifecycle commands', () => {
  it('toggles BUSY and supports suspend/resume', async () => {
    let busy: ((b: boolean) => void) | undefined;
    const platform = createTestPlatform([
      subsystem('sync', {
        init: (ctx) => {
          busy = ctx.busy;
        },
      }),
    ]);
    await platform.start();
    busy!(true);
    expect(platform.status('sync')).toBe('BUSY');
    busy!(false);
    expect(platform.status('sync')).toBe('READY');

    await platform.unit('sync').suspend('page hidden');
    expect(platform.unit('sync').lifecycle.getSnapshot()).toMatchObject({
      status: 'SUSPENDED',
      reason: 'page hidden',
    });
    expect(platform.unit('sync').control).toBeUndefined();
    await platform.unit('sync').resume();
    expect(platform.status('sync')).toBe('READY');
  });

  it('runs disposers in reverse, aborts the signal and refuses to destroy centralized units', async () => {
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const platform = createTestPlatform([
      subsystem('queue', { kind: 'centralized' }),
      subsystem('logger', {
        init: (ctx) => {
          signal = ctx.signal;
          return () => {
            calls.push('logger');
          };
        },
        features: [
          feature('a', { init: () => () => void calls.push('a') }),
          feature('b', { init: () => () => void calls.push('b') }),
        ],
      }),
    ]);
    await platform.start();
    await expect(platform.unit('queue').destroy()).rejects.toThrow('centralized');

    await platform.unit('logger').destroy();
    expect(calls).toEqual(['b', 'a', 'logger']);
    expect(signal!.aborted).toBe(true);
    expect(platform.status('logger')).toBe('DESTROYED');

    await platform.stop();
    expect(platform.status('queue')).toBe('DESTROYED');
  });

  it('reports a throwing disposer without stopping teardown', async () => {
    const platform = createTestPlatform([
      subsystem('logger', {
        init: () => () => {
          throw new Error('flush failed');
        },
      }),
    ]);
    await platform.start();
    await platform.stop();
    expect(platform.status('logger')).toBe('DESTROYED');
    expect(platform.errors.map((e) => (e.error as Error).message)).toEqual(['flush failed']);
  });
});

describe('Kernel — persistence', () => {
  it('restores persisted state on start and saves it on destroy', async () => {
    const persistence = createMemoryPersistence({
      prefs: { version: 1, data: { theme: 'dark' } },
    });
    const prefs = defineSubsystem({
      id: 'prefs',
      scope: 'window',
      kind: 'featurized',
      state: {
        initial: { theme: 'light', session: 'x' },
        policy: { theme: { readable: true, persisted: true } },
      },
      control: (ctx) => ({
        commands: { set: (theme: string) => ctx.state.update((s) => void (s.theme = theme)) },
        views: { state: ctx.state.readable },
      }),
    });
    const platform = createTestPlatform([prefs], { persistence });
    await platform.start();
    const control = platform.unit<ReturnType<typeof prefs.control>>('prefs').control!;
    expect(control.views.state.getSnapshot()).toEqual({ theme: 'dark' });

    control.commands.set('sepia');
    await platform.stop();
    expect(persistence.saved.get('prefs')).toEqual({ version: 1, data: { theme: 'sepia' } });
  });
});

describe('Kernel — packets', () => {
  const echo = subsystem('echo', {
    receive: (packet) => ({ echoed: packet.take() }),
  });

  it('delivers a request and resolves with the reply', async () => {
    let request: ((p: unknown) => Promise<unknown>) | undefined;
    const platform = createTestPlatform([
      echo,
      subsystem('client', {
        init: (ctx) => {
          request = (payload) =>
            ctx.port.request({ eventId: 'echo:ping', payload, target: 'echo' });
        },
      }),
    ]);
    await platform.start();
    await expect(request!({ n: 1 })).resolves.toEqual({ echoed: { n: 1 } });

    const [envelope] = platform.routed;
    expect(envelope.metadata).toMatchObject({ source: 'client', target: 'echo', scope: 'tab' });
    expect(envelope.metadata.correlationId).toBeDefined();
    expect(envelope.fingerprints.entries.map((e) => e.actionName)).toEqual(['sent']);
  });

  it('stamps sends from a feature with its component id, under the parent identity', async () => {
    let send: (() => Promise<void>) | undefined;
    const platform = createTestPlatform([
      subsystem('storage', {
        features: [
          feature('idb', {
            init: (ctx) => {
              send = () => ctx.port.send({ eventId: 'storage:changed', payload: null });
            },
          }),
        ],
      }),
    ]);
    await platform.start();
    await send!();
    const [envelope] = platform.routed;
    expect(envelope.metadata.source).toBe('storage');
    expect(envelope.fingerprints.entries[0]).toMatchObject({
      subsystemId: 'storage',
      componentId: 'idb',
    });
  });

  it('broadcasts to running subscribers only, each with its own copy', async () => {
    const received: { id: string; payload: unknown }[] = [];
    const listener = (id: string, subscribes = ['auth:login']) =>
      subsystem(id, {
        subscribes,
        receive: (packet) => {
          const payload = packet.take() as { user: string };
          received.push({ id, payload: { ...payload } }); // as received
          payload.user = 'mutated'; // must not leak to the next subscriber
        },
      });
    let broadcast: (() => Promise<void>) | undefined;
    const platform = createTestPlatform([
      listener('a'),
      listener('b'),
      listener('c', ['other']),
      subsystem('auth', {
        subscribes: ['auth:login'],
        receive: () => {
          throw new Error('the sender must not receive its own broadcast');
        },
        init: (ctx) => {
          broadcast = () => ctx.port.send({ eventId: 'auth:login', payload: { user: 'ada' } });
        },
      }),
    ]);
    await platform.start();
    await broadcast!();
    // Each subscriber got its own copy: a's mutation did not reach b.
    expect(received).toEqual([
      { id: 'a', payload: { user: 'ada' } },
      { id: 'b', payload: { user: 'ada' } },
    ]);
    expect(platform.errors).toEqual([]);
  });

  it('reports a failing subscriber without failing the broadcast', async () => {
    let broadcast: (() => Promise<void>) | undefined;
    const platform = createTestPlatform([
      subsystem('bad', {
        subscribes: ['x'],
        receive: () => {
          throw new Error('handler bug');
        },
      }),
      subsystem('src', {
        init: (ctx) => {
          broadcast = () => ctx.port.send({ eventId: 'x', payload: 1 });
        },
      }),
    ]);
    await platform.start();
    await expect(broadcast!()).resolves.toBeUndefined();
    expect(platform.errors).toMatchObject([{ unitId: 'bad' }]);
  });

  it('rejects requests to unknown, non-running and feature targets, and expired packets', async () => {
    let request: ((target: string, ttl?: number) => Promise<unknown>) | undefined;
    const platform = createTestPlatform([
      echo,
      subsystem('waiting', { requires: [{ target: 'nowhere' }], receive: () => 1 }),
      subsystem('storage', { features: [feature('idb')] }),
      subsystem('client', {
        init: (ctx) => {
          request = (target, ttl) => ctx.port.request({ eventId: 'q', payload: null, target, ttl });
        },
      }),
    ]);
    await platform.start();
    await expect(request!('ghost')).rejects.toThrow(UnitUnavailableError);
    await expect(request!('waiting')).rejects.toThrow('UNINITIALIZED');
    await expect(request!('storage/idb')).rejects.toThrow('features are not addressable');
    await expect(request!('storage')).rejects.toThrow('does not receive packets');

    const originalRoute = platform.kernel.deliver.bind(platform.kernel);
    vi.spyOn(platform.kernel, 'deliver').mockImplementation((envelope) => {
      platform.clock.advance(100);
      return originalRoute(envelope);
    });
    await expect(request!('echo', 50)).rejects.toThrow(PacketExpiredError);
  });

  it('continues the trace when a packet is caused by another', async () => {
    let forward: (() => Promise<unknown>) | undefined;
    const platform = createTestPlatform([
      subsystem('logger', { receive: () => 'logged' }),
      subsystem('storage', {
        receive: (packet, ctx) =>
          ctx.port.request({
            eventId: 'log',
            payload: null,
            target: 'logger',
            causedBy: packet.header,
          }),
      }),
      subsystem('client', {
        init: (ctx) => {
          forward = () => ctx.port.request({ eventId: 'put', payload: null, target: 'storage' });
        },
      }),
    ]);
    await platform.start();
    await expect(forward!()).resolves.toBe('logged');
    const [first, second] = platform.routed;
    expect(second.metadata.traceId).toBe(first.metadata.traceId);
    expect(second.metadata.parentSpanId).toBe(first.metadata.spanId);
  });
});
