import { describe, expect, it } from 'vitest';

import type { Fingerprint } from '../src';
import { Logger, type LogEntry } from '../src';

function makeFingerprint(level: Fingerprint['level'], actionName: string): Fingerprint {
  return {
    actionName,
    valueType: 'string',
    timestamp: 0,
    subsystemId: 'test',
    componentId: null,
    counter: null,
    level,
    message: null,
  };
}

describe('Logger', () => {
  it('logs an entry and returns it', () => {
    const logger = new Logger({ now: () => 0, makeId: () => 'id-1' });
    logger.log('INFO', 'hello');

    expect(logger.getBufferSize()).toBe(1);
    expect(logger.getRecentLogs()[0]).toMatchObject({ level: 'INFO', message: 'hello' });
  });

  it('drops entries below the minimum level', () => {
    const logger = new Logger({ minLevel: 'WARN' });

    logger.log('DEBUG', 'debug');
    logger.log('INFO', 'info');
    logger.log('WARN', 'warn');
    logger.log('ERROR', 'error');

    expect(logger.getRecentLogs().map((e) => e.level)).toEqual(['WARN', 'ERROR']);
  });

  it('evicts the oldest entry when the buffer is full', () => {
    const logger = new Logger({ maxBufferSize: 2 });

    logger.log('INFO', 'one');
    logger.log('INFO', 'two');
    logger.log('INFO', 'three');

    expect(logger.getRecentLogs().map((e) => e.message)).toEqual(['two', 'three']);
  });

  it('redacts sensitive keys in context', () => {
    const logger = new Logger();
    logger.log('ERROR', 'auth failed', {
      context: { url: '/api', token: 'secret-token', password: 'hunter2', ok: true },
    });

    expect(logger.getRecentLogs()[0].context).toEqual({
      url: '/api',
      token: '[REDACTED]',
      password: '[REDACTED]',
      ok: true,
    });
  });

  it('logs a fingerprint trail as entries', () => {
    const logger = new Logger();
    logger.logFingerprints([
      makeFingerprint('INFO', 'enqueued'),
      makeFingerprint('ERROR', 'retry-scheduled'),
    ]);

    const entries = logger.getRecentLogs();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'INFO', message: 'enqueued' });
    expect(entries[1]).toMatchObject({ level: 'ERROR', message: 'retry-scheduled' });
  });

  it('flushes to the destination without clearing the buffer', () => {
    const flushed: LogEntry[][] = [];
    const logger = new Logger({ destination: (entries) => flushed.push(entries) });

    logger.log('INFO', 'a');
    logger.log('INFO', 'b');
    logger.flush();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(logger.getBufferSize()).toBe(2); // not cleared
  });

  it('clears the buffer', () => {
    const logger = new Logger();
    logger.log('INFO', 'a');
    logger.clearBuffer();

    expect(logger.getBufferSize()).toBe(0);
  });
});
