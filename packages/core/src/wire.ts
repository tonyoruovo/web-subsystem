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
 *   "payload": {}, "metadata": { "messageId": "...", ... },
 *   "fingerprints": { "entries": [], "dropped": 0 } }
 * ```
 *
 * Receivers deduplicate by `metadata.messageId` (at-least-once delivery).
 *
 * @author MathAid
 */

import { z } from 'zod';

import type { PacketEnvelope } from './packet';
import { SCOPES } from './scope';

/** @summary The current wire protocol version. */
export const WIRE_PROTOCOL_VERSION = 1;

const nonEmpty = z.string().min(1);

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

/** @summary The schema of a version-1 wire envelope. */
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

/** @summary A version-1 wire envelope. */
export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>;

/** @summary Thrown when data is not a valid wire envelope. */
export class WireProtocolError extends Error {
  override readonly name = 'WireProtocolError';
  constructor(
    message: string,
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * @summary Serializes an envelope for the wire.
 * @param {PacketEnvelope} envelope The envelope. Its payload must be JSON-serializable.
 * @returns {string} The JSON text.
 * @throws {WireProtocolError} When the result would not be a valid wire envelope.
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
 * @param {string | unknown} input JSON text, or an already-parsed value.
 * @returns {PacketEnvelope} The envelope, without the version field.
 * @throws {WireProtocolError} On invalid JSON, an unsupported version, or a schema violation.
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
