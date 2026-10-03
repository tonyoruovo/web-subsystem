> **Amendments (M6, 2026-10-03).** These override the text below wherever they conflict. See [ARCHITECTURE §18.2](../docs/ARCHITECTURE.md#182-storage) and [§8.7](../docs/ARCHITECTURE.md#87-processor-configuration-m6).
>
> - Storage is a featurized, Tab-scoped subsystem with an optional dependency on Crypto. Its lifecycle is the kernel lifecycle, not `idle | booting | running | winding_down`.
> - The coordinator is the processor `coordinator` on the hosts shared, then virtual. The backends run inside it. They are not kernel features.
> - The fallback chain is IndexedDB, OPFS, Cache, then (on the virtual host only) `localStorage`, `sessionStorage` and memory. A worker without a persistent backend refuses to start, so the runner fails over.
> - Callers use collections (`commands.collection(definition)`), not `registerStore` packets. Validation, serialization, compression and encryption run on the main thread.
> - Interactive transactions (`begin`, `commit`, `rollback`) become atomic batches (`batch(operations)`).
> - Change events go to every tab through a `BroadcastChannel`, then to subscribers as the Tab broadcast `storage:changed`. Quota events are `storage:quota`. Integrity failures are `storage:corrupt`.
> - The kernel's state persistence uses `createStatePersistence()`, which runs on the main thread.
> - Dropped for now: query indexes, compaction, backups, an in-memory read cache, field-level encryption, statistics, and the WebSQL and cookie fallbacks.

# Storage Manager
```
 /\        /\   
 ||   ||   ||  ||
 \/   \/   \/  \/
```
- Serialization
- Encryption
- Compression

## Initial Proposal
- Transactions spanning multiple backends will be aborted the instant a backend switch is done/triggered
- All implementations will be running a single shared-worker instance. This means that all CRUD ops will be done from a single thread and ops will be scheduled using an internal scheduler
- Encryption keys will use uuid provided remote once at boot (initialization, hard refresh). These will leave in-memory
- The states - idle, booting, running and winding_down - will implement an abort which can be used for restart, context-switching ops such that they can be safely interrupted without data loss. When these are combined with transactions it makes data movement stable
- In-memory will serve as both a final fallback and as a backend. They will function as in-memory dbs and will loose their data on page refresh. This is intentionally used as a last resort to keep the storage functionality resilient even when indexedDb and the storages fail

- Versioned schema migration needs more context and explanation
- In-memory storage will work as caching layers both for transactions and write/read through layers
- Data will be written alongside their user-defined weights. These will help the quota manager decide which entries to remove during eviction. User-defined eviction policy will determine tie-breaking techniques
- Using the `BroadcastChannel`, change event are fired on the mutative ops
- Support table (capabilities) can be generated from the global state that have already computed these values
- Canonical identifiers/keys in the format `<domain>:<platform>:<platform-version>:<calling-module>:<actual-key>` where:
    - `domain` is a string that represent the name/identifier of the app, website or program
    - `platform` is a string which is one of `android`, `ios`, `win`, `unix`, `mac`, `safari`, `chrome`, `edge`, `firefox`, `opera`, `browser` and `iot`
    - `platform-version` is a positive number
    - `calling-module` is an identifier of the page/logical-module from which the write op was called
    - `actual-keys` is the user-defined key for the value
- Unified external change event for cross-tab storage sync
- Zod schema versioning by applying `schema_version` state for each entry saved
- User defined parsers and serializers/formatters inside schemas

**Storage - Workflow**
```
+-------------------------------------------------------------------------+
|                          VUE 3.3+ APPLICATION                           |
|                                                                         |
|  +-------------+   +-------------+   +-------------+   +-------------+  |
|  |   Page / Component A          |   |  Page / Component B           |  |
|  |                               |   |                               |  |
|  |  useStorage('domain:chrome…') |   |  useStorage('domain:chrome…') |  |
|  +--------------|----------------+   +---------------|---------------+  |
|                 |  Composable (Facade)               |                  |
|                 +------------------|-----------------+                  |
|                                    |                                    |
|             +----------------------▼-----------------------+            |
|             |              FACADE LAYER                    |            |
|             |                                              |            |
|             |  - Resolves canonical key                    |            |
|             |  - Attaches calling-module segment           |            |
|             |  - Exposes: get / set / delete / query /     |            |
|             |             transaction / subscribe          |            |
|             |  - Reads capabilities from global state      |            |
|             |  - Forwards all ops to SharedWorker via      |            |
|             |    MessageChannel (request/response pairs)   |            |
|             +----------------------|-----------------------+            |
|                                    |                                    |
|             +----------------------▼------------------------+           |
|             |           PINIA GLOBAL STATE                  |           |
|             |                                               |           |
|             |  storageState: {                              |           |
|             |    lifecycle: idle|booting|running|           |           |
|             |               winding_down                    |           |
|             |    activeBackend: IndexedDB|LS|SS|Memory      |           |
|             |    capabilities: { idb, ls, ss, sw, crypto }  |           |
|             |    encryptionReady: boolean                   |           |
|             |    pendingOps: Op[]          (drain queue)    |           |
|             |    changeLog: ChangeEvent[]  (audit feed)     |           |
|             |  }                                            |           |
|             +-----------------------------------------------+           |
+-------------------------------------------------------------------------+
                                     |
                    MessageChannel / postMessage
                                     |
+------------------------------------▼------------------------------------+
|                         SHARED WORKER                                   |
|                     (single coordinator thread)                         |
|                                                                         |
|  +-----------------------------------------------------------------+    |
|  |                     LIFECYCLE MANAGER                           |    |
|  |                                                                 |    |
|  |   idle --► booting --► running --► winding_down --► idle        |    |
|  |               |            |             |                      |    |
|  |            abort()      abort()       abort()   (all states     |    |
|  |               |            |             |       implement      |    |
|  |               +------------┴-------------+       AbortSignal)   |    |
|  |                                                                 |    |
|  |   Boot sequence:                                                |    |
|  |     1. Run capability probes (write/read/delete smoke tests)    |    |
|  |     2. Fetch encryption key from remote (with timeout + abort)  |    |
|  |     3. Init SubtleCrypto with key, mark encryptionReady         |    |
|  |     4. Select active backend strategy via fallback chain        |    |
|  |     5. Run schema migrations on active backend                  |    |
|  |     6. Drain pendingOps queue                                   |    |
|  |     7. Transition to running                                    |    |
|  +-----------------------------------------------------------------+    |
|                                                                         |
|  +-----------------------------------------------------------------+    |
|  |                      OP SCHEDULER                               |    |
|  |                                                                 |    |
|  |   Incoming ops --► priority queue --► serial execution          |    |
|  |                                                                 |    |
|  |   Op types: Read | Write | Delete | Transaction | Migration     |    |
|  |   Each op carries: AbortSignal, priority, transactionId?,       |    |
|  |                                                                 |    |
|  |   Scheduler rules:                                              |    |
|  |   - One active transaction at a time (others wait in queue)     |    |
|  |   - Backend switch during transaction --► abort transaction     |    |
|  |   - winding_down --► drain current op, reject rest              |    |
|  +-------------------------------|---------------------------------+    |
|                                  |                                      |
|  +-------------------------------▼-----------------------------------+  |
|  |                    TRANSACTION MANAGER                            |  |
|  |                                                                   |  |
|  |   begin() --► snapshot pre-state --► execute ops                  |  |
|  |                                         |                         |  |
|  |                               success? -┤                         |  |
|  |                                  yes --► commit, emit change      |  |
|  |                                  no  --► restore snapshot         |  |
|  |                                         (compensating rollback    |  |
|  |                                          on LS/SS; native on IDB) |  |
|  |                                                                   |  |
|  |   Transaction strength levels:                                    |  |
|  |     serializable  -- IDB only                                     |  |
|  |     compensating  -- LS / SS                                      |  |
|  |     best-effort   -- Memory                                       |  |
|  |   (strength exposed to caller; mismatch rejects the transaction)  |  |
|  +-------------------------------|-----------------------------------+  |
|                                  |                                      |
|  +-------------------------------▼-----------------------------------+  |
|  |                      DATA PIPELINE                                |  |
|  |              (ordered, applied per op)                            |  |
|  |                                                                   |  |
|  |   WRITE path:                                                     |  |
|  |     validate (Zod) --► user serializer --► encrypt                |  |
|  |     --► attach metadata --► backend write                         |  |
|  |                                                                   |  |
|  |   READ path:                                                      |  |
|  |     backend read --► check TTL/expiry --► decrypt                 |  |
|  |     --► check schema_version --► migrate if stale                 |  |
|  |     --► user deserializer --► validate (Zod) --► return           |  |
|  |                                                                   |  |
|  |   Metadata envelope (stored alongside every entry):               |  |
|  |   {                                                               |  |
|  |     schema_version: number                                        |  |
|  |     written_at:     timestamp                                     |  |
|  |     expires_at:     timestamp | null                              |  |
|  |     weight:         number    (user-defined, for eviction)        |  |
|  |     backend:        string    (which strategy wrote this)         |  |
|  |   }                                                               |  |
|  +-------------------------------|-----------------------------------+  |
|                                  |                                      |
|  +-------------------------------▼-----------------------------------+  |
|  |                    STRATEGY REGISTRY                              |  |
|  |                                                                   |  |
|  |   Fallback chain (resolved at boot from capability probe):        |  |
|  |                                                                   |  |
|  |   IndexedDB --► LocalStorage --► SessionStorage --► Memory        |  |
|  |      |               |                |               |           |  |
|  |   serializable   compensating    compensating    best-effort      |  |
|  |   transactions   transactions    transactions    transactions     |  |
|  |                                                                   |  |
|  |   Each strategy implements:                                       |  |
|  |     probe() → CapabilityResult                                    |  |
|  |     read(key) / write(key, envelope) / delete(key)                |  |
|  |     beginTx() / commitTx() / rollbackTx()                         |  |
|  |     estimateQuota() / evict(policy)                               |  |
|  |     close()   ← called during winding_down                        |  |
|  |                                                                   |  |
|  |   User may override chain order via Facade config                 |  |
|  +-------------------------------|-----------------------------------+  |
|                                  |                                      |
|  +-------------------------------▼-----------------------------------+  |
|  |                      QUOTA MANAGER                                |  |
|  |                                                                   |  |
|  |   Monitors: navigator.storage.estimate() on interval              |  |
|  |   On pressure:                                                    |  |
|  |     1. Evict expired entries first (TTL sweep)                    |  |
|  |     2. Sort remaining by user-defined weight                      |  |
|  |     3. Apply user eviction policy for tie-breaking                |  |
|  |     4. Emit quota warning event to all connected tabs             |  |
|  +-------------------------------------------------------------------+  |
|                                                                         |
|  +------------------------------------------------------------------+   |
|  |                   MIGRATION RUNNER                               |   |
|  |                                                                  |   |
|  |   At boot, per backend:                                          |   |
|  |     - Read current stored schema_version                         |   |
|  |     - Compare against registered migrations[]                    |   |
|  |     - Run transforms sequentially, version by version            |   |
|  |     - Each migration: (oldData, oldSchema) => newData            |   |
|  |     - Wrap entire migration sequence in a transaction            |   |
|  |     - On failure: rollback, surface error, halt boot             |   |
|  |                                                                  |   |
|  |   Per-entry lazy migration (on READ):                            |   |
|  |     - If entry.schema_version < current: migrate that entry      |   |
|  |     - Write migrated entry back before returning to caller       |   |
|  +------------------------------------------------------------------+   |
+-------------------------------------------------------------------------+
                                     |
                    BroadcastChannel('storage-sync')
                                     |
              +----------------------▼------------------------+
              |          ALL CONNECTED TABS / WINDOWS         |
              |                                               |
              |  Receives: ChangeEvent {                      |
              |    key, op, schema_version, timestamp,        |
              |    backend, workerId                          |
              |  }                                            |
              |                                               |
              |  Facade subscribes, updates its state, and    |
              |  notifies the host framework                  |
              +-----------------------------------------------+
```

## Initial Proposal - 2
### States

The state object for the Storage Manager subsystem contains:

- **importance/priority/weight**: `CRITICAL` - Storage operations are fundamental to data persistence and offline functionality
- **storageRegistry**: Map of registered storage schemas and configurations
  ```javascript
  {
    storeName: {
      type: 'indexedDB' | 'localStorage' | 'sessionStorage',
      schema: ZodSchema,
      version: number,
      indexes: Array<{name: string, keyPath: string, unique: boolean}>,
      ttl: number | null, // Time-to-live for entries
      maxSize: number | null, // Max entries or bytes
      evictionPolicy: 'LRU' | 'FIFO' | 'LFU' | 'NONE'
    }
  }
  ```
- **activeConnections**: Map of open IndexedDB connections
  ```javascript
  {
    dbName: {
      connection: IDBDatabase,
      version: number,
      openedAt: number,
      lastUsed: number,
      transactionCount: number,
      status: 'OPEN' | 'CLOSING' | 'CLOSED' | 'ERROR'
    }
  }
  ```
- **transactionQueue**: Priority queue for pending transactions
  ```javascript
  {
    transactionId: {
      dbName: string,
      storeNames: string[],
      mode: 'readonly' | 'readwrite',
      operations: Array<Operation>,
      priority: number,
      status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED',
      createdAt: number
    }
  }
  ```
- **storageQuotas**: Current storage usage and limits
  ```javascript
  {
    total: number, // Total available storage (bytes)
    used: number, // Currently used storage (bytes)
    available: number, // Remaining storage (bytes)
    byStore: Record<string, {
      used: number,
      itemCount: number,
      lastCalculated: number
    }>,
    thresholds: {
      warning: number, // Percentage (e.g., 80)
      critical: number // Percentage (e.g., 95)
    }
  }
  ```
- **cacheMetadata**: Metadata for cached entries
  ```javascript
  {
    cacheKey: {
      storeName: string,
      key: any,
      size: number,
      createdAt: number,
      expiresAt: number | null,
      accessCount: number,
      lastAccessed: number,
      tags: string[]
    }
  }
  ```
- **storageSettings**: Configuration object:
  - **autoCompact**: Flag for automatic database compaction
  - **compactThreshold**: Threshold for triggering compaction (percentage of deleted records)
  - **enableEncryption**: Flag for encrypting sensitive data at rest
  - **compressionEnabled**: Flag for compressing large data before storage
  - **compressionThreshold**: Minimum size (bytes) to trigger compression
  - **transactionTimeout**: Default transaction timeout (ms)
  - **maxConcurrentTransactions**: Maximum simultaneous transactions
  - **enableOptimisticLocking**: Flag for optimistic concurrency control
  - **enableQuotaMonitoring**: Flag for continuous quota monitoring
  - **quotaCheckInterval**: Interval for quota checks (ms)
  - **migrationStrategy**: Strategy for schema migrations ('auto' | 'manual')
  - **backupEnabled**: Flag for automatic backups
  - **backupInterval**: Interval for automatic backups (ms)
- **statistics**: Real-time storage statistics
  ```javascript
  {
    totalOperations: number,
    successfulOperations: number,
    failedOperations: number,
    operationsByType: Record<'CREATE' | 'READ' | 'UPDATE' | 'DELETE', number>,
    operationsByStore: Record<string, number>,
    averageOperationTime: number,
    cacheHitRate: number,
    storageFragmentation: number, // Percentage
    lastCompactionTime: number | null
  }
  ```
- **migrationHistory**: Log of schema migrations
  ```javascript
  {
    migrationId: {
      storeName: string,
      fromVersion: number,
      toVersion: number,
      executedAt: number,
      duration: number,
      success: boolean,
      rollbackAvailable: boolean
    }
  }
  ```
- **eventSubscriptions**: Map of subsystems subscribed to CRUD events
  ```javascript
  {
    subsystemId: {
      stores: string[],
      operations: Array<'CREATE' | 'READ' | 'UPDATE' | 'DELETE'>,
      filters: {
        keyPatterns?: RegExp[],
        minPriority?: number
      }
    }
  }
  ```

### Features

#### Schema Manager

- Registers and validates storage schemas using Zod
- Manages schema versions and migrations
- Handles schema evolution and backward compatibility
- Validates data against schemas before storage
- Provides schema introspection capabilities
- **Weight**: HIGH - Data integrity foundation

#### IndexedDB Manager

- Manages IndexedDB connections and lifecycle
- Implements database opening, closing, and deletion
- Handles database upgrades and version management
- Manages object stores and indexes
- Implements transaction coordination
- **Weight**: HIGH - Primary storage mechanism

#### Web Storage Manager

- Manages localStorage and sessionStorage operations
- Implements unified interface for both storage types
- Handles storage quota and overflow
- Provides key enumeration and pattern matching
- Implements namespace isolation
- **Weight**: MEDIUM - Supplementary storage

#### Transaction Coordinator

- Manages transaction lifecycle and ordering
- Implements transaction queuing and prioritization
- Handles concurrent transaction conflicts
- Provides transaction atomicity guarantees
- Implements deadlock detection and resolution
- **Weight**: HIGH - Data consistency

#### CRUD Operation Handler

- Implements Create, Read, Update, Delete operations
- Provides batch operation capabilities
- Handles optimistic locking and version conflicts
- Implements cascade operations (delete related records)
- Provides upsert (insert or update) operations
- **Weight**: HIGH - Core functionality

#### Validation Engine

- Validates data against registered schemas
- Provides comprehensive error messages
- Supports custom validation rules
- Implements pre-storage and post-retrieval validation
- Handles validation for nested and complex objects
- **Weight**: HIGH - Data quality assurance

#### Query Engine

- Implements flexible querying capabilities
- Supports filtering, sorting, and pagination
- Provides index-based optimized queries
- Implements full-text search (where supported)
- Handles cursor-based iteration for large datasets
- **Weight**: MEDIUM - Data retrieval optimization

#### Cache Manager

- Implements in-memory caching layer
- Manages cache invalidation and TTL
- Implements various eviction policies (LRU, FIFO, LFU)
- Provides cache statistics and hit rates
- Handles cache warming and preloading
- **Weight**: MEDIUM - Performance optimization

#### Quota Monitor

- Continuously monitors storage quota
- Calculates storage usage per store
- Emits warnings when approaching limits
- Triggers cleanup or compaction when needed
- Provides quota estimates and projections
- **Weight**: HIGH - Storage health

#### Compaction Manager

- Performs database compaction to reclaim space
- Removes deleted or expired records
- Defragments storage for better performance
- Implements incremental compaction
- Schedules compaction during idle periods
- **Weight**: MEDIUM - Maintenance

#### Migration Manager

- Handles schema version migrations
- Implements migration scripts and rollbacks
- Preserves data during migrations
- Validates data after migrations
- Logs migration history for auditing
- **Weight**: HIGH - Schema evolution

#### Encryption Handler

- Encrypts sensitive data before storage
- Decrypts data on retrieval
- Manages encryption keys securely
- Supports field-level encryption
- Implements key rotation
- **Weight**: HIGH - Security

#### Compression Handler

- Compresses large data before storage
- Decompresses data on retrieval
- Selects optimal compression algorithm
- Implements adaptive compression based on data type
- Tracks compression ratios
- **Weight**: LOW - Space optimization

#### Backup Manager

- Creates periodic backups of critical data
- Exports data in portable formats
- Implements incremental backups
- Handles backup restoration
- Manages backup retention policies
- **Weight**: MEDIUM - Data protection

#### Event Broadcaster

- Emits CRUD events to subscribed subsystems
- Implements event filtering and routing
- Provides event batching for performance
- Handles event delivery guarantees
- Implements event replay for sync
- **Weight**: MEDIUM - Inter-subsystem communication

#### Storage Analytics

- Tracks storage operation metrics
- Monitors performance and bottlenecks
- Analyzes access patterns
- Identifies hot and cold data
- Provides optimization recommendations
- Sends data to Analytics Manager
- **Weight**: LOW - Observability

### Life Cycle Manager

#### Initialization Sequence

1. Detect browser storage capabilities and limitations
2. Register all event IDs with action names in notification center
3. Initialize storage quota monitoring
4. Load persisted schemas and configurations
5. Initialize feature components in order:
   - Schema Manager (first - needed by others)
   - Validation Engine (early - data quality)
   - Encryption Handler (early - security)
   - Compression Handler
   - IndexedDB Manager
   - Web Storage Manager
   - Cache Manager
   - Transaction Coordinator
   - CRUD Operation Handler
   - Query Engine
   - Quota Monitor
   - Migration Manager
   - Compaction Manager
   - Backup Manager
   - Event Broadcaster
   - Storage Analytics
6. Open persistent IndexedDB connections for registered stores
7. Run pending migrations if any
8. Initialize in-memory cache with frequently accessed data
9. Start quota monitoring if enabled
10. Subscribe to critical events:
    - Global State stop events for cleanup
    - Browser visibility changes for optimization
11. Restore interrupted transactions from previous session
12. Log initialization complete event

#### Destruction Sequence

1. Pause all ongoing operations
2. Unsubscribe from all notification center events
3. Complete or abort all active transactions
4. Flush cache to persistent storage
5. Persist current state:
   - Transaction queue
   - Cache metadata
   - Statistics
6. Close all IndexedDB connections gracefully
7. Clear sensitive data from memory
8. Generate final storage session statistics
9. Terminate worker connections
10. Log shutdown complete event

### Worker

The Storage Manager uses a **Physical Worker** (Web Worker) to offload intensive storage operations from the UI thread while maintaining a Virtual Worker interface for synchronous operations.

#### Receiver

- Receives CRUD operation requests from main thread
- Accepts transaction requests (begin, commit, rollback)
- Receives schema registration and validation requests
- Accepts query requests with filters and sorting
- Receives cache operation commands
- Accepts backup and restore commands
- Receives migration execution requests
- Accepts compaction triggers

#### Processor

##### Transaction Processor

- Validates transaction requests
- Manages transaction lifecycle
- Implements ACID properties
- Handles transaction conflicts
- Coordinates multi-store transactions
- Implements savepoints for partial rollback

##### CRUD Processor

- Validates operations against schemas
- Executes create, read, update, delete operations
- Handles batch operations efficiently
- Implements optimistic locking
- Manages version conflicts
- Applies encryption/compression as needed

##### Query Processor

- Parses query specifications
- Optimizes query execution plans
- Uses indexes for efficient retrieval
- Implements pagination and cursors
- Handles sorting and filtering
- Aggregates results from multiple stores

##### Validation Processor

- Validates data against Zod schemas
- Provides detailed validation errors
- Implements custom validation rules
- Handles nested object validation
- Validates foreign key constraints

##### Cache Processor

- Manages in-memory cache operations
- Implements eviction policies
- Handles cache invalidation
- Computes cache keys
- Tracks cache statistics

##### Migration Processor

- Executes schema migration scripts
- Validates data after migration
- Implements rollback mechanisms
- Logs migration progress
- Handles large-scale data transformations

##### Encryption/Compression Processor

- Encrypts/decrypts sensitive fields
- Compresses/decompresses large data
- Manages encryption keys
- Selects optimal algorithms
- Handles key rotation

##### Quota Processor

- Calculates storage usage
- Monitors quota changes
- Triggers cleanup operations
- Estimates future usage
- Implements storage reclamation strategies

#### Dispatcher

- Returns operation results to main thread
- Emits CRUD events to notification center
- Sends quota warnings when thresholds exceeded
- Posts error events for failed operations
- Emits migration progress updates
- Sends statistics to Analytics Manager
- Notifies Logger of critical operations
- Broadcasts storage status changes

#### Additional Worker Requirements

- **Pausable**: Can pause non-critical operations during high-priority work
- **Resumable**: Resumes paused operations from checkpoints
- **Abortable**: Can abort long-running operations cleanly
- **Error Handling**:
  - Isolates operation errors to prevent corruption
  - Implements automatic rollback on transaction failures
  - Provides detailed error diagnostics
  - Handles database corruption with recovery
- **Visibility API**:
  - Reduces background operations when page hidden
  - Defers compaction and backups to idle periods
  - Prioritizes user-initiated operations
- **Cleanup Protocols**:
  - Automatic transaction cleanup on timeout
  - Connection cleanup on database errors
  - Memory cleanup after large operations
  - Orphaned data detection and removal
  - Cache cleanup on storage pressure

#### Virtual Worker Mode

- Used for simple, synchronous storage operations (localStorage/sessionStorage)
- Implements immediate execution for critical operations
- Provides fallback when Web Workers unavailable
- Limited to non-blocking operations

### Dependencies

Ordered by initialization priority:

1. **Global State** (CRITICAL) - Required for platform status, timestamps
2. **Notification Center** (CRITICAL) - Required for event coordination
3. **Message Queue** (HIGH) - For sending storage event packets
4. **Logger** (MEDIUM) - For logging storage operations and errors
5. **Analytics Manager** (LOW) - For storage performance metrics

#### Functional Predicates

```javascript
shouldValidate(operation) {
  const store = state.storageRegistry[operation.storeName];
  return store && store.schema && !operation.skipValidation;
}

shouldEncrypt(storeName, fieldPath) {
  const store = state.storageRegistry[storeName];
  return state.storageSettings.enableEncryption &&
         store.encryptedFields?.includes(fieldPath);
}

shouldCompress(data) {
  return state.storageSettings.compressionEnabled &&
         calculateSize(data) > state.storageSettings.compressionThreshold;
}

shouldUseCache(operation) {
  return operation.type === 'READ' &&
         !operation.skipCache &&
         isCacheable(operation.storeName);
}

shouldTriggerCompaction() {
  return state.storageSettings.autoCompact &&
         state.statistics.storageFragmentation > state.storageSettings.compactThreshold;
}

shouldEmitQuotaWarning() {
  const usagePercentage = (state.storageQuotas.used / state.storageQuotas.total) * 100;
  return usagePercentage >= state.storageQuotas.thresholds.warning;
}

shouldQueueTransaction(transaction) {
  return getCurrentTransactionCount() >= state.storageSettings.maxConcurrentTransactions ||
         hasConflictingTransaction(transaction);
}

shouldEvictFromCache(cacheEntry) {
  const now = Date.now();
  return (cacheEntry.expiresAt && cacheEntry.expiresAt < now) ||
         isEvictionPolicyTriggered(cacheEntry);
}
```

### Control Interface

#### Getters (No-arg)

- `getStorageQuota()` - Returns current storage usage and available space
- `getRegisteredStores()` - Returns list of registered store names
- `getStoreSchema(storeName)` - Returns schema for specific store
- `getActiveTransactionCount()` - Returns number of in-progress transactions
- `getStorageStatistics()` - Returns comprehensive storage statistics
- `getCacheStatistics()` - Returns cache hit/miss rates and size
- `getStorageHealth()` - Returns overall storage health status
- `getMigrationHistory()` - Returns log of executed migrations
- `isStoreOpen(storeName)` - Checks if IndexedDB store is open

#### Setters

- `setCompactionEnabled(enabled)` - Enables/disables auto-compaction
- `setEncryptionEnabled(enabled)` - Enables/disables encryption
- `setCompressionEnabled(enabled)` - Enables/disables compression
- `setQuotaThresholds(warning, critical)` - Updates quota warning thresholds
- `setTransactionTimeout(ms)` - Updates default transaction timeout
- `setCacheEvictionPolicy(policy)` - Updates cache eviction strategy

#### Actions (Fire events to message queue)

##### Schema Management

- `registerStore(config)` - Registers new storage schema
  ```javascript
  config: {
    name: string,
    type: 'indexedDB' | 'localStorage' | 'sessionStorage',
    schema: ZodSchema,
    version?: number,
    indexes?: Array<{name: string, keyPath: string, unique?: boolean}>,
    ttl?: number,
    maxSize?: number,
    evictionPolicy?: 'LRU' | 'FIFO' | 'LFU' | 'NONE',
    encryptedFields?: string[]
  }
  ```
- `updateStoreSchema(storeName, newSchema, version)` - Updates existing schema
- `deleteStore(storeName)` - Deletes store and all its data
- `migrateStore(storeName, migrationScript)` - Executes schema migration

##### CRUD Operations

- `create(storeName, data, options?)` - Creates new entry
  ```javascript
  options: {
    skipValidation?: boolean,
    skipCache?: boolean,
    priority?: number,
    onProgress?: (progress) => void
  }
  ```
- `read(storeName, key, options?)` - Reads entry by key
- `update(storeName, key, data, options?)` - Updates existing entry
- `delete(storeName, key, options?)` - Deletes entry
- `upsert(storeName, key, data, options?)` - Insert or update
- `batchCreate(storeName, items, options?)` - Batch create
- `batchUpdate(storeName, updates, options?)` - Batch update
- `batchDelete(storeName, keys, options?)` - Batch delete

##### Query Operations

- `query(storeName, filters, options?)` - Query with filters
  ```javascript
  filters: {
    where?: Record<string, any>,
    orderBy?: {field: string, direction: 'asc' | 'desc'},
    limit?: number,
    offset?: number,
    tags?: string[]
  },
  options: {
    useCache?: boolean,
    includeMetadata?: boolean
  }
  ```
- `count(storeName, filters?)` - Count matching entries
- `exists(storeName, key)` - Check if key exists
- `getAll(storeName, options?)` - Get all entries
- `clear(storeName)` - Clear all entries in store

##### Transaction Operations

- `beginTransaction(storeNames, mode)` - Start transaction
- `commitTransaction(transactionId)` - Commit transaction
- `rollbackTransaction(transactionId)` - Rollback transaction
- `executeInTransaction(storeNames, operations)` - Execute operations atomically

##### Cache Operations

- `invalidateCache(storeName, key?)` - Invalidate cache entries
- `clearCache(storeName?)` - Clear cache for store or all
- `warmCache(storeName, keys)` - Preload cache with keys
- `getCacheEntry(storeName, key)` - Get cached entry

##### Maintenance Operations

- `compactStore(storeName)` - Manually trigger compaction
- `backupStore(storeName)` - Create backup
- `restoreStore(storeName, backupData)` - Restore from backup
- `exportStore(storeName, format)` - Export data
- `importStore(storeName, data)` - Import data
- `repairStore(storeName)` - Attempt to repair corrupted store

#### Subscriptions (Subscribe to notification center events)

- Subscribes to Global State stop events for cleanup
- Subscribes to browser visibility changes for optimization
- Subscribes to storage quota changes from browser
- Subscribes to Auth Manager for user context changes (for user-specific stores)

### Message Packets

```typescript
/**
 * Shared Type Definitions
 */
export type StorageType = 'indexedDB' | 'localStorage' | 'sessionStorage'
export type CRUDOperation = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE'
export type TransactionMode = 'readonly' | 'readwrite'
export type Importance = 'HIGH' | 'MEDIUM' | 'LOW'

export interface BasePacket<P, R = any> {
  eventId: symbol
  actionName: string
  payload: P
  importance: Importance
  onComplete: (result: R) => void
  onError: (error: Error) => void
  onLog: ((fingerprints: Fingerprint[]) => void) | null
  fingerprints: Fingerprint[]
}

/**
 * 1. Store Registration Packet
 */
export interface RegisterStorePayload {
  name: string
  type: StorageType
  schema: any // ZodSchema
  version: number
  indexes: Array<{
    name: string
    keyPath: string | string[]
    unique: boolean
  }>
  ttl: number | null
  maxSize: number | null
  evictionPolicy: 'LRU' | 'FIFO' | 'LFU' | 'NONE'
  encryptedFields: string[]
}

export interface RegisterStoreResult {
  success: boolean
  storeName: string
  version: number
}

export type RegisterStorePacket = BasePacket<RegisterStorePayload, RegisterStoreResult>

/**
 * 2. CRUD Operation Packet
 */
export interface CRUDOperationPayload {
  operation: CRUDOperation
  storeName: string
  key?: any
  data?: any
  options: {
    skipValidation: boolean
    skipCache: boolean
    priority: number
    transactionId: string | null
  }
  subsystemId: string
}

export interface CRUDOperationResult {
  success: boolean
  operation: CRUDOperation
  storeName: string
  key: any
  data: any
  version: number
  timestamp: number
  fromCache: boolean
}

export type CRUDOperationPacket = BasePacket<CRUDOperationPayload, CRUDOperationResult>

/**
 * 3. Query Packet
 */
export interface QueryPayload {
  storeName: string
  filters: {
    where: Record<string, any>
    orderBy: { field: string; direction: 'asc' | 'desc' } | null
    limit: number | null
    offset: number | null
    tags: string[]
  }
  options: {
    useCache: boolean
    includeMetadata: boolean
  }
}

export interface QueryResult {
  results: any[]
  totalCount: number
  hasMore: boolean
  executionTime: number
  fromCache: boolean
}

export type QueryPacket = BasePacket<QueryPayload, QueryResult>

/**
 * 4. Transaction Packet
 */
export interface TransactionPayload {
  action: 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  transactionId: string
  storeNames: string[]
  mode: TransactionMode
  operations: CRUDOperationPayload[]
}

export interface TransactionResult {
  transactionId: string
  action: 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  success: boolean
  operationsCompleted: number
  operationsFailed: number
  duration: number
}

export type TransactionPacket = BasePacket<TransactionPayload, TransactionResult>

/**
 * 5. CRUD Event Packet (Broadcast)
 */
export interface CRUDEventPayload {
  operation: CRUDOperation
  storeName: string
  key: any
  data: any
  previousData: any | null // For UPDATE operations
  version: number
  timestamp: number
  subsystemId: string
  transactionId: string | null
}

export type CRUDEventPacket = BasePacket<CRUDEventPayload, void>

/**
 * 6. Quota Warning Packet
 */
export interface QuotaWarningPayload {
  severity: 'WARNING' | 'CRITICAL'
  totalQuota: number
  usedQuota: number
  availableQuota: number
  usagePercentage: number
  topStores: Array<{ storeName: string; size: number; percentage: number }>
  timestamp: number
}

export type QuotaWarningPacket = BasePacket<QuotaWarningPayload, void>

/**
 * 7. Migration Packet
 */
export interface MigrationPayload {
  storeName: string
  fromVersion: number
  toVersion: number
  migrationScript: string | Function
  validateAfter: boolean
}

export interface MigrationResult {
  success: boolean
  storeName: string
  fromVersion: number
  toVersion: number
  recordsMigrated: number
  duration: number
  errors: string[]
}

export type MigrationPacket = BasePacket<MigrationPayload, MigrationResult>

/**
 * 8. Compaction Packet
 */
export interface CompactionPayload {
  storeName: string
  force: boolean
  estimateOnly: boolean
}

export interface CompactionResult {
  success: boolean
  storeName: string
  spaceReclaimed: number
  recordsRemoved: number
  duration: number
  fragmentationBefore: number
  fragmentationAfter: number
}

export type CompactionPacket = BasePacket<CompactionPayload, CompactionResult>

/**
 * 9. Backup/Restore Packet
 */
export interface BackupPayload {
  action: 'BACKUP' | 'RESTORE'
  storeName: string
  data: any | null // For restore
  format: 'json' | 'binary'
  compress: boolean
}

export interface BackupResult {
  action: 'BACKUP' | 'RESTORE'
  success: boolean
  storeName: string
  data: any | null // For backup
  size: number
  recordCount: number
  timestamp: number
}

export type BackupPacket = BasePacket<BackupPayload, BackupResult>

/**
 * 10. Cache Operation Packet
 */
export interface CacheOperationPayload {
  operation: 'INVALIDATE' | 'CLEAR' | 'WARM' | 'GET'
  storeName: string
  key: any | null
  keys: any[] | null // For warm
}

export interface CacheOperationResult {
  success: boolean
  operation: string
  keysAffected: number
  cacheSize: number
}

export type CacheOperationPacket = BasePacket<CacheOperationPayload, CacheOperationResult>

/**
 * Unified Storage Packet Type
 */
export type StoragePacket =
  | RegisterStorePacket
  | CRUDOperationPacket
  | QueryPacket
  | TransactionPacket
  | CRUDEventPacket
  | QuotaWarningPacket
  | MigrationPacket
  | CompactionPacket
  | BackupPacket
  | CacheOperationPacket
```

---

### Special Considerations

#### Data Integrity

- Schema validation on all write operations
- Transaction support for atomic operations
- Optimistic locking for concurrent access
- Foreign key constraint enforcement
- Automatic data versioning
- Rollback capabilities on failures

#### Performance Optimization

- In-memory caching with intelligent eviction
- Index-based query optimization
- Batch operation support
- Lazy loading for large datasets
- Connection pooling for IndexedDB
- Query result caching

#### Storage Strategies

**IndexedDB**: Primary storage for structured data

- Supports complex queries and indexes
- Transactional with ACID guarantees
- Asynchronous operations
- Large storage capacity

**localStorage**: Supplementary storage for simple key-value data

- Synchronous operations (fast for small data)
- 5-10MB limit per domain
- String-only storage
- Survives browser restarts

**sessionStorage**: Temporary storage for session data

- Cleared on tab close
- Same capacity as localStorage
- Isolated per tab
- Useful for temporary state

#### Schema Evolution

- Automatic migration execution
- Rollback support for failed migrations
- Data preservation during migrations
- Version tracking and history
- Backward compatibility checks

#### Quota Management

- Continuous monitoring of storage usage
- Proactive warnings at configurable thresholds
- Automatic cleanup of expired data
- User-triggered cleanup options
- Storage estimation and forecasting

#### Security

- Field-level encryption for sensitive data
- Secure key management
- Data sanitization before storage
- Access control per store
- Audit logging of sensitive operations

#### Error Handling

- Graceful degradation on quota exceeded
- Automatic retry for transient failures
- Detailed error reporting with context
- Database corruption detection and recovery
- Connection failure handling

#### Browser Compatibility

- IndexedDB with fallback to WebSQL (deprecated)
- localStorage with cookie fallback
- Feature detection for all APIs
- Polyfills where applicable
- Graceful degradation on unsupported features

#### Developer Experience

- Schema-first approach with Zod validation
- Type-safe operations with TypeScript
- Comprehensive error messages
- Transaction support for complex operations
- Query builder for flexible data retrieval
- Built-in migration tools
