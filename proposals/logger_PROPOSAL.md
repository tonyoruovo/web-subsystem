
# Logger Manager
Soon to be integrated into the notification center

## Initial Proposal
### States

The state object for the Logger subsystem contains:

- **importance/priority/weight**: `HIGH` - Logging is critical for debugging and monitoring system health
- **buffer**: Circular buffer holding recent log entries (in-memory, size-limited)
- **settings**: The settings for this logger:
  - **maxBufferSize**: Maximum number of log entries to keep in memory (default: 1000)
  - **maxAge**: Maximum age of logs before auto-deletion (in milliseconds)
  - **destinations**: Array of enabled output destinations (console, storage, network)
  - **filterRules**: Object containing filtering rules for log suppression/highlighting
  - **sessionId**: Unique identifier for the current logging session
  - **flushInterval**: Interval (ms) for auto-flushing buffered logs to persistent storage
  - **compressionEnabled**: Flag for enabling log compression before storage
  - **anonymizationRules**: Rules for sanitizing sensitive data from logs

### Features

#### Log Entry Manager

- Formats log entries with standardized structure
- Assigns unique IDs to each log entry
- Timestamps all entries with high-precision timing
- **Weight**: MEDIUM - Standard logging operations

#### Fingerprint Logger

- Receives fingerprint arrays from completed/errored packets
- Parses and structures fingerprint data for storage
- Correlates fingerprints across related packets
- Builds execution traces from fingerprint sequences
- **Weight**: HIGH - Critical for packet flow analysis

#### Level Filter

- Applies log level filtering based on current state
- Implements dynamic level adjustment per subsystem
- Provides methods for checking if a level should be logged
- **Weight**: LOW - Simple filtering logic

#### Buffer Manager

- Manages the circular log buffer
- Implements buffer overflow handling (FIFO eviction)
- Provides buffer search and query capabilities
- Handles buffer flushing to persistent storage
- **Weight**: MEDIUM - Memory management operations

#### Persistence Manager

- Interfaces with Storage Manager for log persistence
- Implements batch writing for performance
- Manages log rotation and archival
- Handles log compression before storage
- **Weight**: MEDIUM - I/O bound operations

#### Export Manager

- Generates exportable log reports (JSON, CSV, plain text)
- Filters logs by date range, subsystem, level, etc.
- Implements log aggregation and summarization
- Creates diagnostic bundles for debugging
- **Weight**: LOW - User-initiated, non-critical

#### Sanitization Manager

- Strips sensitive data (tokens, passwords, PII) from logs
- Applies anonymization rules from state
- Provides configurable redaction patterns
- **Weight**: HIGH - Security-critical operations

#### Analytics Aggregator

- Generates log statistics and metrics
- Tracks error rates, performance metrics
- Identifies anomalies and patterns
- Provides data to Analytics Manager subsystem
- **Weight**: LOW - Background analysis

#### Real-time Stream Manager

- Provides live log streaming interface
- Implements WebSocket/SSE for remote logging
- Manages real-time log filtering and formatting
- **Weight**: MEDIUM - Developer tool feature

### Life Cycle Manager

#### Initialization Sequence

1. Initialize session ID and startup timestamp
2. Register all event IDs with action names in the notification center
3. Initialize log buffer with configured size
4. Load persisted log level and configuration from storage
5. Initialize all feature components in order:
   - Level Filter (first - needed by others)
   - Sanitization Manager (early - security)
   - Log Entry Manager
   - Fingerprint Logger
   - Buffer Manager
   - Persistence Manager
   - Analytics Aggregator
   - Export Manager
   - Real-time Stream Manager
6. Subscribe to notification center events for fingerprint logging
7. Start buffer flush timer if persistence enabled
8. Log initialization complete event

#### Destruction Sequence

1. Unsubscribe from all notification center events
2. Stop flush timer
3. Flush remaining buffer contents to storage
4. Generate final session statistics
5. Clean up old logs based on maxLogAge
6. Terminate real-time streams
7. Free buffer memory
8. Log shutdown complete event (final entry)

### Worker

The Logger subsystem may use a **Virtual Worker** pattern (not a physical Web Worker) since logging must be synchronous and immediately available to the UI thread for debugging purposes.

#### Receiver

- Receives log entry requests from the main thread
- Accepts fingerprint arrays from packet completions
- Receives buffer flush commands
- Accepts export/query requests

#### Processor

- **Fingerprint Processor**: Parses and structures fingerprint data, builds execution traces
- **Entry Processor**: Formats log entries, applies sanitization, assigns IDs
- **Buffer Processor**: Manages circular buffer operations, handles overflow
- **Persistence Processor**: Batches logs, compresses if enabled, prepares for storage
- **Query Processor**: Searches and filters log buffer based on criteria
- **Statistics Processor**: Aggregates log data for analytics

They may also:

- Validates log entry structure
- Applies configured filters and transformations
- Adds system metadata (platform status, user context)
- Manages fingerprint correlation
- Determines output destinations based on severity and source

#### Dispatcher

- Sends formatted logs to console (if enabled)
- Emits logs to external services via Network Manager
- Posts batched logs to Storage Manager for persistence
- Emits log events to Analytics Manager
- Streams logs to real-time subscribers
- Returns query results to requesters

#### Additional Worker Requirements

- **Cleanup Protocols**:
  - Graceful degradation when dependencies fail
  - Buffer protection during network issues
  - Error recovery with retry mechanisms
- **Pausable**: Can temporarily halt buffer flushing during high-priority operations
- **Resumable**: Resumes flushing when system returns to idle
- **Abortable**: Can cancel pending persistence operations if system stops
- **Error Handling**: Catches and handles logging errors to prevent recursive failures
- **Visibility API**: Reduces logging frequency when page is hidden to conserve resources

### Dependencies

Ordered by initialization priority:

1. **Global State** (HIGH) - Required for checking platform status, timestamps
2. **Storage Manager** (HIGH) - Required for log persistence
3. **Notification Center** (HIGH) - Required for receiving fingerprint events
4. **Message Queue** (MEDIUM) - For sending low-priority log events
5. **Analytics Manager** (LOW) - For sending aggregated log statistics

### Message Packets

```ts
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'FATAL'
export type ExportFormat = 'json' | 'csv' | 'text'
export type PacketImportance = 'LOW' | 'MEDIUM' | 'HIGH'

export interface Fingerprint {
  actionName: string
  valueType: string
  timestamp: number
  subsystemId: string
  componentId: string | null
  counter: number | null
}

export interface BasePacket<TAction extends string, TPayload> {
  eventId: symbol
  actionName: TAction
  payload: TPayload
  importance: PacketImportance
  onComplete: (result: any) => void
  onError: (error: any) => void
  onLog: ((fingerprints: Fingerprint[]) => void) | null
  fingerprints: Fingerprint[]
}

/**
 * Log Entry Packet
 */
export type LogEntryPacket = BasePacket<
  'LOG_ENTRY',
  {
    level: LogLevel
    message: string
    context: Record<string, any>
    subsystemId: string
    componentId: string | null
    timestamp: number
    sessionId: string
  }
>

/**
 * Fingerprint Log Packet
 */
export type FingerprintLogPacket = BasePacket<
  'LOG_FINGERPRINTS',
  {
    packetId: string
    fingerprints: Fingerprint[]
    originalEventId: symbol
  }
>

/**
 * Flush Buffer Packet
 */
export type FlushBufferPacket = BasePacket<
  'FLUSH_LOG_BUFFER',
  {
    force: boolean
    compress: boolean
  }
>

/**
 * Export Logs Packet
 */
export type ExportLogsPacket = BasePacket<
  'EXPORT_LOGS',
  {
    format: ExportFormat
    filters: {
      startDate: number | null
      endDate: number | null
      levels: string[]
      subsystems: string[]
    }
    includeFingerprints: boolean
  }
>

export type LoggerPacket =
  | LogEntryPacket
  | FingerprintLogPacket
  | FlushBufferPacket
  | ExportLogsPacket
```

### Control Interface

#### Getters (No-arg)

- `getBufferSize()` - Returns current number of buffered entries
- `getSessionId()` - Returns current session ID
- `getLogStatistics()` - Returns aggregated statistics
- `isPersistenceEnabled()` - Returns persistence flag status
- `getRecentLogs(count = 50)` - Returns most recent N log entries

#### Setters

- `enablePersistence(enabled)` - Toggles log persistence
- `setFlushInterval(ms)` - Updates auto-flush interval
- `addFilterRule(rule)` - Adds log filtering rule
- `removeFilterRule(ruleId)` - Removes filtering rule

#### Actions (Fire events to message queue)

- `log(level, message, context)` - Creates new log entry
- `logFingerprints(fingerprintArray)` - Logs packet fingerprints
- `flushBuffer()` - Forces immediate buffer flush to storage
- `clearBuffer()` - Clears in-memory log buffer
- `exportLogs(options)` - Generates log export
- `queryLogs(criteria)` - Searches logs based on criteria
- `cleanOldLogs()` - Removes logs older than maxLogAge

#### Subscriptions (Subscribe to notification center events)

- Subscribes to all packet completion events to receive fingerprints
- Subscribes to global state changes for status monitoring
- Subscribes to error events from all subsystems
