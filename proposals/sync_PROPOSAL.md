
# Sync manager
## Initial Proposal

### States

- **importance/priority/weight**: `HIGH` - Synchronization is critical for data consistency and offline-first functionality
- **status**: Current sync state (IDLE, SYNCING, PAUSED, CONFLICT, ERROR)
- **queue**: Priority queue of pending sync operations
- **lastSyncTimestamp**: Timestamp of last successful full sync
- **retryBackoff**: Current backoff multiplier for failed sync attempts
- **lastAttemptTimestamp**: Timestamp of last sync attempt (successful or failed)
- **interval**: Auto-sync interval in milliseconds (default: 300000 - 5 minutes)
- **offlineChanges**: Map of changes made while offline, keyed by entity type and ID
- **syncSettings**: Configuration object:
  - **autoSync**: Flag for automatic background sync
  - **syncOnReconnect**: Flag to trigger sync when going online
  - **batchSize**: Maximum items per sync batch
  - **maxRetries**: Maximum retry attempts for failed syncs
  - **retryDelayBase**: Base delay for exponential backoff (ms)
  - **deltaSync**: Flag to enable delta/incremental sync vs full sync
  - **compressionEnabled**: Flag for compressing sync payloads
  - **conflictThreshold**: Number of conflicts before requiring manual intervention
- **activeOperations**: Map of currently in-progress sync operations
- **entityPriorities**: Map defining sync priority per entity type
- **bandwidthMode**: Current mode (FULL, CONSERVATIVE, MINIMAL) affecting sync behavior

### Message Packets

```ts
/**
 * Shared Type Definitions
 */
export type Importance = 'HIGH' | 'MEDIUM' | 'LOW'

export interface BasePacket<P, R = any> {
  eventId: symbol
  actionName: string
  payload: P
  importance: Importance
  onComplete: (result: R) => void
  onError: (error: Error) => void
  onLog: ((fingerprints: string[]) => void) | null
  fingerprints: string[]
}

/**
 * 1. Sync Request
 */
export interface SyncRequestPayload {
  syncType: 'FULL' | 'DELTA' | 'ENTITY'
  entityTypes: string[] | null
  entityIds: string[] | null
  direction: 'PULL' | 'PUSH' | 'BOTH'
  force: boolean
  priority: number
  userId: string
  authToken: string
}

export type SyncRequestPacket = BasePacket<SyncRequestPayload>

/**
 * 2. Conflict Resolution
 */
export interface ConflictResolutionPayload {
  conflictId: string
  entityType: string
  entityId: string
  localVersion: Record<string, any>
  remoteVersion: Record<string, any>
  resolution: 'CLIENT_WINS' | 'SERVER_WINS' | 'MERGE' | 'MANUAL'
  mergedData: Record<string, any> | null
  userId: string
}

export type ConflictResolutionPacket = BasePacket<ConflictResolutionPayload>

/**
 * 3. Offline Change
 */
export interface OfflineChangePayload {
  operation: 'CREATE' | 'UPDATE' | 'DELETE'
  entityType: string
  entityId: string
  data: Record<string, any>
  timestamp: number
  userId: string
  dependencies: string[]
}

export type OfflineChangePacket = BasePacket<OfflineChangePayload>

/**
 * 4. Sync Progress
 */
export interface SyncProgressPayload {
  operationId: string
  entityType: string
  phase: 'PREPARING' | 'UPLOADING' | 'DOWNLOADING' | 'APPLYING' | 'COMPLETE'
  progress: number // 0-100
  itemsProcessed: number
  itemsTotal: number
  currentItem: string | null
  startTime: number
  estimatedCompletion: number | null
}

export type SyncProgressPacket = BasePacket<SyncProgressPayload>

/**
 * 5. Sync Complete
 */
export interface SyncCompletePayload {
  operationId: string
  syncType: string
  success: boolean
  entityTypes: string[]
  itemsSynced: number
  conflictsDetected: number
  conflictsResolved: number
  duration: number
  timestamp: number
  errors: Record<string, any>[] | null
}

export type SyncCompletePacket = BasePacket<SyncCompletePayload>

/**
 * Unified Sync Packet Type
 */
export type SyncPacket =
  | SyncRequestPacket
  | ConflictResolutionPacket
  | OfflineChangePacket
  | SyncProgressPacket
  | SyncCompletePacket
```

### Dependencies

Ordered by initialization priority:

1. **Global State** (CRITICAL) - Required for online/offline status, auth state, timestamps
2. **Storage Manager** (CRITICAL) - Required for persisting data and offline changes
3. **Network Manager** (CRITICAL) - Required for sync API communication
4. **Notification Center** (HIGH) - Required for event coordination
5. **Message Queue** (HIGH) - For sending sync event packets
6. **Logger** (MEDIUM) - For logging sync operations and conflicts
7. **Analytics Manager** (LOW) - For sync performance metrics

### Control Interface

#### Getters (No-arg)

- `getSyncStatus()` - Returns current sync status (IDLE, SYNCING, etc.)
- `getLastSyncTime()` - Returns timestamp of last successful sync
- `getPendingSyncCount()` - Returns number of pending sync operations
- `getConflictCount()` - Returns number of unresolved conflicts
- `getOfflineChanges()` - Returns map of offline changes
- `getSyncMetadata(entityType?)` - Returns sync metadata for entity type or all
- `isAutoSyncEnabled()` - Returns auto-sync flag status
- `getActiveOperations()` - Returns currently in-progress sync operations
- `getBandwidthMode()` - Returns current bandwidth mode
- `isSyncing()`: Boolean indicating if sync is in progress

#### Setters

- `setAutoSync(enabled)` - Enables/disables automatic sync (fires event to message queue)
- `setSyncInterval(ms)` - Updates auto-sync interval
- `setConflictStrategy(strategy)` - Updates conflict resolution strategy
- `setBandwidthMode(mode)` - Sets bandwidth usage mode (FULL, CONSERVATIVE, MINIMAL)
- `setEntityPriority(entityType, priority)` - Updates sync priority for entity type

#### Actions (Fire events to message queue)

- `syncNow(options?)` - Triggers immediate sync
- `syncEntity(entityType, entityId?)` - Syncs specific entity or entity type
- `pauseSync()` - Pauses ongoing sync operations
- `resumeSync()` - Resumes paused sync
- `resolveConflict(conflictId, resolution)` - Manually resolves specific conflict
- `clearOfflineChanges()` - Clears offline change queue (dangerous, requires confirmation)
- `resetSyncState(entityType?)` - Resets sync metadata for fresh sync
- `pushLocalChanges()` - Pushes only local changes without pulling
- `pullRemoteChanges()` - Pulls only remote changes without pushing

### Life Cycle Manager

#### Initialization Sequence

1. Initialize sync status and session metadata
2. Register all event IDs with action names in notification center
3. Load persisted sync state from Storage Manager:
   - Last sync timestamps
   - Offline changes queue
   - Pending conflicts
   - User preferences
4. Initialize feature components in order:
   - Network Condition Monitor (first - needed by others)
   - Offline Change Tracker
   - Conflict Detector
   - Conflict Resolver
   - Sync Queue Manager
   - Delta Sync Engine
   - Entity Sync Coordinator
   - Retry Manager
   - Sync Scheduler
   - Compression Manager
   - Sync Analytics
5. Subscribe to critical events:
   - Global state online/offline changes
   - Global state authentication changes
   - Storage Manager CRUD events
   - Network Manager connection quality changes
6. Restore interrupted sync operations from previous session
7. If `syncOnAuth` enabled and user authenticated, trigger initial sync
8. If `syncOnReconnect` enabled and online, trigger sync
9. Start auto-sync scheduler if enabled
10. Log initialization complete event

#### Destruction Sequence

1. Pause auto-sync scheduler
2. Unsubscribe from all notification center events
3. Abort all active sync operations gracefully
4. Persist current sync state:
   - Offline changes queue
   - Pending conflicts
   - Sync metadata
   - Active operation checkpoints
5. Generate final sync session statistics
6. Clear in-memory sync queues
7. Terminate worker connections
8. Log shutdown complete event

### Features

#### Sync Queue Manager

- Manages the priority queue of sync operations
- Implements intelligent batching of related operations
- Handles operation deduplication and merging
- Schedules sync operations based on priority and network conditions
- **Weight**: HIGH - Core sync coordination

#### Delta Sync Engine

- Computes differential changes since last sync
- Generates minimal payloads for efficient bandwidth usage
- Tracks entity versions and checksums
- Implements change detection algorithms
- **Weight**: MEDIUM - Performance optimization

#### Conflict Detector

- Identifies conflicts between local and remote changes
- Categorizes conflicts by severity and type
- Generates conflict metadata for resolution
- Tracks conflict history and patterns
- **Weight**: HIGH - Data integrity critical

#### Conflict Resolver

- Applies configured resolution strategies
- Implements automatic resolution algorithms (timestamp-based, merge, etc.)
- Manages manual conflict resolution queue
- Logs resolution decisions for audit trail
- **Weight**: HIGH - Data consistency critical

#### Offline Change Tracker

- Monitors and records changes made while offline
- Maintains operation order and dependencies
- Implements optimistic locking mechanisms
- Handles change replay during sync
- **Weight**: HIGH - Offline-first functionality

#### Sync Scheduler

- Manages automatic sync intervals
- Implements intelligent scheduling based on:
  - Network conditions
  - Battery status
  - User activity patterns
  - Data priority
- Handles sync throttling and debouncing
- **Weight**: MEDIUM - Background automation

#### Network Condition Monitor

- Tracks network quality and bandwidth
- Adjusts sync behavior based on connection type (WiFi, cellular, etc.)
- Implements adaptive sync strategies
- Monitors data usage and respects user limits
- **Weight**: MEDIUM - Resource optimization

#### Entity Sync Coordinator

- Coordinates sync per entity type
- Manages entity-specific sync rules
- Handles cascading updates and dependencies
- Implements partial sync for large datasets
- **Weight**: HIGH - Multi-entity orchestration

#### Batch Processor

- Groups operations into efficient batches
- Manages batch size and composition
- Handles partial batch failures
- Implements batch rollback on critical failures
- **Weight**: MEDIUM - Performance optimization

#### Retry Manager

- Implements exponential backoff for failed syncs
- Tracks retry attempts per operation
- Identifies permanent vs transient failures
- Manages retry queue prioritization
- **Weight**: MEDIUM - Resilience

#### Compression Manager

- Compresses outgoing sync payloads
- Decompresses incoming sync data
- Selects optimal compression based on payload size
- **Weight**: LOW - Performance enhancement

#### Sync Analytics

- Tracks sync performance metrics
- Monitors sync success/failure rates
- Identifies bottlenecks and slow operations
- Provides data to Analytics Manager
- **Weight**: LOW - Observability

### Worker

The Sync Manager uses a **Physical Worker** (Web Worker) to offload sync computations and network operations from the UI thread.

#### Receiver

- Receives sync operation requests from main thread
- Accepts conflict resolution commands
- Receives offline change notifications
- Accepts manual sync triggers
- Receives configuration updates
- Accepts abort/pause/resume commands

#### Processor

- **Sync Operation Processor**
- Determines sync type (full, delta, entity-specific)
- Batches operations for efficiency
- Computes change sets and diffs
- Applies conflict resolution strategies
- Tracks operation progress

- **Payload Processor**
- Serializes local changes for upload
- Deserializes remote changes for application
- Compresses/decompresses payloads
- Validates data integrity and schemas
- Handles large payload chunking

- **Conflict Resolution Processor**
- Analyzes conflicts using configured strategy
- Implements merge algorithms for complex conflicts
- Generates conflict reports for manual review
- Tracks resolution metadata

- **Network Coordination Processor**
- Sequences network requests via Network Manager
- Implements request batching and parallelization
- Handles rate limiting and throttling
- Manages request retries with backoff

- **State Reconciliation Processor6**
- Applies remote changes to local storage
- Updates entity versions and timestamps
- Maintains referential integrity
- Triggers cascade updates

#### Dispatcher

- Posts sync results to Storage Manager for persistence
- Emits progress events to notification center
- Sends conflict notifications for manual resolution
- Posts completion status to main thread
- Emits sync metrics to Analytics Manager
- Sends network requests via Network Manager
- Returns operation results to requesters

#### Additional Worker Requirements

- **Pausable**: Can pause sync during critical user operations or poor network
- **Resumable**: Resumes from checkpoint after pause
- **Abortable**: Can abort sync cleanly, preserving state
- **Error Handling**:
  - Isolates errors by operation to prevent cascade failures
  - Implements circuit breaker for repeated failures
  - Graceful degradation when dependencies unavailable
- **Visibility API**: Pauses background sync when page hidden
- **Cleanup Protocols**:
  - Checkpoint mechanism for long-running syncs
  - Transaction rollback on failures
  - Orphaned operation cleanup
  - Memory management for large sync operations

#### Virtual Worker Fallback

- If Web Workers are unavailable, implements virtual worker with:
  - RequestAnimationFrame-based scheduling
  - Chunked processing to prevent UI blocking
  - Reduced functionality during page visibility changes
  - Graceful degradation of features

### Subscriptions (Subscribe to notification center events)

- Subscribes to Storage Manager CRUD events to track local changes
- Subscribes to Global State online/offline changes to trigger sync
- Subscribes to Network Request Manager for requests
- Subscribes to visibility API changes for background sync management

### Special Considerations

#### Performance Optimization

- Delta sync reduces payload size by 70-90%
- Batching reduces network round trips
- Compression reduces bandwidth usage
- Adaptive sync adjusts to network conditions
- Incremental sync for large datasets

#### Data Integrity

- Checksums verify data integrity
- Version vectors detect concurrent edits
- Transactional application of changes
- Rollback mechanisms for failed syncs
- Referential integrity maintenance

#### Security

- All sync payloads encrypted in transit
- Authentication tokens refreshed automatically
- Sensitive data sanitized before logging
- Audit trail of all sync operations

#### User Experience

- Progress indicators for long syncs
- Conflict notifications with clear resolution paths
- Sync status always visible
- Background sync doesn't block UI
- Graceful handling of poor connectivity
