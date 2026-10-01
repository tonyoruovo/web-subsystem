/**
 * @fileoverview
 * @summary A MessageChannel transport for the queue's worker leg.
 * @description
 * The queue delivers to a target in its own realm. When the target runs in a
 * worker, the queue registers a receiver that forwards the envelope over a
 * `MessagePort`. This transport owns that port, wires the request/response
 * correlation through a {@linkcode CorrelationRegistry}, and resolves callbacks
 * when the worker posts a response.
 *
 * ```text
 *   main thread                          worker
 *   transport.request(env)  --port.postMessage-->  handler
 *   transport.onMessage <--  port.onmessage <--    response
 *        |-- registry.resolve(correlationId)
 *   ```
 *
 * A response is `{ correlationId, result? }` on success, or
 * `{ correlationId, error? }` on failure.
 *
 * @see {@linkcode CorrelationRegistry}
 * @see {@linkcode PacketEnvelope}
 * @author MathAid
 */

import type { PacketEnvelope } from '../packet.dto';
import { CorrelationRegistry } from '../packet.registry';

/**
 * @summary The minimal MessagePort surface the transport needs.
 * @description
 * An interface so tests can substitute a fake. A real `MessagePort` satisfies
 * this shape.
 */
export interface MessagePortLike {
  /** Posts a message to the other end of the port. */
  postMessage(message: unknown): void;
  /** Handler for messages from the other end. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Starts the port, if the concrete type requires it. */
  start?(): void;
}

/**
 * @summary The response a worker posts back.
 */
export interface ChannelResponse {
  /** The correlation id echoed from the request envelope. */
  correlationId: string;
  /** The resolved value, on success. */
  result?: unknown;
  /** The error, on failure. */
  error?: Error;
}

/**
 * @summary Options for constructing a {@linkcode ChannelTransport}.
 */
export interface ChannelTransportOptions {
  /** The port to the worker. */
  port: MessagePortLike;
  /** Optional correlation registry. Defaults to a new one. */
  registry?: CorrelationRegistry;
}

/**
 * @summary The MessageChannel transport for the queue worker leg.
 * @description
 * Wraps a port and a registry. Register its `receive` method with the queue for
 * a worker-backed target. Use `request` for a correlated round-trip.
 *
 * @example
 * Example 1: Register a worker target with the queue
 * ```ts
 * const transport = new ChannelTransport({ port: worker.port });
 * queue.registerReceiver('storage-worker', transport.receive.bind(transport));
 * ```
 */
export class ChannelTransport {
  /** @internal The port. */
  private readonly port: MessagePortLike;

  /** @internal The correlation registry. */
  private readonly registry: CorrelationRegistry;

  /** @internal Monotonic counter for correlation ids. */
  private counter = 0;

  /**
   * @summary Creates a ChannelTransport.
   * @param {ChannelTransportOptions} options The port and optional registry.
   */
  constructor(options: ChannelTransportOptions) {
    this.port = options.port;
    this.registry = options.registry ?? new CorrelationRegistry();
    this.port.onmessage = (event) => this.onMessage(event.data as ChannelResponse);
    this.port.start?.();
  }

  /**
   * @summary Forwards an envelope to the worker.
   * @description
   * A fire-and-forget delivery. Register this with the queue for a
   * worker-backed target.
   *
   * @param {PacketEnvelope} envelope The envelope to forward.
   * @returns {void}
   */
  receive(envelope: PacketEnvelope): void {
    this.port.postMessage(envelope);
  }

  /**
   * @summary Sends a request and resolves callbacks by correlation id.
   * @description
   * Ensures the envelope has a correlation id, registers the callbacks, and
   * posts the envelope. When the worker posts a response with the same id, the
   * callbacks run.
   *
   * @param {PacketEnvelope} envelope The request envelope.
   * @param {(result: R) => void} onComplete Runs on a success response.
   * @param {(error: Error) => void} onError Runs on a failure response.
   * @returns {void}
   */
  request<R>(
    envelope: PacketEnvelope,
    onComplete: (result: R) => void,
    onError: (error: Error) => void,
  ): void {
    const id = envelope.metadata.correlationId ?? `corr-${++this.counter}`;
    envelope.metadata.correlationId = id;
    this.registry.register(id, { onComplete, onError, onLog: null });
    this.port.postMessage(envelope);
  }

  /**
   * @summary The correlation registry this transport uses.
   * @returns {CorrelationRegistry} The registry.
   */
  getRegistry(): CorrelationRegistry {
    return this.registry;
  }

  /**
   * @summary Stops listening and drains pending callbacks.
   * @returns {void}
   */
  close(): void {
    this.port.onmessage = null;
    this.registry.drain();
  }

  /**
   * @summary Handles a response from the worker.
   * @param {ChannelResponse} message The response.
   * @returns {void}
   * @internal
   */
  private onMessage(message: ChannelResponse): void {
    if (!message || typeof message.correlationId !== 'string') return;
    if (message.error) {
      this.registry.reject(message.correlationId, message.error);
    } else {
      this.registry.resolve(message.correlationId, message.result);
    }
  }
}
