import { describe, expect, it } from 'vitest';

import type { PacketEnvelope, QueueConfiguration } from '../src';
import { MessageQueue } from '../src';

function makeConfig(overrides: Partial<QueueConfiguration> = {}): QueueConfiguration {
  return {
    maxQueueSize: 100,
    maxQueueSizePerSubsystem: 20,
    maxActiveMessages: 10,
    maxRetryAttempts: 3,
    maxMessageAge: 60_000,
    processingTimeout: 5_000,
    batchSize: 10,
    dispatchInterval: 16,
    retryStrategy: 'EXPONENTIAL_BACKOFF',
    retryDelayBase: 100,
    retryDelayMultiplier: 2,
    enableDeadLetterQueue: true,
    deadLetterMaxSize: 100,
    deadLetterRetentionDays: 7,
    enableDeduplication: false,
    deduplicationWindow: 1_000,
    ...overrides,
  };
}

function makeEnvelope(
  id: string,
  importance: PacketEnvelope['importance'],
  target: string | null,
): PacketEnvelope {
  return {
    eventId: 'test:event',
    actionName: 'TEST',
    payload: { id },
    importance,
    metadata: {
      messageId: id,
      sourceSubsystem: 'test',
      targetSubsystem: target,
      timestamp: Date.now(),
    },
    fingerprints: [],
  };
}

describe('MessageQueue', () => {
  it('dispatches by priority, CRITICAL before LOW', async () => {
    const queue = new MessageQueue({ config: makeConfig() });
    const order: string[] = [];
    queue.registerReceiver('target', async (p) => {
      order.push(p.metadata.messageId);
    });

    queue.enqueue(makeEnvelope('low', 'LOW', 'target'));
    queue.enqueue(makeEnvelope('high', 'HIGH', 'target'));
    queue.enqueue(makeEnvelope('critical', 'CRITICAL', 'target'));
    queue.enqueue(makeEnvelope('medium', 'MEDIUM', 'target'));

    await queue.drain();

    expect(order).toEqual(['critical', 'high', 'medium', 'low']);
    expect(queue.getQueueDepth()).toBe(0);
  });

  it('delivers a packet to its registered receiver', async () => {
    const queue = new MessageQueue({ config: makeConfig() });
    const received: string[] = [];
    queue.registerReceiver('target', async (p) => {
      received.push((p.payload as { id: string }).id);
    });

    queue.enqueue(makeEnvelope('a', 'HIGH', 'target'));
    await queue.dispatchOnce();

    expect(received).toEqual(['a']);
    expect(queue.getQueueDepth()).toBe(0);
  });

  it('retries a failed delivery with backoff and succeeds later', async () => {
    let now = 0;
    let calls = 0;
    const queue = new MessageQueue({
      config: makeConfig({ maxRetryAttempts: 2 }),
      now: () => now,
      retryDelay: () => 100,
    });

    queue.registerReceiver('target', async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });

    queue.enqueue(makeEnvelope('a', 'HIGH', 'target'));

    await queue.dispatchOnce(); // first attempt fails
    expect(calls).toBe(1);
    expect(queue.getQueueDepth()).toBe(1); // parked in RETRY

    expect(await queue.dispatchOnce()).toBe(false); // not yet due

    now = 150; // advance past the retry delay
    await queue.dispatchOnce(); // retry succeeds
    expect(calls).toBe(2);
    expect(queue.getQueueDepth()).toBe(0);
  });

  it('dead-letters a packet after exhausting retries', async () => {
    const queue = new MessageQueue({
      config: makeConfig({ maxRetryAttempts: 2 }),
      now: () => 0,
      retryDelay: () => 0,
    });

    queue.registerReceiver('target', async () => {
      throw new Error('always fails');
    });

    queue.enqueue(makeEnvelope('a', 'HIGH', 'target'));

    await queue.dispatchOnce(); // initial
    await queue.dispatchOnce(); // retry 1
    await queue.dispatchOnce(); // retry 2, then dead-letter

    expect(queue.getDeadLetter()).toHaveLength(1);
    expect(queue.getQueueDepth()).toBe(1); // only the dead-letter entry remains
  });

  it('treats a missing receiver as a delivery failure', async () => {
    const queue = new MessageQueue({ config: makeConfig({ maxRetryAttempts: 0 }) });
    queue.enqueue(makeEnvelope('a', 'HIGH', 'missing'));

    await queue.dispatchOnce();

    expect(queue.getDeadLetter()).toHaveLength(1);
  });

  it('rejects a broadcast packet with no target', async () => {
    const queue = new MessageQueue({ config: makeConfig({ maxRetryAttempts: 0 }) });
    queue.enqueue(makeEnvelope('a', 'HIGH', null));

    await queue.dispatchOnce();

    expect(queue.getDeadLetter()).toHaveLength(1);
  });

  it('replays a dead-lettered packet', async () => {
    const queue = new MessageQueue({ config: makeConfig({ maxRetryAttempts: 0 }) });

    let calls = 0;
    queue.registerReceiver('target', async () => {
      calls += 1;
      throw new Error('fail');
    });

    queue.enqueue(makeEnvelope('a', 'HIGH', 'target'));
    await queue.dispatchOnce(); // fails once, dead-letters immediately

    expect(queue.getDeadLetter()).toHaveLength(1);

    queue.registerReceiver('target', async () => {
      calls += 1; // fixed receiver succeeds
    });

    expect(queue.replayDeadLetter('a')).toBe(true);
    await queue.drain();

    expect(calls).toBe(2); // one failure, one replayed success
    expect(queue.getQueueDepth()).toBe(0);
  });

  it('drains a large queue without loss or reordering', async () => {
    const queue = new MessageQueue({ config: makeConfig() });
    const received: string[] = [];
    queue.registerReceiver('target', async (p) => {
      received.push(p.metadata.messageId);
    });

    const count = 500;
    for (let i = 0; i < count; i++) {
      queue.enqueue(makeEnvelope(`m${i}`, 'LOW', 'target'));
    }
    await queue.drain();

    expect(received).toHaveLength(count);
    expect(received[0]).toBe('m0');
    expect(received[count - 1]).toBe(`m${count - 1}`);
  });
});
