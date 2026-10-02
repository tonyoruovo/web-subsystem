/**
 * @fileoverview
 * @summary Packets: serializable envelopes, read-once payloads and bounded fingerprint trails.
 * @description
 * Implements docs/ARCHITECTURE.md §9.
 *
 * ```text
 *   PacketEnvelope (serializable: crosses channels, workers, tabs and the network)
 *   +-- eventId, actionName, importance
 *   +-- metadata      ids, source and target, scope, trace ids, ttl, ...
 *   +-- fingerprints  bounded trail: first `head` + last `tail` entries, plus a dropped count
 *   +-- payload
 *
 *   Packet (in-realm): the envelope's header, plus a payload readable once (take())
 *   ```
 *
 * Senders describe a packet as an {@linkcode OutgoingPacket}; the kernel turns
 * it into a {@linkcode PacketEnvelope} with {@linkcode createEnvelope}, and a
 * receiver gets it as a {@linkcode Packet}. Callbacks never travel with an
 * envelope: replies are matched by correlation id (see `correlation.ts`).
 *
 * @example
 * Receiving a packet in a subsystem
 * ```ts
 * defineSubsystem({
 *   id: 'storage',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   state: { initial: {} },
 *   receive: (packet) => {
 *     const { key, value } = packet.take() as { key: string; value: unknown };
 *     return write(key, value);
 *   },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 * ```
 *
 * @example
 * Continuing a trace from a received packet
 * ```ts
 * receive: (packet, ctx) =>
 *   ctx.port.request({ eventId: 'logger:write', payload: 'stored', target: 'logger', causedBy: packet.header }),
 * ```
 *
 * @throws {PayloadConsumedError} From {@linkcode Packet.take} and {@linkcode Packet.forward} on a second read.
 * @author MathAid
 */

import type { Scope } from './scope';

/**
 * @summary Scheduling priority of a packet.
 * @description
 * `CRITICAL` packets pass while the platform is `BUSY`; the Queue (M3) holds
 * or rejects `LOW` and `MEDIUM` ones then. Independent of a fingerprint's
 * {@linkcode LogLevel}.
 *
 * @public
 */
export type Importance = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * @summary Log level of a fingerprint.
 * @public
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * @summary One recorded action in a packet's history.
 *
 * @description
 * Records what happened (`actionName`), when (`timestamp`), who acted
 * (`subsystemId`, and the feature or worker as `componentId`), and how serious
 * it was (`level`). `counter` collapses repeated identical actions and
 * `message` adds free text.
 *
 * Every hop a packet takes appends one, so the trail explains a packet's path
 * from its sender to its sink. The Logger joins trails by trace id.
 *
 * @example
 * Example 1: The fingerprint a port adds when a feature sends
 * ```ts
 * // { actionName: 'sent', subsystemId: 'storage', componentId: 'idb', level: 'INFO', ... }
 * ```
 *
 * @example
 * Example 2: Recording a retry
 * ```ts
 * packet.stamp(makeFingerprint('queue', 'retried', { counter: 2, level: 'WARN' }));
 * ```
 *
 * @public
 * @see {@linkcode makeFingerprint}
 */
export interface Fingerprint {
  /**
   * @summary The name of the action, for example `sent`, `delivered` or `failed`.
   * @description The platform uses a small set of names: `sent`, `enqueued`,
   * `dispatched`, `delivered`, `completed`, `failed`, `retry-scheduled`,
   * `dead-lettered`, `rejected`, `fanned-out` and `relayed`. Subsystems can add their own.
   */
  readonly actionName: string;
  /**
   * @summary The JavaScript type of the value that the action used.
   * @description The value is the result of `typeof`, or `'undefined'` when no value applies.
   */
  readonly valueType: string;
  /**
   * @summary The time of the action, in Unix milliseconds.
   */
  readonly timestamp: number;
  /**
   * @summary The id of the subsystem that did the action.
   */
  readonly subsystemId: string;
  /**
   * @summary The feature, worker or state key that did the action, or `null`.
   * @description For example, `idb` when the `storage/idb` feature sends a packet.
   */
  readonly componentId: string | null;
  /**
   * @summary The number of times that the same action occurred, or `null`.
   * @description The Queue sets it on `retry-scheduled` to show the attempt number.
   */
  readonly counter: number | null;
  /**
   * @summary The severity of the action.
   * @description `WARN` and higher show a problem. The Logger uses the level to filter.
   */
  readonly level: LogLevel;
  /**
   * @summary Free text about the action, or `null`.
   * @description Failures put the error message here.
   */
  readonly message: string | null;
}

/**
 * @summary A bounded fingerprint trail (ARCHITECTURE §9.3).
 *
 * @description
 * `entries` holds the first `head` and the last `tail` fingerprints, in order;
 * `dropped` counts the ones removed between them. Keeping both ends means the
 * origin and the outcome of a long chain are never lost.
 *
 * @example
 * Example 1: A short trail
 * ```ts
 * // { entries: [sent, delivered], dropped: 0 }
 * ```
 *
 * @example
 * Example 2: A long trail that was trimmed
 * ```ts
 * // { entries: [16 oldest ..., 48 newest ...], dropped: 7 }
 * ```
 *
 * @public
 * @see {@linkcode appendFingerprint}
 */
export interface FingerprintTrail {
  /**
   * @summary The kept fingerprints, oldest first.
   * @description The list holds the first `head` entries and the last `tail`
   * entries of the trail. The entries between the two parts are removed.
   */
  readonly entries: readonly Fingerprint[];
  /**
   * @summary The number of entries removed between the head and the tail.
   * @description A value of `0` means that the trail is complete.
   */
  readonly dropped: number;
}

/**
 * @summary How many fingerprints a trail keeps at each end.
 *
 * @example
 * Tight limits for a high-volume event
 * ```ts
 * packet.stamp(fingerprint, { head: 4, tail: 8 });
 * ```
 *
 * @public
 */
export interface TrailLimits {
  /**
   * @summary The number of entries to keep from the start of the trail.
   * @description These entries show where the packet came from. The default is 16.
   */
  readonly head: number;
  /**
   * @summary The number of entries to keep from the end of the trail.
   * @description These entries show the last steps and the result. The default is 48.
   */
  readonly tail: number;
}

/**
 * @summary The default trail limits: the first 16 and the last 48 fingerprints.
 * @constant
 * @public
 */
export const DEFAULT_TRAIL_LIMITS: TrailLimits = { head: 16, tail: 48 };

/**
 * @summary An empty, frozen trail: the starting trail of every envelope.
 * @constant
 * @public
 */
export const EMPTY_TRAIL: FingerprintTrail = Object.freeze({
  entries: Object.freeze([]),
  dropped: 0,
});

/**
 * @summary Returns a new trail with `fingerprint` appended, keeping the head and the tail.
 *
 * @description
 * Never mutates `trail`. When the trail would exceed `head + tail` entries,
 * the oldest entry of the tail section is removed and `dropped` grows by one.
 *
 * ```text
 *   head=2, tail=3, appending a9:
 *   [a0 a1 | a6 a7 a8]  -->  [a0 a1 | a7 a8 a9]  dropped + 1
 *   ```
 *
 * @example
 * Example 1: Appending to an envelope's trail
 * ```ts
 * const next = { ...envelope, fingerprints: appendFingerprint(envelope.fingerprints, fingerprint) };
 * ```
 *
 * @example
 * Example 2: Custom limits
 * ```ts
 * const trail = appendFingerprint(EMPTY_TRAIL, fingerprint, { head: 2, tail: 2 });
 * ```
 *
 * @param {FingerprintTrail} trail The current trail.
 * @param {Fingerprint} fingerprint The new entry.
 * @param {TrailLimits} [limits=DEFAULT_TRAIL_LIMITS] How many entries to keep.
 * @returns {FingerprintTrail} The new trail.
 *
 * @public
 */
export function appendFingerprint(
  trail: FingerprintTrail,
  fingerprint: Fingerprint,
  limits: TrailLimits = DEFAULT_TRAIL_LIMITS,
): FingerprintTrail {
  const entries = [...trail.entries, fingerprint];
  let dropped = trail.dropped;
  if (entries.length > limits.head + limits.tail) {
    entries.splice(limits.head, 1); // the oldest entry of the tail section
    dropped += 1;
  }
  return { entries, dropped };
}

/**
 * @summary Creates a {@linkcode Fingerprint}, filling unspecified fields with defaults.
 *
 * @description
 * Defaults: `valueType` `'undefined'`, `timestamp` `Date.now()`, `componentId`
 * and `counter` and `message` `null`, `level` `'INFO'`.
 *
 * @example
 * Example 1: A delivery fingerprint
 * ```ts
 * packet.stamp(makeFingerprint('storage', 'delivered'));
 * ```
 *
 * @example
 * Example 2: A failure with details
 * ```ts
 * makeFingerprint('sync', 'failed', { level: 'ERROR', message: 'HTTP 503', componentId: 'pull' });
 * ```
 *
 * @param {string} subsystemId The subsystem that acted.
 * @param {string} actionName What happened.
 * @param {object} [options] Overrides for the other fields.
 * @returns {Fingerprint} The fingerprint.
 *
 * @public
 */
export function makeFingerprint(
  subsystemId: string,
  actionName: string,
  options: Partial<Omit<Fingerprint, 'subsystemId' | 'actionName'>> = {},
): Fingerprint {
  return {
    actionName,
    valueType: options.valueType ?? 'undefined',
    timestamp: options.timestamp ?? Date.now(),
    subsystemId,
    componentId: options.componentId ?? null,
    counter: options.counter ?? null,
    level: options.level ?? 'INFO',
    message: options.message ?? null,
  };
}

/**
 * @summary Routing and tracing metadata of a packet.
 *
 * @description
 * Identifies the packet (`messageId`), its route (`source`, `target`,
 * `scope`), its timing (`timestamp`, `ttl`), and its place in a trace
 * (`traceId`, `spanId`, `parentSpanId`). `correlationId` links a request to
 * its reply, `orderingKey` orders related packets, and `authToken` carries an
 * elevation token for protected requests.
 *
 * The kernel fills it in from an {@linkcode OutgoingPacket}; routers and
 * transports read it to deliver the packet.
 *
 * @example
 * Example 1: A request's metadata
 * ```ts
 * // { messageId: 'm1', source: 'auth', target: 'storage', scope: 'window',
 * //   timestamp: 1700000000000, correlationId: 'c1', traceId: 't1', spanId: 's1' }
 * ```
 *
 * @example
 * Example 2: Rejecting expired packets
 * ```ts
 * const { timestamp, ttl } = envelope.metadata;
 * if (ttl !== undefined && Date.now() > timestamp + ttl) drop(envelope);
 * ```
 *
 * @public
 */
export interface PacketMetadata {
  /**
   * @summary The unique id of this packet.
   * @description Receivers use it to drop a packet that arrives two times.
   */
  readonly messageId: string;
  /**
   * @summary The id of the subsystem that sent the packet.
   * @description A feature sends with the id of its parent subsystem.
   */
  readonly source: string;
  /**
   * @summary The id of the target subsystem, or `null` for a broadcast.
   */
  readonly target: string | null;
  /**
   * @summary The scope of the packet.
   * @description For a broadcast, the scope sets how far the packet goes
   * (ARCHITECTURE §11.2). A broadcast always has the scope of its sender.
   */
  readonly scope: Scope;
  /**
   * @summary The time when the sender made the packet, in Unix milliseconds.
   */
  readonly timestamp: number;
  /**
   * @summary The time to live, in milliseconds.
   * @description When `timestamp + ttl` is in the past, the kernel and the
   * Queue do not deliver the packet. Without a value, the packet does not expire.
   */
  readonly ttl?: number;
  /**
   * @summary The id that links a reply to its request.
   */
  readonly correlationId?: string;
  /**
   * @summary The id of the trace: one value for all packets of one causal chain.
   * @description The value stays the same across tabs and devices, so the
   * Logger can join the trails of one chain (ARCHITECTURE §9.4).
   */
  readonly traceId: string;
  /**
   * @summary The id of this packet's span in the trace.
   */
  readonly spanId: string;
  /**
   * @summary The id of the span that caused this packet.
   * @description It is absent on the first packet of a trace.
   */
  readonly parentSpanId?: string;
  /**
   * @summary A key that keeps related packets in order.
   * @description The Queue delivers packets with the same key one at a time, in the order that they arrived.
   */
  readonly orderingKey?: string;
  /**
   * @summary An elevation token for a protected request.
   * @description The wire protocol refuses a broadcast that has a token.
   */
  readonly authToken?: string;
}

/**
 * @summary The serializable form of a packet.
 *
 * @description
 * Everything a packet carries: `eventId` and `actionName` (what it is about),
 * the `payload`, its `importance`, its {@linkcode PacketMetadata}, and its
 * {@linkcode FingerprintTrail}. Every field survives `structuredClone` and,
 * for Global packets, JSON.
 *
 * Envelopes are what crosses boundaries: routers, transports and the wire
 * protocol all move envelopes. Inside a realm, a receiver gets a
 * {@linkcode Packet} instead, which enforces the read-once rule.
 *
 * @example
 * Example 1: Building one
 * ```ts
 * const envelope = createEnvelope(
 *   { eventId: 'storage:put', payload: { key: 'a' }, target: 'storage' },
 *   { source: 'auth', scope: 'window' },
 * );
 * ```
 *
 * @example
 * Example 2: Sending it over a transport
 * ```ts
 * const reply = await transport.request(envelope);
 * ```
 *
 * @template P The payload type.
 * @public
 */
export interface PacketEnvelope<P = unknown> {
  /**
   * @summary The stable id of the event, for example `storage:put`.
   * @description Subscribers list event ids in `subscribes`. Access control in
   * the NotificationCenter also uses the event id.
   */
  readonly eventId: string;
  /**
   * @summary A name of the action for logs.
   * @description The default is the event id.
   */
  readonly actionName: string;
  /**
   * @summary The data of the packet.
   * @description The value must be structured-cloneable. Global packets must also be JSON values.
   */
  readonly payload: P;
  /**
   * @summary The scheduling priority of the packet.
   */
  readonly importance: Importance;
  /**
   * @summary The routing and tracing data of the packet.
   */
  readonly metadata: PacketMetadata;
  /**
   * @summary The bounded history of the packet.
   */
  readonly fingerprints: FingerprintTrail;
}

/**
 * @summary An envelope without its payload: what a {@linkcode Packet} exposes freely.
 *
 * @example
 * Passing the header on to continue a trace
 * ```ts
 * ctx.port.send({ eventId: 'audit', payload: null, causedBy: packet.header });
 * ```
 *
 * @public
 */
export type PacketHeader = Omit<PacketEnvelope, 'payload'>;

/**
 * @summary What a sender provides; the kernel fills in ids, source, scope and time.
 *
 * @description
 * Only `eventId` and `payload` are required. Add `target` for a 1-to-1
 * request (omit it for a broadcast), `importance` to change scheduling, `ttl`
 * to drop stale packets, `orderingKey` to keep related packets in order,
 * `authToken` for protected requests, and `causedBy` to continue the trace of
 * the packet being handled.
 *
 * It is the argument of `ctx.port.send` and `ctx.port.request`.
 *
 * @example
 * Example 1: A broadcast
 * ```ts
 * await ctx.port.send({ eventId: 'settings:changed', payload: { theme: 'dark' } });
 * ```
 *
 * @example
 * Example 2: A time-limited, high-priority request
 * ```ts
 * await ctx.port.request({
 *   eventId: 'auth:refresh',
 *   payload: null,
 *   target: 'auth',
 *   importance: 'HIGH',
 *   ttl: 5_000,
 * });
 * ```
 *
 * @template P The payload type.
 * @public
 */
export interface OutgoingPacket<P = unknown> {
  /**
   * @summary The stable id of the event, for example `storage:put`.
   */
  readonly eventId: string;
  /**
   * @summary The data of the packet.
   * @description The value must be structured-cloneable.
   */
  readonly payload: P;
  /**
   * @summary A name of the action for logs.
   * @description The default is `eventId`.
   */
  readonly actionName?: string;
  /**
   * @summary The scheduling priority.
   * @description The default is `MEDIUM`. Use `CRITICAL` only for packets that
   * must pass while the platform is `BUSY`.
   */
  readonly importance?: Importance;
  /**
   * @summary The id of the target subsystem.
   * @description Leave it out to send a broadcast.
   */
  readonly target?: string;
  /**
   * @summary The time to live, in milliseconds.
   * @description The packet is not delivered after this time.
   */
  readonly ttl?: number;
  /**
   * @summary A key that keeps related packets in order.
   */
  readonly orderingKey?: string;
  /**
   * @summary An elevation token for a protected request.
   * @description Do not set it on a broadcast.
   */
  readonly authToken?: string;
  /**
   * @summary The header of the packet that caused this one.
   * @description The new packet continues the trace of that packet: it gets the
   * same `traceId`, and its `parentSpanId` is the `spanId` of that packet.
   */
  readonly causedBy?: PacketHeader;
}

/**
 * @summary Generates unique ids. The kernel's default is `crypto.randomUUID`.
 *
 * @example
 * Deterministic ids for tests
 * ```ts
 * let n = 0;
 * const ids: IdFactory = () => `id-${++n}`;
 * ```
 *
 * @public
 */
export type IdFactory = () => string;

/**
 * @summary Builds a complete {@linkcode PacketEnvelope} from an {@linkcode OutgoingPacket}.
 *
 * @description
 * Assigns a new `messageId` and `spanId`, sets `source`, `scope` and
 * `timestamp` from `context`, and continues the trace of `draft.causedBy`
 * (same `traceId`, `parentSpanId` set to its `spanId`) or starts a new one.
 * Optional fields are only present when given. The trail starts empty.
 *
 * The kernel calls it for every packet a port sends. Call it directly to
 * build envelopes for transports or tests.
 *
 * @example
 * Example 1: A request envelope
 * ```ts
 * const envelope = createEnvelope(
 *   { eventId: 'storage:get', payload: { key: 'theme' }, target: 'storage' },
 *   { source: 'settings', scope: 'window', correlationId: crypto.randomUUID() },
 * );
 * ```
 *
 * @example
 * Example 2: Deterministic ids and time in a test
 * ```ts
 * let n = 0;
 * createEnvelope(draft, { source: 'a', scope: 'tab', ids: () => `id-${++n}`, now: () => 1_000 });
 * ```
 *
 * @template P The payload type.
 * @param {OutgoingPacket<P>} draft What the sender provided.
 * @param {object} context The sender and its scope, an optional correlation id, and optional id and clock sources.
 * @returns {PacketEnvelope<P>} The envelope.
 *
 * @public
 */
export function createEnvelope<P>(
  draft: OutgoingPacket<P>,
  context: {
    readonly source: string;
    readonly scope: Scope;
    readonly ids?: IdFactory;
    readonly now?: () => number;
    readonly correlationId?: string;
  },
): PacketEnvelope<P> {
  const ids = context.ids ?? (() => crypto.randomUUID());
  const parent = draft.causedBy?.metadata;
  const metadata: PacketMetadata = {
    messageId: ids(),
    source: context.source,
    target: draft.target ?? null,
    scope: context.scope,
    timestamp: (context.now ?? Date.now)(),
    traceId: parent?.traceId ?? ids(),
    spanId: ids(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    ...(draft.ttl !== undefined ? { ttl: draft.ttl } : {}),
    ...(draft.orderingKey !== undefined ? { orderingKey: draft.orderingKey } : {}),
    ...(draft.authToken !== undefined ? { authToken: draft.authToken } : {}),
  };
  return {
    eventId: draft.eventId,
    actionName: draft.actionName ?? draft.eventId,
    payload: draft.payload,
    importance: draft.importance ?? 'MEDIUM',
    metadata,
    fingerprints: EMPTY_TRAIL,
  };
}

/**
 * @summary Thrown when a packet's payload is read a second time.
 *
 * @description
 * A payload is read once per delivery (amendment A7). The message names the
 * packet's `messageId`.
 *
 * @example
 * Example 1: Reading twice
 * ```ts
 * packet.take();
 * packet.take(); // throws PayloadConsumedError
 * ```
 *
 * @example
 * Example 2: Forwarding after reading
 * ```ts
 * packet.take();
 * packet.forward(); // throws PayloadConsumedError: forwarding is the read
 * ```
 *
 * @public
 */
export class PayloadConsumedError extends Error {
  /**
   * @summary The name of the error class: `'PayloadConsumedError'`.
   */
  override readonly name = 'PayloadConsumedError';

  /**
   * @summary Creates the error for one packet.
   * @param {string} messageId The id of the packet.
   */
  constructor(messageId: string) {
    super(
      `Packet ${messageId}: the payload was already taken. A payload is read once per delivery.`,
    );
  }
}

/**
 * @summary An in-realm packet: the envelope's header, plus a payload readable once.
 *
 * @description
 * Wraps a {@linkcode PacketEnvelope}. `header` exposes everything except the
 * payload; `take()` returns the payload once; `forward()` hands the whole
 * envelope on, which also counts as the read; `stamp()` appends a fingerprint.
 *
 * It implements the read-once rule (ARCHITECTURE §9.2, amendment A7). With
 * `clone: true`, used for one packet per broadcast subscriber, `take()` clones
 * the payload lazily, so subscribers cannot affect each other and a subscriber
 * that never reads the payload costs nothing.
 *
 * @example
 * Example 1: Reading a request's payload
 * ```ts
 * receive: (packet) => {
 *   const { key } = packet.take() as { key: string };
 *   return read(key);
 * },
 * ```
 *
 * @example
 * Example 2: A second read throws
 * ```ts
 * const packet = new Packet(envelope);
 * packet.take();
 * packet.take(); // throws PayloadConsumedError
 * ```
 *
 * @example
 * Example 3: A router passing a packet on
 * ```ts
 * packet.stamp(makeFingerprint('queue', 'dispatched'));
 * await transport.request(packet.forward());
 * ```
 *
 * @template P The payload type.
 * @public
 */
export class Packet<P = unknown> {
  #header: PacketHeader;
  readonly #payload: P;
  readonly #clone: boolean;
  #consumed = false;

  /**
   * @summary Wraps an envelope.
   * @param {PacketEnvelope<P>} envelope The envelope to wrap.
   * @param {object} [options] Set `clone: true` to make `take()` return a structured clone.
   */
  constructor(envelope: PacketEnvelope<P>, options: { readonly clone?: boolean } = {}) {
    const { payload, ...header } = envelope;
    this.#header = header;
    this.#payload = payload;
    this.#clone = options.clone ?? false;
  }

  /**
   * @summary All parts of the envelope except the payload.
   * @description The header includes the current fingerprint trail, so it
   * changes after each `stamp`. Reading the header does not count as a read of
   * the payload.
   * @example
   * Continuing the trace of the packet in hand
   * ```ts
   * await ctx.port.send({ eventId: 'audit:read', payload: null, causedBy: packet.header });
   * ```
   * @returns {PacketHeader} The header.
   */
  get header(): PacketHeader {
    return this.#header;
  }

  /**
   * @summary Tells if the payload was read, with `take` or `forward`.
   * @example
   * Reading the payload only when nobody did
   * ```ts
   * if (!packet.consumed) use(packet.take());
   * ```
   * @returns {boolean} `true` after the read.
   */
  get consumed(): boolean {
    return this.#consumed;
  }

  /**
   * @summary Returns the payload. You can read it one time only.
   * @description When the packet was made with `clone: true`, each call
   * returns a structured clone, so a subscriber cannot change the payload of
   * another subscriber.
   * @example
   * Example 1: Reading a request
   * ```ts
   * const { key } = packet.take() as { key: string };
   * ```
   * @example
   * Example 2: A second read throws
   * ```ts
   * packet.take();
   * packet.take(); // PayloadConsumedError
   * ```
   * @returns {P} The payload, or a clone of it.
   * @throws {PayloadConsumedError} When the payload was already read.
   */
  take(): P {
    this.#consume();
    return this.#clone ? structuredClone(this.#payload) : this.#payload;
  }

  /**
   * @summary Adds a fingerprint to the trail of this packet.
   * @description The trail keeps its head and its tail (see {@linkcode appendFingerprint}).
   * Stamping does not read the payload.
   * @example
   * Recording a step in a receiver
   * ```ts
   * packet.stamp(makeFingerprint('storage', 'written', { componentId: 'idb' }));
   * ```
   * @param {Fingerprint} fingerprint The new entry.
   * @param {TrailLimits} [limits] The trail limits. The default is {@linkcode DEFAULT_TRAIL_LIMITS}.
   */
  stamp(fingerprint: Fingerprint, limits?: TrailLimits): void {
    this.#header = {
      ...this.#header,
      fingerprints: appendFingerprint(this.#header.fingerprints, fingerprint, limits),
    };
  }

  /**
   * @summary Returns the full envelope, to send it to a transport or to the next hop.
   * @description Forwarding counts as the read of the payload. After it,
   * `take` and `forward` throw.
   * @example
   * A router that passes the packet on
   * ```ts
   * packet.stamp(makeFingerprint('queue', 'dispatched'));
   * await transport.request(packet.forward());
   * ```
   * @returns {PacketEnvelope<P>} The envelope, with the current trail.
   * @throws {PayloadConsumedError} When the payload was already read.
   */
  forward(): PacketEnvelope<P> {
    this.#consume();
    return { ...this.#header, payload: this.#payload };
  }

  /**
   * @summary Marks the payload as read.
   * @throws {PayloadConsumedError} When it was already read.
   * @internal
   */
  #consume(): void {
    if (this.#consumed) throw new PayloadConsumedError(this.#header.metadata.messageId);
    this.#consumed = true;
  }
}
