import {
  Kernel,
  NO_CONTROL,
  type PacketPort,
  type Scheduler,
  type StatePersistence,
  type SubsystemDefinition,
} from '@platform/core';
import { createMemoryPersistence, createTestPlatform } from '@platform/core/testing';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOGGER_ID,
  createLogger,
  formatEntry,
  type LoggerControl,
  type LoggerOptions,
} from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

let t = 1_000;
const now = () => t;

afterEach(() => {
  t = 1_000;
  vi.restoreAllMocks();
});

/** A logger alone, on the test platform. */
async function alone(options: LoggerOptions = {}, persistence?: StatePersistence) {
  const platform = createTestPlatform([createLogger({ sessionId: 's1', now, ...options })], {
    persistence,
  });
  await platform.start();
  return { platform, logger: platform.unit<LoggerControl>(LOGGER_ID).control! };
}

/** A logger with the Queue, the Notification Center, a sender and a failing target. */
async function wired() {
  let port: PacketPort | undefined;
  let ids = 0;
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const subsystem = (id: string, extra: Partial<SubsystemDefinition>): SubsystemDefinition => ({
    id,
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    control: () => NO_CONTROL,
    ...extra,
  });
  const errors: unknown[] = [];
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createLogger({ sessionId: 's1', now }),
      subsystem('app', { init: (ctx) => void (port = ctx.port) }),
      subsystem('sync', {
        subscribes: ['news'],
        receive: () => {
          throw new Error('HTTP 503');
        },
      }),
    ],
    { router: queue.router, ids: () => `id-${++ids}`, onError: (e) => errors.push(e) },
  );
  await kernel.start();
  return { kernel, port: port!, logger: kernel.unit<LoggerControl>(LOGGER_ID).control!, errors };
}

describe('log', () => {
  it('filters by level, globally and per subsystem, and sanitizes context', async () => {
    const { logger } = await alone();
    expect(logger.commands.log('DEBUG', 'noise')).toBeNull();
    const entry = logger.commands.log('WARN', 'Quota low', {
      subsystemId: 'storage',
      componentId: 'idb',
      context: { used: 90, token: 'abc' },
    });
    expect(entry).toEqual({
      id: 'log-1',
      level: 'WARN',
      message: 'Quota low',
      subsystemId: 'storage',
      componentId: 'idb',
      timestamp: 1_000,
      sessionId: 's1',
      traceId: null,
      context: { used: 90, token: '[REDACTED]' },
    });

    logger.commands.setLevel('DEBUG', 'sync');
    logger.commands.setLevel('ERROR');
    expect(logger.commands.isEnabled('DEBUG', 'sync')).toBe(true);
    expect(logger.commands.isEnabled('WARN')).toBe(false);
    expect(logger.commands.log('DEBUG', 'pulled', { subsystemId: 'sync' })).not.toBeNull();
    logger.commands.resetLevel('sync');
    expect(logger.commands.isEnabled('DEBUG', 'sync')).toBe(false);

    expect(logger.views.state.getSnapshot()).toMatchObject({
      minLevel: 'ERROR',
      levels: {},
      entries: 2,
      sessionId: 's1',
    });
  });

  it('keeps the newest entries and counts the dropped ones', async () => {
    const { logger } = await alone({ maxEntries: 2 });
    for (const message of ['a', 'b', 'c']) logger.commands.log('INFO', message);
    await Promise.resolve();
    expect(logger.views.entries.getSnapshot().map((e) => e.message)).toEqual(['b', 'c']);
    expect(logger.views.state.getSnapshot()).toMatchObject({ entries: 2, dropped: 1 });
  });

  it('mirrors entries at or above a level to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { logger } = await alone({ console: 'WARN' });
    logger.commands.log('INFO', 'quiet');
    logger.commands.log('WARN', 'loud', { subsystemId: 'storage' });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('1970-01-01T00:00:01.000Z WARN  [storage] loud');
  });

  it('keeps the thresholds across restarts', async () => {
    const persistence = createMemoryPersistence();
    const first = await alone({}, persistence);
    first.logger.commands.setLevel('ERROR');
    first.logger.commands.setLevel('DEBUG', 'sync');
    await first.platform.stop();

    const second = await alone({}, persistence);
    expect(second.logger.views.state.getSnapshot()).toMatchObject({
      minLevel: 'ERROR',
      levels: { sync: 'DEBUG' },
    });
  });
});

describe('query and export', () => {
  it('filters by level, subsystem, time, trace and text, and exports', async () => {
    const { logger } = await alone();
    logger.commands.log('INFO', 'Boot done', { subsystemId: 'app' });
    t = 2_000;
    logger.commands.log('ERROR', 'Open failed', { subsystemId: 'storage', traceId: 't1' });
    t = 3_000;
    logger.commands.log('WARN', 'Retrying open', { subsystemId: 'storage', context: { n: 1 } });

    const messages = (criteria: Parameters<typeof logger.commands.query>[0]) =>
      logger.commands.query(criteria).map((e) => e.message);
    expect(messages({ levels: ['ERROR', 'WARN'] })).toEqual(['Open failed', 'Retrying open']);
    expect(messages({ subsystems: ['app'] })).toEqual(['Boot done']);
    expect(messages({ since: 2_000, until: 2_500 })).toEqual(['Open failed']);
    expect(messages({ traceId: 't1' })).toEqual(['Open failed']);
    expect(messages({ text: 'OPEN', limit: 1 })).toEqual(['Retrying open']);

    expect(JSON.parse(logger.commands.export('json', { subsystems: ['app'] }))).toHaveLength(1);
    expect(logger.commands.export('text', { since: 2_000 }).split('\n')).toEqual([
      '1970-01-01T00:00:02.000Z ERROR [storage] Open failed trace=t1',
      '1970-01-01T00:00:03.000Z WARN  [storage] Retrying open {"n":1}',
    ]);
  });

  it('formats entries with a component', () => {
    const line = formatEntry({
      id: 'log-1',
      level: 'INFO',
      message: 'ok',
      subsystemId: 'storage',
      componentId: 'idb',
      timestamp: 0,
      sessionId: 's',
      traceId: null,
      context: null,
    });
    expect(line).toBe('1970-01-01T00:00:00.000Z INFO  [storage/idb] ok');
  });

  it('records outside trails and clears', async () => {
    const { logger } = await alone();
    logger.commands.recordTrail({
      kind: 'packet',
      messageId: 'm1',
      traceId: 't9',
      eventId: 'sync:pull',
      source: 'sync',
      outcome: 'completed',
      reason: null,
      trail: { entries: [], dropped: 0 },
    });
    logger.commands.log('INFO', 'remote', { traceId: 't9' });
    expect(logger.commands.trace('t9')).toMatchObject({
      records: [{ messageId: 'm1', timestamp: 1_000 }],
      entries: [{ message: 'remote' }],
    });
    logger.commands.clear();
    expect(logger.commands.trace('t9')).toEqual({ traceId: 't9', records: [], entries: [] });
    expect(logger.views.state.getSnapshot()).toMatchObject({ entries: 0, traces: 0 });
  });
});

describe('trails', () => {
  it('joins a failed request and its follow-up log entries by traceId', async () => {
    const { port, logger } = await wired();
    await expect(
      port.request({ eventId: 'sync:pull', payload: null, target: 'sync' }),
    ).rejects.toThrow('HTTP 503');

    const [record] = logger.views.traces.getSnapshot();
    expect(record).toMatchObject({ kind: 'packet', outcome: 'failed', source: 'app' });
    const trace = logger.commands.trace(record.traceId);
    expect(trace.records).toHaveLength(1);
    expect(trace.entries).toMatchObject([
      {
        level: 'ERROR',
        message: 'sync:pull failed: HTTP 503',
        subsystemId: 'app',
        context: { recordedBy: 'queue' },
      },
    ]);
  });

  it('records a broadcast twice (queue and fan-out) and logs a failed delivery', async () => {
    const { port, logger } = await wired();
    await port.send({ eventId: 'news', payload: null });
    const records = logger.views.traces.getSnapshot();
    expect(records.map((r) => [r.kind, r.outcome])).toEqual([
      ['broadcast', 'fanned-out'],
      ['packet', 'completed'],
    ]);
    expect(records[0].traceId).toBe(records[1].traceId);
    expect(logger.commands.trace(records[0].traceId).entries).toMatchObject([
      { level: 'WARN', subsystemId: 'sync', message: 'news delivery failed: HTTP 503' },
    ]);
  });

  it('stops observing while the Queue is suspended, and resumes with it', async () => {
    const { kernel, port, logger } = await wired();
    await kernel.unit('queue').suspend();
    await Promise.resolve();
    await kernel.unit('queue').resume();
    await new Promise((resolve) => setTimeout(resolve));
    await port.send({ eventId: 'ping', payload: null, target: 'nobody' }).catch(() => {});
    expect(logger.views.traces.getSnapshot()).toHaveLength(1); // observed once, not twice
  });
});

describe('sink', () => {
  it('buffers entries until a sink is bound, then writes through, and reports sink errors', async () => {
    const { platform, logger } = await alone({ sinkCapacity: 2 });
    logger.commands.log('INFO', 'a');
    logger.commands.log('INFO', 'b');
    logger.commands.log('INFO', 'c');

    const written: string[] = [];
    await logger.commands.bindSink((entry) => {
      if (entry.message === 'bad') throw new Error('disk full');
      written.push(entry.message);
    });
    logger.commands.log('INFO', 'd');
    logger.commands.log('INFO', 'bad');
    await Promise.resolve();
    expect(written).toEqual(['b', 'c', 'd']);
    expect(platform.errors.map((e) => (e.error as Error).message)).toEqual(['disk full']);
    expect(logger.views.state.getSnapshot().sinkBound).toBe(true);

    logger.commands.unbindSink();
    logger.commands.log('INFO', 'e');
    expect(written).toEqual(['b', 'c', 'd']);
    expect(logger.views.state.getSnapshot().sinkBound).toBe(false);
  });

  it('reports a sink that rejects', async () => {
    const { platform, logger } = await alone();
    await logger.commands.bindSink(() => Promise.reject(new Error('offline')));
    logger.commands.log('INFO', 'a');
    await vi.waitFor(() => expect(platform.errors).toHaveLength(1));
  });
});
