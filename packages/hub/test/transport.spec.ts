import {
  Kernel,
  NO_CONTROL,
  type PacketPort,
  type Scheduler,
  type SubsystemDefinition,
} from '@platform/core';
import { createNotificationCenter } from '@platform/notification';
import { createQueue, type QueueControl } from '@platform/queue';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WINDOW_TRANSPORT_ID,
  channelLink,
  createWindowTransport,
  readPartitionId,
  type WindowClientOptions,
  type WindowTransportControl,
} from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

/** One tab: the centralized subsystems, the Window transport, and a window-scoped 'prefs'. */
async function tab(name: string, transport: WindowClientOptions, withQueue = true) {
  let port: PacketPort | undefined;
  const heard: unknown[] = [];
  const prefs: SubsystemDefinition = {
    id: 'prefs',
    scope: 'window',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: ['prefs:changed'],
    init: (ctx) => void (port = ctx.port),
    receive: (packet) => void heard.push(packet.take()),
    control: () => NO_CONTROL,
  };
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  let n = 0;
  const kernel = new Kernel(
    [
      ...(withQueue ? [queue.subsystem] : []),
      notification.subsystem,
      createWindowTransport({ channel: 'test-window', ...transport }),
      prefs,
    ],
    { router: queue.router, ids: () => `${name}-${++n}` },
  );
  kernels.push(kernel);
  await kernel.start();
  const transportControl = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
  await vi.waitFor(() =>
    expect(transportControl.views.state.getSnapshot().connection).toBe('connected'),
  );
  return { kernel, port: port!, heard, transport: transportControl };
}

describe('Window transport', () => {
  it('carries a Window broadcast to the same subsystem in another tab, once', async () => {
    const a = await tab('a', { origin: 'https://app.test' });
    const b = await tab('b', { origin: 'https://app.test' });
    expect(a.transport.views.state.getSnapshot()).toMatchObject({
      mode: 'single-origin',
      reach: 'site',
    });

    await a.port.send({ eventId: 'prefs:changed', payload: { theme: 'dark' } });
    await vi.waitFor(() => expect(b.heard).toEqual([{ theme: 'dark' }]));
    expect(a.heard).toEqual([]); // not to itself
    expect(a.transport.views.state.getSnapshot().sent).toBe(1);
    expect(b.transport.views.state.getSnapshot().received).toBe(1);

    const queueB = b.kernel.unit<QueueControl>('queue').control!;
    const [settled] = queueB.views.trails.getSnapshot();
    expect(settled).toMatchObject({ outcome: 'completed', source: 'prefs', target: null });
    expect(settled.trail.entries[0].actionName).toBe('ingested');
  });

  it('counts what arrives while there is no Queue, and reconnects on command', async () => {
    const a = await tab('a', { origin: 'https://app.test' });
    const b = await tab('b', { origin: 'https://app.test' }, false);
    await a.port.send({ eventId: 'prefs:changed', payload: 1 });
    await vi.waitFor(() => expect(b.transport.views.state.getSnapshot().dropped).toBe(1));
    await b.transport.commands.reconnect();
    expect(b.transport.views.state.getSnapshot().connection).toBe('connected');
  });

  it('reads the partition id in direct mode', async () => {
    const factory = new IDBFactory();
    const link = channelLink({ channel: 'test-direct', partition: () => readPartitionId(factory) });
    const { partitionId } = await link.open(() => {});
    expect(partitionId).toBe(await readPartitionId(factory));
    link.close();
  });
});
