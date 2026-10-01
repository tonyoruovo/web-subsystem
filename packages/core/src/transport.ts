/**
 * @fileoverview
 * @summary Transports: move packet envelopes between realms.
 * @description
 * A {@linkcode Transport} carries envelopes to the other side and back:
 * one-way (`send`) or as a request with a reply (`request`). Two
 * implementations ship in M2:
 *
 * - **In-realm** ({@linkcode createInRealmTransportPair}): same thread, but
 *   with the same guarantees as a real boundary (structured clone, async
 *   delivery).
 * - **Port** ({@linkcode createPortTransport}): over a `MessagePort`, using the
 *   shared request/response protocol. {@linkcode createChannelTransportPair}
 *   wires two of them through a `MessageChannel`.
 *
 * ```text
 *   realm A                                   realm B
 *   transport.request(envelope)  ---------->  onEnvelope(handler)
 *                                <----------  handler's return value (the reply)
 *   transport.send(envelope)     ---------->  onEnvelope(handler), reply ignored
 *   ```
 *
 * The Queue (M3) routes through transports; the Window hub (M5) and the
 * Global transport (M8) add more.
 *
 * @example
 * Connecting the main thread to a worker
 * ```ts
 * import { createPortTransport } from '@platform/core';
 *
 * const worker = new Worker(new URL('./realm.worker.ts', import.meta.url), { type: 'module' });
 * const transport = createPortTransport(worker);
 * const reply = await transport.request(envelope, { timeoutMs: 5_000 });
 * ```
 *
 * @example
 * Testing cross-realm code without workers
 * ```ts
 * import { createInRealmTransportPair } from '@platform/core';
 *
 * const [main, other] = createInRealmTransportPair();
 * other.onEnvelope((envelope) => ({ received: envelope.eventId }));
 * await main.request(envelope); // { received: '...' }
 * ```
 *
 * @author MathAid
 */

import type { PacketEnvelope } from './packet';
import { RpcClosedError, RpcEndpoint, type PortLike } from './rpc';

/**
 * @summary Handles an incoming envelope; the return value is the reply to a request.
 * @description `expectsReply` is `true` for requests and `false` for one-way
 * envelopes, whose return value is ignored.
 *
 * @example
 * Answering requests and ignoring the rest
 * ```ts
 * const handler: EnvelopeHandler = (envelope, expectsReply) =>
 *   expectsReply ? answer(envelope) : record(envelope);
 * ```
 *
 * @public
 */
export type EnvelopeHandler = (envelope: PacketEnvelope, expectsReply: boolean) => unknown;

/**
 * @summary One side of a link between realms.
 *
 * @description
 * `send` delivers an envelope without waiting; `request` delivers one and
 * resolves with the other side's reply; `onEnvelope` sets the single active
 * handler for incoming envelopes; `close` closes this side, rejecting pending
 * requests. Envelopes are copied across the link, never shared.
 *
 * Routers use transports to reach subsystems in other realms (workers, other
 * tabs, other subdomains, the server).
 *
 * @example
 * Example 1: A request with a timeout
 * ```ts
 * const reply = await transport.request<{ ok: boolean }>(envelope, { timeoutMs: 2_000 });
 * ```
 *
 * @example
 * Example 2: Handling incoming envelopes
 * ```ts
 * const stop = transport.onEnvelope((envelope) => kernel.deliver(envelope));
 * ```
 *
 * @public
 */
export interface Transport {
  /**
   * @summary Delivers an envelope without waiting for a reply.
   * @param {PacketEnvelope} envelope The envelope.
   */
  send(envelope: PacketEnvelope): void;
  /**
   * @summary Delivers an envelope and resolves with the other side's reply.
   * @template R The reply type.
   * @param {PacketEnvelope} envelope The envelope.
   * @param {object} [options] `timeoutMs`: how long to wait (port transports only).
   * @returns {Promise<R>} The reply.
   */
  request<R = unknown>(envelope: PacketEnvelope, options?: { timeoutMs?: number }): Promise<R>;
  /**
   * @summary Sets the handler for incoming envelopes. Only one handler is active.
   * @param {EnvelopeHandler} handler The handler.
   * @returns {() => void} Removes the handler, if it is still the active one.
   */
  onEnvelope(handler: EnvelopeHandler): () => void;
  /** Closes this side. Pending requests reject. */
  close(): void;
}

/**
 * @summary Creates a {@linkcode Transport} over a `MessagePort`-like object.
 *
 * @description
 * Speaks the shared request/response protocol through an `RpcEndpoint`.
 * A request reaching a side with no handler rejects on the sending side.
 *
 * @example
 * Example 1: Over a worker
 * ```ts
 * const transport = createPortTransport(new Worker(url, { type: 'module' }));
 * ```
 *
 * @example
 * Example 2: Inside the worker, the other end
 * ```ts
 * const transport = createPortTransport(self as unknown as PortLike);
 * transport.onEnvelope((envelope) => handle(envelope));
 * ```
 *
 * @param {PortLike} port The port.
 * @returns {Transport} The transport.
 *
 * @public
 */
export function createPortTransport(port: PortLike): Transport {
  const endpoint = new RpcEndpoint(port);
  let handler: EnvelopeHandler | null = null;
  endpoint.handle('envelope', (envelope) => {
    if (!handler) throw new Error('No envelope handler on the receiving side.');
    return handler(envelope as PacketEnvelope, true);
  });
  endpoint.onNote('envelope', (envelope) => void handler?.(envelope as PacketEnvelope, false));
  return {
    send: (envelope) => endpoint.notify('envelope', envelope),
    request: (envelope, options) => endpoint.request('envelope', envelope, options),
    onEnvelope(next) {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
    close: () => endpoint.close(),
  };
}

/**
 * @summary Creates two transports connected through a new `MessageChannel`.
 *
 * @example
 * Example 1: Both ends in one realm, for tests
 * ```ts
 * const [a, b] = createChannelTransportPair();
 * b.onEnvelope(() => 'pong');
 * await a.request(envelope); // 'pong'
 * ```
 *
 * @example
 * Example 2: Closing both ends
 * ```ts
 * a.close();
 * b.close();
 * ```
 *
 * @returns {[Transport, Transport]} The two ends.
 *
 * @public
 */
export function createChannelTransportPair(): [Transport, Transport] {
  const { port1, port2 } = new MessageChannel();
  return [
    createPortTransport(port1 as unknown as PortLike),
    createPortTransport(port2 as unknown as PortLike),
  ];
}

/**
 * @summary Creates two transports connected in the same realm.
 *
 * @description
 * Envelopes and replies are structured-cloned and delivered in a later
 * microtask, so code tested in-realm behaves as it would across a real
 * boundary: no shared references, no synchronous delivery.
 *
 * @example
 * Example 1: Simulating another tab in a test
 * ```ts
 * const [tab, otherTab] = createInRealmTransportPair();
 * otherTab.onEnvelope((envelope) => otherKernel.deliver(envelope));
 * ```
 *
 * @example
 * Example 2: Payloads are copies
 * ```ts
 * const payload = { list: [1] };
 * b.onEnvelope((envelope) => { (envelope.payload as { list: number[] }).list.push(2); });
 * await a.request({ ...envelope, payload });
 * payload.list; // [1]
 * ```
 *
 * @returns {[Transport, Transport]} The two ends.
 *
 * @public
 */
export function createInRealmTransportPair(): [Transport, Transport] {
  type Side = { handler: EnvelopeHandler | null; closed: boolean; peer?: Side };
  const a: Side = { handler: null, closed: false };
  const b: Side = { handler: null, closed: false, peer: a };
  a.peer = b;

  const make = (self: Side): Transport => {
    const deliver = async (envelope: PacketEnvelope, expectsReply: boolean) => {
      if (self.closed || self.peer!.closed) throw new RpcClosedError('The transport is closed.');
      const copy = structuredClone(envelope);
      await Promise.resolve();
      const handler = self.peer!.handler;
      if (!handler) throw new Error('No envelope handler on the receiving side.');
      return structuredClone(await handler(copy, expectsReply));
    };
    return {
      send(envelope) {
        deliver(envelope, false).catch(() => {});
      },
      request: (envelope) => deliver(envelope, true) as Promise<never>,
      onEnvelope(handler) {
        self.handler = handler;
        return () => {
          if (self.handler === handler) self.handler = null;
        };
      },
      close() {
        self.closed = true;
      },
    };
  };
  return [make(a), make(b)];
}
