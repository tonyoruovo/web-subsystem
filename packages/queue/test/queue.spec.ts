import {
  Kernel,
  NO_CONTROL,
  PacketExpiredError,
  UnitUnavailableError,
  createEnvelope,
  type PacketPort,
  type Scheduler,
  type SubsystemDefinition,
} from '@platform/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';
import {
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
} from '@platform/notification';
import { describe, expect, it, vi } from 'vitest';

import {
  QUEUE_ID,
  QueueRejectedError,
  createQueue,
  type DeadLetter,
  type QueueControl,
  type QueueOptions,
} from '../src';

/** Runs tasks in a microtask: fast and ordered. */
const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const actions = (trail: { entries: readonly { actionName: string; subsystemId: string }[] }) =>
  trail.entries.map((e) => `${e.actionName}:${e.subsystemId}`);

interface Setup {
  readonly options?: QueueOptions;
  readonly extra?: SubsystemDefinition[];
  readonly echo?: Partial<SubsystemDefinition>;
  readonly now?: () => number;
}

async function setup({ options = {}, extra = [], echo = {}, now }: Setup = {}) {
  let port: PacketPort | undefined;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const received: string[] = [];
  let ids = 0;

  const app: SubsystemDefinition = {
    id: 'app',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    init: (ctx) => {
      port = ctx.port;
    },
    control: () => NO_CONTROL,
  };
  const target: SubsystemDefinition = {
    id: 'echo',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: ['news'],
    receive: async (packet) => {
      received.push(packet.header.eventId);
      if (packet.header.eventId === 'block') await gate;
      return { echoed: packet.take() };
    },
    control: () => NO_CONTROL,
    ...echo,
  };

  const queue = createQueue({
    scheduler,
    retryBaseMs: 1,
    retryStrategy: 'exponential',
    ...(now ? { now } : {}),
    ...options,
  });
  const errors: unknown[] = [];
  const kernel = new Kernel([queue.subsystem, ...extra, app, target], {
    router: queue.router,
    ids: () => `id-${++ids}`,
    onError: (error) => errors.push(error),
    ...(now ? { now } : {}),
  });
  await kernel.start();
  const control = kernel.unit<QueueControl>(QUEUE_ID).control!;
  return { kernel, queue, control, port: port!, received, release, errors };
}

describe('requests', () => {
  it('delivers a request, resolves with the reply, and records the full trail', async () => {
    const { port, control } = await setup();
    const reply = await port.request({ eventId: 'ping', payload: { n: 1 }, target: 'echo' });
    expect(reply).toEqual({ echoed: { n: 1 } });

    const [settled] = control.views.trails.getSnapshot();
    expect(settled).toMatchObject({ outcome: 'completed', source: 'app', target: 'echo' });
    expect(actions(settled.trail)).toEqual([
      'sent:app',
      'enqueued:queue',
      'dispatched:queue',
      'delivered:echo',
      'completed:queue',
    ]);
    expect(control.views.state.getSnapshot()).toMatchObject({
      depth: 0,
      inFlight: 0,
      completed: 1,
    });
  });

  it('dispatches by tier, FIFO within a tier, and one at a time per ordering key', async () => {
    const { port, received, release } = await setup({ options: { maxActive: 1 } });
    const blocked = port.send({ eventId: 'block', payload: null, target: 'echo' });
    const sends = [
      port.send({ eventId: 'low', payload: null, target: 'echo', importance: 'LOW' }),
      port.send({ eventId: 'medium-1', payload: null, target: 'echo' }),
      port.send({ eventId: 'high', payload: null, target: 'echo', importance: 'HIGH' }),
      port.send({ eventId: 'medium-2', payload: null, target: 'echo' }),
    ];
    await vi.waitFor(() => expect(received).toEqual(['block']));
    release();
    await Promise.all([blocked, ...sends]);
    expect(received).toEqual(['block', 'high', 'medium-1', 'medium-2', 'low']);
  });

  it('keeps packets sharing an ordering key in order, even across tiers', async () => {
    const { port, received, release } = await setup();
    const first = port.send({ eventId: 'block', payload: null, target: 'echo', orderingKey: 'k' });
    const second = port.send({
      eventId: 'after',
      payload: null,
      target: 'echo',
      orderingKey: 'k',
      importance: 'HIGH',
    });
    const other = port.send({ eventId: 'other', payload: null, target: 'echo' });
    await other;
    expect(received).toEqual(['block', 'other']);
    release();
    await Promise.all([first, second]);
    expect(received).toEqual(['block', 'other', 'after']);
  });

  it('fails without retrying when the target throws', async () => {
    const receive = vi.fn(() => {
      throw new Error('bad input');
    });
    const { port, control } = await setup({ echo: { receive } });
    await expect(port.request({ eventId: 'x', payload: null, target: 'echo' })).rejects.toThrow(
      'bad input',
    );
    expect(receive).toHaveBeenCalledTimes(1);
    const [settled] = control.views.trails.getSnapshot();
    expect(settled).toMatchObject({ outcome: 'failed', reason: 'bad input' });
    expect(settled.trail.entries.at(-2)?.actionName).toBe('delivered');
    expect(settled.trail.entries.at(-1)).toMatchObject({ actionName: 'failed', level: 'ERROR' });
    expect(control.views.state.getSnapshot().failed).toBe(1);
  });

  it('fails at once for an unknown target', async () => {
    const { port, control } = await setup();
    await expect(port.send({ eventId: 'x', payload: null, target: 'nobody' })).rejects.toThrow(
      UnitUnavailableError,
    );
    expect(control.views.state.getSnapshot()).toMatchObject({ failed: 1, retrying: 0 });
  });
});

describe('observe', () => {
  it('pushes every settled packet, beyond the trails view, and reports a throwing observer', async () => {
    const { port, control, errors } = await setup({ options: { trailHistory: 1 } });
    const seen: string[] = [];
    const stop = control.commands.observe((settled) => void seen.push(settled.eventId));
    control.commands.observe(() => {
      throw new Error('observer bug');
    });
    await port.send({ eventId: 'a', payload: null, target: 'echo' });
    await port.send({ eventId: 'b', payload: null, target: 'echo' });
    stop();
    await port.send({ eventId: 'c', payload: null, target: 'echo' });
    expect(seen).toEqual(['a', 'b']);
    expect(control.views.trails.getSnapshot().map((p) => p.eventId)).toEqual(['c']);
    expect(errors).toHaveLength(3);
  });
});

describe('ingest', () => {
  const remote = (
    messageId: string,
    scope: 'window' | 'tab' = 'window',
    target: string | null = null,
  ) =>
    createEnvelope(
      { eventId: 'news', payload: { n: 1 }, ...(target ? { target } : {}) },
      { source: 'echo', scope, ids: () => messageId },
    );

  it('fans out a broadcast from another tab once, on a new span of the same trace', async () => {
    const { control, received } = await setup({ options: { ids: () => 'span-local' } });
    const envelope = remote('m-1');
    await expect(control.commands.ingest(envelope)).resolves.toBe(true);
    await expect(control.commands.ingest(envelope)).resolves.toBe(false);

    expect(received).toEqual(['news']); // the local 'echo' hears the remote 'echo'
    const [settled] = control.views.trails.getSnapshot();
    expect(settled).toMatchObject({ outcome: 'completed', traceId: envelope.metadata.traceId });
    expect(actions(settled.trail)).toEqual([
      'ingested:queue',
      'dispatched:queue',
      'completed:queue',
    ]);
    expect(control.views.state.getSnapshot()).toMatchObject({ completed: 1, duplicates: 1 });
  });

  it('refuses requests and Tab broadcasts from other tabs, and anything once stopped', async () => {
    const { kernel, control } = await setup();
    await expect(control.commands.ingest(remote('m-2', 'tab'))).rejects.toMatchObject({
      reason: 'scope',
    });
    await expect(control.commands.ingest(remote('m-3', 'window', 'echo'))).rejects.toMatchObject({
      reason: 'scope',
    });
    await kernel.unit(QUEUE_ID).suspend();
    const stopping = kernel.stop();
    await stopping;
    await expect(control.commands.ingest(remote('m-4'))).rejects.toMatchObject({
      reason: 'stopped',
    });
  });

  it('passes remote: true to the fan-out', async () => {
    const fanOut = vi.fn(async () => {});
    const { control } = await setup({ options: { fanOut } });
    await control.commands.ingest(remote('m-5'));
    expect(fanOut).toHaveBeenCalledWith(expect.anything(), expect.anything(), { remote: true });
  });
});

describe('retries and dead letters', () => {
  it('retries while the target is suspended, then delivers', async () => {
    const { kernel, port, control } = await setup({ options: { retryBaseMs: 50 } });
    await kernel.unit('echo').suspend();
    const reply = port.request({ eventId: 'ping', payload: 1, target: 'echo' });
    await vi.waitFor(() => expect(control.views.state.getSnapshot().retrying).toBe(1));
    await kernel.unit('echo').resume();
    await expect(reply).resolves.toEqual({ echoed: 1 });

    const trail = control.views.trails.getSnapshot()[0].trail;
    const retry = trail.entries.find((e) => e.actionName === 'retry-scheduled');
    expect(retry).toMatchObject({ level: 'WARN', counter: 1 });
    expect(trail.entries.at(-1)?.actionName).toBe('completed');
  });

  it('dead-letters after the last retry, writes the sink, and replays', async () => {
    const { kernel, port, control } = await setup({ options: { maxRetries: 2 } });
    const early: DeadLetter[] = [];
    await kernel.unit('echo').suspend();

    await expect(port.send({ eventId: 'ping', payload: 1, target: 'echo' })).rejects.toThrow(
      UnitUnavailableError,
    );
    const [letter] = control.views.deadLetters.getSnapshot();
    expect(letter).toMatchObject({ reason: 'undeliverable', attempts: 3 });
    expect(letter.envelope.fingerprints.entries.at(-1)?.actionName).toBe('dead-lettered');
    expect(control.views.state.getSnapshot().deadLetters).toBe(1);

    await control.commands.bindDeadLetterSink((l) => void early.push(l));
    expect(early).toHaveLength(1);

    await kernel.unit('echo').resume();
    expect(control.commands.replay('missing')).toBe(false);
    expect(control.commands.replay(letter.envelope.metadata.messageId)).toBe(true);
    await vi.waitFor(() =>
      expect(control.views.trails.getSnapshot().at(-1)?.outcome).toBe('completed'),
    );
    const replayed = control.views.trails.getSnapshot().at(-1)!;
    expect(replayed.trail.entries.map((e) => e.actionName)).toContain('replayed');
    expect(control.views.deadLetters.getSnapshot()).toEqual([]);
    control.commands.unbindDeadLetterSink();
  });

  it('dead-letters an expired packet', async () => {
    let t = 0;
    const { port, control } = await setup({ now: () => t });
    const sent = port.send({ eventId: 'ping', payload: 1, target: 'echo', ttl: 5 });
    t = 100;
    await expect(sent).rejects.toThrow(PacketExpiredError);
    expect(control.views.deadLetters.getSnapshot()[0]).toMatchObject({ reason: 'expired' });
  });
});

describe('admission', () => {
  it('refuses packets Global State does not admit, and tracks pending work', async () => {
    const globalState = createGlobalState({
      environment: createStaticEnvironment(),
      tabIdentity: false,
      busyThreshold: 1,
    });
    const { kernel, port, control, release } = await setup({ extra: [globalState] });
    const global = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;

    const blocked = port.send({ eventId: 'block', payload: null, target: 'echo' });
    await vi.waitFor(() => expect(global.views.state.getSnapshot().pending).toHaveLength(1));
    global.commands.beginWork({ id: 'upload', subsystemId: 'app', importance: 'LOW' });
    await vi.waitFor(() => expect(global.views.state.getSnapshot().status).toBe('BUSY'));

    await expect(port.send({ eventId: 'x', payload: null, target: 'echo' })).rejects.toMatchObject({
      name: 'QueueRejectedError',
      reason: 'admission',
    });
    await expect(
      port.send({ eventId: 'y', payload: null, target: 'echo', importance: 'CRITICAL' }),
    ).resolves.toBeUndefined();

    release();
    await blocked;
    global.commands.endWork('upload');
    await vi.waitFor(() => expect(global.views.state.getSnapshot().pending).toEqual([]));
    const rejected = control.views.trails.getSnapshot().find((p) => p.outcome === 'rejected')!;
    expect(rejected.trail.entries.at(-1)).toMatchObject({ actionName: 'rejected', level: 'WARN' });
  });

  it('refuses non-critical packets past the depth limit', async () => {
    const { port, control, release } = await setup({ options: { maxActive: 1, maxDepth: 1 } });
    const blocked = port.send({ eventId: 'block', payload: null, target: 'echo' });
    const waiting = port.send({ eventId: 'a', payload: null, target: 'echo' });
    await expect(port.send({ eventId: 'b', payload: null, target: 'echo' })).rejects.toThrow(
      QueueRejectedError,
    );
    const critical = port.send({
      eventId: 'c',
      payload: null,
      target: 'echo',
      importance: 'CRITICAL',
    });
    release();
    await Promise.all([blocked, waiting, critical]);
    expect(control.views.state.getSnapshot()).toMatchObject({ rejected: 1, completed: 3 });
  });

  it('refuses a broadcast outside its sender’s scope', async () => {
    const { kernel, queue } = await setup();
    const envelope = createEnvelope(
      { eventId: 'news', payload: null },
      { source: 'app', scope: 'window' },
    );
    await expect(queue.router(kernel).route(envelope, false)).rejects.toMatchObject({
      reason: 'scope',
    });
  });
});

describe('lifecycle', () => {
  it('holds packets while suspended and dispatches on resume', async () => {
    const { kernel, port, received } = await setup();
    await kernel.unit(QUEUE_ID).suspend();
    const sent = port.send({ eventId: 'held', payload: null, target: 'echo' });
    await Promise.resolve();
    expect(received).toEqual([]);
    await kernel.unit(QUEUE_ID).resume();
    await sent;
    expect(received).toEqual(['held']);
  });

  it('refuses waiting packets when stopped, and new ones afterwards', async () => {
    const { kernel, port, release } = await setup({ options: { maxActive: 1 } });
    const blocked = port.send({ eventId: 'block', payload: null, target: 'echo' });
    const waiting = port.send({ eventId: 'a', payload: null, target: 'echo' });
    await kernel.unit(QUEUE_ID).suspend();
    const stopping = kernel.stop();
    await expect(waiting).rejects.toMatchObject({ reason: 'stopped' });
    release();
    await Promise.allSettled([blocked, stopping]);
    await expect(port.send({ eventId: 'b', payload: null, target: 'echo' })).rejects.toMatchObject({
      reason: 'stopped',
    });
  });
});

describe('broadcasts', () => {
  it('hands broadcasts to the Notification Center, which records every delivery', async () => {
    const notification = createNotificationCenter();
    const { kernel, port, control } = await setup({
      options: { fanOut: notification.fanOut },
      extra: [notification.subsystem],
    });
    const heard = vi.fn();
    kernel
      .unit<NotificationControl>(NOTIFICATION_ID)
      .control!.commands.subscribe('news', heard, { subscriber: 'ui' });

    await port.send({ eventId: 'news', payload: { headline: 'hi' } });

    expect(heard).toHaveBeenCalledWith({ headline: 'hi' }, expect.anything());
    const [record] = kernel
      .unit<NotificationControl>(NOTIFICATION_ID)
      .control!.views.history.getSnapshot();
    expect(actions(record.trail)).toEqual([
      'sent:app',
      'enqueued:queue',
      'dispatched:queue',
      'fanned-out:notification',
      'delivered:notification',
      'delivered:notification',
    ]);
    expect(control.views.trails.getSnapshot()[0]).toMatchObject({
      outcome: 'completed',
      target: null,
    });
  });

  it('uses the kernel’s direct broadcast without a fan-out', async () => {
    const { port, received } = await setup();
    await port.send({ eventId: 'news', payload: null });
    expect(received).toEqual(['news']);
  });
});
