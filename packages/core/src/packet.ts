/**
 * @fileoverview
 * @summary Packets: serializable envelopes, read-once payloads and bounded fingerprint trails.
 * @description
 * Implements docs/ARCHITECTURE.md §9:
 *
 * ```text
 *   PacketEnvelope (serializable: crosses channels, workers, tabs and the network)
 *   +-- eventId, actionName, importance
 *   +-- metadata      ids, source/target, scope, trace ids, ttl, ...
 *   +-- fingerprints  bounded trail: first `head` + last `tail` entries, plus a dropped count
 *   +-- payload
 *
 *   Packet (in-realm): the envelope's header plus a payload readable once (take())
 *   ```
 *
 * Callbacks never travel with the envelope; see {@linkcode CorrelationRegistry}.
 *
 * @author MathAid
 */

import type { Scope } from './scope';

/** @summary Scheduling priority. `CRITICAL` packets pass while the platform is `BUSY`. */
export type Importance = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** @summary Log level of a fingerprint. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** @summary One recorded action in a packet's history. */
export interface Fingerprint {
  /** What happened, for example `sent`, `delivered`, `handled`. */
  readonly actionName: string;
  /** JS type of the value involved. */
  readonly valueType: string;
  /** Unix milliseconds. */
  readonly timestamp: number;
  /** The subsystem that acted. */
  readonly subsystemId: string;
  /** The feature, worker or state key involved, or `null`. */
  readonly componentId: string | null;
  /** How many times the same action repeated, or `null`. */
  readonly counter: number | null;
  readonly level: LogLevel;
  readonly message: string | null;
}

/** @summary A bounded fingerprint trail (§9.3). */
export interface FingerprintTrail {
  /** The first `head` entries, then the last `tail` entries, in order. */
  readonly entries: readonly Fingerprint[];
  /** How many entries between the head and the tail were dropped. */
  readonly dropped: number;
}

/** @summary How many fingerprints a trail keeps. */
export interface TrailLimits {
  readonly head: number;
  readonly tail: number;
}

/** @summary The default trail limits: 16 + 48. */
export const DEFAULT_TRAIL_LIMITS: TrailLimits = { head: 16, tail: 48 };

/** @summary An empty trail. */
export const EMPTY_TRAIL: FingerprintTrail = Object.freeze({
  entries: Object.freeze([]),
  dropped: 0,
});

/**
 * @summary Returns a new trail with `fingerprint` appended, keeping the head and the tail.
 * @param {FingerprintTrail} trail The current trail.
 * @param {Fingerprint} fingerprint The new entry.
 * @param {TrailLimits} [limits] How many entries to keep.
 * @returns {FingerprintTrail} The new trail.
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
 * @summary Creates a fingerprint, filling unspecified fields with defaults.
 * @param {string} subsystemId The subsystem that acted.
 * @param {string} actionName What happened.
 * @param {object} [options] Field overrides.
 * @returns {Fingerprint} The fingerprint.
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

/** @summary Routing and tracing metadata. */
export interface PacketMetadata {
  /** Unique id of this packet. */
  readonly messageId: string;
  /** The sending subsystem. */
  readonly source: string;
  /** The target subsystem, or `null` for a broadcast. */
  readonly target: string | null;
  /** The packet's scope: for a broadcast, how far it reaches (§11.2). */
  readonly scope: Scope;
  /** Unix milliseconds when the packet was created. */
  readonly timestamp: number;
  /** Time to live in milliseconds. */
  readonly ttl?: number;
  /** Links a reply to its request. */
  readonly correlationId?: string;
  /** Shared by every packet of one causal chain, across tabs and devices (§9.4). */
  readonly traceId: string;
  /** This packet's span in the trace. */
  readonly spanId: string;
  /** The span that caused this packet. */
  readonly parentSpanId?: string;
  /** Orders packets that share this key. */
  readonly orderingKey?: string;
  /** Elevation token. Never attached to broadcasts. */
  readonly authToken?: string;
}

/** @summary The serializable form of a packet. */
export interface PacketEnvelope<P = unknown> {
  readonly eventId: string;
  readonly actionName: string;
  readonly payload: P;
  readonly importance: Importance;
  readonly metadata: PacketMetadata;
  readonly fingerprints: FingerprintTrail;
}

/** @summary An envelope without its payload. */
export type PacketHeader = Omit<PacketEnvelope, 'payload'>;

/** @summary What a sender provides; the kernel fills in ids, source, scope and time. */
export interface OutgoingPacket<P = unknown> {
  readonly eventId: string;
  readonly payload: P;
  /** Defaults to `eventId`. */
  readonly actionName?: string;
  /** Defaults to `MEDIUM`. */
  readonly importance?: Importance;
  /** The target subsystem. Omit for a broadcast. */
  readonly target?: string;
  readonly ttl?: number;
  readonly orderingKey?: string;
  readonly authToken?: string;
  /** The packet this one was caused by: continues its trace. */
  readonly causedBy?: PacketHeader;
}

/** @summary Generates unique ids. Defaults to `crypto.randomUUID`. */
export type IdFactory = () => string;

/**
 * @summary Builds a complete envelope from an outgoing packet.
 * @param {OutgoingPacket<P>} draft What the sender provided.
 * @param {object} context The sender and its scope, plus id and clock sources.
 * @returns {PacketEnvelope<P>} The envelope.
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

/** @summary Thrown when a packet's payload is read a second time. */
export class PayloadConsumedError extends Error {
  override readonly name = 'PayloadConsumedError';
  constructor(messageId: string) {
    super(
      `Packet ${messageId}: the payload was already taken. A payload is read once per delivery.`,
    );
  }
}

/**
 * @summary An in-realm packet: the envelope's header, plus a payload read once.
 * @description
 * Implements the read-once rule (§9.2, amendment A7): `take()` returns the
 * payload and a second call throws {@linkcode PayloadConsumedError}. With
 * `clone: true` (one packet per broadcast subscriber), `take()` clones the
 * payload lazily, so a subscriber that never reads it costs nothing.
 *
 * @example
 * ```ts
 * const packet = new Packet(envelope);
 * const payload = packet.take();
 * packet.take(); // throws PayloadConsumedError
 * ```
 */
export class Packet<P = unknown> {
  #header: PacketHeader;
  readonly #payload: P;
  readonly #clone: boolean;
  #consumed = false;

  constructor(envelope: PacketEnvelope<P>, options: { readonly clone?: boolean } = {}) {
    const { payload, ...header } = envelope;
    this.#header = header;
    this.#payload = payload;
    this.#clone = options.clone ?? false;
  }

  /** @summary Everything except the payload. */
  get header(): PacketHeader {
    return this.#header;
  }

  /** @summary True once the payload was taken or forwarded. */
  get consumed(): boolean {
    return this.#consumed;
  }

  /**
   * @summary Returns the payload. Allowed once.
   * @throws {PayloadConsumedError} On a second read.
   */
  take(): P {
    this.#consume();
    return this.#clone ? structuredClone(this.#payload) : this.#payload;
  }

  /**
   * @summary Appends a fingerprint to this packet's trail.
   * @param {Fingerprint} fingerprint The entry.
   * @param {TrailLimits} [limits] Trail limits.
   */
  stamp(fingerprint: Fingerprint, limits?: TrailLimits): void {
    this.#header = {
      ...this.#header,
      fingerprints: appendFingerprint(this.#header.fingerprints, fingerprint, limits),
    };
  }

  /**
   * @summary Hands the whole envelope on (to a transport or the next hop). Counts as the read.
   * @throws {PayloadConsumedError} When the payload was already taken.
   */
  forward(): PacketEnvelope<P> {
    this.#consume();
    return { ...this.#header, payload: this.#payload };
  }

  #consume(): void {
    if (this.#consumed) throw new PayloadConsumedError(this.#header.metadata.messageId);
    this.#consumed = true;
  }
}
