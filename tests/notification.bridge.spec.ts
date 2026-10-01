import { describe, expect, it } from 'vitest';

import type { BroadcastChannelLike, EventDefinition } from '../src';
import { NotificationBridge, NotificationCenter } from '../src';

function makeEvent(eventId: string): EventDefinition {
  return {
    eventId,
    eventName: eventId,
    subsystemId: 'test',
    category: 'STATE',
    importance: 'HIGH',
    description: 'test event',
    payloadSchema: null,
    registeredAt: 0,
    usageCount: 0,
    lastFiredAt: null,
    averageHandlerCount: 0,
  };
}

class FakeChannel implements BroadcastChannelLike {
  posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  close(): void {
    this.closed = true;
  }
}

describe('NotificationBridge', () => {
  it('delivers locally and posts to the channel on fire', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:x'));
    let calls = 0;
    center.subscribe('test:x', () => {
      calls += 1;
    });

    const channel = new FakeChannel();
    const bridge = new NotificationBridge({ center, channel });
    bridge.connect();

    bridge.fire('test:x', { n: 1 });
    await center.drain();

    expect(calls).toBe(1);
    expect(channel.posted).toHaveLength(1);
  });

  it('delivers a received broadcast locally without re-posting', async () => {
    const center = new NotificationCenter();
    center.registerEvent(makeEvent('test:y'));
    let calls = 0;
    center.subscribe('test:y', () => {
      calls += 1;
    });

    const channel = new FakeChannel();
    const bridge = new NotificationBridge({ center, channel });
    bridge.connect();

    const message = { eventId: 'test:y', payload: {}, metadata: {} };
    channel.onmessage?.({ data: message } as MessageEvent);
    await center.drain();

    expect(calls).toBe(1);
    expect(channel.posted).toHaveLength(0); // no re-post
  });

  it('does not post an unknown event', () => {
    const center = new NotificationCenter();
    const channel = new FakeChannel();
    const bridge = new NotificationBridge({ center, channel });
    bridge.connect();

    bridge.fire('missing:event', {});

    expect(channel.posted).toHaveLength(0);
  });

  it('closes the channel', () => {
    const center = new NotificationCenter();
    const channel = new FakeChannel();
    const bridge = new NotificationBridge({ center, channel });
    bridge.connect();

    bridge.close();

    expect(channel.closed).toBe(true);
    expect(channel.onmessage).toBeNull();
  });
});
