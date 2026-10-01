/**
 * @fileoverview
 * @summary Shared packet types for manager-to-manager communication.
 * @description
 * Defines the packet model used by the Message Queue and the Notification
 * Center. A packet has two halves:
 *
 * ```text
 *   Packet
 *   +-- envelope    (serializable, crosses MessageChannel / BroadcastChannel)
 *   +-- callbacks   (local only, resolved by correlation id)
 *   ```
 *
 * The envelope carries `eventId`, `actionName`, `payload`, `importance`,
 * `metadata`, and a `fingerprints` trail. The callbacks (`onComplete`,
 * `onError`, `onLog`) never cross the wire. `postMessage` uses structured
 * clone, which rejects functions and symbols. The sender stores its callbacks
 * in a {@linkcode CorrelationRegistry} and resolves them by `correlationId`
 * when the response envelope returns.
 *
 * @see {@linkcode Packet}
 * @see {@linkcode PacketEnvelope}
 * @see {@linkcode CorrelationRegistry}
 * @author MathAid
 */

/**
 * @summary Priority of a packet for scheduling.
 * @description
 * The Message Queue schedules packets by this value. `CRITICAL` packets pass
 * while the platform is `BUSY`. `LOW` and `MEDIUM` packets are held or rejected.
 */
export type Importance = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * @summary Severity of an error or log entry.
 * @description
 * Independent of {@linkcode Importance}. `Importance` drives scheduling.
 * `Severity` drives logging and alerting.
 */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * @summary Log level for a {@linkcode Fingerprint}.
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * @summary One recorded action in a packet's journey.
 * @description
 * Every manager that handles a packet appends a fingerprint. The Logger
 * consumes the {@linkcode PacketEnvelope.fingerprints} array on completion.
 * The array order is the causal chain. This is what makes a failure
 * traceable from source to sink.
 */
export interface Fingerprint {
  /** Name of the action taken, for example `enqueued` or `handler-executed`. */
  actionName: string;
  /** JS type of the value involved, for example `string` or `object`. */
  valueType: string;
  /** Unix milliseconds when the action happened. */
  timestamp: number;
  /** Id of the manager that took the action. */
  subsystemId: string;
  /** Feature name, worker URL, or `null`. */
  componentId: string | null;
  /** Repeat count when the same action happened many times, or `null`. */
  counter: number | null;
  /** Log level for this action. */
  level: LogLevel;
  /** Optional human message, or `null`. */
  message: string | null;
}

/**
 * @summary Metadata that identifies and correlates a packet.
 * @description
 * Carries routing and tracing fields. `correlationId` links a request envelope
 * to its response envelope. `traceId` and `spanId` link packets across
 * managers. `dependencies` blocks dispatch until the named messages complete.
 */
export interface PacketMetadata {
  /** Unique id of this packet. */
  messageId: string;
  /** Id of the manager that produced the packet. */
  sourceSubsystem: string;
  /** Id of the manager that must receive the packet, or `null` for a broadcast. */
  targetSubsystem: string | null;
  /** Unix milliseconds when the packet was created. */
  timestamp: number;
  /** Time to live in milliseconds, after which the packet is dropped. */
  ttl?: number;
  /** Ids of packets that must complete before this one dispatches. */
  dependencies?: string[];
  /** Id that links a request to its response. */
  correlationId?: string;
  /** Distributed tracing id across managers. */
  traceId?: string;
  /** Individual operation id within a trace. */
  spanId?: string;
  /** Orders packets that share this key. */
  orderingKey?: string;
  /**
   * Optional elevation token for protected operations.
   * @note Only attach this to packets that need elevated access. Never attach
   * it to broadcast packets. It travels in the envelope, so treat it as
   * sensitive.
   */
  authToken?: string;
}

/**
 * @summary The serializable wire form of a packet.
 * @description
 * This is the only part of a packet that crosses `MessageChannel` or
 * `BroadcastChannel`. Every field must survive the structured clone
 * algorithm. `eventId` is a string, not a symbol. Symbols are not cloneable.
 * The Notification Center maps the string id to an internal symbol for fast
 * in-realm dispatch.
 *
 * @example
 * Example 1: An auth packet bound for the storage manager
 * ```ts
 * const envelope: PacketEnvelope<{ userId: string }> = {
 *   eventId: 'auth:login-success',
 *   actionName: 'AUTH_LOGIN',
 *   payload: { userId: 'abc' },
 *   importance: 'HIGH',
 *   metadata: {
 *     messageId: crypto.randomUUID(),
 *     sourceSubsystem: 'auth',
 *     targetSubsystem: 'storage',
 *     timestamp: Date.now(),
 *     correlationId: 'corr-123',
 *   },
 *   fingerprints: [],
 * };
 * ```
 *
 * @example
 * Example 2: A broadcast envelope with no single target
 * ```ts
 * const envelope: PacketEnvelope = {
 *   eventId: 'global:network-status-changed',
 *   actionName: 'NETWORK_OFFLINE',
 *   payload: { online: false },
 *   importance: 'HIGH',
 *   metadata: {
 *     messageId: crypto.randomUUID(),
 *     sourceSubsystem: 'global-state',
 *     targetSubsystem: null,
 *     timestamp: Date.now(),
 *   },
 *   fingerprints: [],
 * };
 * ```
 */
export interface PacketEnvelope<P = unknown> {
  /** Stable string id of the event. Mapped to a symbol by the Notification Center. */
  eventId: string;
  /** Human-readable action name for logging and dispatch. */
  actionName: string;
  /** The payload. Must be structured-cloneable. */
  payload: P;
  /** Scheduling priority. */
  importance: Importance;
  /** Routing and tracing metadata. */
  metadata: PacketMetadata;
  /** Accumulated action trail, in order. */
  fingerprints: Fingerprint[];
}

/**
 * @summary The in-realm packet: an envelope plus local callbacks.
 * @description
 * A {@linkcode Packet} never crosses a thread or tab boundary. It is created
 * in the sender's realm. The sender registers its callbacks in a
 * {@linkcode CorrelationRegistry} under `metadata.correlationId`, then posts
 * only the {@linkcode PacketEnvelope}. When the response envelope returns, the
 * registry resolves the callbacks by correlation id.
 *
 * @example
 * Example 1: Building a request packet and posting only its envelope
 * ```ts
 * const packet: Packet<{ q: string }, { results: string[] }> = {
 *   envelope: {
 *     eventId: 'search:query',
 *     actionName: 'SEARCH_QUERY',
 *     payload: { q: 'hello' },
 *     importance: 'MEDIUM',
 *     metadata: {
 *       messageId: crypto.randomUUID(),
 *       sourceSubsystem: 'ui',
 *       targetSubsystem: 'network',
 *       timestamp: Date.now(),
 *       correlationId: 'corr-1',
 *     },
 *     fingerprints: [],
 *   },
 *   onComplete: (r) => console.log(r.results),
 *   onError: (e) => console.error(e),
 *   onLog: null,
 * };
 *
 * registry.register(packet.envelope.metadata.correlationId!, packet);
 * channel.postMessage(packet.envelope); // envelope only, never the callbacks
 * ```
 */
export interface Packet<P = unknown, R = unknown> {
  /** The serializable envelope. This is what crosses the wire. */
  readonly envelope: PacketEnvelope<P>;
  /** Called with the result when the response resolves. */
  onComplete: (result: R) => void;
  /** Called with the error when the response rejects. */
  onError: (error: Error) => void;
  /** Optional log hook that receives the final fingerprint trail. */
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
}

/**
 * @summary A string id that links a request envelope to its response.
 * @description
 * The sender generates this id, stores its callbacks under it, and posts the
 * envelope. The receiver echoes the id in the response envelope. The sender
 * resolves the stored callbacks when the response returns.
 */
export type CorrelationId = string;

/**
 * @summary Creates a fingerprint for the packet trail.
 * @description
 * A manager appends one of these to `PacketEnvelope.fingerprints` at each
 * lifecycle point it handles the packet. The array order is the causal chain.
 * The Logger consumes the array on completion.
 *
 * @example
 * Example 1: Append an "enqueued" fingerprint
 * ```ts
 * envelope.fingerprints.push(makeFingerprint('message-queue', 'enqueued', { timestamp: Date.now() }));
 * ```
 *
 * @param {string} subsystemId The manager that took the action.
 * @param {string} actionName The name of the action.
 * @param {object} [options] Optional field overrides.
 * @returns {Fingerprint} The fingerprint.
 */
export function makeFingerprint(
  subsystemId: string,
  actionName: string,
  options: {
    valueType?: string;
    timestamp?: number;
    componentId?: string | null;
    counter?: number | null;
    level?: LogLevel;
    message?: string | null;
  } = {},
): Fingerprint {
  return {
    actionName,
    valueType: options.valueType ?? 'string',
    timestamp: options.timestamp ?? Date.now(),
    subsystemId,
    componentId: options.componentId ?? null,
    counter: options.counter ?? null,
    level: options.level ?? 'INFO',
    message: options.message ?? null,
  };
}
