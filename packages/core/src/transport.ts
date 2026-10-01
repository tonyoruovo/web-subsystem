/**
 * @fileoverview
 * @summary Transports: move packet envelopes between realms.
 * @description
 * A {@linkcode Transport} carries envelopes to the other side and back:
 * one-way (`send`) or as a request with a reply (`request`). Two
 * implementations ship in M2:
 *
 * - **In-realm** ({@linkcode createInRealmTransportPair}): same thread, but with
 *   the same guarantees as a real boundary (structured clone, async delivery).
 * - **Port** ({@linkcode createPortTransport}): over a `MessagePort`, using the
 *   shared request/response protocol. {@linkcode createChannelTransportPair}
 *   wires two of them through a `MessageChannel`.
 *
 * The Queue (M3) routes through transports; the Window hub (M5) and the
 * Global transport (M8) add more.
 *
 * @author MathAid
 */

import type { PacketEnvelope } from './packet';
import { RpcClosedError, RpcEndpoint, type PortLike } from './rpc';

/** @summary Handles an incoming envelope; the return value is the reply to a request. */
export type EnvelopeHandler = (envelope: PacketEnvelope, expectsReply: boolean) => unknown;

/** @summary One side of a link between realms. */
export interface Transport {
  /** Delivers an envelope without waiting for a reply. */
  send(envelope: PacketEnvelope): void;
  /** Delivers an envelope and resolves with the other side's reply. */
  request<R = unknown>(envelope: PacketEnvelope, options?: { timeoutMs?: number }): Promise<R>;
  /** Sets the handler for incoming envelopes. Only one handler is active. */
  onEnvelope(handler: EnvelopeHandler): () => void;
  /** Closes this side. Pending requests reject. */
  close(): void;
}

/**
 * @summary A transport over a `MessagePort`-like object.
 * @param {PortLike} port The port.
 * @returns {Transport} The transport.
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
 * @summary Two transports connected through a new `MessageChannel`.
 * @returns {[Transport, Transport]} The two ends.
 */
export function createChannelTransportPair(): [Transport, Transport] {
  const { port1, port2 } = new MessageChannel();
  return [
    createPortTransport(port1 as unknown as PortLike),
    createPortTransport(port2 as unknown as PortLike),
  ];
}

/**
 * @summary Two transports connected in the same realm.
 * @description
 * Envelopes are structured-cloned and delivered in a later microtask, so code
 * tested in-realm behaves as it would across a real boundary.
 *
 * @returns {[Transport, Transport]} The two ends.
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
