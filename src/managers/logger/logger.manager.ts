/**
 * @fileoverview
 * @summary The Logger manager: buffered, sanitized, level-filtered logging.
 * @description
 * Implements the observability foundation of M1. It buffers log entries in a
 * bounded ring, filters by level, sanitizes sensitive fields, and flushes to a
 * destination. Managers replace their `console.warn` stopgaps with this Logger.
 * On abrupt shutdown the destination can be a `sendBeacon` flush.
 *
 * ```text
 *   log(level, message, context)
 *        |-- level filter (drop below minLevel)
 *        |-- sanitize (redact sensitive keys)
 *        v
 *   circular buffer (FIFO eviction at maxBufferSize)
 *        |
 *        v
 *   flush() -> destination (console, storage, beacon)
 *   ```
 *
 * @see {@linkcode Fingerprint}
 * @see {@linkcode LogLevel}
 * @author MathAid
 */

import type { Fingerprint, LogLevel } from '../packet.dto';

/**
 * @summary One buffered log entry.
 */
export interface LogEntry {
  /** Unique id. */
  id: string;
  /** The level. */
  level: LogLevel;
  /** The message. */
  message: string;
  /** The manager that logged, defaults to `logger`. */
  subsystemId: string;
  /** Feature name or `null`. */
  componentId: string | null;
  /** Unix milliseconds. */
  timestamp: number;
  /** The logging session. */
  sessionId: string;
  /** Optional sanitized context. */
  context?: Record<string, unknown>;
}

/**
 * @summary Options for constructing a {@linkcode Logger}.
 */
export interface LoggerOptions {
  /** Max buffered entries. Defaults to 1000. */
  maxBufferSize?: number;
  /** Minimum level to keep. Defaults to `DEBUG`. */
  minLevel?: LogLevel;
  /** Session id. Defaults to `default`. */
  sessionId?: string;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
  /** The sink entries flush to. Defaults to none (flush is a no-op). */
  destination?: (entries: LogEntry[]) => void;
  /** Keys to redact in context, matched case-insensitively. */
  sensitiveKeys?: string[];
}

/**
 * @summary The log level ranks, for filtering.
 */
const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

/**
 * @summary Default sensitive keys to redact.
 */
const DEFAULT_SENSITIVE_KEYS = [
  'token',
  'password',
  'secret',
  'authorization',
  'credential',
  'api_key',
  'apikey',
];

/**
 * @summary The Logger manager.
 * @description
 * A bounded, sanitizing log buffer. Use `log` for normal entries and
 * `logFingerprints` for packet trails. `flush` sends the buffer to the
 * configured destination and leaves the buffer intact.
 *
 * @example
 * Example 1: Log and flush to a custom sink
 * ```ts
 * const logger = new Logger({ destination: (entries) => sendBeacon(entries) });
 * logger.log('ERROR', 'request failed', { context: { url: '/api', token: 'abc' } });
 * logger.flush();
 * ```
 */
export class Logger {
  /** @internal The bounded buffer. */
  private readonly buffer: LogEntry[] = [];

  /** @internal The max buffer size. */
  private readonly maxBufferSize: number;

  /** @internal The minimum level. */
  private readonly minLevel: LogLevel;

  /** @internal The session id. */
  private readonly sessionId: string;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /** @internal The sink. */
  private readonly destination?: (entries: LogEntry[]) => void;

  /** @internal The keys to redact. */
  private readonly sensitiveKeys: string[];

  /**
   * @summary Creates a Logger.
   * @param {LoggerOptions} [options] The configuration and injectables.
   */
  constructor(options: LoggerOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 1_000;
    this.minLevel = options.minLevel ?? 'DEBUG';
    this.sessionId = options.sessionId ?? 'default';
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? makeCounter();
    this.destination = options.destination;
    this.sensitiveKeys = options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  }

  /**
   * @summary Logs an entry, after level filtering and sanitization.
   * @description
   * Drops entries below `minLevel`. Redacts values for sensitive keys. Appends
   * to the buffer, evicting the oldest entry when the buffer is full.
   *
   * @param {LogLevel} level The level.
   * @param {string} message The message.
   * @param {object} [options] Optional fields.
   * @param {Record<string, unknown>} [options.context] Context to attach.
   * @param {string} [options.subsystemId] The manager that logged. Defaults to `logger`.
   * @param {string | null} [options.componentId] Feature name or `null`.
   * @returns {void}
   */
  log(
    level: LogLevel,
    message: string,
    options: {
      context?: Record<string, unknown>;
      subsystemId?: string;
      componentId?: string | null;
    } = {},
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const entry: LogEntry = {
      id: this.makeId(),
      level,
      message,
      subsystemId: options.subsystemId ?? 'logger',
      componentId: options.componentId ?? null,
      timestamp: this.now(),
      sessionId: this.sessionId,
      context: options.context === undefined ? undefined : this.sanitize(options.context),
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  /**
   * @summary Logs a packet's fingerprint trail.
   * @description
   * Emits one entry per fingerprint, mapping the fingerprint level to the log
   * level. This records the causal chain a packet passed through.
   *
   * @param {Fingerprint[]} fingerprints The trail to record.
   * @returns {void}
   */
  logFingerprints(fingerprints: Fingerprint[]): void {
    for (const fp of fingerprints) {
      this.log(fp.level, fp.message ?? fp.actionName, {
        subsystemId: fp.subsystemId,
        componentId: fp.componentId,
        context: {
          actionName: fp.actionName,
          valueType: fp.valueType,
          counter: fp.counter,
        },
      });
    }
  }

  /**
   * @summary The most recent entries, newest last.
   * @param {number} [count] Max entries to return. Defaults to all.
   * @returns {LogEntry[]} A copy of the requested entries.
   */
  getRecentLogs(count?: number): LogEntry[] {
    if (count === undefined) return [...this.buffer];
    return this.buffer.slice(-count);
  }

  /**
   * @summary Number of buffered entries.
   * @returns {number} The buffer size.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * @summary Clears the buffer.
   * @returns {void}
   */
  clearBuffer(): void {
    this.buffer.length = 0;
  }

  /**
   * @summary Sends the buffer to the destination without clearing it.
   * @returns {void}
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    this.destination?.([...this.buffer]);
  }

  /**
   * @summary Redacts values for sensitive keys.
   * @param {Record<string, unknown>} context The context to sanitize.
   * @returns {Record<string, unknown>} The sanitized context.
   * @internal
   */
  private sanitize(context: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      out[key] = this.sensitiveKeys.includes(key.toLowerCase()) ? '[REDACTED]' : value;
    }
    return out;
  }
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `log-${++counter}`;
}
