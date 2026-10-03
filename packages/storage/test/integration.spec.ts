/**
 * Late binding (docs/ARCHITECTURE.md §18.2): the Queue keeps its dead letters,
 * and the Logger its entries, in Storage collections, so both survive a reload.
 */
import 'fake-indexeddb/auto';

import {
  Kernel,
  NO_CONTROL,
  type PacketPort,
  type Scheduler,
  type SubsystemDefinition,
} from '@platform/core';
import { LOGGER_ID, createLogger, type LoggerControl } from '@platform/logger';
import { QUEUE_ID, createQueue, type QueueControl } from '@platform/queue';
import { afterEach, describe, expect, it } from 'vitest';

import { STORAGE_ID, createStorage, type StorageControl } from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

/** One page load: Queue, Logger and Storage, plus an app and a target that can be suspended. */
async function session(database: string) {
  let port: PacketPort | undefined;
  const app: SubsystemDefinition = {
    id: 'app',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    init: (ctx) => void (port = ctx.port),
    control: () => NO_CONTROL,
  };
  const target: SubsystemDefinition = {
    id: 'billing',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    receive: () => 'ok',
    control: () => NO_CONTROL,
  };
  const queue = createQueue({ scheduler, maxRetries: 0 });
  const kernel = new Kernel(
    [
      queue.subsystem,
      createLogger({ sessionId: crypto.randomUUID() }),
      createStorage({ domain: 'shop', database, hosts: ['virtual'], keys: null, quota: false }),
      app,
      target,
    ] as SubsystemDefinition[],
    { router: queue.router },
  );
  kernels.push(kernel);
  await kernel.start();
  return {
    kernel,
    port: port!,
    queue: kernel.unit<QueueControl>(QUEUE_ID).control!,
    logger: kernel.unit<LoggerControl>(LOGGER_ID).control!,
    storage: kernel.unit<StorageControl>(STORAGE_ID).control!,
  };
}

describe('Queue and Logger with Storage', () => {
  it('keeps dead letters and log entries across a reload', async () => {
    const database = `integration-${crypto.randomUUID()}`;
    const first = await session(database);
    await first.kernel.unit('billing').suspend();
    await expect(
      first.port.send({ eventId: 'charge', payload: { amount: 30 }, target: 'billing' }),
    ).rejects.toThrow();
    const [letter] = first.queue.views.deadLetters.getSnapshot();
    first.logger.commands.log('ERROR', 'Payment service is down', { subsystemId: 'billing' });

    const deadLetters = first.storage.commands.collection({ name: 'queue.dead-letters' });
    await expect.poll(() => deadLetters.count()).toBe(1);
    const logEntries = first.storage.commands.collection({ name: 'logger.entries' });
    await expect.poll(() => logEntries.count()).toBeGreaterThan(0);
    await first.kernel.stop();
    kernels.splice(0);

    // The next page load: the letter is back, and it can be replayed.
    const second = await session(database);
    await expect
      .poll(() =>
        second.queue.views.deadLetters.getSnapshot().map((l) => l.envelope.metadata.messageId),
      )
      .toEqual([letter!.envelope.metadata.messageId]);
    const history = await second.logger.commands.history();
    expect(history.map((entry) => entry.message)).toContain('Payment service is down');

    expect(second.queue.commands.replay(letter!.envelope.metadata.messageId)).toBe(true);
    await expect
      .poll(() => second.storage.commands.collection({ name: 'queue.dead-letters' }).count())
      .toBe(0);
  });
});
