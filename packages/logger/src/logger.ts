/**
 * @fileoverview
 * @summary The Logger: sanitized, level-filtered log entries and packet trails, joined by `traceId`.
 * @description
 * Implements the Logger of docs/ARCHITECTURE.md §13 (amended proposal:
 * `proposals/logger_PROPOSAL.md`). It has no required dependency, so it runs
 * from the start of boot, and it follows the Queue, the Notification Center
 * and its sink as they come and go (late binding, §7.2).
 *
 * ```text
 *   commands.log(level, message, options)
 *     --> level filter (minLevel, or a per-subsystem level)
 *     --> sanitize(context)                       secrets never reach the log
 *     --> entries ring (maxEntries)  --> console mirror (optional)
 *                                    --> sink (LateBinding: buffered until bound, e.g. Storage in M6)
 *
 *   Queue.observe        every settled packet  --> traces ring; failures also logged
 *   Notification.observe every broadcast       --> traces ring; failed deliveries also logged
 *
 *   commands.trace(traceId) --> every trail and entry sharing the traceId (ARCHITECTURE §9, A4)
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * const kernel = new Kernel([...centralized, createLogger({ console: 'WARN' }), ...subsystems], {
 *   router: queue.router,
 * });
 * ```
 *
 * @example
 * Logging from a subsystem that declares an optional dependency on `logger`
 * ```ts
 * ctx.dependency<LoggerControl>('logger')?.commands.log('WARN', 'Quota low', {
 *   subsystemId: ctx.id,
 *   context: { used, available },
 * });
 * ```
 *
 * @author MathAid
 */

import {
  LateBinding,
  createRingBuffer,
  defineSubsystem,
  type ControlInterface,
  type FingerprintTrail,
  type LogLevel,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import { sanitize, type SanitizeOptions } from './sanitize';

/**
 * @summary The id the Logger registers under.
 * @constant {'logger'}
 * @public
 */
export const LOGGER_ID = 'logger';

/**
 * @summary The rank of each level: an entry is kept when its rank is at least the threshold's.
 * @constant {Readonly<Record<LogLevel, number>>}
 * @public
 */
export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

/**
 * @summary One log entry.
 *
 * @description
 * `id` is unique in the session. `subsystemId` and `componentId` say who
 * logged (`componentId` is a feature or `null`). `traceId` links the entry to
 * a packet's trace, or is `null`. `context` is the sanitized context, or
 * `null`. Entries are frozen.
 *
 * @example
 * Example 1: An entry
 * ```ts
 * // { id: 'log-7', level: 'WARN', message: 'Quota low', subsystemId: 'storage', componentId: 'idb',
 * //   timestamp: 1700000000000, sessionId: 's1', traceId: null, context: { used: 90 } }
 * ```
 *
 * @example
 * Example 2: Showing errors only
 * ```ts
 * entries.getSnapshot().filter((e) => LEVEL_RANK[e.level] >= LEVEL_RANK.ERROR);
 * ```
 *
 * @public
 */
export interface LogEntry {
  readonly id: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly subsystemId: string;
  readonly componentId: string | null;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly traceId: string | null;
  readonly context: Readonly<Record<string, unknown>> | null;
}

/**
 * @summary Who logged, and what to attach, for `commands.log`.
 *
 * @description
 * `subsystemId` defaults to `'app'`; `componentId` to `null`. `context` is
 * sanitized before it is kept. `traceId` links the entry to a trace (pass
 * `packet.header.metadata.traceId` from a `receive` handler).
 *
 * @example
 * Example 1: From a feature
 * ```ts
 * log('ERROR', 'Open failed', { subsystemId: 'storage', componentId: 'idb', context: { error } });
 * ```
 *
 * @example
 * Example 2: Inside a packet handler
 * ```ts
 * log('INFO', 'Pulled', { subsystemId: 'sync', traceId: packet.header.metadata.traceId });
 * ```
 *
 * @public
 */
export interface LogOptions {
  readonly subsystemId?: string;
  readonly componentId?: string | null;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly traceId?: string;
}

/**
 * @summary A packet's trail, as the Logger keeps it.
 *
 * @description
 * `kind` is `packet` (settled by the Queue) or `broadcast` (fanned out by the
 * Notification Center; its trail has one entry per delivery). A broadcast
 * appears as both: the Queue settles it and the Notification Center fans it
 * out. `outcome` and `reason` are the recorder's. `timestamp` is when the
 * Logger received it.
 *
 * @example
 * Example 1: A failed request
 * ```ts
 * // { kind: 'packet', eventId: 'sync:pull', source: 'sync', outcome: 'failed', reason: 'HTTP 503', trail, ... }
 * ```
 *
 * @example
 * Example 2: Printing a trail
 * ```ts
 * console.table(record.trail.entries);
 * ```
 *
 * @public
 */
export interface TraceRecord {
  readonly kind: 'packet' | 'broadcast';
  readonly messageId: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly source: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly trail: FingerprintTrail;
  readonly timestamp: number;
}

/**
 * @summary Everything the Logger holds for one `traceId`: trails and entries, oldest first.
 *
 * @example
 * Example 1: Following a user action
 * ```ts
 * const { records, entries } = logger.commands.trace(traceId);
 * ```
 *
 * @example
 * Example 2: Was anything in the trace an error?
 * ```ts
 * trace.entries.some((e) => e.level === 'ERROR');
 * ```
 *
 * @public
 */
export interface Trace {
  readonly traceId: string;
  readonly records: readonly TraceRecord[];
  readonly entries: readonly LogEntry[];
}

/**
 * @summary Criteria for `commands.query` and `commands.export`; every field narrows the result.
 *
 * @description
 * `levels` and `subsystems` keep matching entries; `since` and `until` bound
 * the timestamp (inclusive); `traceId` keeps one trace; `text` keeps entries
 * whose message contains it (case-insensitive); `limit` keeps the newest N.
 *
 * @example
 * Example 1: Recent errors from Storage
 * ```ts
 * query({ levels: ['ERROR', 'FATAL'], subsystems: ['storage'], limit: 20 });
 * ```
 *
 * @example
 * Example 2: The last hour
 * ```ts
 * query({ since: Date.now() - 3_600_000 });
 * ```
 *
 * @public
 */
export interface LogQuery {
  readonly levels?: readonly LogLevel[];
  readonly subsystems?: readonly string[];
  readonly since?: number;
  readonly until?: number;
  readonly traceId?: string;
  readonly text?: string;
  readonly limit?: number;
}

/**
 * @summary A settled packet or a broadcast record, as the Queue and the Notification Center push them.
 * @description Only the fields the Logger reads. `deliveries` is present on broadcast records.
 * @public
 */
export interface ObservedPacket {
  readonly messageId: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly source: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly trail: FingerprintTrail;
  readonly deliveries?: readonly {
    readonly subscriber: string;
    readonly outcome: string;
    readonly reason: string | null;
  }[];
}

/**
 * @summary The part of the Queue's and the Notification Center's control interfaces the Logger uses.
 *
 * @example
 * Example 1: What the Logger calls
 * ```ts
 * const stop = source.commands.observe((packet) => record(packet));
 * ```
 *
 * @example
 * Example 2: A stand-in for tests
 * ```ts
 * const source: TrailSource = { commands: { observe: () => () => {} }, views: {} };
 * ```
 *
 * @public
 */
export interface TrailSource extends ControlInterface {
  readonly commands: {
    observe(observer: (packet: ObservedPacket) => void): () => void;
  };
}

/**
 * @summary Options for {@linkcode createLogger}.
 *
 * @description
 * - `minLevel` (default `INFO`): the threshold until changed (the change is persisted).
 * - `maxEntries` (default 1000) and `maxTraces` (default 200): ring sizes.
 * - `sinkCapacity` (default 500): entries buffered until a sink is bound.
 * - `console` (default `false`): mirror entries at or above this level to the console.
 * - `sanitize`: extra patterns or depth for {@linkcode sanitize}.
 * - `sessionId`, `now`: replace the session id and the clock.
 *
 * @example
 * Example 1: Development
 * ```ts
 * createLogger({ minLevel: 'DEBUG', console: 'DEBUG' });
 * ```
 *
 * @example
 * Example 2: Also redacting card numbers
 * ```ts
 * createLogger({ sanitize: { patterns: [...DEFAULT_SENSITIVE_PATTERNS, 'card'] } });
 * ```
 *
 * @public
 */
export interface LoggerOptions {
  readonly minLevel?: LogLevel;
  readonly maxEntries?: number;
  readonly maxTraces?: number;
  readonly sinkCapacity?: number;
  readonly console?: LogLevel | false;
  readonly sanitize?: SanitizeOptions;
  readonly sessionId?: string;
  readonly now?: () => number;
}

/**
 * @summary The Logger's state.
 *
 * @description
 * `minLevel` and `levels` (per-subsystem thresholds) are persisted.
 * `sessionId` identifies this run. `entries`, `traces` and `dropped` count
 * what the rings hold and what they evicted. `sinkBound` says whether entries
 * go to a sink or are buffered.
 *
 * @example
 * Example 1: A fresh logger
 * ```ts
 * // { minLevel: 'INFO', levels: {}, sessionId: 's1', entries: 0, traces: 0, dropped: 0, sinkBound: false }
 * ```
 *
 * @example
 * Example 2: Showing the threshold in a debug panel
 * ```ts
 * state.getSnapshot().minLevel;
 * ```
 *
 * @public
 */
export interface LoggerData {
  minLevel: LogLevel;
  levels: Record<string, LogLevel>;
  sessionId: string;
  entries: number;
  traces: number;
  dropped: number;
  sinkBound: boolean;
}

/**
 * @summary The Logger's control interface.
 *
 * @description
 * - `log(level, message, options)`: keeps an entry, returning it, or `null` when filtered out.
 * - `isEnabled(level, subsystemId)`: whether `log` would keep it (skip building costly context).
 * - `setLevel(level, subsystemId?)` / `resetLevel(subsystemId)`: the global or a per-subsystem threshold.
 * - `query(criteria)`, `trace(traceId)`, `export(format, criteria)`: read the log.
 * - `recordTrail(record)`: adds a trail from elsewhere (another tab, a server) to join by `traceId`.
 * - `clear()`: empties both rings.
 * - `bindSink(sink)` / `unbindSink()`: send entries to a sink (Storage, from M6), buffered until bound.
 *
 * Views: `state`, `entries` (oldest first) and `traces`.
 *
 * @example
 * Example 1: Quieter logs, but everything from Sync
 * ```ts
 * commands.setLevel('WARN');
 * commands.setLevel('DEBUG', 'sync');
 * ```
 *
 * @example
 * Example 2: A diagnostic bundle
 * ```ts
 * const text = commands.export('text', { since: Date.now() - 600_000 });
 * ```
 *
 * @public
 */
export interface LoggerControl {
  readonly commands: {
    log(level: LogLevel, message: string, options?: LogOptions): LogEntry | null;
    isEnabled(level: LogLevel, subsystemId?: string): boolean;
    setLevel(level: LogLevel, subsystemId?: string): void;
    resetLevel(subsystemId: string): void;
    query(criteria?: LogQuery): LogEntry[];
    trace(traceId: string): Trace;
    export(format: 'json' | 'text', criteria?: LogQuery): string;
    recordTrail(record: Omit<TraceRecord, 'timestamp'>): void;
    clear(): void;
    bindSink(sink: (entry: LogEntry) => void | Promise<void>): Promise<void>;
    unbindSink(): void;
  };
  readonly views: {
    readonly state: View<Partial<LoggerData>>;
    readonly entries: View<readonly LogEntry[]>;
    readonly traces: View<readonly TraceRecord[]>;
  };
}

/** @summary Console methods per level. @internal */
const CONSOLE_METHOD: Readonly<Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'>> = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
};

/** @summary Log levels for packet outcomes worth an entry. @internal */
const OUTCOME_LEVEL: Readonly<Record<string, LogLevel>> = {
  failed: 'ERROR',
  'dead-lettered': 'ERROR',
  rejected: 'WARN',
};

/**
 * @summary Formats one entry as a line of text.
 *
 * @example
 * Example 1: An entry with a trace
 * ```ts
 * formatEntry(entry); // '2026-10-02T10:00:00.000Z WARN  [storage/idb] Quota low trace=t1 {"used":90}'
 * ```
 *
 * @example
 * Example 2: Printing the whole log
 * ```ts
 * console.log(entries.getSnapshot().map(formatEntry).join('\n'));
 * ```
 *
 * @param {LogEntry} entry The entry.
 * @returns {string} One line.
 *
 * @public
 */
export function formatEntry(entry: LogEntry): string {
  const who = entry.componentId ? `${entry.subsystemId}/${entry.componentId}` : entry.subsystemId;
  const trace = entry.traceId ? ` trace=${entry.traceId}` : '';
  const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
  return `${new Date(entry.timestamp).toISOString()} ${entry.level.padEnd(5)} [${who}] ${entry.message}${trace}${context}`;
}

/**
 * @summary Creates the Logger subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode LOGGER_ID}, featurized, Tab
 * scope). It declares optional dependencies on `queue` and `notification` and
 * observes them whenever they run, so it also works without them.
 *
 * @example
 * Example 1: With the centralized subsystems
 * ```ts
 * new Kernel([createGlobalState(), queue.subsystem, notification.subsystem, createLogger()], {
 *   router: queue.router,
 * });
 * ```
 *
 * @example
 * Example 2: Joining a trace
 * ```ts
 * const logger = kernel.unit<LoggerControl>('logger').control!;
 * logger.commands.trace(traceId).records.map((r) => r.eventId);
 * ```
 *
 * @param {LoggerOptions} [options] Threshold, ring sizes, console mirror, sanitizing, session id and clock.
 * @returns {SubsystemDefinition<LoggerData, LoggerControl>} The subsystem.
 *
 * @public
 */
export function createLogger(
  options: LoggerOptions = {},
): SubsystemDefinition<LoggerData, LoggerControl> {
  const now = options.now ?? Date.now;
  const mirror = options.console ?? false;
  const entries = createRingBuffer<LogEntry>(options.maxEntries ?? 1000);
  const traces = createRingBuffer<TraceRecord>(options.maxTraces ?? 200);
  const sink = new LateBinding<LogEntry>({ capacity: options.sinkCapacity ?? 500 });
  let nextId = 0;
  /** The running Logger's internals, shared by `init` and `control`. */
  let api: {
    log(level: LogLevel, message: string, options?: LogOptions): LogEntry | null;
    enabled(level: LogLevel, subsystemId: string): boolean;
  } | null = null;

  const readable = { readable: true } as const;
  const persisted = { readable: true, persisted: true } as const;

  return defineSubsystem({
    id: LOGGER_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'queue', kind: 'optional' },
      { target: 'notification', kind: 'optional' },
    ],
    state: {
      initial: {
        minLevel: options.minLevel ?? 'INFO',
        levels: {},
        sessionId: options.sessionId ?? crypto.randomUUID(),
        entries: 0,
        traces: 0,
        dropped: 0,
        sinkBound: false,
      } as LoggerData,
      policy: {
        minLevel: persisted,
        levels: persisted,
        sessionId: readable,
        entries: readable,
        traces: readable,
        dropped: readable,
        sinkBound: readable,
      },
      version: 1,
    },
    init(ctx) {
      const record = (kind: TraceRecord['kind'], packet: ObservedPacket) => {
        traces.push({
          kind,
          messageId: packet.messageId,
          traceId: packet.traceId,
          eventId: packet.eventId,
          source: packet.source,
          outcome: packet.outcome,
          reason: packet.reason,
          trail: packet.trail,
          timestamp: now(),
        });
        ctx.state.update((s) => void (s.traces = traces.size));
      };
      const follow = (target: string, kind: TraceRecord['kind']) => {
        let stop: (() => void) | undefined;
        ctx.watch<TrailSource>(target, (source) => {
          stop?.();
          stop = source?.commands.observe((packet) => {
            record(kind, packet);
            const level = OUTCOME_LEVEL[packet.outcome];
            if (level) {
              log(level, `${packet.eventId} ${packet.outcome}: ${packet.reason ?? 'no reason'}`, {
                subsystemId: packet.source,
                traceId: packet.traceId,
                context: { messageId: packet.messageId, recordedBy: target },
              });
            }
            for (const delivery of packet.deliveries ?? []) {
              if (delivery.outcome !== 'failed') continue;
              log('WARN', `${packet.eventId} delivery failed: ${delivery.reason ?? 'no reason'}`, {
                subsystemId: delivery.subscriber,
                traceId: packet.traceId,
                context: { messageId: packet.messageId, source: packet.source },
              });
            }
          });
        });
        return () => stop?.();
      };

      const enabled = (level: LogLevel, subsystemId: string) => {
        const { minLevel, levels } = ctx.state.get();
        return LEVEL_RANK[level] >= LEVEL_RANK[levels[subsystemId] ?? minLevel];
      };

      function log(level: LogLevel, message: string, logOptions: LogOptions = {}) {
        const subsystemId = logOptions.subsystemId ?? 'app';
        if (!enabled(level, subsystemId)) return null;
        const entry: LogEntry = {
          id: `log-${++nextId}`,
          level,
          message,
          subsystemId,
          componentId: logOptions.componentId ?? null,
          timestamp: now(),
          sessionId: ctx.state.get().sessionId,
          traceId: logOptions.traceId ?? null,
          context: logOptions.context ? sanitize(logOptions.context, options.sanitize) : null,
        };
        entries.push(entry);
        ctx.state.update((s) => {
          s.entries = entries.size;
          s.dropped = entries.dropped;
        });
        if (mirror !== false && LEVEL_RANK[level] >= LEVEL_RANK[mirror]) {
          console[CONSOLE_METHOD[level]](formatEntry(entry));
        }
        try {
          void Promise.resolve(sink.write(entry)).catch((error: unknown) => ctx.report(error));
        } catch (error) {
          ctx.report(error);
        }
        return entry;
      }
      api = { log, enabled };

      const stops = [follow('queue', 'packet'), follow('notification', 'broadcast')];
      return () => {
        for (const stop of stops) stop();
        api = null;
      };
    },
    control: (ctx) => {
      const query = (criteria: LogQuery = {}): LogEntry[] => {
        const text = criteria.text?.toLowerCase();
        const found = entries
          .toArray()
          .filter(
            (e) =>
              (!criteria.levels || criteria.levels.includes(e.level)) &&
              (!criteria.subsystems || criteria.subsystems.includes(e.subsystemId)) &&
              (criteria.since === undefined || e.timestamp >= criteria.since) &&
              (criteria.until === undefined || e.timestamp <= criteria.until) &&
              (criteria.traceId === undefined || e.traceId === criteria.traceId) &&
              (text === undefined || e.message.toLowerCase().includes(text)),
          );
        return criteria.limit === undefined ? found : found.slice(-criteria.limit);
      };
      return {
        commands: {
          log: (level: LogLevel, message: string, logOptions?: LogOptions) =>
            api!.log(level, message, logOptions),
          isEnabled: (level: LogLevel, subsystemId = 'app') => api!.enabled(level, subsystemId),
          setLevel(level: LogLevel, subsystemId?: string) {
            ctx.state.update((s) => {
              if (subsystemId === undefined) s.minLevel = level;
              else s.levels[subsystemId] = level;
            });
          },
          resetLevel(subsystemId: string) {
            ctx.state.update((s) => void delete s.levels[subsystemId]);
          },
          query,
          trace: (traceId: string): Trace => ({
            traceId,
            records: traces.toArray().filter((r) => r.traceId === traceId),
            entries: entries.toArray().filter((e) => e.traceId === traceId),
          }),
          export(format: 'json' | 'text', criteria?: LogQuery) {
            const found = query(criteria);
            return format === 'json'
              ? JSON.stringify(found, null, 2)
              : found.map(formatEntry).join('\n');
          },
          recordTrail(record: Omit<TraceRecord, 'timestamp'>) {
            traces.push({ ...record, timestamp: now() });
            ctx.state.update((s) => void (s.traces = traces.size));
          },
          clear() {
            entries.clear();
            traces.clear();
            ctx.state.update((s) => {
              s.entries = 0;
              s.traces = 0;
            });
          },
          async bindSink(entrySink: (entry: LogEntry) => void | Promise<void>) {
            await sink.bind(entrySink);
            ctx.state.update((s) => void (s.sinkBound = true));
          },
          unbindSink() {
            sink.unbind();
            ctx.state.update((s) => void (s.sinkBound = false));
          },
        },
        views: { state: ctx.state.readable, entries: entries.view, traces: traces.view },
      };
    },
  });
}
