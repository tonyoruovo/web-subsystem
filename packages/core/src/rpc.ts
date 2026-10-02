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
 *   { rpc: 1, k: 'res',  id, ok: false, error } failure: { name, message, stack }
 *   { rpc: 1, k: 'note', op, data }             one-way message
 *   ```
 *
 * Messages without `rpc: 1` are ignored, so a port can carry other traffic.
 *
 * @example
 * Two endpoints over a MessageChannel
 * ```ts
 * import { RpcEndpoint } from '@platform/core';
 *
 * const { port1, port2 } = new MessageChannel();
 * const client = new RpcEndpoint(port1);
 * const server = new RpcEndpoint(port2);
 * server.handle('add', ({ x, y }: { x: number; y: number }) => x + y);
 * await client.request('add', { x: 1, y: 2 }); // 3
 * ```
 *
 * @example
 * Talking to a worker
 * ```ts
 * const worker = new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' });
 * const endpoint = new RpcEndpoint(worker);
 * await endpoint.request('hello', null, { timeoutMs: 5_000 });
 * ```
 *
 * @throws {RpcTimeoutError} From {@linkcode RpcEndpoint.request} when no reply arrives in time.
 * @throws {RpcClosedError} For requests made or pending when the endpoint closes.
 * @throws {RemoteError} When the other side's handler throws.
 * @author MathAid
 */

/**
 * @summary The parts of a `MessagePort` (or `Worker`, or worker scope) the protocol uses.
 *
 * @description
 * `postMessage`, `addEventListener` and `removeEventListener` for `message`
 * and `messageerror`, and the optional `start` and `close`. `MessagePort`,
 * `Worker`, a `SharedWorker`'s port, and a dedicated worker's global scope
 * all satisfy it.
 *
 * @example
 * Example 1: A MessagePort
 * ```ts
 * const port: PortLike = new MessageChannel().port1;
 * ```
 *
 * @example
 * Example 2: Inside a dedicated worker
 * ```ts
 * const port = self as unknown as PortLike;
 * ```
 *
 * @public
 */
export interface PortLike {
  /**
   * @summary Sends a message to the other side.
   * @param {unknown} message A structured-cloneable message.
   */
  postMessage(message: unknown): void;
  /**
   * @summary Listens to incoming messages and to messages that cannot be deserialized.
   * @param {'message' | 'messageerror'} type The event type.
   * @param {(event: MessageEvent) => void} listener Called with each event.
   */
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  /**
   * @summary Stops a listener.
   * @param {'message' | 'messageerror'} type The event type.
   * @param {(event: MessageEvent) => void} listener The listener to remove.
   */
  removeEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void;
  /**
   * @summary Starts the delivery of messages.
   * @description A `MessagePort` that uses `addEventListener` needs this call. Other ports do not have it.
   */
  start?(): void;
  /**
   * @summary Closes the port.
   */
  close?(): void;
}

/**
 * @summary The messages of the protocol.
 * @internal
 */
type RpcMessage =
  | { rpc: 1; k: 'req'; id: number; op: string; data: unknown }
  | { rpc: 1; k: 'res'; id: number; ok: true; value: unknown }
  | { rpc: 1; k: 'res'; id: number; ok: false; error: SerializedError }
  | { rpc: 1; k: 'note'; op: string; data: unknown };

/**
 * @summary An error as it crosses a port: its name, message and stack.
 *
 * @example
 * Example 1: What a handler's TypeError becomes
 * ```ts
 * // { name: 'TypeError', message: 'bad input', stack: '...' }
 * ```
 *
 * @example
 * Example 2: A thrown string
 * ```ts
 * serializeError('nope'); // { name: 'Error', message: 'nope' }
 * ```
 *
 * @public
 */
export interface SerializedError {
  /**
   * @summary The `name` of the error, for example `TypeError`.
   */
  readonly name: string;
  /**
   * @summary The message of the error.
   */
  readonly message: string;
  /**
   * @summary The stack of the error, when the other side had one.
   */
  readonly stack?: string;
}

/**
 * @summary An error thrown on the other side of a port.
 *
 * @description
 * Rebuilt from a {@linkcode SerializedError}: it keeps the remote `name`,
 * `message` and `stack`, so callers can still branch on `error.name`.
 *
 * @example
 * Example 1: Branching on the remote error's name
 * ```ts
 * try { await endpoint.request('parse', text); }
 * catch (error) { if (error instanceof RemoteError && error.name === 'SyntaxError') showParseError(); }
 * ```
 *
 * @example
 * Example 2: Logging the remote stack
 * ```ts
 * catch (error) { console.error((error as RemoteError).stack); }
 * ```
 *
 * @public
 */
export class RemoteError extends Error {
  /**
   * @summary The name of the error on the other side, for example `'TypeError'`.
   */
  override readonly name: string;

  /**
   * @summary Rebuilds an error that the other side sent.
   * @param {SerializedError} serialized The error from the other side.
   */
  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    if (serialized.stack) this.stack = serialized.stack;
  }
}

/**
 * @summary Thrown when a request gets no reply in time.
 *
 * @example
 * Example 1: A bounded request
 * ```ts
 * await endpoint.request('ping', 1, { timeoutMs: 2_000 }); // RpcTimeoutError after 2 s of silence
 * ```
 *
 * @example
 * Example 2: Treating silence as unavailability
 * ```ts
 * catch (error) { if (error instanceof RpcTimeoutError) markUnavailable(); }
 * ```
 *
 * @public
 */
export class RpcTimeoutError extends Error {
  /**
   * @summary The name of the error class: `'RpcTimeoutError'`.
   */
  override readonly name = 'RpcTimeoutError';
}

/**
 * @summary Thrown for requests made on, or pending in, a closed endpoint.
 *
 * @example
 * Example 1: Closing rejects what is pending
 * ```ts
 * const pending = endpoint.request('slow');
 * endpoint.close();
 * await pending; // rejects with RpcClosedError
 * ```
 *
 * @example
 * Example 2: Requests after close
 * ```ts
 * await endpoint.request('x'); // rejects with RpcClosedError
 * ```
 *
 * @public
 */
export class RpcClosedError extends Error {
  /**
   * @summary The name of the error class: `'RpcClosedError'`.
   */
  override readonly name = 'RpcClosedError';
}

/**
 * @summary Converts any thrown value to a cloneable {@linkcode SerializedError}.
 *
 * @example
 * Example 1: An Error
 * ```ts
 * serializeError(new TypeError('bad')); // { name: 'TypeError', message: 'bad', stack: '...' }
 * ```
 *
 * @example
 * Example 2: Anything else
 * ```ts
 * serializeError(42); // { name: 'Error', message: '42' }
 * ```
 *
 * @param {unknown} error The thrown value.
 * @returns {SerializedError} Its name, message and stack.
 *
 * @public
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

/**
 * @summary One end of the request/response protocol.
 *
 * @description
 * Wraps a {@linkcode PortLike}. `handle` answers requests for an operation,
 * `request` sends one and resolves with the reply, `onNote` and `notify`
 * carry one-way messages, and `close` stops everything, rejecting pending
 * requests. Handler errors travel back as {@linkcode RemoteError}s.
 *
 * Worker hosts, `serveProcessor` and port transports are built on it. Use it
 * directly for any other request/response traffic over a port.
 *
 * @example
 * Example 1: Both sides over a MessageChannel
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * const a = new RpcEndpoint(port1);
 * const b = new RpcEndpoint(port2);
 * b.handle('add', ({ x, y }: { x: number; y: number }) => x + y);
 * await a.request('add', { x: 1, y: 2 }); // 3
 * ```
 *
 * @example
 * Example 2: Progress notes from a worker
 * ```ts
 * endpoint.onNote('progress', (value) => (bar.value = value as number));
 * ```
 *
 * @public
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

  /** @summary Dispatches one incoming protocol message. @internal */
  readonly #onMessage = (event: MessageEvent) => {
    const message = event.data as RpcMessage | undefined;
    if (!message || message.rpc !== 1) return;
    if (message.k === 'req') void this.#answer(message.id, message.op, message.data);
    else if (message.k === 'res') this.#settle(message);
    else for (const listener of this.#notes.get(message.op) ?? []) listener(message.data);
  };

  /**
   * @summary Creates an endpoint on a port, and starts the port.
   * @param {PortLike} port The port to speak over. It is started immediately.
   */
  constructor(port: PortLike) {
    this.#port = port;
    port.addEventListener('message', this.#onMessage);
    port.start?.();
  }

  /**
   * @summary Tells whether the endpoint is closed.
   * @returns {boolean} `true` once closed.
   */
  get closed(): boolean {
    return this.#closed !== null;
  }

  /**
   * @summary Answers requests for `op`. The handler's result (or thrown error) is the reply.
   * @param {string} op The operation name.
   * @param {(data: unknown) => unknown} handler Receives the request data; may be async.
   * @returns {() => void} Removes the handler.
   */
  handle(op: string, handler: (data: unknown) => unknown): () => void {
    this.#handlers.set(op, handler);
    return () => this.#handlers.delete(op);
  }

  /**
   * @summary Listens to one-way messages for `op`.
   * @param {string} op The operation name.
   * @param {(data: unknown) => void} listener Receives the message data.
   * @returns {() => void} Removes the listener.
   */
  onNote(op: string, listener: (data: unknown) => void): () => void {
    const listeners = this.#notes.get(op) ?? new Set();
    listeners.add(listener);
    this.#notes.set(op, listeners);
    return () => listeners.delete(listener);
  }

  /**
   * @summary Sends a request and resolves with the reply.
   * @template T The reply type.
   * @param {string} op The operation name.
   * @param {unknown} [data] The request data. Must be structured-cloneable.
   * @param {object} [options] `timeoutMs`: how long to wait for the reply.
   * @returns {Promise<T>} The reply.
   * @throws {RpcTimeoutError} When no reply arrives within `timeoutMs`.
   * @throws {RemoteError} When the other side's handler throws, or has no handler for `op`.
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

  /**
   * @summary Sends a one-way message. Ignored once closed.
   * @param {string} op The operation name.
   * @param {unknown} [data] The message data. Must be structured-cloneable.
   */
  notify(op: string, data?: unknown): void {
    if (!this.#closed) this.#post({ rpc: 1, k: 'note', op, data });
  }

  /**
   * @summary Stops listening, rejects pending requests, and closes the port.
   * @description Calling it again has no effect.
   * @param {Error} [reason] What pending and later requests are rejected with. Defaults to an {@linkcode RpcClosedError}.
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

  /** @summary Posts one protocol message. @internal */
  #post(message: RpcMessage): void {
    this.#port.postMessage(message);
  }

  /** @summary Runs the handler for a request and posts the reply or failure. @internal */
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

  /** @summary Settles the pending request a reply belongs to. @internal */
  #settle(message: Extract<RpcMessage, { k: 'res' }>): void {
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new RemoteError(message.error));
  }
}
