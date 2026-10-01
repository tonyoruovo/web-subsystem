/**
 * @fileoverview
 * @summary The Realtime manager: a websocket with reconnect, heartbeat, and topics.
 * @description
 * Implements the websocket core of M3. It owns the socket lifecycle, reconnects
 * with backoff on an unexpected close, sends heartbeats and detects dead
 * connections by a missed pong, multiplexes many logical topics over one
 * socket, and routes incoming messages to per-topic handlers.
 *
 * ```text
 *   connect()            -> open socket, status open, start heartbeat
 *   subscribe(topic, fn) -> register handler + send subscribe
 *   publish(topic, data) -> send publish
 *   heartbeat            -> send ping each interval; missed pong -> close
 *   onmessage            -> pong -> update liveness, else route to handlers
 *   onclose (unexpected) -> reconnect with backoff
 *   ```
 *
 * The socket is injected as a factory so the manager is testable without a real
 * WebSocket.
 *
 * @author MathAid
 */

/**
 * @summary A minimal websocket surface the manager drives.
 */
export interface RealtimeSocket {
  /** Sends a message. */
  send(data: unknown): void;
  /** Closes the socket. */
  close(): void;
  /** Fires when the socket opens. */
  onopen: ((event: unknown) => void) | null;
  /** Fires on an incoming message. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Fires when the socket closes. */
  onclose: ((event: unknown) => void) | null;
  /** Fires on a socket error. */
  onerror: ((event: unknown) => void) | null;
}

/**
 * @summary The connection status.
 */
export type RealtimeStatus = 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';

/**
 * @summary A routed inbound message.
 */
export interface RealtimeMessage {
  topic: string;
  data: unknown;
}

/**
 * @summary Options for constructing a {@linkcode RealtimeManager}.
 */
export interface RealtimeManagerOptions {
  /** Creates a socket. */
  socketFactory: () => RealtimeSocket;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
  /** Injectable reconnect delay. Defaults to exponential backoff. */
  retryDelay?: (attempt: number) => number;
  /** Max reconnect attempts. Defaults to 5. */
  maxReconnectAttempts?: number;
  /** Heartbeat interval in milliseconds. Defaults to 30000. */
  heartbeatInterval?: number;
  /** Missed-pong timeout in milliseconds. Defaults to 3x the interval. */
  heartbeatTimeout?: number;
}

/**
 * @summary The Realtime manager.
 * @description
 * One instance per realm. Subscribers receive messages for their topic only.
 *
 * @example
 * Example 1: Connect and subscribe to a topic
 * ```ts
 * const realtime = new RealtimeManager({ socketFactory: () => new WebSocket(url) });
 * realtime.connect();
 * realtime.subscribe('notifications', (data) => console.log(data));
 * ```
 */
export class RealtimeManager {
  /** @internal topic to subscription id to handler. */
  private readonly handlers = new Map<string, Map<string, (data: unknown) => void>>();

  /** @internal The active socket. */
  private socket: RealtimeSocket | null = null;

  /** @internal The status. */
  private status: RealtimeStatus = 'closed';

  /** @internal The socket factory. */
  private readonly socketFactory: () => RealtimeSocket;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /** @internal The reconnect delay function. */
  private readonly retryDelay: (attempt: number) => number;

  /** @internal The max reconnect attempts. */
  private readonly maxReconnectAttempts: number;

  /** @internal The heartbeat interval. */
  private readonly heartbeatInterval: number;

  /** @internal The heartbeat timeout. */
  private readonly heartbeatTimeout: number;

  /** @internal The reconnect attempts so far. */
  private reconnectAttempts = 0;

  /** @internal True when the close was user-initiated. */
  private intentionalClose = false;

  /** @internal The heartbeat timer. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** @internal The last pong time. */
  private lastPongAt = 0;

  /**
   * @summary Creates a RealtimeManager.
   * @param {RealtimeManagerOptions} options The socket factory and injectables.
   */
  constructor(options: RealtimeManagerOptions) {
    this.socketFactory = options.socketFactory;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? makeCounter();
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.heartbeatTimeout = options.heartbeatTimeout ?? this.heartbeatInterval * 3;
  }

  /**
   * @summary Opens the socket.
   * @returns {void}
   */
  connect(): void {
    this.status = 'connecting';
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.socket = this.socketFactory();
    this.socket.onopen = () => {
      this.status = 'open';
      this.lastPongAt = this.now();
      this.startHeartbeat();
    };
    this.socket.onmessage = (event) => this.handleMessage(event.data);
    this.socket.onclose = () => {
      this.handleClose();
    };
  }

  /**
   * @summary Closes the socket and stops reconnecting.
   * @returns {void}
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.status = 'closed';
  }

  /**
   * @summary Subscribes a handler to a topic.
   * @param {string} topic The topic.
   * @param {(data: unknown) => void} handler The handler.
   * @returns {string} The subscription id.
   */
  subscribe(topic: string, handler: (data: unknown) => void): string {
    const id = this.makeId();
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Map());
    this.handlers.get(topic)!.set(id, handler);
    this.socket?.send({ type: 'subscribe', topic });
    return id;
  }

  /**
   * @summary Removes a subscription.
   * @param {string} topic The topic.
   * @param {string} subscriptionId The subscription id.
   * @returns {void}
   */
  unsubscribe(topic: string, subscriptionId: string): void {
    this.handlers.get(topic)?.delete(subscriptionId);
    if (this.handlers.get(topic)?.size === 0) this.handlers.delete(topic);
    this.socket?.send({ type: 'unsubscribe', topic });
  }

  /**
   * @summary Publishes a message on a topic.
   * @param {string} topic The topic.
   * @param {unknown} payload The payload.
   * @returns {void}
   */
  publish(topic: string, payload: unknown): void {
    this.socket?.send({ type: 'publish', topic, payload });
  }

  /**
   * @summary The current connection status.
   * @returns {RealtimeStatus} The status.
   */
  getConnectionStatus(): RealtimeStatus {
    return this.status;
  }

  /**
   * @summary The subscribed topics.
   * @returns {string[]} The topics.
   */
  getSubscriptions(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * @summary Handles an inbound message, treating pong as a control message.
   * @param {unknown} data The raw message.
   * @returns {void}
   * @internal
   */
  private handleMessage(data: unknown): void {
    const msg = data as { type?: string; topic?: string; data?: unknown };
    if (msg && msg.type === 'pong') {
      this.lastPongAt = this.now();
      return;
    }
    this.route(msg as RealtimeMessage);
  }

  /**
   * @summary Routes an inbound message to its topic handlers.
   * @param {RealtimeMessage} message The message.
   * @returns {void}
   * @internal
   */
  private route(message: RealtimeMessage): void {
    if (!message || typeof message.topic !== 'string') return;
    for (const handler of this.handlers.get(message.topic)?.values() ?? []) {
      handler(message.data);
    }
  }

  /**
   * @summary Starts the heartbeat interval.
   * @description
   * Sends a ping each interval. When the last pong is older than the timeout,
   * it closes the socket to trigger a reconnect.
   * @returns {void}
   * @internal
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.now() - this.lastPongAt > this.heartbeatTimeout) {
        this.socket?.close();
      } else {
        this.socket?.send({ type: 'ping' });
      }
    }, this.heartbeatInterval);
  }

  /**
   * @summary Stops the heartbeat interval.
   * @returns {void}
   * @internal
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * @summary Handles a socket close, reconnecting when unexpected.
   * @returns {void}
   * @internal
   */
  private handleClose(): void {
    this.socket = null;
    this.stopHeartbeat();

    if (this.intentionalClose) {
      this.status = 'closed';
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.status = 'closed';
      return;
    }

    this.status = 'reconnecting';
    this.reconnectAttempts += 1;
    const delay = this.retryDelay(this.reconnectAttempts);
    setTimeout(() => {
      this.socket = this.socketFactory();
      this.socket.onopen = () => {
        this.status = 'open';
        this.reconnectAttempts = 0;
        this.lastPongAt = this.now();
        this.startHeartbeat();
      };
      this.socket.onmessage = (event) => this.handleMessage(event.data);
      this.socket.onclose = () => this.handleClose();
    }, delay);
  }
}

/**
 * @summary Default reconnect delay: exponential backoff, capped at 10 seconds.
 * @param {number} attempt The reconnect attempt count.
 * @returns {number} The delay in milliseconds.
 * @internal
 */
function defaultRetryDelay(attempt: number): number {
  return Math.min(10_000, 100 * Math.pow(2, attempt));
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `sub-${++counter}`;
}
