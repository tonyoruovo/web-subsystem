import { describe, expect, it, vi } from 'vitest';

import { RealtimeManager, type RealtimeSocket } from '../src';

class FakeSocket implements RealtimeSocket {
  sent: unknown[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
}

function makeManager(sockets: FakeSocket[]): { manager: RealtimeManager; sockets: FakeSocket[] } {
  let index = 0;
  const manager = new RealtimeManager({
    socketFactory: () => sockets[Math.min(index++, sockets.length - 1)],
    retryDelay: () => 0,
  });
  return { manager, sockets };
}

describe('RealtimeManager', () => {
  it('connects and reaches open status', () => {
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();

    sockets[0].onopen?.({});
    expect(manager.getConnectionStatus()).toBe('open');
  });

  it('routes an inbound message to a topic handler', () => {
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();
    sockets[0].onopen?.({});

    const seen: unknown[] = [];
    manager.subscribe('notifications', (data) => seen.push(data));

    sockets[0].onmessage?.({ data: { topic: 'notifications', data: { id: 1 } } });
    expect(seen).toEqual([{ id: 1 }]);
  });

  it('sends subscribe and publish messages', () => {
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();
    sockets[0].onopen?.({});

    manager.subscribe('topic', () => {});
    manager.publish('topic', { n: 1 });

    expect(sockets[0].sent).toEqual([
      { type: 'subscribe', topic: 'topic' },
      { type: 'publish', topic: 'topic', payload: { n: 1 } },
    ]);
  });

  it('disconnects and stops reconnecting', () => {
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();
    sockets[0].onopen?.({});

    manager.disconnect();
    expect(manager.getConnectionStatus()).toBe('closed');
  });

  it('reconnects after an unexpected close', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const { manager } = makeManager(sockets);
    manager.connect();
    sockets[0].onopen?.({});
    expect(manager.getConnectionStatus()).toBe('open');

    // Unexpected close triggers a reconnect (retryDelay is 0).
    sockets[0].onclose?.({});
    await new Promise((r) => setTimeout(r, 0));
    sockets[1].onopen?.({});

    expect(manager.getConnectionStatus()).toBe('open');
  });

  it('unsubscribes a handler', () => {
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();
    sockets[0].onopen?.({});

    const seen: unknown[] = [];
    const id = manager.subscribe('topic', (data) => seen.push(data));
    manager.unsubscribe('topic', id);

    sockets[0].onmessage?.({ data: { topic: 'topic', data: 1 } });
    expect(seen).toHaveLength(0);
  });

  it('sends a ping on the heartbeat interval', () => {
    vi.useFakeTimers();
    const { manager, sockets } = makeManager([new FakeSocket()]);
    manager.connect();
    sockets[0].onopen?.({});

    vi.advanceTimersByTime(30_000);

    expect(sockets[0].sent.some((m) => (m as { type: string }).type === 'ping')).toBe(true);
    vi.useRealTimers();
  });

  it('closes on a missed heartbeat pong', () => {
    vi.useFakeTimers();
    let now = 0;
    const socket = new FakeSocket();
    const manager = new RealtimeManager({
      socketFactory: () => socket,
      now: () => now,
      retryDelay: () => 0,
      heartbeatInterval: 100,
      heartbeatTimeout: 300,
    });

    manager.connect();
    socket.onopen?.({});
    vi.advanceTimersByTime(100);
    expect(socket.sent.some((m) => (m as { type: string }).type === 'ping')).toBe(true);

    now = 400; // no pong arrived, past the 300ms timeout
    vi.advanceTimersByTime(300);

    expect(socket.closed).toBe(true);
    vi.useRealTimers();
  });
});
