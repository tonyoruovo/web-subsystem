import { describe, expect, it } from 'vitest';

import { ChannelTransport, type MessagePortLike, type PacketEnvelope } from '../src';

function makeEnvelope(correlationId?: string): PacketEnvelope {
  return {
    eventId: 'test:event',
    actionName: 'TEST',
    payload: { q: 'hello' },
    importance: 'MEDIUM',
    metadata: {
      messageId: 'm1',
      sourceSubsystem: 'ui',
      targetSubsystem: 'worker',
      timestamp: 0,
      correlationId,
    },
    fingerprints: [],
  };
}

class FakePort implements MessagePortLike {
  posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

describe('ChannelTransport', () => {
  it('forwards an envelope on receive', () => {
    const port = new FakePort();
    const transport = new ChannelTransport({ port });

    const envelope = makeEnvelope();
    transport.receive(envelope);

    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toBe(envelope);
  });

  it('resolves callbacks when a success response arrives', () => {
    const port = new FakePort();
    const transport = new ChannelTransport({ port });

    const envelope = makeEnvelope();
    let result: unknown = null;
    transport.request(
      envelope,
      (r) => (result = r),
      () => {},
    );

    expect(port.posted).toHaveLength(1);
    const correlationId = envelope.metadata.correlationId;
    expect(correlationId).toBeTruthy();

    port.onmessage?.({ data: { correlationId, result: 42 } } as MessageEvent);
    expect(result).toBe(42);
  });

  it('rejects callbacks when an error response arrives', () => {
    const port = new FakePort();
    const transport = new ChannelTransport({ port });

    const envelope = makeEnvelope();
    const errors: Error[] = [];
    transport.request(
      envelope,
      () => {},
      (e) => {
        errors.push(e);
      },
    );

    const correlationId = envelope.metadata.correlationId;
    port.onmessage?.({ data: { correlationId, error: new Error('boom') } } as MessageEvent);

    expect(errors[0].message).toBe('boom');
  });

  it('drains pending callbacks on close', () => {
    const port = new FakePort();
    const transport = new ChannelTransport({ port });

    transport.request(
      makeEnvelope(),
      () => {},
      () => {},
    );
    expect(transport.getRegistry().size()).toBe(1);

    transport.close();
    expect(transport.getRegistry().size()).toBe(0);
    expect(port.onmessage).toBeNull();
  });
});
