
**Type**: Centralized  
**Importance/Priority/Weight**: **CRITICAL** - Foundation for all subsystem coordination and platform state management

The Global State subsystem serves as the central nervous system of the platform, maintaining the canonical source of truth for platform-wide status, coordinating subsystem lifecycle, and orchestrating inter-subsystem communication. Unlike featurized subsystems, it operates as a singleton with direct visibility to all other subsystems.

---

## States

The state object maintains comprehensive platform-wide state with strict immutability guarantees:

### Core Platform Status
- **platformStatus**: Enum (`INITIALIZING`, `IDLE`, `BUSY`, `DEGRADED`, `STOPPED`, `CRASHED`)
  - `INITIALIZING`: Platform bootstrapping in progress
  - `IDLE`: No pending work, ready for operations
  - `BUSY`: Pending tokens above threshold, accepting only critical packets
  - `DEGRADED`: Some subsystems unavailable, reduced functionality
  - `STOPPED`: Graceful shutdown initiated, no new work accepted
  - `CRASHED`: Unrecoverable error, requires restart

- **pendingTokens**: `Map<string, PendingToken>` - Active work tracking
  ```typescript
  interface PendingToken {
    id: string;
    subsystemId: string;
    importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    createdAt: number;
    estimatedDuration: number | null;
    category: 'NETWORK' | 'STORAGE' | 'AUTH' | 'COMPUTATION' | 'UI' | 'SYNC';
  }
  ```
  - When `size === 0`: Platform is `IDLE`
  - When `size > busyThreshold`: Platform is `BUSY`
  - When `pendingTokens === null`: Platform is `STOPPED`
  - CRITICAL tokens can exceed threshold and still be accepted

- **busyThreshold**: Number - Threshold for BUSY status (default: 50, dynamic based on device capabilities)

- **subsystemRegistry**: `Map<string, SubsystemStatus>` - Real-time subsystem health
  ```typescript
  interface SubsystemStatus {
    subsystemId: string;
    type: 'CENTRALIZED' | 'FEATURIZED';
    status: 'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'BUSY' | 'ERROR' | 'DESTROYED';
    importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    lastHeartbeat: number;
    errorCount: number;
    dependencies: string[];
    healthScore: number; // 0-100
    startedAt: number | null;
  }
  ```

### Network & Connectivity
- **onlineStatus**: Object containing detailed network state
  ```typescript
  interface OnlineStatus {
    online: boolean;
    connectionType: 'none' | 'wifi' | 'cellular' | 'ethernet' | 'unknown';
    effectiveType: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
    downlink: number | null; // Mbps
    rtt: number | null; // Round-trip time in ms
    saveData: boolean; // User's data saver preference
    lastOnlineTime: number | null;
    lastOfflineTime: number | null;
    transitionCount: number; // Number of online/offline transitions
  }
  ```

### Authentication & User Context
- **authenticationContext**: Object containing auth state (synced with Auth Manager)
  ```typescript
  interface AuthenticationContext {
    authenticated: boolean;
    authLevel: 'GUEST' | 'USER' | 'ADMIN' | 'CORPORATE' | 'MODERATOR' | 'SUSPENDED' | 'EXPIRED';
    permissionSummary: {
      hasElevatedPrivileges: boolean;
      criticalPermissions: string[];
      elevationTokens: Record<string, { token: string; expiresAt: number; scope: string[] }>;
    };
  }
  ```

### Timing & Synchronization
- **timestamps**: Object containing critical platform timestamps
  ```typescript
  interface Timestamps {
    platformStartup: number;
    lastLoginTime: number | null; // For login request
    lastLogoutTime: number | null; // For user initiated logout request
    lastHeartbeat: number;
    lastSync: number | null;
    lastNetworkRequest: number | null;
    lastStorageWrite: number | null;
    lastPacketProcessed: number | null;
    lastError: number | null;
    // lastUserInteraction: number | null;
  }
  ```

### Device & Environment
- **deviceInfo**: Object containing device capabilities and characteristics
  ```typescript
  interface DeviceInfo {
    // User Agent parsing
    browser: string;
    browserVersion: string;
    os: string;
    osVersion: string;

    // Locale
    language: string;
    timezone: string;
    
    // Capabilities
    supportsWebWorkers: boolean;
    supportsIndexedDB: boolean;
    supportsServiceWorker: boolean;
    supportsWebAssembly: boolean;
    
    // Performance
    deviceMemory: number | null; // GB
    hardwareConcurrency: number; // CPU cores
    maxTouchPoints: number;
    
    // Display
    devicePixelRatio: number;
    
    // Features
    cookiesEnabled: boolean;
    doNotTrack: boolean | null;
    
    // Identifiers
    deviceFingerprint: string | null; // Hashed composite
    sessionFingerprint: string; // Unique per session
    deviceType: 'desktop' | 'mobile' | 'tablet';
  }
  ```

### Performance & Resource Monitoring
- **performanceMetrics**: Object containing platform performance data
  ```typescript
  interface PerformanceMetrics {
    // Memory
    memoryUsage: {
      heapUsed: number | null;
      heapTotal: number | null;
      jsHeapSizeLimit: number | null;
    };
    
    // Timing
    averagePacketProcessingTime: number; // ms
    averageResponseTime: number; // ms
    subsystemResponseTimes: Map<string, number>; // subsystemId -> avg response time
    
    // Throughput
    packetsProcessedLastMinute: number;
    packetsProcessedTotal: number;
    errorsLastMinute: number;
    errorsTotal: number;
    
    // Resource usage
    activeWebWorkers: number;
    activeConnections: number;
    cacheSize: number; // bytes
    storageUsed: number; // bytes

    // Battery & power (if available)
    battery?: {
        level: number;
        charging: boolean;
        chargingTime: number | null;
        dischargingTime: number | null;
    };
    
    // Health indicators
    platformHealthScore: number; // 0-100
    lastPerformanceCheck: number;
    // Transient UI hints (non-persistent)
    uiHints: {
        frameRate: number | null;
        reducedMotion: boolean;
        highContrast: boolean;
    };
  }
  ```

### Feature Flags & Configuration
- **featureFlags**: `Map<string, FeatureFlag>` - Dynamic feature control
  ```typescript
  interface FeatureFlag {
    key: string;
    enabled: boolean;
    rolloutPercentage: number; // 0-100
    dependencies: string[];
    enabledForUser: boolean; // Computed based on rollout
    overriddenByAdmin: boolean;
  }
  ```

- **platformConfiguration**: Object containing runtime configuration
  ```typescript
  interface PlatformConfiguration {
    environment: 'development' | 'staging' | 'production';
    debugMode: boolean;
    logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
    apiBaseUrl: string;
    cdnBaseUrl: string;
    maxRetryAttempts: number;
    defaultTimeout: number;
    enableAnalytics: boolean;
    enableCrashReporting: boolean;
    maintenanceMode: boolean;
  }
  ```

### Error & Recovery State
- **errorState**: Object tracking error conditions
  ```typescript
  interface ErrorState {
    hasUnrecoverableError: boolean;
    lastCriticalError: {
      message: string;
      stack: string;
      subsystemId: string;
      timestamp: number;
    } | null;
    recentErrors: Array<{
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      subsystemId: string;
      timestamp: number;
      count: number; // Deduplicated count
    }>;
    errorRateLastMinute: number;
    circuitBreakers: Map<string, CircuitBreakerState>;
  }
  
  interface CircuitBreakerState {
    subsystemId: string;
    status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    failureCount: number;
    lastFailure: number | null;
    nextRetry: number | null;
  }
  ```

### Visibility & Lifecycle
- **visibilityState**: Object tracking page visibility
  ```typescript
  interface VisibilityState {
    isVisible: boolean;
    lastVisibilityChange: number;
    hiddenDuration: number; // Total ms spent hidden
    visibilityChangeCount: number;
    backgroundMode: 'ACTIVE' | 'THROTTLED' | 'SUSPENDED';
  }
  ```

### State Versioning & History
- **stateVersion**: Number - Increments on every state mutation
- **stateHistory**: Circular buffer of recent state snapshots (for debugging/rollback)
- **lastStateTransition**: Object tracking most recent state change
  ```typescript
  interface StateTransition {
    from: Partial<GlobalState>;
    to: Partial<GlobalState>;
    reason: string;
    subsystemId: string;
    timestamp: number;
  }
  ```

---

## Features

Each feature manages a specific aspect of global state and provides specialized functionality.

### Platform Status Manager
**Purpose**: Manages overall platform status and work capacity

**Responsibilities**:
- Monitors pending tokens and calculates platform status
- Enforces busy threshold and work admission control
- Tracks work distribution across categories
- Provides status transition logic with state machine guarantees
- Implements platform health scoring algorithm

**State Fields**: `platformStatus`, `pendingTokens`, `busyThreshold`

**Key Methods**:
- `calculatePlatformStatus(): PlatformStatus`
- `canAcceptWork(importance: Importance): boolean`
- `registerPendingToken(token: PendingToken): void`
- `completePendingToken(tokenId: string): void`
- `getWorkloadDistribution(): Map<string, number>`
- `getPlatformHealthScore(): number`

**Weight**: CRITICAL - Core platform coordination

---

### Subsystem Registry Manager
**Purpose**: Maintains real-time registry of all subsystems and their health

**Responsibilities**:
- Tracks subsystem lifecycle (initialization → destruction)
- Receives and processes heartbeat signals
- Computes subsystem health scores
- Detects stale/crashed subsystems
- Validates dependency graphs
- Provides subsystem discovery and querying

**State Fields**: `subsystemRegistry`

**Key Methods**:
- `registerSubsystem(config: SubsystemConfig): void`
- `updateSubsystemStatus(subsystemId: string, status: SubsystemStatus): void`
- `processHeartbeat(subsystemId: string): void`
- `getSubsystemHealth(subsystemId: string): number`
- `getDependencyGraph(): DirectedGraph`
- `validateDependencies(subsystemId: string): boolean`
- `getSubsystemsByStatus(status: string): SubsystemStatus[]`

**Weight**: CRITICAL - Subsystem coordination

---

### Network Status Manager
**Purpose**: Monitors and provides network connectivity state

**Responsibilities**:
- Integrates with Navigator Online/Offline API
- Monitors Network Information API
- Tracks connection quality metrics
- Detects and broadcasts network transitions
- Provides network quality estimation
- Implements adaptive behavior recommendations

**State Fields**: `onlineStatus`, `timestamps.lastNetworkRequest`

**Key Methods**:
- `isOnline(): boolean`
- `getConnectionQuality(): 'excellent' | 'good' | 'fair' | 'poor' | 'offline'`
- `getEffectiveBandwidth(): number`
- `shouldDeferRequest(priority: number): boolean`
- `getNetworkRecommendations(): NetworkRecommendations`

**Subscriptions**:
- Browser `online`/`offline` events
- Network Information API change events
- Network Request Manager connection status updates

**Weight**: HIGH - Network-dependent operations

---

### Authentication Context Manager
**Purpose**: Provides centralized authentication state (mirrors Auth Manager)

**Responsibilities**:
- Synchronizes with Auth Manager subsystem
- Caches authentication state for quick access
- Provides permission checking predicates
- Tracks session lifecycle
- Detects authentication state changes

**State Fields**: `authenticationContext`, `timestamps.lastAuthTime`

**Key Methods**:
- `isAuthenticated(): boolean`
- `getAuthLevel(): AuthLevel`
- `getUserId(): string | null`
- `hasElevatedPrivileges(): boolean`
- `isSessionValid(): boolean`
- `getSessionTimeRemaining(): number | null`

**Subscriptions**:
- Auth Manager login/logout events
- Auth Manager session refresh events
- Auth Manager token expiry warnings

**Weight**: HIGH - Security-critical

---

### Timestamp Manager
**Purpose**: Manages all platform-critical timestamps

**Responsibilities**:
- Maintains high-precision timestamps
- Calculates time intervals and durations
- Provides uptime and session duration
- Tracks subsystem-specific timing
- Implements timestamp-based predicates

**State Fields**: `timestamps`

**Key Methods**:
- `getPlatformUptime(): number`
- `getTimeSinceLastSync(): number`
- `getTimeSinceLastError(): number`
- `getTimeSinceLastUserInteraction(): number`
- `updateTimestamp(key: string): void`
- `isStale(timestamp: number, maxAge: number): boolean`

**Weight**: MEDIUM - Timing coordination

---

### Device Info Manager
**Purpose**: Provides device capabilities and characteristics

**Responsibilities**:
- Parses User Agent for browser/OS info
- Detects feature support (Web Workers, IndexedDB, etc.)
- Monitors device memory and CPU
- Generates device fingerprints
- Provides capability-based predicates

**State Fields**: `deviceInfo`

**Key Methods**:
- `getDeviceCapabilities(): DeviceCapabilities`
- `supportsFeature(feature: string): boolean`
- `getDeviceClass(): 'high-end' | 'mid-range' | 'low-end'`
- `getRecommendedWorkerCount(): number`
- `shouldUsePhysicalWorker(): boolean`
- `getDeviceFingerprint(): string`

**Weight**: MEDIUM - Capability detection

---

### Performance Monitor
**Purpose**: Tracks platform performance and resource usage

**Responsibilities**:
- Monitors memory usage via Performance API
- Tracks packet processing metrics
- Calculates throughput rates
- Computes platform health score
- Detects performance degradation
- Triggers performance optimization suggestions

**State Fields**: `performanceMetrics`

**Key Methods**:
- `getMemoryUsage(): MemoryUsage`
- `getAverageResponseTime(): number`
- `getPacketThroughput(): number`
- `getErrorRate(): number`
- `getPlatformHealth(): number`
- `detectPerformanceIssues(): PerformanceIssue[]`
- `suggestOptimizations(): Optimization[]`

**Subscriptions**:
- Message Queue packet completion events
- All subsystem error events
- Browser memory pressure events

**Weight**: MEDIUM - Performance optimization

---

### Feature Flag Manager
**Purpose**: Controls feature rollout and A/B testing

**Responsibilities**:
- Manages feature flag definitions
- Computes user-specific rollout eligibility
- Handles admin overrides
- Validates feature dependencies
- Provides feature flag querying

**State Fields**: `featureFlags`

**Key Methods**:
- `isFeatureEnabled(key: string): boolean`
- `getFeatureRollout(key: string): number`
- `enableFeature(key: string, userId?: string): void`
- `disableFeature(key: string, userId?: string): void`
- `getEnabledFeatures(): string[]`
- `validateFeatureDependencies(key: string): boolean`

**Weight**: LOW - Feature management

---

### Configuration Manager
**Purpose**: Manages runtime platform configuration

**Responsibilities**:
- Maintains platform configuration
- Validates configuration changes
- Provides environment-specific defaults
- Handles hot-reload of configuration
- Persists configuration updates

**State Fields**: `platformConfiguration`

**Key Methods**:
- `getEnvironment(): string`
- `isDebugMode(): boolean`
- `getLogLevel(): LogLevel`
- `getApiBaseUrl(): string`
- `isMaintenanceMode(): boolean`
- `updateConfiguration(updates: Partial<PlatformConfiguration>): void`

**Weight**: MEDIUM - Platform configuration

---

### Error Tracking Manager
**Purpose**: Centralized error tracking and circuit breaker management

**Responsibilities**:
- Records and categorizes errors
- Implements error rate limiting
- Manages circuit breakers for failing subsystems
- Detects error patterns and cascading failures
- Provides error recovery recommendations

**State Fields**: `errorState`

**Key Methods**:
- `recordError(error: Error, subsystemId: string, severity: Severity): void`
- `getErrorRate(): number`
- `getCircuitBreakerState(subsystemId: string): CircuitBreakerState`
- `shouldOpenCircuitBreaker(subsystemId: string): boolean`
- `resetCircuitBreaker(subsystemId: string): void`
- `hasUnrecoverableError(): boolean`
- `getRecentErrors(count: number): Error[]`

**Subscriptions**:
- All subsystem error events
- Logger critical error events

**Weight**: HIGH - System stability

---

### Visibility Manager
**Purpose**: Manages page visibility and background behavior

**Responsibilities**:
- Tracks page visibility via Page Visibility API
- Calculates hidden duration
- Determines background operation mode
- Triggers background throttling
- Coordinates visibility-based optimizations

**State Fields**: `visibilityState`

**Key Methods**:
- `isPageVisible(): boolean`
- `getBackgroundMode(): BackgroundMode`
- `getHiddenDuration(): number`
- `shouldThrottleBackgroundWork(): boolean`
- `suggestBackgroundStrategy(): BackgroundStrategy`

**Subscriptions**:
- Browser `visibilitychange` events

**Weight**: MEDIUM - Resource optimization

---

### State History Manager
**Purpose**: Maintains state history for debugging and recovery

**Responsibilities**:
- Records state transitions
- Maintains circular buffer of snapshots
- Provides state diffing
- Enables state rollback (emergency)
- Exports state history for debugging

**State Fields**: `stateVersion`, `stateHistory`, `lastStateTransition`

**Key Methods**:
- `recordStateChange(from: Partial<State>, to: Partial<State>, reason: string): void`
- `getStateHistory(count: number): StateSnapshot[]`
- `exportStateHistory(): string`
- `diffState(versionA: number, versionB: number): StateDiff`
- `rollbackState(toVersion: number): boolean` // Emergency only

**Weight**: LOW - Debugging support

---

## Life Cycle Manager

### Initialization Sequence

The Global State initialization is the first step in platform bootstrap and follows a strict sequence:

1. **Pre-initialization Phase**
   ```javascript
   // Validate environment
   - Check browser compatibility
   - Verify essential APIs available (Object, Promise, etc.)
   - Set initial status to INITIALIZING
   ```

2. **Core State Initialization**
   ```javascript
   // Initialize state with safe defaults
   - Create state object with default values
   - Initialize platformStatus = 'INITIALIZING'
   - Set timestamps.platformStartup = Date.now()
   - Initialize empty registries (subsystemRegistry, featureFlags)
   - Create device fingerprint
   ```

3. **Device & Environment Detection**
   ```javascript
   // Gather device information
   - Parse User Agent
   - Detect feature support
   - Query device capabilities (memory, CPU)
   - Detect network connection type
   - Initialize deviceInfo state
   ```

4. **Feature Component Initialization** (ordered by dependency)
   ```javascript
   // Initialize in this exact order:
   1. Device Info Manager (no dependencies)
   2. Timestamp Manager (no dependencies)
   3. Configuration Manager (uses Device Info)
   4. Error Tracking Manager (uses Configuration)
   5. Platform Status Manager (uses Timestamp, Error Tracking)
   6. Subsystem Registry Manager (uses Platform Status)
   7. Network Status Manager (uses Device Info, Timestamp)
   8. Authentication Context Manager (depends on external Auth Manager later)
   9. Performance Monitor (uses Timestamp, Device Info)
   10. Visibility Manager (uses Timestamp)
   11. Feature Flag Manager (uses Configuration)
   12. State History Manager (uses Timestamp)
   ```

5. **Event Registration**
   ```javascript
   // Register with Notification Center (once it's initialized)
   - Register all event IDs with action names
   - Create event ID → action name mapping
   - Assign event priorities
   ```

6. **Browser API Subscriptions**
   ```javascript
   // Subscribe to browser events
   - window.addEventListener('online', onOnlineChange)
   - window.addEventListener('offline', onOfflineChange)
   - document.addEventListener('visibilitychange', onVisibilityChange)
   - navigator.connection?.addEventListener('change', onConnectionChange)
   - performance.addEventListener('resourcetimingbufferfull', onMemoryPressure)
   ```

7. **State Persistence Recovery**
   ```javascript
   // Attempt to restore previous session state (if available)
   - Query Storage Manager for persisted Global State
   - Validate persisted state version compatibility
   - Restore safe state fields (configuration, feature flags)
   - DO NOT restore: pendingTokens, platformStatus, timestamps
   - Merge restored state with initialized state
   ```

8. **Initial Subsystem Registration**
   ```javascript
   // Register self in subsystem registry
   - Register 'global-state' subsystem
   - Set status to READY
   - Record heartbeat
   ```

9. **Health Check**
   ```javascript
   // Perform initial health check
   - Verify all features initialized successfully
   - Check critical dependencies available
   - Validate state consistency
   - Compute initial health score
   ```

10. **Transition to IDLE**
    ```javascript
    // Complete initialization
    - Set platformStatus = 'IDLE'
    - Update timestamps.lastHeartbeat
    - Fire 'global:initialized' event to Notification Center
    - Log initialization completion
    ```

### Post-Initialization Coordination

After Global State initializes, it coordinates other subsystem initialization:

```javascript
// Centralized subsystems initialize in order:
1. Message Queue (depends on Global State)
2. Notification Center (depends on Global State, Message Queue)
3. Logger (depends on Global State, Notification Center)
4. Storage Manager (depends on Global State, Logger)
5. Network Request Manager (depends on Global State, Storage Manager)
6. Auth Manager (depends on Global State, Storage Manager, Network Manager)
7. Sync Manager (depends on most other centralized subsystems)

// Featurized subsystems initialize after all centralized subsystems ready
```

### Destruction Sequence

Graceful shutdown follows reverse initialization order:

1. **Initiate Shutdown**
   ```javascript
   // Broadcast shutdown intent
   - Fire 'global:shutting-down' event
   - Set platformStatus = 'STOPPED'
   - Set pendingTokens = null (block new work)
   - Record timestamps.lastHeartbeat
   ```

2. **Wait for Pending Work**
   ```javascript
   // Allow critical work to complete
   - Wait for CRITICAL importance tokens to complete (max 5s timeout)
   - Cancel all other pending work
   - Collect incomplete work IDs for recovery
   ```

3. **Notify Dependent Subsystems**
   ```javascript
   // Signal all subsystems to clean up
   - Fire 'global:stopped' event to Notification Center
   - Wait for subsystems to acknowledge (max 3s timeout each)
   - Force-terminate unresponsive subsystems
   ```

4. **Persist Critical State**
   ```javascript
   // Save state to storage
   - Prepare state snapshot (exclude runtime fields)
   - Send to Storage Manager for persistence
   - Wait for storage confirmation (max 2s)
   - Record incomplete work for recovery
   ```

5. **Unsubscribe from Browser Events**
   ```javascript
   // Clean up event listeners
   - window.removeEventListener('online', onOnlineChange)
   - window.removeEventListener('offline', onOfflineChange)
   - document.removeEventListener('visibilitychange', onVisibilityChange)
   - navigator.connection?.removeEventListener('change', onConnectionChange)
   ```

6. **Destruct Features** (reverse initialization order)
   ```javascript
   // Clean up features
   12. State History Manager
   11. Feature Flag Manager
   10. Visibility Manager
   9. Performance Monitor
   8. Authentication Context Manager
   7. Network Status Manager
   6. Subsystem Registry Manager
   5. Platform Status Manager
   4. Error Tracking Manager
   3. Configuration Manager
   2. Timestamp Manager
   1. Device Info Manager
   ```

7. **Final Cleanup**
   ```javascript
   // Clear state and resources
   - Clear all registries and maps
   - Nullify state object
   - Log shutdown completion
   - Set platformStatus = null (marker for destroyed state)
   ```

### Emergency Shutdown

For unrecoverable errors or crashes:

```javascript
emergencyShutdown(error: Error) {
  // Skip graceful steps, force cleanup
  - Record critical error
  - Set platformStatus = 'CRASHED'
  - Attempt state persistence (fire-and-forget)
  - Clear all work queues
  - Terminate all workers immediately
  - Log crash with stack trace
  - Display user-facing error
}
```

---

## Worker

**Type**: None (Virtual Worker concepts used internally)

The Global State subsystem does NOT use physical Web Workers as it must be synchronously accessible to all subsystems and runs on the main thread. However, it implements worker-like concepts for internal organization:

### Virtual Worker Pattern

**Receiver-like Functions** (event handlers):
- `onNetworkStatusChange(event: Event)`
- `onVisibilityChange(event: Event)`
- `onSubsystemHeartbeat(subsystemId: string)`
- `onPendingTokenCreated(token: PendingToken)`
- `onPendingTokenCompleted(tokenId: string)`
- `onSubsystemError(subsystemId: string, error: Error)`
- `onConfigurationUpdate(updates: Partial<Configuration>)`

**Processor-like Functions** (state mutations):
- `processPlatformStatusTransition(newStatus: PlatformStatus)`
- `processSubsystemStatusUpdate(subsystemId: string, status: SubsystemStatus)`
- `processErrorEvent(error: Error, subsystemId: string)`
- `processFeatureFlagUpdate(key: string, enabled: boolean)`
- `processPerformanceMetrics(metrics: PerformanceMetrics)`

**Dispatcher-like Functions** (state change broadcasts):
- `dispatchPlatformStatusChange(oldStatus: PlatformStatus, newStatus: PlatformStatus)`
- `dispatchNetworkStatusChange(oldStatus: OnlineStatus, newStatus: OnlineStatus)`
- `dispatchAuthContextChange(oldContext: AuthContext, newContext: AuthContext)`
- `dispatchSubsystemHealthChange(subsystemId: string, health: number)`

### Justification for No Physical Worker

1. **Synchronous Access Required**: All subsystems need immediate, synchronous access to global state for performance
2. **Main Thread Coordination**: Platform status must be queryable without async overhead
3. **Event Loop Integration**: Must directly handle browser events (online, visibility, etc.)
4. **Minimal Computation**: Global State performs mostly bookkeeping, no heavy computation
5. **Shared Memory**: State must be shared across all subsystems without serialization

---

## Dependencies

**Initialization Priority**: Global State initializes FIRST before all other subsystems

### Required Dependencies (Post-Initialization)

Ordered by initialization sequence:

1. **Storage Manager** (HIGH) - For state persistence and recovery
   - Persists configuration, feature flags, error history
   - Stores state snapshots for recovery
   - Required for: State persistence across sessions

2. **Notification Center** (CRITICAL) - For event broadcasting
   - Broadcasts all state change events
   - Coordinates inter-subsystem communication
   - Required for: All event-driven coordination

3. **Message Queue** (HIGH) - For packet tracking
   - Provides pending token lifecycle events
   - Required for: Platform status management

4. **Logger** (MEDIUM) - For audit trail
   - Logs all state transitions
   - Records subsystem lifecycle events
   - Required for: Debugging and audit compliance

5. **Analytics Manager** (LOW) - For telemetry
   - Receives performance metrics
   - Tracks platform health over time
   - Required for: Observability

6. **Auth Manager** (HIGH) - For authentication context
   - Syncs authentication state
   - Provides user context
   - Required for: Authentication-aware features

### Functional Predicates

```javascript
/**
 * Determines if new work can be accepted based on platform status
 */
function canAcceptWork(importance: Importance): boolean {
  if (state.platformStatus === 'STOPPED') return false;
  if (state.platformStatus === 'CRASHED') return false;
  if (importance === 'CRITICAL') return true;
  if (state.platformStatus === 'BUSY') return false;
  if (state.platformStatus === 'DEGRADED' && importance === 'LOW') return false;
  return true;
}

/**
 * Determines if a subsystem is healthy
 */
function isSubsystemHealthy(subsystemId: string): boolean {
  const subsystem = state.subsystemRegistry.get(subsystemId);
  if (!subsystem) return false;
  if (subsystem.status === 'ERROR') return false;
  if (subsystem.healthScore < 50) return false;
  const timeSinceHeartbeat = Date.now() - subsystem.lastHeartbeat;
  if (timeSinceHeartbeat > 30000) return false; // 30s timeout
  return true;
}

/**
 * Determines if network conditions allow request
 */
function shouldAllowNetworkRequest(priority: number): boolean {
  if (!state.onlineStatus.isOnline) return false;
  if (state.onlineStatus.saveData && priority < 5) return false;
  if (state.onlineStatus.effectiveType === 'slow-2g' && priority < 8) return false;
  return true;
}

/**
 * Determines if platform should enter degraded mode
 */
function shouldEnterDegradedMode(): boolean {
  const criticalSubsystems = Array.from(state.subsystemRegistry.values())
    .filter(s => s.importance === 'CRITICAL');
  const unhealthyCount = criticalSubsystems
    .filter(s => !isSubsystemHealthy(s.subsystemId)).length;
  return unhealthyCount > 0 && unhealthyCount < criticalSubsystems.length;
}

/**
 * Determines if background work should be throttled
 */
function shouldThrottleBackgroundWork(): boolean {
  if (!state.visibilityState.isVisible) {
    return state.visibilityState.backgroundMode === 'THROTTLED' ||
           state.visibilityState.backgroundMode === 'SUSPENDED';
  }
  return false;
}

/**
 * Determines if circuit breaker should open for subsystem
 */
function shouldOpenCircuitBreaker(subsystemId: string): boolean {
  const cb = state.errorState.circuitBreakers.get(subsystemId);
  if (!cb) return false;
  if (cb.status === 'OPEN') return false; // Already open
  
  // Open if 5 failures in last 60 seconds
  const recentFailures = cb.failureCount;
  const timeSinceLastFailure = Date.now() - (cb.lastFailure ?? 0);
  return recentFailures >= 5 && timeSinceLastFailure < 60000;
}

/**
 * Determines if user is authenticated with elevated privileges
 */
function hasElevatedAuth(): boolean {
  return state.authenticationContext.isAuthenticated &&
         state.authenticationContext.permissionSummary.hasElevatedPrivileges;
}

/**
 * Determines if feature should be enabled for current user
 */
function isFeatureEnabledForUser(featureKey: string): boolean {
  const flag = state.featureFlags.get(featureKey);
  if (!flag) return false;
  if (flag.overriddenByAdmin) return flag.enabled;
  if (!flag.enabled) return false;
  
  // Check rollout percentage
  const userId = state.authenticationContext.userId ?? state.deviceInfo.sessionFingerprint;
  const hash = simpleHash(userId + featureKey);
  const userPercentile = hash % 100;
  return userPercentile < flag.rolloutPercentage;
}
```

---

## Control Interface

### Getters (No-arg)

#### Platform Status
- `getPlatformStatus(): PlatformStatus` - Returns current platform status
- `isPlatformReady(): boolean` - Returns true if IDLE or BUSY
- `isPlatformBusy(): boolean` - Returns true if BUSY
- `isPlatformStopped(): boolean` - Returns true if STOPPED or CRASHED
- `canAcceptCriticalWork(): boolean` - Returns true if CRITICAL work allowed
- `getPendingWorkCount(): number` - Returns size of pending tokens
- `getWorkloadByCategory(): Map<Category, number>` - Work distribution

#### Subsystems
- `getSubsystemStatus(subsystemId: string): SubsystemStatus | null`
- `getAllSubsystems(): SubsystemStatus[]`
- `getHealthySubsystems(): SubsystemStatus[]`
- `getUnhealthySubsystems(): SubsystemStatus[]`
- `isSubsystemReady(subsystemId: string): boolean`
- `getSubsystemDependencies(subsystemId: string): string[]`

#### Network
- `isOnline(): boolean`
- `getConnectionType(): ConnectionType`
- `getEffectiveConnectionType(): EffectiveType`
- `getNetworkQuality(): NetworkQuality`
- `getDownlinkSpeed(): number | null`
- `getRoundTripTime(): number | null`
- `isDataSaverEnabled(): boolean`

#### Authentication
- `isAuthenticated(): boolean`
- `getAuthLevel(): AuthLevel`
- `getUserId(): string | null`
- `getSessionId(): string | null`
- `hasElevatedPrivileges(): boolean`
- `getTokenExpiry(): number | null`
- `isSessionExpiring(): boolean` - Returns true if < 5 min remaining

#### Timing
- `getPlatformUptime(): number`
- `getTimeSinceStartup(): number`
- `getTimeSinceLastSync(): number`
- `getTimeSinceLastError(): number`
- `getTimeSinceLastUserInteraction(): number`
- `getTimestamp(key: keyof Timestamps): number | null`

#### Device & Environment
- `getDeviceInfo(): DeviceInfo`
- `supportsFeature(feature: string): boolean`
- `getDeviceClass(): DeviceClass`
- `getBrowserInfo(): { browser: string; version: string }`
- `getOSInfo(): { os: string; version: string }`
- `getDeviceFingerprint(): string | null`

#### Performance
- `getMemoryUsage(): MemoryUsage`
- `getPerformanceMetrics(): PerformanceMetrics`
- `getPlatformHealthScore(): number`
- `getAveragePacketProcessingTime(): number`
- `getErrorRate(): number`
- `getPacketThroughput(): number`

#### Features & Configuration
- `isFeatureEnabled(key: string): boolean`
- `getEnabledFeatures(): string[]`
- `getEnvironment(): Environment`
- `isDebugMode(): boolean`
- `getLogLevel(): LogLevel`
- `isMaintenanceMode(): boolean`

#### Errors
- `hasUnrecoverableError(): boolean`
- `getRecentErrors(count: number): Error[]`
- `getErrorRate(): number`
- `getCircuitBreakerState(subsystemId: string): CircuitBreakerState | null`

#### Visibility
- `isPageVisible(): boolean`
- `getBackgroundMode(): BackgroundMode`
- `getHiddenDuration(): number`
- `shouldThrottleBackgroundWork(): boolean`

#### State & History
- `getStateVersion(): number`
- `getStateHistory(count: number): StateSnapshot[]`
- `getLastStateTransition(): StateTransition | null`

---

### Setters

Most state changes happen internally through events. Public setters are minimal:

- `setBusyThreshold(threshold: number)` - Updates busy threshold (admin only)
- `setLogLevel(level: LogLevel)` - Updates log level
- `setMaintenanceMode(enabled: boolean)` - Enables/disables maintenance mode (admin only)
- `setFeatureFlagOverride(key: string, enabled: boolean)` - Admin override (admin only)

---

### Actions (Fire events to message queue)

#### Platform Control
- `initiatePlatformShutdown(reason: string)` - Graceful shutdown
  - Fires `global:shutdown-initiated` event
  - **Importance**: CRITICAL
  - **Payload**: `{ reason: string, timestamp: number }`

- `emergencyShutdown(error: Error)` - Immediate shutdown
  - Fires `global:emergency-shutdown` event
  - **Importance**: CRITICAL
  - **Payload**: `{ error: Error, timestamp: number }`

#### Subsystem Management
- `registerSubsystem(config: SubsystemConfig)` - Register new subsystem
  - Fires `global:subsystem-registered` event
  - **Importance**: HIGH
  - **Payload**: `SubsystemConfig`

- `updateSubsystemStatus(subsystemId: string, status: SubsystemStatus)` - Update status
  - Fires `global:subsystem-status-changed` event
  - **Importance**: MEDIUM
  - **Payload**: `{ subsystemId: string, status: SubsystemStatus }`

- `reportSubsystemHeartbeat(subsystemId: string)` - Heartbeat signal
  - Fires `global:heartbeat` event
  - **Importance**: LOW
  - **Payload**: `{ subsystemId: string, timestamp: number }`

#### Work Management
- `registerPendingWork(token: PendingToken)` - Register new work
  - Fires `global:work-started` event
  - **Importance**: Varies (from token)
  - **Payload**: `PendingToken`

- `completePendingWork(tokenId: string)` - Mark work complete
  - Fires `global:work-completed` event
  - **Importance**: Varies
  - **Payload**: `{ tokenId: string, timestamp: number }`

#### Error Reporting
- `reportError(error: Error, subsystemId: string, severity: Severity)` - Report error
  - Fires `global:error-reported` event
  - **Importance**: Varies by severity
  - **Payload**: `{ error: Error, subsystemId: string, severity: Severity }`

#### Configuration
- `updateConfiguration(updates: Partial<PlatformConfiguration>)` - Update config
  - Fires `global:configuration-updated` event
  - **Importance**: MEDIUM
  - **Payload**: `Partial<PlatformConfiguration>`

---

### Subscriptions (Subscribe to notification center events)

Global State subscribes to events from other subsystems to maintain synchronized state:

#### Message Queue Events
- `queue:packet-enqueued` - Track new work tokens
- `queue:packet-dispatched` - Update work status
- `queue:packet-completed` - Remove work tokens
- `queue:packet-failed` - Record errors

#### Notification Center Events
- `notification:dispatch-failed` - Record system errors

#### Storage Manager Events
- `storage:quota-warning` - Update resource status
- `storage:quota-exceeded` - Trigger degraded mode
- `storage:operation-failed` - Record storage errors

#### Network Request Manager Events
- `network:connection-changed` - Update network status
- `network:request-failed` - Track network errors
- `network:rate-limit-exceeded` - Update resource status

#### Auth Manager Events
- `auth:login-success` - Update authentication context
- `auth:logout` - Clear authentication context
- `auth:token-refreshed` - Update token expiry
- `auth:session-expired` - Clear session

#### Sync Manager Events
- `sync:completed` - Update last sync timestamp
- `sync:failed` - Record sync errors

#### Logger Events
- `logger:critical-error` - Record unrecoverable errors

#### Analytics Manager Events
- `analytics:performance-degradation` - Update health score

#### All Subsystems
- `*:initialized` - Update subsystem registry
- `*:destroyed` - Remove from registry
- `*:error` - Record subsystem errors

---

## Message Packets

Global State defines comprehensive message packets for all state change operations.

### Type Definitions

```typescript
/**
 * Shared Types
 */
export type PlatformStatus = 'INITIALIZING' | 'IDLE' | 'BUSY' | 'DEGRADED' | 'STOPPED' | 'CRASHED';
export type SubsystemStatusType = 'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'BUSY' | 'ERROR' | 'DESTROYED';
export type AuthLevel = 'GUEST' | 'USER' | 'ADMIN' | 'CORPORATE' | 'MODERATOR' | 'SUSPENDED';
export type Importance = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type WorkCategory = 'NETWORK' | 'STORAGE' | 'AUTH' | 'COMPUTATION' | 'UI' | 'SYNC';

export interface BasePacket<P, R = any> {
  eventId: symbol;
  actionName: string;
  payload: P;
  importance: Importance;
  onComplete: (result: R) => void;
  onError: (error: Error) => void;
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
  fingerprints: Fingerprint[];
}
```

---

### 1. Platform Status Change Packet

Broadcast when platform status transitions.

```typescript
export interface PlatformStatusChangePayload {
  oldStatus: PlatformStatus;
  newStatus: PlatformStatus;
  reason: string;
  timestamp: number;
  pendingWorkCount: number;
  healthScore: number;
}

export type PlatformStatusChangePacket = BasePacket<PlatformStatusChangePayload, void>;

// Event ID: global:platform-status-changed
// Importance: CRITICAL
// Broadcast: Yes (all subsystems)
```

---

### 2. Subsystem Registration Packet

Sent when a new subsystem registers.

```typescript
export interface SubsystemRegistrationPayload {
  subsystemId: string;
  type: 'CENTRALIZED' | 'FEATURIZED';
  importance: Importance;
  dependencies: string[];
  version: string;
  capabilities: string[];
}

export interface SubsystemRegistrationResult {
  registered: boolean;
  subsystemId: string;
  assignedPriority: number;
}

export type SubsystemRegistrationPacket = BasePacket<
  SubsystemRegistrationPayload,
  SubsystemRegistrationResult
>;

// Event ID: global:subsystem-register
// Importance: HIGH
// Broadcast: Yes (after successful registration)
```

---

### 3. Subsystem Status Update Packet

Sent when subsystem status changes.

```typescript
export interface SubsystemStatusUpdatePayload {
  subsystemId: string;
  oldStatus: SubsystemStatusType;
  newStatus: SubsystemStatusType;
  healthScore: number;
  errorCount: number;
  timestamp: number;
  reason?: string;
}

export type SubsystemStatusUpdatePacket = BasePacket<SubsystemStatusUpdatePayload, void>;

// Event ID: global:subsystem-status-changed
// Importance: MEDIUM
// Broadcast: Yes
```

---

### 4. Heartbeat Packet

Subsystems send periodic heartbeats to prove liveness.

```typescript
export interface HeartbeatPayload {
  subsystemId: string;
  timestamp: number;
  healthScore: number;
  activeWorkCount: number;
  metadata?: Record<string, any>;
}

export interface HeartbeatResult {
  acknowledged: boolean;
  nextHeartbeatDue: number;
}

export type HeartbeatPacket = BasePacket<HeartbeatPayload, HeartbeatResult>;

// Event ID: global:heartbeat
// Importance: LOW
// Broadcast: No
```

---

### 5. Work Registration Packet

Register new pending work.

```typescript
export interface WorkRegistrationPayload {
  tokenId: string;
  subsystemId: string;
  importance: Importance;
  category: WorkCategory;
  estimatedDuration: number | null;
  description: string;
  critical: boolean;
}

export interface WorkRegistrationResult {
  accepted: boolean;
  tokenId: string;
  platformStatus: PlatformStatus;
  position: number; // Position in work queue
}

export type WorkRegistrationPacket = BasePacket<
  WorkRegistrationPayload,
  WorkRegistrationResult
>;

// Event ID: global:work-register
// Importance: Varies (from payload)
// Broadcast: No
```

---

### 6. Work Completion Packet

Mark pending work as complete.

```typescript
export interface WorkCompletionPayload {
  tokenId: string;
  subsystemId: string;
  success: boolean;
  duration: number;
  error?: Error;
}

export interface WorkCompletionResult {
  acknowledged: boolean;
  newPlatformStatus: PlatformStatus;
  remainingWorkCount: number;
}

export type WorkCompletionPacket = BasePacket<
  WorkCompletionPayload,
  WorkCompletionResult
>;

// Event ID: global:work-complete
// Importance: Varies
// Broadcast: Yes (if platform status changes)
```

---

### 7. Network Status Change Packet

Broadcast when network status changes.

```typescript
export interface NetworkStatusChangePayload {
  oldStatus: {
    isOnline: boolean;
    effectiveType: string;
  };
  newStatus: {
    isOnline: boolean;
    connectionType: string;
    effectiveType: string;
    downlink: number | null;
    rtt: number | null;
    saveData: boolean;
  };
  timestamp: number;
  transitionCount: number;
}

export type NetworkStatusChangePacket = BasePacket<NetworkStatusChangePayload, void>;

// Event ID: global:network-status-changed
// Importance: HIGH
// Broadcast: Yes
```

---

### 8. Authentication Context Change Packet

Broadcast when authentication context changes.

```typescript
export interface AuthContextChangePayload {
  oldContext: {
    isAuthenticated: boolean;
    userId: string | null;
  };
  newContext: AuthenticationContext;
  changeType: 'LOGIN' | 'LOGOUT' | 'REFRESH' | 'PRIVILEGE_CHANGE';
  timestamp: number;
}

export type AuthContextChangePacket = BasePacket<AuthContextChangePayload, void>;

// Event ID: global:auth-context-changed
// Importance: HIGH
// Broadcast: Yes
```

---

### 9. Error Report Packet

Report errors to Global State.

```typescript
export interface ErrorReportPayload {
  subsystemId: string;
  error: {
    message: string;
    stack: string;
    code?: string;
  };
  severity: Severity;
  context: Record<string, any>;
  recoverable: boolean;
  timestamp: number;
}

export interface ErrorReportResult {
  errorId: string;
  circuitBreakerTriggered: boolean;
  shouldRetry: boolean;
  retryAfter?: number;
}

export type ErrorReportPacket = BasePacket<ErrorReportPayload, ErrorReportResult>;

// Event ID: global:error-report
// Importance: Varies by severity
// Broadcast: Yes (if critical)
```

---

### 10. Configuration Update Packet

Update platform configuration.

```typescript
export interface ConfigurationUpdatePayload {
  updates: Partial<PlatformConfiguration>;
  reason: string;
  requestedBy: string; // subsystemId or 'admin'
}

export interface ConfigurationUpdateResult {
  applied: boolean;
  rejectedKeys: string[];
  newConfiguration: PlatformConfiguration;
}

export type ConfigurationUpdatePacket = BasePacket<
  ConfigurationUpdatePayload,
  ConfigurationUpdateResult
>;

// Event ID: global:configuration-update
// Importance: MEDIUM
// Broadcast: Yes
// Permission: Admin or elevated privileges required
```

---

### 11. Feature Flag Update Packet

Update feature flag state.

```typescript
export interface FeatureFlagUpdatePayload {
  featureKey: string;
  enabled: boolean;
  rolloutPercentage?: number;
  overrideByAdmin: boolean;
  userId?: string; // For user-specific override
}

export interface FeatureFlagUpdateResult {
  updated: boolean;
  effectiveForCurrentUser: boolean;
  affectedUsers: number; // Estimated
}

export type FeatureFlagUpdatePacket = BasePacket<
  FeatureFlagUpdatePayload,
  FeatureFlagUpdateResult
>;

// Event ID: global:feature-flag-update
// Importance: MEDIUM
// Broadcast: Yes
```

---

### 12. Visibility Change Packet

Broadcast when page visibility changes.

```typescript
export interface VisibilityChangePayload {
  isVisible: boolean;
  hiddenDuration: number;
  backgroundMode: 'ACTIVE' | 'THROTTLED' | 'SUSPENDED';
  timestamp: number;
  recommendations: {
    shouldDeferNonCriticalWork: boolean;
    shouldReduceNetworkActivity: boolean;
    shouldPauseAnimations: boolean;
  };
}

export type VisibilityChangePacket = BasePacket<VisibilityChangePayload, void>;

// Event ID: global:visibility-changed
// Importance: MEDIUM
// Broadcast: Yes
```

---

### 13. Performance Alert Packet

Alert when performance degrades.

```typescript
export interface PerformanceAlertPayload {
  alertType: 'MEMORY_PRESSURE' | 'HIGH_ERROR_RATE' | 'SLOW_RESPONSE' | 'LOW_HEALTH';
  severity: Severity;
  metrics: {
    memoryUsage?: MemoryUsage;
    errorRate?: number;
    averageResponseTime?: number;
    healthScore?: number;
  };
  recommendations: string[];
  timestamp: number;
}

export type PerformanceAlertPacket = BasePacket<PerformanceAlertPayload, void>;

// Event ID: global:performance-alert
// Importance: HIGH
// Broadcast: Yes
```

---

### 14. Shutdown Initiation Packet

Initiate graceful shutdown.

```typescript
export interface ShutdownInitiationPayload {
  reason: string;
  immediate: boolean; // True for emergency shutdown
  maxWaitTime: number; // Max ms to wait for pending work
  initiatedBy: string; // subsystemId or 'system' or 'user'
}

export interface ShutdownInitiationResult {
  shutdownScheduled: boolean;
  estimatedShutdownTime: number; // timestamp
  pendingCriticalWork: number;
}

export type ShutdownInitiationPacket = BasePacket<
  ShutdownInitiationPayload,
  ShutdownInitiationResult
>;

// Event ID: global:shutdown-initiate
// Importance: CRITICAL
// Broadcast: Yes
```

---

### 15. State Query Packet

Query specific state information.

```typescript
export interface StateQueryPayload {
  queryType: 'PLATFORM_STATUS' | 'SUBSYSTEM_HEALTH' | 'NETWORK_STATUS' | 
              'AUTH_CONTEXT' | 'PERFORMANCE_METRICS' | 'ALL';
  subsystemId?: string; // For subsystem-specific queries
  includeHistory?: boolean;
}

export interface StateQueryResult {
  queryType: string;
  data: any; // Varies by query type
  timestamp: number;
}

export type StateQueryPacket = BasePacket<StateQueryPayload, StateQueryResult>;

// Event ID: global:state-query
// Importance: LOW
// Broadcast: No
```

---

### Unified Global State Packet Type

```typescript
export type GlobalStatePacket =
  | PlatformStatusChangePacket
  | SubsystemRegistrationPacket
  | SubsystemStatusUpdatePacket
  | HeartbeatPacket
  | WorkRegistrationPacket
  | WorkCompletionPacket
  | NetworkStatusChangePacket
  | AuthContextChangePacket
  | ErrorReportPacket
  | ConfigurationUpdatePacket
  | FeatureFlagUpdatePacket
  | VisibilityChangePacket
  | PerformanceAlertPacket
  | ShutdownInitiationPacket
  | StateQueryPacket;
```

---

## Inter-Subsystem Communication Flows

This section illustrates logical communication patterns between Global State and other subsystems.

### Flow 1: Platform Startup Sequence

```
┌─────────────┐
│   Browser   │
│   Loads     │
│  Platform   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE INITIALIZATION                            │
│  - Initialize state with defaults                       │
│  - Detect device capabilities                           │
│  - Set platformStatus = INITIALIZING                    │
│  - Initialize all features                              │
│  - Subscribe to browser events                          │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Fire: global:initialized]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE INITIALIZATION                           │
│  - Subscribe: global:initialized                        │
│  - Initialize queue structures                          │
│  - Register event IDs                                   │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Fire: queue:initialized]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER INITIALIZATION                     │
│  - Subscribe: global:initialized, queue:initialized     │
│  - Start polling message queue                          │
│  - Create event registry                                │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Fire: notification:initialized]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  STORAGE MANAGER INITIALIZATION                         │
│  - Subscribe: notification:initialized                  │
│  - Open IndexedDB connections                           │
│  - Restore persisted state                              │
│  - Send: global:state-query (for persisted state)       │
└──────┬──────────────────────────────────────────────────┘
       │
       │◄────── [Global State returns: StateQueryResult]
       │
       ├─────► [Fire: storage:initialized]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER INITIALIZATION                 │
│  - Subscribe: global:network-status-changed             │
│  - Initialize Cache API                                 │
│  - Start connection monitoring                          │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Fire: network:initialized]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER INITIALIZATION                            │
│  - Subscribe: global:initialized                        │
│  - Query: storage:read (for stored tokens)              │
│  - Validate session                                     │
│  - Send: global:auth-context-change (if authenticated)  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Post Initialization                     │
│  - Receive: auth:login-success                          │
│  - Update authenticationContext                         │
│  - Fire: global:auth-context-changed                    │
│  - Set platformStatus = IDLE                            │
│  - Fire: global:platform-status-changed                 │
└─────────────────────────────────────────────────────────┘
```

---

### Flow 2: User Login Sequence

```
┌─────────────┐
│    User     │
│   Enters    │
│ Credentials │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER                                           │
│  - Validate credentials format                          │
│  - Send: global:work-register (login work token)        │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE                                           │
│  - Receive: global:work-register                        │
│  - Create PendingToken (CRITICAL importance)            │
│  - Check: canAcceptWork(CRITICAL) → true                │
│  - Add to pendingTokens map                             │
│  - Fire: global:work-started                            │
│  - Return: WorkRegistrationResult { accepted: true }    │
└──────┬──────────────────────────────────────────────────┘
       │
       │◄────── [Auth Manager proceeds with login]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER                                           │
│  - Send: network:post (to auth API)                     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Check: global.isOnline() → true                      │
│  - Execute fetch request                                │
│  - Return: RequestResult { token, refreshToken, user }  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER                                           │
│  - Store tokens in state                                │
│  - Send: storage:create (persist tokens)                │
│  - Send: global:auth-context-change                     │
│  - Send: global:work-complete (login token)             │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE                                           │
│  - Receive: global:auth-context-change                  │
│  - Update authenticationContext:                        │
│    * isAuthenticated = true                             │
│    * userId = user.id                                   │
│    * authLevel = user.role                              │
│  - Fire: global:auth-context-changed (broadcast)        │
│  - Receive: global:work-complete                        │
│  - Remove token from pendingTokens                      │
│  - Check platform status (may transition IDLE)          │
└──────┬──────────────────────────────────────────────────┘
       │
       │◄────── [All subscribed subsystems receive auth change]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SYNC MANAGER, STORAGE MANAGER, etc.                    │
│  - Subscribe: global:auth-context-changed               │
│  - React to new authentication state                    │
│  - Start authenticated operations                       │
└─────────────────────────────────────────────────────────┘
```

---

### Flow 3: Network Status Change Handling

```
┌─────────────┐
│   Browser   │
│   Fires     │
│  'offline'  │
│    Event    │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Network Status Manager                  │
│  - Event handler: onNetworkStatusChange()               │
│  - Update onlineStatus.isOnline = false                 │
│  - Record onlineStatus.lastOfflineTime = now            │
│  - Increment transitionCount                            │
│  - Fire: global:network-status-changed                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Broadcast to all subsystems]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Subscribe: global:network-status-changed             │
│  - Pause all non-critical pending requests              │
│  - Queue new requests with offline strategy             │
│  - Fire: network:connection-lost                        │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SYNC MANAGER                                           │
│  - Subscribe: global:network-status-changed             │
│  - Pause ongoing sync operations                        │
│  - Queue local changes for later sync                   │
│  - Fire: sync:paused                                    │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER                                           │
│  - Subscribe: global:network-status-changed             │
│  - Pause token refresh attempts                         │
│  - Switch to offline mode (if supported)                │
└─────────────────────────────────────────────────────────┘
       │
       │ [Time passes... network returns]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Network Status Manager                  │
│  - Event handler: onNetworkStatusChange()               │
│  - Update onlineStatus.isOnline = true                  │
│  - Record onlineStatus.lastOnlineTime = now             │
│  - Fire: global:network-status-changed                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [All subsystems receive online notification]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Resume paused requests with retry logic              │
│  - Process queued requests                              │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SYNC MANAGER                                           │
│  - Resume sync operations                               │
│  - Upload queued local changes                          │
└─────────────────────────────────────────────────────────┘
```

---

### Flow 4: Work Overload → BUSY Status

```
┌──────────────────────────────────────────────────────────┐
│  Multiple subsystems submitting work simultaneously      │
│  - UI interactions                                       │
│  - Background sync                                       │
│  - Network requests                                      │
│  - Storage operations                                    │
└──────┬───────────────────────────────────────────────────┘
       │
       │ [Each sends: global:work-register]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Platform Status Manager                 │
│  - Receive: global:work-register (x50 requests)         │
│  - Add each to pendingTokens map                        │
│  - Current count: pendingTokens.size = 55               │
│  - Check: 55 > busyThreshold (50)                       │
│  - Calculate: platformStatus should be BUSY             │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Platform Status Manager                 │
│  - processPlatformStatusTransition(IDLE → BUSY)         │
│  - Fire: global:platform-status-changed                 │
│    Payload: {                                           │
│      oldStatus: 'IDLE',                                 │
│      newStatus: 'BUSY',                                 │
│      reason: 'Pending work exceeded threshold',         │
│      pendingWorkCount: 55,                              │
│      healthScore: 85                                    │
│    }                                                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Broadcast to all subsystems]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE                                          │
│  - Subscribe: global:platform-status-changed            │
│  - Detect: newStatus = BUSY                             │
│  - Action: Pause accepting new LOW/MEDIUM packets       │
│  - Allow: Only CRITICAL/HIGH packets                    │
│  - Fire: queue:throttled                                │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SYNC MANAGER                                           │
│  - Subscribe: global:platform-status-changed            │
│  - Detect: newStatus = BUSY                             │
│  - Action: Defer non-critical background sync           │
│  - Maintain: Only critical sync operations              │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Subscribe: global:platform-status-changed            │
│  - Detect: newStatus = BUSY                             │
│  - Action: Reduce concurrent request limit              │
│  - Prioritize: Critical requests over prefetch          │
└─────────────────────────────────────────────────────────┘
       │
       │ [Work completes over time...]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Platform Status Manager                 │
│  - Receive: global:work-complete (x20 completions)      │
│  - Remove tokens from pendingTokens                     │
│  - Current count: pendingTokens.size = 35               │
│  - Check: 35 < busyThreshold (50)                       │
│  - Calculate: platformStatus should be IDLE             │
│  - processPlatformStatusTransition(BUSY → IDLE)         │
│  - Fire: global:platform-status-changed                 │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [All subsystems receive IDLE notification]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE, SYNC MANAGER, NETWORK MANAGER           │
│  - Resume normal operation                              │
│  - Process queued work                                  │
└─────────────────────────────────────────────────────────┘
```

---

### Flow 5: Subsystem Error → Circuit Breaker

```
┌─────────────┐
│  NETWORK    │
│  REQUEST    │
│  MANAGER    │
│  (Failing)  │
└──────┬──────┘
       │
       │ [5 consecutive request failures in 60s]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Detect: Repeated failures to API endpoint            │
│  - Send: global:error-report (x5)                       │
│    Payload: {                                           │
│      subsystemId: 'network-request-manager',            │
│      error: { message: 'API timeout', ... },            │
│      severity: 'HIGH',                                  │
│      recoverable: true                                  │
│    }                                                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Error Tracking Manager                  │
│  - Receive: global:error-report (x5 in 60s)             │
│  - Update errorState.circuitBreakers                    │
│  - Get CB for 'network-request-manager'                 │
│  - Increment failureCount = 5                           │
│  - Check: shouldOpenCircuitBreaker() → true             │
│  - Update CB status: CLOSED → OPEN                      │
│  - Set nextRetry = now + 30000 (30s)                    │
│  - Fire: global:circuit-breaker-opened                  │
│    Payload: {                                           │
│      subsystemId: 'network-request-manager',            │
│      status: 'OPEN',                                    │
│      failureCount: 5,                                   │
│      nextRetry: timestamp                               │
│    }                                                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Broadcast circuit breaker state]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Subscribe: global:circuit-breaker-opened             │
│  - Detect: Own subsystemId in payload                   │
│  - Action: Reject new requests immediately              │
│  - Return: Error "Service temporarily unavailable"      │
│  - Schedule: Retry attempt after nextRetry              │
└──────┬──────────────────────────────────────────────────┘
       │
       │ [30 seconds pass...]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Error Tracking Manager                  │
│  - Timer triggers: nextRetry reached                    │
│  - Update CB status: OPEN → HALF_OPEN                   │
│  - Fire: global:circuit-breaker-half-open               │
│  - Allow: Single test request                           │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Subscribe: global:circuit-breaker-half-open          │
│  - Action: Attempt single test request                  │
│  - Result: Success ✓                                    │
│  - Send: global:error-report                            │
│    Payload: { severity: 'INFO', recoverable: true }     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Error Tracking Manager                  │
│  - Receive: Successful request                          │
│  - Update CB status: HALF_OPEN → CLOSED                 │
│  - Reset failureCount = 0                               │
│  - Fire: global:circuit-breaker-closed                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Resume normal operation                              │
│  - Process queued requests                              │
└─────────────────────────────────────────────────────────┘
```

---

### Flow 6: Graceful Platform Shutdown

```
┌─────────────┐
│    User     │
│   Closes    │
│     Tab     │
└──────┬──────┘
       │
       │ [Browser fires 'beforeunload' event]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  PLATFORM - Top Level                                   │
│  - Detect: beforeunload event                           │
│  - Send: global:shutdown-initiate                       │
│    Payload: {                                           │
│      reason: 'User closed tab',                         │
│      immediate: false,                                  │
│      maxWaitTime: 5000                                  │
│    }                                                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Platform Status Manager                 │
│  - Receive: global:shutdown-initiate                    │
│  - Set platformStatus = STOPPED                         │
│  - Set pendingTokens = null (block new work)            │
│  - Fire: global:platform-status-changed                 │
│    Payload: { newStatus: 'STOPPED', ... }               │
│  - Fire: global:shutdown-initiated                      │
│  - Collect: All subsystems from registry                │
│  - Sort: By reverse initialization order                │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────► [Broadcast shutdown to all subsystems]
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SYNC MANAGER (First to shutdown)                       │
│  - Subscribe: global:shutdown-initiated                 │
│  - Pause: All sync operations                           │
│  - Persist: Current sync state                          │
│  - Fire: sync:shutdown-complete                         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER                                           │
│  - Subscribe: global:shutdown-initiated                 │
│  - Persist: Session tokens (if rememberMe)              │
│  - Clear: Sensitive data from memory                    │
│  - Fire: auth:shutdown-complete                         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NETWORK REQUEST MANAGER                                │
│  - Subscribe: global:shutdown-initiated                 │
│  - Abort: All non-critical requests                     │
│  - Wait: Critical requests (max 2s)                     │
│  - Flush: Network cache metadata                        │
│  - Fire: network:shutdown-complete                      │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  STORAGE MANAGER                                        │
│  - Subscribe: global:shutdown-initiated                 │
│  - Commit: All pending transactions                     │
│  - Close: IndexedDB connections                         │
│  - Send: global:state-persist                           │
│    Payload: { stateSnapshot: {...} }                    │
│  - Fire: storage:shutdown-complete                      │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Shutdown Coordinator                    │
│  - Receive: state-persist from Storage Manager          │
│  - Verify: All subsystems acknowledged shutdown         │
│  - Record: Final state snapshot in stateHistory         │
│  - Unsubscribe: All browser event listeners             │
│  - Destruct: All features (reverse order)               │
│  - Clear: All registries                                │
│  - Log: Shutdown complete                               │
│  - Set: platformStatus = null                           │
└─────────────────────────────────────────────────────────┘
```

---

## Special Considerations

### 1. State Immutability & Consistency

**Challenge**: Multiple subsystems reading/writing state concurrently can cause race conditions.

**Solution**:
- All state mutations go through controlled setter functions
- State changes are atomic (no partial updates visible)
- State version increments on every mutation
- Optimistic locking for critical state fields
- State history for rollback capability

**Implementation**:
```javascript
function updateState(updates: Partial<GlobalState>, reason: string) {
  const oldState = cloneState(state);
  const newState = { ...state, ...updates };
  
  // Validate state consistency
  if (!validateStateTransition(oldState, newState)) {
    throw new Error('Invalid state transition');
  }
  
  // Record transition
  recordStateTransition(oldState, newState, reason);
  
  // Atomically apply
  Object.assign(state, newState);
  state.stateVersion++;
  
  // Broadcast changes
  dispatchStateChange(oldState, newState);
}
```

---

### 2. Performance Optimization

**Challenge**: Global State is accessed constantly by all subsystems.

**Optimizations**:
- **Getter Caching**: Cache computed values (e.g., health scores) with TTL
- **Event Batching**: Batch rapid state changes into single broadcasts
- **Selective Notifications**: Only notify relevant subsystems of changes
- **Lazy Computation**: Defer expensive calculations until needed
- **Indexed Lookups**: Use Maps for O(1) subsystem/token lookups

**Example**:
```javascript
const cachedHealthScore = {
  value: null,
  timestamp: 0,
  ttl: 5000 // 5 seconds
};

function getPlatformHealthScore(): number {
  const now = Date.now();
  if (cachedHealthScore.value && (now - cachedHealthScore.timestamp) < cachedHealthScore.ttl) {
    return cachedHealthScore.value;
  }
  
  // Compute expensive health score
  const score = computeHealthScore();
  cachedHealthScore.value = score;
  cachedHealthScore.timestamp = now;
  return score;
}
```

---

### 3. Security & Access Control

**Challenge**: Sensitive state must be protected from unauthorized access.

**Protection**:
- **Permission Checking**: All setters validate permission tokens
- **Data Sanitization**: Sensitive data redacted in logs/exports
- **Admin-Only Operations**: Critical operations require elevated auth
- **Audit Trail**: All state changes logged with initiator

**Example**:
```javascript
function setMaintenanceMode(enabled: boolean, permissionToken: string) {
  // Validate permission
  if (!validatePermission(permissionToken, 'ADMIN')) {
    throw new PermissionError('Admin access required');
  }
  
  // Audit log
  logger.log({
    action: 'setMaintenanceMode',
    value: enabled,
    initiatedBy: extractUserId(permissionToken),
    timestamp: Date.now()
  });
  
  // Update state
  updateState({ 
    platformConfiguration: { 
      ...state.platformConfiguration, 
      maintenanceMode: enabled 
    }
  }, 'Admin maintenance mode toggle');
}
```

---

### 4. Resilience & Recovery

**Challenge**: Global State failure is catastrophic for entire platform.

**Resilience Mechanisms**:
- **State Snapshots**: Periodic snapshots for recovery
- **Error Isolation**: Feature errors don't crash entire subsystem
- **Graceful Degradation**: Continue with reduced functionality
- **Emergency Shutdown**: Clean shutdown on unrecoverable errors
- **State Validation**: Detect and repair inconsistent state

**Example**:
```javascript
function handleCriticalError(error: Error) {
  // Record error
  errorState.hasUnrecoverableError = true;
  errorState.lastCriticalError = {
    message: error.message,
    stack: error.stack,
    timestamp: Date.now()
  };
  
  // Attempt state snapshot
  try {
    const snapshot = createStateSnapshot();
    storage.emergencyPersist('critical-error-snapshot', snapshot);
  } catch (persistError) {
    // Fire-and-forget
  }
  
  // Emergency shutdown
  emergencyShutdown(error);
}
```

---

### 5. Observability & Debugging

**Challenge**: Debugging distributed subsystem issues is difficult.

**Observability Tools**:
- **State History**: Circular buffer of recent state transitions
- **Event Replay**: Reconstruct event sequence from logs
- **Subsystem Health Dashboard**: Real-time health monitoring
- **Performance Profiling**: Track state access patterns
- **State Export**: Export complete state for analysis

**Example**:
```javascript
function exportDebugBundle(): string {
  return JSON.stringify({
    currentState: sanitizeState(state),
    stateHistory: state.stateHistory,
    subsystemRegistry: Array.from(state.subsystemRegistry.values()),
    recentErrors: errorState.recentErrors,
    performanceMetrics: state.performanceMetrics,
    timestamp: Date.now()
  }, null, 2);
}
```

---

### 6. Testing & Validation

**Challenge**: Global State touches every subsystem, making testing complex.

**Testing Strategies**:
- **State Machine Tests**: Verify all status transitions valid
- **Invariant Checking**: Assert state invariants after each mutation
- **Fuzzing**: Random state mutations to find edge cases
- **Integration Tests**: Test inter-subsystem communication flows
- **Chaos Engineering**: Inject failures to test resilience

**Example**:
```javascript
function validateStateInvariants(state: GlobalState): boolean {
  // Invariant: pendingTokens.size matches platformStatus
  if (state.pendingTokens !== null) {
    const size = state.pendingTokens.size;
    if (size === 0 && state.platformStatus !== 'IDLE') return false;
    if (size > state.busyThreshold && state.platformStatus !== 'BUSY') return false;
  } else {
    if (state.platformStatus !== 'STOPPED') return false;
  }
  
  // Invariant: authenticated context matches auth level
  if (state.authenticationContext.isAuthenticated && 
      state.authenticationContext.authLevel === 'GUEST') {
    return false;
  }
  
  // All invariants passed
  return true;
}
```

---

## Summary

This comprehensive redesign of the Global State subsystem:

1. **Aligns with existing patterns** from Network Request, Storage, Auth, and Sync managers
2. **Provides detailed specifications** for all components (States, Features, Message Packets, etc.)
3. **Illustrates inter-subsystem communication** with comprehensive flow diagrams
4. **Addresses special considerations** around performance, security, resilience, and observability
5. **Establishes Global State as the foundation** for all subsystem coordination

The design emphasizes:
- **Centralization**: Single source of truth for platform-wide state
- **Coordination**: Orchestrating subsystem lifecycle and health
- **Observability**: Comprehensive monitoring and debugging capabilities
- **Resilience**: Graceful degradation and error recovery
- **Performance**: Optimized for high-frequency access