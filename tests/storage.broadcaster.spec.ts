import { describe, expect, it } from 'vitest';

import type { StorageChangeEvent } from '../src';
import { StorageBroadcaster, type StorageBroadcastChannelLike } from '../src';

function makeEvent(key: string, op: StorageChangeEvent['op'] = 'set'): StorageChangeEvent {
  return {
    key: key as StorageChangeEvent['key'],
    op,
    schema_version: 1,
    timestamp: 0,
    backend: 'memory',
    workerId: 'main',
  };
}

class FakeChannel implements StorageBroadcastChannelLike {
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

describe('StorageBroadcaster', () => {
  it('notifies a local subscriber whose prefix matches', () => {
    const broadcaster = new StorageBroadcaster();
    const seen: StorageChangeEvent[] = [];
    broadcaster.subscribe('app:chrome:1:', (e) => seen.push(e));

    broadcaster.emit(makeEvent('app:chrome:1:test:count'));

    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe('set');
  });

  it('does not notify a non-matching subscriber', () => {
    const broadcaster = new StorageBroadcaster();
    const seen: StorageChangeEvent[] = [];
    broadcaster.subscribe('other:', (e) => seen.push(e));

    broadcaster.emit(makeEvent('app:chrome:1:test:count'));

    expect(seen).toHaveLength(0);
  });

  it('posts to the channel on emit and delivers received messages locally', () => {
    const channel = new FakeChannel();
    const broadcaster = new StorageBroadcaster({ channel });
    const seen: StorageChangeEvent[] = [];
    broadcaster.subscribe('app:', (e) => seen.push(e));

    broadcaster.emit(makeEvent('app:chrome:1:test:count'));
    expect(channel.posted).toHaveLength(1);

    // Simulate another tab's broadcast.
    channel.onmessage?.({ data: makeEvent('app:chrome:1:test:other') } as MessageEvent);

    expect(seen).toHaveLength(2);
    expect(channel.posted).toHaveLength(1); // no re-post
  });

  it('unsubscribes', () => {
    const broadcaster = new StorageBroadcaster();
    const seen: StorageChangeEvent[] = [];
    const sub = broadcaster.subscribe('app:', (e) => seen.push(e));

    sub.unsubscribe();
    broadcaster.emit(makeEvent('app:chrome:1:test:count'));

    expect(seen).toHaveLength(0);
  });

  it('closes the channel', () => {
    const channel = new FakeChannel();
    const broadcaster = new StorageBroadcaster({ channel });

    broadcaster.close();

    expect(channel.closed).toBe(true);
    expect(channel.onmessage).toBeNull();
  });
});
