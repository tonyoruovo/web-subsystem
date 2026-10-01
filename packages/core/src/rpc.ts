/**
 * @fileoverview
 * @summary A small request/response protocol over any `MessagePort`-like object.
 * @description
 * Shared by worker hosts (handshake, calls, heartbeats) and `MessageChannel`
 * transports (envelopes). Each side can both send requests and answer them.
 *
 * ```text
 *   { rpc: 1, k: 'req',  id, op, data }        request
 *   { rpc: 1, k: 'res',  id, ok: true, value }  reply
 *   { rpc: 1, k: 'res',  id, ok: false, error } failure ({ name, message, stack })
 *   { rpc: 1, k: 'note', op, data }             one-way message
 *   ```
 *
 * Messages without `rpc: 1` are ignored, so a port can carry other traffic.
 *
 * @author MathAid
 */

/** @summary The parts of a `MessagePort` (or `Worker`, or worker scope) the protocol uses. */
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  removeEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void;
  start?(): void;
  close?(): void;
}

type RpcMessage =
  | { rpc: 1; k: 'req'; id: number; op: string; data: unknown }
  | { rpc: 1; k: 'res'; id: number; ok: true; value: unknown }
  | { rpc: 1; k: 'res'; id: number; ok: false; error: SerializedError }
  | { rpc: 1; k: 'note'; op: string; data: unknown };

/** @summary An error as it crosses a port. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** @summary An error thrown on the other side of a port. */
export class RemoteError extends Error {
  override readonly name: string;
  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    if (serialized.stack) this.stack = serialized.stack;
  }
}

/** @summary Thrown when a request gets no reply in time. */
export class RpcTimeoutError extends Error {
  override readonly name = 'RpcTimeoutError';
}

/** @summary Thrown for requests pending when the endpoint closes. */
export class RpcClosedError extends Error {
  override readonly name = 'RpcClosedError';
}

/**
 * @summary Converts any thrown value to a cloneable error description.
 * @param {unknown} error The thrown value.
 * @returns {SerializedError} Its name, message and stack.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

/**
 * @summary One end of the protocol.
 *
 * @example
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * const a = new RpcEndpoint(port1);
 * const b = new RpcEndpoint(port2);
 * b.handle('add', ({ x, y }) => x + y);
 * await a.request('add', { x: 1, y: 2 }); // 3
 * ```
 */
export class RpcEndpoint {
  readonly #port: PortLike;
  readonly #handlers = new Map<string, (data: unknown) => unknown>();
  readonly #notes = new Map<string, Set<(data: unknown) => void>>();
  readonly #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  #nextId = 1;
  #closed: Error | null = null;

  readonly #onMessage = (event: MessageEvent) => {
    const message = event.data as RpcMessage | undefined;
    if (!message || message.rpc !== 1) return;
    if (message.k === 'req') void this.#answer(message.id, message.op, message.data);
    else if (message.k === 'res') this.#settle(message);
    else for (const listener of this.#notes.get(message.op) ?? []) listener(message.data);
  };

  constructor(port: PortLike) {
    this.#port = port;
    port.addEventListener('message', this.#onMessage);
    port.start?.();
  }

  /** @summary True once closed. */
  get closed(): boolean {
    return this.#closed !== null;
  }

  /**
   * @summary Answers requests for `op`. The handler's result (or thrown error) is the reply.
   * @returns A function that removes the handler.
   */
  handle(op: string, handler: (data: unknown) => unknown): () => void {
    this.#handlers.set(op, handler);
    return () => this.#handlers.delete(op);
  }

  /**
   * @summary Listens to one-way messages for `op`.
   * @returns A function that removes the listener.
   */
  onNote(op: string, listener: (data: unknown) => void): () => void {
    const listeners = this.#notes.get(op) ?? new Set();
    listeners.add(listener);
    this.#notes.set(op, listeners);
    return () => listeners.delete(listener);
  }

  /**
   * @summary Sends a request and resolves with the reply.
   * @throws {RpcTimeoutError} When no reply arrives within `timeoutMs`.
   * @throws {RemoteError} When the other side's handler throws.
   * @throws {RpcClosedError} When the endpoint is (or becomes) closed.
   */
  request<T = unknown>(
    op: string,
    data?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: {
        resolve(v: unknown): void;
        reject(e: Error): void;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcTimeoutError(`No reply to "${op}" within ${options.timeoutMs} ms.`));
        }, options.timeoutMs);
      }
      this.#pending.set(id, entry);
      this.#post({ rpc: 1, k: 'req', id, op, data });
    });
  }

  /** @summary Sends a one-way message. Ignored once closed. */
  notify(op: string, data?: unknown): void {
    if (!this.#closed) this.#post({ rpc: 1, k: 'note', op, data });
  }

  /**
   * @summary Stops listening, rejects pending requests, and closes the port.
   * @param {Error} [reason] What pending requests are rejected with.
   */
  close(reason: Error = new RpcClosedError('The endpoint was closed.')): void {
    if (this.#closed) return;
    this.#closed = reason;
    this.#port.removeEventListener('message', this.#onMessage);
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.#pending.delete(id);
    }
    this.#port.close?.();
  }

  #post(message: RpcMessage): void {
    this.#port.postMessage(message);
  }

  async #answer(id: number, op: string, data: unknown): Promise<void> {
    const handler = this.#handlers.get(op);
    try {
      if (!handler) throw new Error(`No handler for "${op}".`);
      const value = await handler(data);
      if (!this.#closed) this.#post({ rpc: 1, k: 'res', id, ok: true, value });
    } catch (error) {
      if (!this.#closed)
        this.#post({ rpc: 1, k: 'res', id, ok: false, error: serializeError(error) });
    }
  }

  #settle(message: Extract<RpcMessage, { k: 'res' }>): void {
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new RemoteError(message.error));
  }
}
