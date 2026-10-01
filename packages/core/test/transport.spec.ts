import { describe, expect, it, vi } from 'vitest';

import {
  RpcClosedError,
  createChannelTransportPair,
  createEnvelope,
  createInRealmTransportPair,
  type PacketEnvelope,
  type Transport,
} from '../src';

const envelope = (payload: unknown, target: string | null = 'b') =>
  createEnvelope(
    { eventId: 'test', payload, target: target ?? undefined },
    { source: 'a', scope: 'tab' },
  ) as PacketEnvelope;

const pairs: [string, () => [Transport, Transport]][] = [
  ['in-realm', createInRealmTransportPair],
  ['MessageChannel', createChannelTransportPair],
];

describe.each(pairs)('%s transport', (_name, createPair) => {
  it('delivers a request and returns the reply', async () => {
    const [a, b] = createPair();
    b.onEnvelope((env, expectsReply) => ({ got: env.payload, expectsReply }));
    await expect(a.request(envelope({ n: 1 }))).resolves.toEqual({
      got: { n: 1 },
      expectsReply: true,
    });
    a.close();
    b.close();
  });

  it('delivers one-way envelopes', async () => {
    const [a, b] = createPair();
    const received = vi.fn();
    b.onEnvelope(received);
    a.send(envelope('note', null));
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received.mock.calls[0][0].payload).toBe('note');
    expect(received.mock.calls[0][1]).toBe(false);
    a.close();
    b.close();
  });

  it('copies envelopes across the boundary', async () => {
    const [a, b] = createPair();
    const payload = { list: [1] };
    let seen: unknown;
    b.onEnvelope((env) => {
      seen = env.payload;
      (env.payload as { list: number[] }).list.push(2);
      return null;
    });
    await a.request(envelope(payload));
    expect(seen).not.toBe(payload);
    expect(payload.list).toEqual([1]);
    a.close();
    b.close();
  });

  it('rejects a request when the other side has no handler, and after close', async () => {
    const [a, b] = createPair();
    await expect(a.request(envelope(1))).rejects.toThrow('No envelope handler');
    const remove = b.onEnvelope(() => 'ok');
    remove();
    await expect(a.request(envelope(1))).rejects.toThrow('No envelope handler');
    a.close();
    await expect(a.request(envelope(1))).rejects.toThrow(RpcClosedError);
    b.close();
  });
});
