/**
 * @fileoverview
 * @summary The Global-scope wire protocol: the versioned JSON form of a packet envelope.
 * @description
 * Implements docs/ARCHITECTURE.md §11.4. This project ships only the protocol
 * (this schema, its documentation and conformance fixtures); servers that
 * carry Global packets implement it.
 *
 * ```json
 * { "v": 1, "eventId": "...", "actionName": "...", "importance": "HIGH",
 *   "payload": {}, "metadata": { "messageId": "...", "...": "..." },
 *   "fingerprints": { "entries": [], "dropped": 0 } }
 * ```
 *
 * Delivery is at least once: receivers deduplicate by `metadata.messageId`.
 * An elevation token (`metadata.authToken`) is never valid on a broadcast.
 *
 * @example
 * Sending a Global packet over a WebSocket
 * ```ts
 * import { encodeWire } from '@platform/core';
 *
 * socket.send(encodeWire(envelope));
 * ```
 *
 * @example
 * Receiving one, rejecting anything malformed
 * ```ts
 * import { WireProtocolError, decodeWire } from '@platform/core';
 *
 * socket.addEventListener('message', ({ data }) => {
 *   try {
 *     deliver(decodeWire(data));
 *   } catch (error) {
 *     if (error instanceof WireProtocolError) console.warn(error.message, error.issues);
 *   }
 * });
 * ```
 *
 * @throws {WireProtocolError} From {@linkcode encodeWire} and {@linkcode decodeWire} for anything that is not a valid version-1 envelope.
 * @see {@link https://zod.dev Zod}
 * @author MathAid
 */

import { z } from 'zod';

import type { PacketEnvelope } from './packet';
import { SCOPES } from './scope';

/**
 * @summary The current wire protocol version: `1`.
 * @description Sent as the `v` field of every wire envelope. A receiver
 * rejects any other version.
 * @constant {1}
 * @public
 */
export const WIRE_PROTOCOL_VERSION = 1;

/** @summary A non-empty string. @internal */
const nonEmpty = z.string().min(1);

/** @summary The wire schema of one fingerprint. @internal */
const FingerprintSchema = z.object({
  actionName: nonEmpty,
  valueType: z.string(),
  timestamp: z.number().nonnegative(),
  subsystemId: nonEmpty,
  componentId: z.string().nullable(),
  counter: z.number().int().nonnegative().nullable(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']),
  message: z.string().nullable(),
});

/** @summary The wire schema of packet metadata. @internal */
const MetadataSchema = z.object({
  messageId: nonEmpty,
  source: nonEmpty,
  target: nonEmpty.nullable(),
  scope: z.enum(SCOPES),
  timestamp: z.number().nonnegative(),
  ttl: z.number().int().positive().optional(),
  correlationId: nonEmpty.optional(),
  traceId: nonEmpty,
  spanId: nonEmpty,
  parentSpanId: nonEmpty.optional(),
  orderingKey: nonEmpty.optional(),
  authToken: nonEmpty.optional(),
});

/**
 * @summary The zod schema of a version-1 wire envelope.
 *
 * @description
 * Validates every field of a {@linkcode PacketEnvelope} plus the version field
 * `v`, and refuses an `authToken` on a broadcast (`target: null`). The payload
 * itself is not validated: it belongs to the event's own schema.
 *
 * Use it on a server, or in a conformance test, to validate envelopes without
 * this package's encode and decode helpers.
 *
 * @example
 * Example 1: Validating on a Node server
 * ```ts
 * const result = WireEnvelopeSchema.safeParse(JSON.parse(body));
 * if (!result.success) return reply.status(400).send(result.error.issues);
 * ```
 *
 * @example
 * Example 2: Generating a JSON Schema for other languages
 * ```ts
 * import { z } from 'zod';
 * const jsonSchema = z.toJSONSchema(WireEnvelopeSchema);
 * ```
 *
 * @constant
 * @public
 */
export const WireEnvelopeSchema = z
  .object({
    v: z.literal(WIRE_PROTOCOL_VERSION),
    eventId: nonEmpty,
    actionName: nonEmpty,
    importance: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    payload: z.unknown(),
    metadata: MetadataSchema,
    fingerprints: z.object({
      entries: z.array(FingerprintSchema),
      dropped: z.number().int().nonnegative(),
    }),
  })
  .refine((envelope) => envelope.metadata.target !== null || !envelope.metadata.authToken, {
    message: 'An elevation token must never be attached to a broadcast.',
    path: ['metadata', 'authToken'],
  });

/**
 * @summary A version-1 wire envelope: a {@linkcode PacketEnvelope} plus `v: 1`.
 * @public
 */
export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>;

/**
 * @summary Thrown when data is not a valid wire envelope.
 *
 * @description
 * `issues` lists the schema violations (empty for invalid JSON or an
 * unsupported version), in zod's issue format.
 *
 * @example
 * Example 1: Reporting what was wrong
 * ```ts
 * catch (error) {
 *   if (error instanceof WireProtocolError) for (const issue of error.issues) console.warn(issue.path, issue.message);
 * }
 * ```
 *
 * @example
 * Example 2: An unsupported version
 * ```ts
 * decodeWire('{"v":2}'); // throws WireProtocolError: Unsupported wire protocol version: 2.
 * ```
 *
 * @public
 */
export class WireProtocolError extends Error {
  /**
   * @summary The name of the error class: `'WireProtocolError'`.
   */
  override readonly name = 'WireProtocolError';

  /**
   * @summary Creates the error for one refused envelope.
   * @param {string} message What went wrong.
   * @param {readonly z.core.$ZodIssue[]} [issues] The schema violations, if any.
   */
  constructor(
    message: string,
    /**
     * @summary The schema violations, as zod reports them.
     * @description The list is empty when the input is not JSON or has the wrong version.
     */
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * @summary Serializes an envelope for the wire.
 *
 * @description
 * Adds `v: 1`, validates the result against {@linkcode WireEnvelopeSchema}
 * and returns it as JSON text. Validating before sending keeps malformed
 * envelopes from ever reaching a server.
 *
 * @example
 * Example 1: Over a WebSocket
 * ```ts
 * socket.send(encodeWire(envelope));
 * ```
 *
 * @example
 * Example 2: Over HTTP
 * ```ts
 * await fetch('/global', { method: 'POST', body: encodeWire(envelope), headers: { 'content-type': 'application/json' } });
 * ```
 *
 * @param {PacketEnvelope} envelope The envelope. Its payload must be JSON-serializable.
 * @returns {string} The JSON text.
 * @throws {WireProtocolError} When the result would not be a valid wire envelope.
 *
 * @public
 */
export function encodeWire(envelope: PacketEnvelope): string {
  const wire = { v: WIRE_PROTOCOL_VERSION, ...envelope };
  const result = WireEnvelopeSchema.safeParse(wire);
  if (!result.success) {
    throw new WireProtocolError('Envelope is not a valid wire envelope.', result.error.issues);
  }
  return JSON.stringify(wire);
}

/**
 * @summary Parses and validates a wire envelope.
 *
 * @description
 * Accepts JSON text or an already-parsed value, checks the version first (so
 * a newer protocol fails with a clear message), validates the rest, and
 * returns the envelope without the `v` field.
 *
 * @example
 * Example 1: From a WebSocket message
 * ```ts
 * socket.addEventListener('message', ({ data }) => deliver(decodeWire(data)));
 * ```
 *
 * @example
 * Example 2: From a parsed HTTP body
 * ```ts
 * const envelope = decodeWire(await response.json());
 * ```
 *
 * @param {string | unknown} input JSON text, or an already-parsed value.
 * @returns {PacketEnvelope} The envelope, without the version field.
 * @throws {WireProtocolError} On invalid JSON, an unsupported version, or a schema violation.
 *
 * @public
 */
export function decodeWire(input: string | unknown): PacketEnvelope {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new WireProtocolError('Wire envelope is not valid JSON.');
    }
  }
  const version = (value as { v?: unknown } | null)?.v;
  if (version !== WIRE_PROTOCOL_VERSION) {
    throw new WireProtocolError(`Unsupported wire protocol version: ${String(version)}.`);
  }
  const result = WireEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new WireProtocolError('Invalid wire envelope.', result.error.issues);
  }
  const { v: _version, ...envelope } = result.data;
  return envelope as PacketEnvelope;
}
