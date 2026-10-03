import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HostFailureError,
  ProcessorRunner,
  ProcessorStartError,
  RemoteError,
  RpcClosedError,
  RpcEndpoint,
  RpcTimeoutError,
  VirtualHost,
  WorkerBudget,
  WorkerHost,
  createScheduler,
  defineProcessor,
  validateProcessorDef,
  type Host,
  type HostKind,
  type PortLike,
  type ProcessorDef,
} from '../src';
import { createTestPlatform } from '../src/testing';

import { FakeSharedWorker, FakeWorker } from './fixtures/fake-workers';

/** The processor every test runs: doubles numbers, posts on request, yields when asked. */
const doubler = defineProcessor<number | 'post' | 'boom', number | string>({
  async handle(message, scope) {
    if (message === 'post') {
      scope.post({ from: scope.host });
      return 'posted';
    }
    if (message === 'boom') throw new TypeError('bad input');
    if (scope.shouldYield()) await scope.yield();
    return message * 2;
  },
});

const scheduler = createScheduler();

function def(overrides: Partial<ProcessorDef<number, number>> = {}): ProcessorDef<number, number> {
  return {
    id: 'doubler',
    job: 'sink',
    hosts: ['virtual'],
    load: async () => doubler as never,
    ...overrides,
  };
}

const channel = () => {
  const { port1, port2 } = new MessageChannel();
  return [
    new RpcEndpoint(port1 as unknown as PortLike),
    new RpcEndpoint(port2 as unknown as PortLike),
  ];
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RpcEndpoint', () => {
  it('answers requests, carries notes and reports remote errors', async () => {
    const [a, b] = channel();
    b.handle('add', (data) => (data as number[])[0] + (data as number[])[1]);
    b.handle('fail', () => {
      throw new TypeError('nope');
    });
    const notes: unknown[] = [];
    b.onNote('hi', (data) => notes.push(data));

    await expect(a.request('add', [1, 2])).resolves.toBe(3);
    const failure = await a.request('fail').catch((e) => e);
    expect(failure).toBeInstanceOf(RemoteError);
    expect(failure).toMatchObject({ name: 'TypeError', message: 'nope' });
    await expect(a.request('missing')).rejects.toThrow('No handler for "missing"');

    a.notify('hi', 1);
    await a.request('add', [0, 0]); // flush
    expect(notes).toEqual([1]);
    a.close();
    b.close();
  });

  it('times out, rejects pending requests on close and refuses requests once closed', async () => {
    const [a, b] = channel();
    b.handle('silent', () => new Promise(() => {})); // never replies
    await expect(a.request('silent', null, { timeoutMs: 10 })).rejects.toThrow(RpcTimeoutError);

    const pending = a.request('silent');
    a.close();
    await expect(pending).rejects.toThrow(RpcClosedError);
    await expect(a.request('x')).rejects.toThrow(RpcClosedError);
    expect(a.closed).toBe(true);
    b.close();
  });

  it('ignores messages that are not part of the protocol', async () => {
    const { port1, port2 } = new MessageChannel();
    const a = new RpcEndpoint(port1 as unknown as PortLike);
    const b = new RpcEndpoint(port2 as unknown as PortLike);
    b.handle('ok', () => 'ok');
    port1.postMessage({ unrelated: true });
    await expect(a.request('ok')).resolves.toBe('ok');
    a.close();
    b.close();
  });
});

describe('createScheduler', () => {
  it('prefers scheduler.postTask and scheduler.yield', async () => {
    const postTask = vi.fn((task: () => unknown) => Promise.resolve(task()));
    const yieldFn = vi.fn(() => Promise.resolve());
    const s = createScheduler({
      scheduler: { postTask: postTask as never, yield: yieldFn },
      setTimeout,
    });
    expect(s.kind).toBe('postTask');
    await expect(s.postTask(() => 1, 'background')).resolves.toBe(1);
    await s.yield();
    expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: 'background' });
    expect(yieldFn).toHaveBeenCalled();
  });

  it('falls back to a MessageChannel macrotask, then to setTimeout', async () => {
    const viaChannel = createScheduler({ MessageChannel, setTimeout });
    expect(viaChannel.kind).toBe('message-channel');
    await expect(viaChannel.postTask(() => 'a')).resolves.toBe('a');

    const viaTimeout = createScheduler({ setTimeout });
    expect(viaTimeout.kind).toBe('timeout');
    await expect(viaTimeout.postTask(() => 'b')).resolves.toBe('b');
    await expect(viaTimeout.yield()).resolves.toBeUndefined();
  });

  it('runs a task after the current one, never inside it', async () => {
    const order: string[] = [];
    const s = createScheduler({ MessageChannel, setTimeout });
    const done = s.postTask(() => order.push('task'));
    order.push('sync');
    await Promise.resolve();
    order.push('microtask');
    await done;
    expect(order).toEqual(['sync', 'microtask', 'task']);
  });

  it('keeps a Node process alive only while tasks wait (port ref and unref)', async () => {
    const calls: string[] = [];
    class TrackedChannel extends MessageChannel {
      constructor() {
        super();
        const port = this.port1 as MessagePort & { ref(): void; unref(): void };
        const { ref, unref } = port;
        port.ref = () => void (calls.push('ref'), ref.call(port));
        port.unref = () => void (calls.push('unref'), unref.call(port));
      }
    }
    const s = createScheduler({ MessageChannel: TrackedChannel, setTimeout });
    expect(calls.at(-1)).toBe('unref'); // idle: does not hold the process
    calls.length = 0;
    await Promise.all([s.postTask(() => 1), s.postTask(() => 2)]);
    expect(calls).toEqual(['ref', 'unref']); // held while the two tasks waited, then released
  });

  it('uses requestIdleCallback for idle work when present, and propagates errors', async () => {
    const requestIdleCallback = vi.fn((callback: () => void) => setTimeout(callback, 0));
    const s = createScheduler({ requestIdleCallback, setTimeout });
    await expect(s.idle(() => 'idle')).resolves.toBe('idle');
    expect(requestIdleCallback).toHaveBeenCalled();
    await expect(
      s.postTask(() => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');
    await expect(createScheduler({ setTimeout }).idle(() => 'bg')).resolves.toBe('bg');
  });
});

describe('WorkerBudget', () => {
  it('sizes itself from the core count', () => {
    expect(WorkerBudget.forDevice(4, 8).limit).toBe(4);
    expect(WorkerBudget.forDevice(4, 2).limit).toBe(1);
    expect(WorkerBudget.forDevice(4, 1).limit).toBe(1);
    expect(() => new WorkerBudget(0)).toThrow(RangeError);
  });

  it('counts a shared worker once per key and frees slots on release', () => {
    const budget = new WorkerBudget(2);
    const a = budget.tryAcquire('shared', 'storage')!;
    const b = budget.tryAcquire('shared', 'storage')!;
    const c = budget.tryAcquire('dedicated', 'sync')!;
    expect(budget.used).toBe(2);
    expect(budget.tryAcquire('dedicated', 'other')).toBeNull();
    a();
    a(); // releasing twice is harmless
    expect(budget.used).toBe(2);
    b();
    expect(budget.used).toBe(1);
    c();
    expect(budget.used).toBe(0);
  });
});

describe('validateProcessorDef', () => {
  it('requires a virtual fallback last, unique hosts and worker factories', () => {
    expect(() => validateProcessorDef(def({ hosts: [] }))).toThrow("must end with 'virtual'");
    expect(() => validateProcessorDef(def({ hosts: ['virtual', 'dedicated'] }))).toThrow(
      "must end with 'virtual'",
    );
    expect(() => validateProcessorDef(def({ hosts: ['virtual', 'virtual'] }))).toThrow('twice');
    expect(() => validateProcessorDef(def({ hosts: ['shared', 'virtual'] }))).toThrow(
      "needs a 'shared' worker factory",
    );
  });
});

describe('VirtualHost', () => {
  it('runs the module as main-thread tasks and forwards posts', async () => {
    const host = new VirtualHost(async () => doubler, scheduler, 5);
    const posts: unknown[] = [];
    host.onPost((m) => posts.push(m));
    await expect(host.call(2)).rejects.toThrow('not started');
    await host.start();
    await expect(host.call(21)).resolves.toBe(42);
    await expect(host.call('post')).resolves.toBe('posted');
    await expect(host.call('boom')).rejects.toThrow(TypeError);
    expect(posts).toEqual([{ from: 'virtual' }]);
    await host.stop();
  });

  it('yields once the slice budget is used up', async () => {
    const yieldSpy = vi.fn(() => Promise.resolve());
    const host = new VirtualHost(
      async () => doubler,
      { ...scheduler, yield: yieldSpy, postTask: (task) => Promise.resolve(task()) },
      0,
    );
    await host.start();
    await expect(host.call(1)).resolves.toBe(2);
    expect(yieldSpy).toHaveBeenCalled();
  });
});

describe('WorkerHost — failover triggers', () => {
  const dedicated = (worker: () => FakeWorker, extra: object = {}) =>
    new WorkerHost<number | 'post', unknown>('dedicated', worker as never, {
      processorId: 'doubler',
      handshakeTimeoutMs: 50,
      ...extra,
    });

  it('runs calls in the worker and forwards posts', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const host = dedicated(() => new FakeWorker({ module: doubler as never }));
    const posts: unknown[] = [];
    host.onPost((m) => posts.push(m));
    await host.start();
    await expect(host.call(4)).resolves.toBe(8);
    await expect(host.call('post')).resolves.toBe('posted');
    await vi.waitFor(() => expect(posts).toEqual([{ from: 'dedicated' }]));
    await host.stop();
  });

  it('1. unavailable: the worker type is missing, or the factory throws', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(dedicated(() => new FakeWorker()).start()).rejects.toMatchObject({
      trigger: 'unavailable',
    });

    vi.stubGlobal('Worker', FakeWorker);
    const throwing = dedicated(() => {
      throw new Error('CSP blocked the worker');
    });
    await expect(throwing.start()).rejects.toMatchObject({ trigger: 'unavailable' });
  });

  it('2. error: a worker error fails the host, rejects pending calls and terminates it', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    let worker!: FakeWorker;
    const slow = defineProcessor<number, number>({ handle: () => new Promise(() => {}) });
    const host = dedicated(() => (worker = new FakeWorker({ module: slow as never })));
    const failures: HostFailureError[] = [];
    host.onFailure((f) => failures.push(f));
    await host.start();

    const pending = host.call(1);
    worker.crash('out of memory');
    await expect(pending).rejects.toMatchObject({ trigger: 'error' });
    expect(failures.map((f) => f.trigger)).toEqual(['error']);
    expect(worker.terminated).toBe(true);
    await expect(host.call(2)).rejects.toBeInstanceOf(HostFailureError);
  });

  it('2. error: during the handshake', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const host = dedicated(() => {
      const worker = new FakeWorker(); // never serves
      setTimeout(() => worker.crash('syntax error in worker'), 0);
      return worker;
    });
    await expect(host.start()).rejects.toMatchObject({ trigger: 'error' });
  });

  it('3. handshake-timeout: the worker never answers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    let worker!: FakeWorker;
    const host = dedicated(() => (worker = new FakeWorker()));
    await expect(host.start()).rejects.toMatchObject({ trigger: 'handshake-timeout' });
    expect(worker.terminated).toBe(true);
  });

  it('4. heartbeat-missed: pings stop being answered', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const host = dedicated(() => new FakeWorker({ module: doubler as never, dropPings: true }), {
      heartbeat: { intervalMs: 10, timeoutMs: 20 },
    });
    const failure = new Promise<HostFailureError>((resolve) => host.onFailure(resolve));
    await host.start();
    await expect(failure).resolves.toMatchObject({ trigger: 'heartbeat-missed' });
  });

  it('shared hosts serve through the worker port and beat by default', async () => {
    vi.stubGlobal('SharedWorker', FakeSharedWorker);
    let worker!: FakeSharedWorker;
    const host = new WorkerHost<number, number>(
      'shared',
      () => (worker = new FakeSharedWorker({ module: doubler as never })) as never,
      { processorId: 'doubler', heartbeat: { intervalMs: 10, timeoutMs: 50 } },
    );
    await host.start();
    await expect(host.call(5)).resolves.toBe(10);
    await new Promise((r) => setTimeout(r, 40)); // a few healthy heartbeats
    await expect(host.call(6)).resolves.toBe(12);

    const failure = new Promise<HostFailureError>((resolve) => host.onFailure(resolve));
    worker.crash();
    await expect(failure).resolves.toMatchObject({ host: 'shared', trigger: 'error' });
  });
});

/** A scripted host for supervisor tests. */
function scriptedHost(kind: HostKind, script: { failStart?: boolean; failCalls?: boolean }) {
  let fail: ((e: HostFailureError) => void) | undefined;
  const host: Host<number, string> & { failNow(): void; stopped: boolean } = {
    kind,
    stopped: false,
    start: async () => {
      if (script.failStart) throw new HostFailureError(kind, 'unavailable', 'scripted');
    },
    call: async (n) => {
      if (script.failCalls) throw new HostFailureError(kind, 'error', 'scripted');
      return `${kind}:${n}`;
    },
    onPost: () => () => {},
    onFailure: (listener) => {
      fail = listener;
      return () => {
        fail = undefined;
      };
    },
    stop: async () => {
      host.stopped = true;
    },
    failNow: () => fail?.(new HostFailureError(kind, 'heartbeat-missed', 'scripted')),
  };
  return host;
}

describe('ProcessorRunner — hybrid failover', () => {
  const fullDef: ProcessorDef<number, string> = {
    id: 'p',
    job: 'sink',
    hosts: ['shared', 'dedicated', 'virtual'],
    load: async () => ({ handle: (n: number) => `virtual:${n}` }),
    shared: () => ({}) as SharedWorker,
    dedicated: () => ({}) as Worker,
  };

  const runner = (
    scripts: Partial<Record<HostKind, { failStart?: boolean; failCalls?: boolean }>>,
    budget = new WorkerBudget(4),
  ) => {
    const hosts: Partial<Record<HostKind, ReturnType<typeof scriptedHost>>> = {};
    const r = new ProcessorRunner(fullDef, {
      budget,
      createHost: ((kind: HostKind) =>
        (hosts[kind] = scriptedHost(kind, scripts[kind] ?? {}))) as never,
    });
    return { r, hosts };
  };

  it('starts on the first host that works and records the skipped ones', async () => {
    const { r } = runner({ shared: { failStart: true } });
    await r.start();
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'dedicated',
      failovers: [{ host: 'shared', trigger: 'unavailable' }],
    });
    await expect(r.call(1)).resolves.toBe('dedicated:1');
  });

  it('re-runs a failed call on the next host', async () => {
    const { r, hosts } = runner({ shared: { failCalls: true } });
    await r.start();
    await expect(r.call(7)).resolves.toBe('dedicated:7');
    expect(r.status.getSnapshot().host).toBe('dedicated');
    expect(hosts.shared!.stopped).toBe(false); // a failed host is dropped, not stopped
  });

  it('switches hosts when the running host reports a failure', async () => {
    const { r, hosts } = runner({});
    await r.start();
    hosts.shared!.failNow();
    await vi.waitFor(() => expect(r.status.getSnapshot().host).toBe('dedicated'));
    expect(r.status.getSnapshot().failovers).toMatchObject([
      { host: 'shared', trigger: 'heartbeat-missed' },
    ]);
  });

  it('skips physical hosts over the worker budget', async () => {
    const budget = new WorkerBudget(1);
    budget.tryAcquire('dedicated', 'someone-else');
    const { r } = runner({}, budget);
    await r.start();
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'virtual',
      failovers: [
        { host: 'shared', trigger: 'budget' },
        { host: 'dedicated', trigger: 'budget' },
      ],
    });
  });

  it('releases its budget slot on stop, and on failover', async () => {
    const budget = new WorkerBudget(4);
    const { r, hosts } = runner({}, budget);
    await r.start();
    expect(budget.used).toBe(1);
    hosts.shared!.failNow();
    await vi.waitFor(() => expect(r.status.getSnapshot().host).toBe('dedicated'));
    expect(budget.used).toBe(1);
    await r.stop();
    expect(budget.used).toBe(0);
    expect(r.status.getSnapshot().host).toBeNull();
    await expect(r.call(1)).rejects.toThrow('not running');
  });

  it('throws when no host can start, and propagates ordinary errors', async () => {
    const { r } = runner({
      shared: { failStart: true },
      dedicated: { failStart: true },
      virtual: { failStart: true },
    });
    await expect(r.start()).rejects.toThrow(ProcessorStartError);

    const failing = new ProcessorRunner<number, number>({
      ...def(),
      load: async () => ({
        handle: () => {
          throw new RangeError('invalid');
        },
      }),
    });
    await failing.start();
    await expect(failing.call(1)).rejects.toThrow(RangeError);
  });
});

describe('Kernel — processors', () => {
  it('starts processors before init and exposes them through the context', async () => {
    let result: Promise<unknown> | undefined;
    const platform = createTestPlatform([
      {
        id: 'math',
        scope: 'tab',
        kind: 'featurized',
        state: { initial: {} },
        processors: [def()],
        init: (ctx) => {
          result = ctx.processor<number, number>('doubler').call(5);
          expect(() => ctx.processor('nope')).toThrow('No processor "nope"');
        },
        control: () => ({ commands: {}, views: {} }),
      },
    ]);
    await platform.start();
    await expect(result).resolves.toBe(10);
    await platform.stop();
  });

  it('fails the unit when a processor cannot start, and rejects invalid definitions early', async () => {
    const platform = createTestPlatform([
      {
        id: 'math',
        scope: 'tab',
        kind: 'featurized',
        state: { initial: {} },
        processors: [
          def({
            load: async () => {
              throw new Error('module not found');
            },
          }),
        ],
        control: () => ({ commands: {}, views: {} }),
      },
    ]);
    await platform.start();
    expect(platform.status('math')).toBe('FAILED');

    const invalid = {
      id: 'math',
      scope: 'tab' as const,
      kind: 'featurized' as const,
      state: { initial: {} },
      control: () => ({ commands: {}, views: {} }),
    };
    expect(() =>
      createTestPlatform([{ ...invalid, processors: [def({ hosts: ['dedicated'] })] }]),
    ).toThrow("must end with 'virtual'");
    expect(() => createTestPlatform([{ ...invalid, processors: [def(), def()] }])).toThrow(
      'Processor ids must be unique',
    );
  });
});
