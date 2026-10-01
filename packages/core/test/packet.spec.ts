import { describe, expect, it, vi } from 'vitest';

import {
  CorrelationRegistry,
  EMPTY_TRAIL,
  Packet,
  PayloadConsumedError,
  ScopeViolationError,
  WireProtocolError,
  appendFingerprint,
  assertSendAllowed,
  createEnvelope,
  decodeWire,
  encodeWire,
  makeFingerprint,
  reaches,
  type FingerprintTrail,
  type Relation,
  type Scope,
} from '../src';

function counterIds() {
  let n = 0;
  return () => `id-${++n}`;
}

const envelope = (payload: unknown = { n: 1 }) =>
  createEnvelope(
    { eventId: 'storage:put', payload, target: 'storage' },
    { source: 'auth', scope: 'tab', ids: counterIds(), now: () => 1_000 },
  );

describe('createEnvelope', () => {
  it('fills in ids, source, scope, time and defaults', () => {
    expect(envelope()).toEqual({
      eventId: 'storage:put',
      actionName: 'storage:put',
      payload: { n: 1 },
      importance: 'MEDIUM',
      metadata: {
        messageId: 'id-1',
        source: 'auth',
        target: 'storage',
        scope: 'tab',
        timestamp: 1_000,
        traceId: 'id-2',
        spanId: 'id-3',
      },
      fingerprints: EMPTY_TRAIL,
    });
  });

  it('continues the trace of the packet that caused it', () => {
    const cause = envelope();
    const { payload: _payload, ...header } = cause;
    const next = createEnvelope(
      { eventId: 'logger:write', payload: null, causedBy: header },
      { source: 'storage', scope: 'tab', ids: () => 'new' },
    );
    expect(next.metadata.traceId).toBe(cause.metadata.traceId);
    expect(next.metadata.parentSpanId).toBe(cause.metadata.spanId);
    expect(next.metadata.target).toBeNull();
  });
});

describe('fingerprint trail', () => {
  const fp = (i: number) => makeFingerprint('s', `a${i}`, { timestamp: i });

  it('keeps every entry while under the limit', () => {
    let trail: FingerprintTrail = EMPTY_TRAIL;
    for (let i = 0; i < 4; i++) trail = appendFingerprint(trail, fp(i), { head: 2, tail: 2 });
    expect(trail.entries.map((e) => e.actionName)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(trail.dropped).toBe(0);
  });

  it('keeps the first head and last tail entries, and counts the rest', () => {
    let trail: FingerprintTrail = EMPTY_TRAIL;
    for (let i = 0; i < 10; i++) trail = appendFingerprint(trail, fp(i), { head: 2, tail: 3 });
    expect(trail.entries.map((e) => e.actionName)).toEqual(['a0', 'a1', 'a7', 'a8', 'a9']);
    expect(trail.dropped).toBe(5);
  });

  it('does not mutate the previous trail', () => {
    const next = appendFingerprint(EMPTY_TRAIL, fp(0));
    expect(EMPTY_TRAIL.entries).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
  });
});

describe('Packet', () => {
  it('allows the payload to be taken once', () => {
    const packet = new Packet(envelope());
    expect(packet.take()).toEqual({ n: 1 });
    expect(packet.consumed).toBe(true);
    expect(() => packet.take()).toThrow(PayloadConsumedError);
  });

  it('keeps the payload out of the header', () => {
    expect('payload' in new Packet(envelope()).header).toBe(false);
  });

  it('clones lazily, per delivery, when asked', () => {
    const payload = { n: 1 };
    const a = new Packet(envelope(payload), { clone: true });
    const b = new Packet(envelope(payload), { clone: true });
    const taken = a.take();
    expect(taken).toEqual(payload);
    expect(taken).not.toBe(payload);
    expect(b.consumed).toBe(false);
  });

  it('stamps fingerprints and forwards the envelope as its one read', () => {
    const packet = new Packet(envelope());
    packet.stamp(makeFingerprint('queue', 'enqueued'));
    const forwarded = packet.forward();
    expect(forwarded.fingerprints.entries.map((e) => e.actionName)).toEqual(['enqueued']);
    expect(forwarded.payload).toEqual({ n: 1 });
    expect(() => packet.take()).toThrow(PayloadConsumedError);
  });
});

describe('scopes', () => {
  const table: [Scope, Relation, boolean][] = [
    ['page', 'same-page', true],
    ['page', 'same-tab', false],
    ['tab', 'same-tab', true],
    ['tab', 'same-site', false],
    ['window', 'same-site', true],
    ['window', 'remote', false],
    ['global', 'remote', true],
  ];

  it.each(table)('a %s broadcast reaches %s: %s', (scope, relation, expected) => {
    expect(reaches(scope, relation)).toBe(expected);
  });

  it('limits broadcasts to the sender scope', () => {
    expect(() =>
      assertSendAllowed({ sender: 'ui', senderScope: 'page', packetScope: 'global', target: null }),
    ).toThrow(ScopeViolationError);
    expect(() =>
      assertSendAllowed({ sender: 'ui', senderScope: 'page', packetScope: 'page', target: null }),
    ).not.toThrow();
  });

  it('lets requests cross scopes', () => {
    expect(() =>
      assertSendAllowed({
        sender: 'ui',
        senderScope: 'page',
        packetScope: 'page',
        target: 'storage',
      }),
    ).not.toThrow();
  });
});

describe('wire protocol', () => {
  it('round-trips an envelope', () => {
    const original = envelope();
    expect(decodeWire(encodeWire(original))).toEqual(original);
  });

  it('accepts already-parsed values', () => {
    const original = envelope();
    expect(decodeWire({ v: 1, ...original })).toEqual(original);
  });

  it('rejects invalid JSON, other versions and schema violations', () => {
    expect(() => decodeWire('{')).toThrow(WireProtocolError);
    expect(() => decodeWire({ ...envelope(), v: 2 })).toThrow('Unsupported wire protocol version');
    expect(() => decodeWire({ ...envelope(), v: 1, importance: 'URGENT' })).toThrow(
      WireProtocolError,
    );
  });

  it('refuses an elevation token on a broadcast', () => {
    const broadcast = createEnvelope(
      { eventId: 'x', payload: null, authToken: 'secret' },
      { source: 'auth', scope: 'global' },
    );
    expect(() => encodeWire(broadcast)).toThrow(WireProtocolError);
  });
});

describe('CorrelationRegistry', () => {
  it('settles a pending request once and reports the trail', () => {
    const registry = new CorrelationRegistry();
    const onComplete = vi.fn();
    const onLog = vi.fn();
    registry.register('c1', { onComplete, onError: vi.fn(), onLog });
    registry.resolve('c1', 42, EMPTY_TRAIL);
    registry.resolve('c1', 43);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(42);
    expect(onLog).toHaveBeenCalledWith(EMPTY_TRAIL);
    expect(registry.size).toBe(0);
  });

  it('rejects duplicates and isolates throwing callbacks', () => {
    const unhandled = vi.fn();
    const registry = new CorrelationRegistry(unhandled);
    registry.register('c1', {
      onComplete: vi.fn(),
      onError: () => {
        throw new Error('callback bug');
      },
    });
    expect(() => registry.register('c1', { onComplete: vi.fn(), onError: vi.fn() })).toThrow();
    registry.reject('c1', new Error('boom'));
    expect(unhandled).toHaveBeenCalledWith(expect.any(Error), 'c1');
  });

  it('rejects everything pending when the transport closes', () => {
    const registry = new CorrelationRegistry();
    const errors: Error[] = [];
    for (const id of ['a', 'b']) {
      registry.register(id, { onComplete: vi.fn(), onError: (e) => errors.push(e) });
    }
    registry.rejectAll(new Error('closed'));
    expect(errors.map((e) => e.message)).toEqual(['closed', 'closed']);
    expect(registry.size).toBe(0);
  });
});
