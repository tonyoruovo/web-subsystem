- Toast service
- Banner service
- Managing `ws://`
- Logging (No need for a logging manager)

## Initial Proposal

**Type**: Centralized  
**Importance/Priority/Weight**: **CRITICAL** - Core event broadcasting and inter-subsystem communication hub

The Notification Center subsystem serves as the central event dispatcher and communication backbone of the platform. It manages event-driven communication between all subsystems, ensuring reliable message delivery, priority-based dispatch, and comprehensive event lifecycle tracking. Unlike featurized subsystems, it operates as a singleton event bus with visibility across all subsystems.

---

### States

The state object maintains comprehensive event management state with strict ordering and delivery guarantees:

#### Core Event Registry
- **eventRegistry**: `Map<string, EventDefinition>` - Central registry of all system events
  ```typescript
  interface EventDefinition {
    eventId: string; // UUID or Symbol
    eventName: string; // Human-readable name (e.g., "user:login", "storage:write-complete")
    subsystemId: string; // Owning subsystem
    category: 'LIFECYCLE' | 'DATA' | 'STATE' | 'ERROR' | 'USER' | 'SYSTEM' | 'NETWORK';
    importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    description: string;
    payloadSchema: object | null; // JSON Schema for validation
    registeredAt: number;
    usageCount: number;
    lastFiredAt: number | null;
    averageHandlerCount: number;
  }
  ```

- **subscriptions**: `Map<string, Set<Subscription>>` - Active event subscriptions (eventId -> subscribers)
  ```typescript
  interface Subscription {
    subscriptionId: string;
    eventId: string;
    subscriberSubsystemId: string;
    handler: EventHandler;
    priority: number; // Higher = earlier execution
    filterPredicate: ((payload: any) => boolean) | null;
    maxExecutions: number | null; // For one-time or limited subscriptions
    executionCount: number;
    subscribedAt: number;
    lastExecutedAt: number | null;
    errorCount: number;
    enabled: boolean;
  }
  
  type EventHandler = (payload: any, metadata: EventMetadata) => void | Promise<void>;
  ```

#### Event Queue & Dispatch
- **eventQueue**: `PriorityQueue<QueuedEvent>` - Events awaiting dispatch
  ```typescript
  interface QueuedEvent {
    queueId: string;
    eventId: string;
    payload: any;
    metadata: EventMetadata;
    importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    enqueuedAt: number;
    scheduledFor: number | null; // For delayed events
    retryCount: number;
    maxRetries: number;
  }
  
  interface EventMetadata {
    sourceSubsystemId: string;
    sourceComponentId: string | null; // Feature name, Worker URL, etc.
    correlationId: string; // For tracking related events
    causationId: string | null; // Event that caused this event
    timestamp: number;
    fingerprints: Fingerprint[];
    permissionToken: string | null;
    isRetry: boolean;
  }
  ```

#### Dispatch State & Performance
- **dispatchState**: Object tracking dispatcher status
  ```typescript
  interface DispatchState {
    status: 'IDLE' | 'DISPATCHING' | 'PAUSED' | 'ERROR' | 'SHUTDOWN';
    currentlyDispatching: Set<string>; // Event IDs currently being dispatched
    dispatchLoopRunning: boolean;
    lastDispatchTime: number | null;
    eventsDispatchedTotal: number;
    eventsDispatchedLastMinute: number;
    averageDispatchTime: number; // ms
    queueSize: number;
    queueCapacity: number; // Max queue size
    backpressureActive: boolean; // Queue near capacity
  }
  ```

- **performanceMetrics**: Object containing dispatcher performance data
  ```typescript
  interface NotificationPerformanceMetrics {
    // Throughput
    eventsPerSecond: number;
    subscriptionsPerEvent: number;
    averageHandlerExecutionTime: number; // ms
    
    // Queue metrics
    averageQueueWaitTime: number; // ms from enqueue to dispatch
    queueUtilization: number; // 0-1
    peakQueueSize: number;
    
    // Reliability
    deliverySuccessRate: number; // 0-1
    handlerErrorRate: number; // 0-1
    retriedEvents: number;
    droppedEvents: number;
    
    // Latency breakdown
    p50DispatchLatency: number;
    p95DispatchLatency: number;
    p99DispatchLatency: number;
    
    // Resource usage
    activeHandlers: number;
    pendingPromises: number;
    
    lastMetricsUpdate: number;
  }
  ```

#### Event History & Debugging
- **eventHistory**: `CircularBuffer<DispatchedEvent>` - Recent event history (last 1000 events)
  ```typescript
  interface DispatchedEvent {
    eventId: string;
    eventName: string;
    payload: any; // Sanitized for sensitive data
    metadata: EventMetadata;
    dispatchedAt: number;
    handlersExecuted: number;
    handlersErrored: number;
    totalExecutionTime: number;
    errors: Array<{
      subscriberSubsystemId: string;
      error: string;
      timestamp: number;
    }>;
  }
  ```

- **correlationRegistry**: `Map<string, CorrelationChain>` - Track related events
  ```typescript
  interface CorrelationChain {
    rootEventId: string;
    events: Array<{
      eventId: string;
      timestamp: number;
      subsystemId: string;
    }>;
    status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
    createdAt: number;
    completedAt: number | null;
  }
  ```

#### Error Tracking & Circuit Breaking
- **errorTracking**: Object tracking handler failures
  ```typescript
  interface ErrorTracking {
    handlerErrors: Map<string, HandlerErrorState>; // subscriptionId -> error state
    circuitBreakers: Map<string, CircuitBreakerState>; // subscriptionId -> breaker
    recentErrors: CircularBuffer<{
      subscriptionId: string;
      eventId: string;
      error: string;
      timestamp: number;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    }>;
    errorRateLastMinute: number;
  }
  
  interface HandlerErrorState {
    subscriptionId: string;
    consecutiveErrors: number;
    totalErrors: number;
    lastError: {
      message: string;
      stack: string;
      timestamp: number;
    } | null;
    recoveredAt: number | null;
  }
  
  interface CircuitBreakerState {
    subscriptionId: string;
    status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    failureThreshold: number; // Consecutive failures to open
    failureCount: number;
    lastFailure: number | null;
    openedAt: number | null;
    nextRetry: number | null; // When to try HALF_OPEN
    successCount: number; // In HALF_OPEN state
    successThreshold: number; // Successes to close
  }
  ```

#### Configuration
- **notificationConfig**: Object containing runtime configuration
  ```typescript
  interface NotificationConfig {
    maxQueueSize: number; // Default: 10000
    dispatchBatchSize: number; // Events per dispatch cycle
    dispatchIntervalMs: number; // Dispatch loop interval
    maxHandlerExecutionTime: number; // ms before warning
    enableAsyncHandlers: boolean;
    enableEventValidation: boolean;
    enableEventHistory: boolean;
    historyBufferSize: number;
    circuitBreakerEnabled: boolean;
    circuitBreakerThreshold: number;
    circuitBreakerResetTime: number; // ms
    maxRetries: number;
    retryBackoffMultiplier: number;
    enableCorrelationTracking: boolean;
    correlationTTL: number; // ms
  }
  ```

---

### Features

The Notification Center is composed of specialized features that manage different aspects of event-driven communication:

#### 1. Event Registry Manager
**Purpose**: Manages the central registry of all system events and their definitions.  
**Weight**: CRITICAL - Required for all event operations

**Responsibilities**:
- Register new events with validation
- Deregister events and cleanup subscriptions
- Provide event lookups by ID or name
- Validate event payload schemas
- Track event usage statistics
- Prevent duplicate event registrations

**State Fields Used**:
- `eventRegistry`

**Key Operations**:
```typescript
registerEvent(definition: EventDefinition): Result<string, Error>
deregisterEvent(eventId: string): Result<void, Error>
getEventDefinition(eventId: string): EventDefinition | null
validateEventPayload(eventId: string, payload: any): Result<void, ValidationError>
listEventsBySubsystem(subsystemId: string): EventDefinition[]
updateEventStats(eventId: string): void
```

**Message Packets Produced**:
- `notification:event-registered` - When new event registered
- `notification:event-deregistered` - When event removed
- `notification:validation-error` - When payload validation fails

**Fingerprint Actions**:
- `event-registered`
- `event-deregistered`
- `event-lookup`
- `validation-passed`
- `validation-failed`

---

#### 2. Subscription Manager
**Purpose**: Manages event subscriptions and subscriber lifecycle.  
**Weight**: CRITICAL - Core subscription handling

**Responsibilities**:
- Subscribe handlers to events
- Unsubscribe handlers
- Manage subscription priorities
- Apply filter predicates
- Handle one-time and limited subscriptions
- Enable/disable subscriptions
- Clean up orphaned subscriptions

**State Fields Used**:
- `subscriptions`
- `eventRegistry`

**Key Operations**:
```typescript
subscribe(options: SubscribeOptions): Result<string, Error>
unsubscribe(subscriptionId: string): Result<void, Error>
unsubscribeAll(subsystemId: string): Result<number, Error>
getSubscriptions(eventId: string): Subscription[]
updateSubscriptionPriority(subscriptionId: string, priority: number): Result<void, Error>
enableSubscription(subscriptionId: string, enabled: boolean): Result<void, Error>
```

**Message Packets Produced**:
- `notification:subscription-added` - New subscription created
- `notification:subscription-removed` - Subscription removed
- `notification:subscription-limit-reached` - Max executions reached

**Fingerprint Actions**:
- `subscription-created`
- `subscription-removed`
- `subscription-executed`
- `filter-applied`

---

#### 3. Event Queue Manager
**Purpose**: Manages priority-based event queuing and backpressure.  
**Weight**: CRITICAL - Ensures reliable event ordering

**Responsibilities**:
- Enqueue events with priority
- Dequeue events for dispatch
- Handle queue overflow
- Apply backpressure when needed
- Schedule delayed events
- Manage retry queue
- Report queue metrics

**State Fields Used**:
- `eventQueue`
- `dispatchState`
- `notificationConfig`

**Key Operations**:
```typescript
enqueue(event: QueuedEvent): Result<void, QueueFullError>
dequeue(): QueuedEvent | null
dequeueBatch(size: number): QueuedEvent[]
scheduleDelayedEvent(event: QueuedEvent, delayMs: number): void
clearQueue(): void
getQueueMetrics(): QueueMetrics
applyBackpressure(): void
releaseBackpressure(): void
```

**Message Packets Produced**:
- `notification:queue-full` - Queue capacity reached
- `notification:backpressure-active` - Backpressure applied
- `notification:backpressure-released` - Backpressure released
- `notification:queue-cleared` - Queue manually cleared

**Fingerprint Actions**:
- `event-enqueued`
- `event-dequeued`
- `queue-overflow`
- `backpressure-applied`

---

#### 4. Event Dispatcher
**Purpose**: Core dispatch loop that executes event handlers.  
**Weight**: CRITICAL - Handles all event delivery

**Responsibilities**:
- Run dispatch loop
- Execute handlers in priority order
- Handle async handlers
- Track execution time
- Implement timeout protection
- Manage concurrent dispatches
- Handle dispatch errors
- Update performance metrics

**State Fields Used**:
- `eventQueue`
- `subscriptions`
- `dispatchState`
- `performanceMetrics`
- `eventHistory`

**Key Operations**:
```typescript
startDispatchLoop(): void
stopDispatchLoop(): void
pauseDispatch(): void
resumeDispatch(): void
dispatchEvent(event: QueuedEvent): Promise<DispatchResult>
executeHandler(subscription: Subscription, payload: any, metadata: EventMetadata): Promise<void>
recordDispatch(event: DispatchedEvent): void
```

**Message Packets Produced**:
- `notification:dispatch-started` - Dispatcher started
- `notification:dispatch-paused` - Dispatcher paused
- `notification:dispatch-error` - Critical dispatch error
- `notification:handler-timeout` - Handler exceeded timeout

**Fingerprint Actions**:
- `dispatch-started`
- `dispatch-completed`
- `handler-executed`
- `handler-timeout`
- `dispatch-error`

---

#### 5. Correlation Tracker
**Purpose**: Tracks relationships between events for debugging and analysis.  
**Weight**: MEDIUM - Debugging and observability

**Responsibilities**:
- Create correlation chains
- Track causation relationships
- Link related events
- Provide correlation queries
- Clean up old correlations
- Generate correlation reports

**State Fields Used**:
- `correlationRegistry`
- `eventHistory`
- `notificationConfig`

**Key Operations**:
```typescript
startCorrelation(rootEventId: string): string
addToCorrelation(correlationId: string, eventId: string): void
completeCorrelation(correlationId: string): void
getCorrelationChain(correlationId: string): CorrelationChain | null
findRelatedEvents(eventId: string): string[]
cleanupExpiredCorrelations(): void
```

**Message Packets Produced**:
- `notification:correlation-started` - New correlation chain
- `notification:correlation-completed` - Chain completed

**Fingerprint Actions**:
- `correlation-created`
- `event-linked`
- `correlation-completed`

---

#### 6. Circuit Breaker Manager
**Purpose**: Protects system from cascading failures due to faulty handlers.  
**Weight**: HIGH - System resilience

**Responsibilities**:
- Monitor handler failures
- Open circuits on threshold
- Attempt recovery in half-open state
- Close circuits on recovery
- Track breaker state transitions
- Report breaker status

**State Fields Used**:
- `errorTracking`
- `subscriptions`
- `notificationConfig`

**Key Operations**:
```typescript
recordHandlerSuccess(subscriptionId: string): void
recordHandlerFailure(subscriptionId: string, error: Error): void
shouldExecuteHandler(subscriptionId: string): boolean
transitionToHalfOpen(subscriptionId: string): void
transitionToClosed(subscriptionId: string): void
transitionToOpen(subscriptionId: string): void
getCircuitBreakerState(subscriptionId: string): CircuitBreakerState
resetCircuitBreaker(subscriptionId: string): void
```

**Message Packets Produced**:
- `notification:circuit-opened` - Circuit breaker opened
- `notification:circuit-half-open` - Attempting recovery
- `notification:circuit-closed` - Circuit recovered
- `notification:circuit-reset` - Manually reset

**Fingerprint Actions**:
- `failure-recorded`
- `circuit-opened`
- `recovery-attempted`
- `circuit-closed`

---

#### 7. Performance Monitor
**Purpose**: Tracks and reports notification center performance metrics.  
**Weight**: LOW - Observability

**Responsibilities**:
- Calculate throughput metrics
- Track latency percentiles
- Monitor queue utilization
- Report handler performance
- Detect performance degradation
- Export metrics for analytics

**State Fields Used**:
- `performanceMetrics`
- `dispatchState`
- `eventHistory`

**Key Operations**:
```typescript
updateMetrics(): void
calculateLatencyPercentiles(): { p50: number; p95: number; p99: number }
getEventThroughput(): number
getQueueUtilization(): number
detectPerformanceDegradation(): boolean
exportMetrics(): PerformanceReport
resetMetrics(): void
```

**Message Packets Produced**:
- `notification:performance-degraded` - Performance below threshold
- `notification:metrics-updated` - Periodic metrics update

**Fingerprint Actions**:
- `metrics-calculated`
- `degradation-detected`
- `metrics-exported`

---

#### 8. Event Validator
**Purpose**: Validates event payloads against registered schemas.  
**Weight**: MEDIUM - Data integrity

**Responsibilities**:
- Validate payloads against JSON schemas
- Sanitize event data
- Enforce payload size limits
- Check required fields
- Validate permission tokens
- Report validation errors

**State Fields Used**:
- `eventRegistry`
- `notificationConfig`

**Key Operations**:
```typescript
validatePayload(eventId: string, payload: any): ValidationResult
sanitizePayload(payload: any): any
checkPayloadSize(payload: any): boolean
validatePermissionToken(token: string, requiredLevel: string): boolean
validateMetadata(metadata: EventMetadata): ValidationResult
```

**Message Packets Produced**:
- `notification:validation-failed` - Payload validation failed
- `notification:payload-too-large` - Payload exceeds size limit

**Fingerprint Actions**:
- `payload-validated`
- `validation-failed`
- `payload-sanitized`

---

### Lifecycle Manager

**Purpose**: Manages initialization, configuration, and destruction of the Notification Center subsystem.

#### Initialization Sequence

```javascript
async function initialize(): Promise<void> {
  // 1. Validate dependencies
  await validateDependencies();
  
  // 2. Initialize state
  initializeState();
  
  // 3. Initialize features in order
  await EventRegistryManager.initialize();
  await SubscriptionManager.initialize();
  await EventQueueManager.initialize();
  await EventValidator.initialize();
  await CircuitBreakerManager.initialize();
  await CorrelationTracker.initialize();
  await PerformanceMonitor.initialize();
  await EventDispatcher.initialize(); // Last - starts dispatch loop
  
  // 4. Register system events
  registerSystemEvents();
  
  // 5. Subscribe to dependencies
  subscribeToGlobalState();
  subscribeToMessageQueue();
  
  // 6. Notify subsystems
  fireEvent('notification:ready', {
    timestamp: Date.now(),
    queueCapacity: notificationConfig.maxQueueSize
  });
  
  // 7. Start dispatch loop
  EventDispatcher.startDispatchLoop();
}
```

#### Destruction Sequence

```javascript
async function destroy(): Promise<void> {
  // 1. Stop accepting new events
  EventQueueManager.applyBackpressure();
  
  // 2. Stop dispatch loop
  EventDispatcher.stopDispatchLoop();
  
  // 3. Wait for in-flight events (with timeout)
  await waitForPendingDispatches(5000);
  
  // 4. Unsubscribe from all events
  unsubscribeFromAll();
  
  // 5. Destroy features in reverse order
  await EventDispatcher.destroy();
  await PerformanceMonitor.destroy();
  await CorrelationTracker.destroy();
  await CircuitBreakerManager.destroy();
  await EventValidator.destroy();
  await EventQueueManager.destroy();
  await SubscriptionManager.destroy();
  await EventRegistryManager.destroy();
  
  // 6. Persist critical state
  await persistState();
  
  // 7. Clear state
  clearState();
  
  // 8. Notify shutdown complete
  // (Use Message Queue directly since Notification Center is shutting down)
}
```

---

### Worker

**Type**: Virtual Worker (No Web Worker - runs on main thread due to synchronous event dispatch requirements)

The Notification Center does not use a Web Worker because:
1. Event handlers need synchronous access to subsystem state
2. Events must be dispatched in strict order on the main thread
3. Minimal computation - primarily dispatching callbacks
4. Cross-thread message passing would add latency

However, it implements the Worker interface conceptually:

#### Receiver
- Receives `fireEvent` requests from subsystems
- Accepts subscription registration requests
- Receives configuration updates
- Accepts pause/resume commands
- Receives manual dispatch triggers

#### Processor

**Event Processing Pipeline**:
1. Receive event fire request
2. Validate event payload (if enabled)
3. Add fingerprint for enqueue action
4. Enqueue event with priority
5. Wake dispatch loop if sleeping

**Dispatch Processing Pipeline**:
1. Dequeue next event(s)
2. Lookup subscriptions for event
3. Filter subscriptions by predicate
4. Sort by priority
5. Execute handlers sequentially or in parallel
6. Track execution time and errors
7. Update circuit breakers
8. Record to event history
9. Update performance metrics

**Subscription Processing Pipeline**:
1. Receive subscription request
2. Validate event exists
3. Create subscription record
4. Add to subscriptions map
5. Sort subscription list by priority
6. Notify subscriber confirmed

#### Dispatcher
- Posts event delivery confirmations to subscribers
- Emits performance metrics to Analytics Manager
- Sends error notifications for handler failures
- Posts queue status to Global State
- Emits correlation data to Logger
- Returns subscription IDs to requesters

#### Additional Virtual Worker Requirements

**Pausable**: Can pause dispatch loop during critical operations
```javascript
function pauseDispatch() {
  dispatchState.status = 'PAUSED';
  // Events still enqueue, but dispatch loop pauses
}
```

**Resumable**: Resumes dispatch from paused state
```javascript
function resumeDispatch() {
  dispatchState.status = 'DISPATCHING';
  // Dispatch loop resumes processing queue
}
```

**Abortable**: Can abort in-flight dispatches cleanly
```javascript
async function abortDispatch() {
  dispatchState.status = 'SHUTDOWN';
  // Wait for current handler executions with timeout
  await Promise.race([
    waitForCurrentHandlers(),
    timeout(5000)
  ]);
}
```

**Error Handling**:
- Isolates handler errors to prevent cascade failures
- Circuit breaker prevents repeated execution of failing handlers
- Error events fire to notify system of issues
- Graceful degradation if critical features fail

**Visibility API Management**:
- Pauses dispatch when page hidden (optional config)
- Resumes on page visible
- Adjusts dispatch interval based on visibility

**Cleanup Protocols**:
- Clears expired correlations periodically
- Removes disabled subscriptions
- Purges old event history
- Resets circuit breakers after cooldown
- Garbage collects orphaned state

---

### Dependencies

The Notification Center relies on these subsystems:

#### 1. Global State (CRITICAL)
**Purpose**: Read platform status, subsystem health, and configuration  
**Used For**:
- Checking if platform is STOPPED (reject new events)
- Checking if platform is BUSY (apply backpressure)
- Reading subsystem registry for validation
- Monitoring online/offline status
- Reading performance thresholds

**Initialization Order**: Global State must initialize BEFORE Notification Center

**Functional Predicates**:
```javascript
function shouldAcceptEvent(event): boolean {
  const platformStatus = GlobalState.getPlatformStatus();
  
  // Always reject if stopped
  if (platformStatus === 'STOPPED' || platformStatus === 'CRASHED') {
    return false;
  }
  
  // Accept CRITICAL events even when BUSY
  if (event.importance === 'CRITICAL') {
    return true;
  }
  
  // Reject non-critical events when BUSY
  if (platformStatus === 'BUSY' && event.importance !== 'CRITICAL') {
    return false;
  }
  
  return true;
}
```

---

#### 2. Message Queue (HIGH)
**Purpose**: Handle cross-subsystem message routing  
**Used For**:
- Receiving event fire requests from other subsystems
- Sending subscription confirmations
- Routing events that require queuing semantics
- Coordinating with queue for backpressure

**Initialization Order**: Message Queue must initialize BEFORE Notification Center

**Functional Predicates**:
```javascript
function shouldUseQueue(event): boolean {
  // Use queue for events from remote subsystems
  if (event.metadata.sourceSubsystemId !== 'notification-center') {
    return true;
  }
  
  // Use queue for delayed events
  if (event.scheduledFor !== null) {
    return true;
  }
  
  return false;
}
```

---

#### 3. Logger (MEDIUM)
**Purpose**: Log event dispatches and errors  
**Used For**:
- Logging event history with fingerprints
- Recording handler errors
- Tracking performance metrics
- Debugging event flows

**Initialization Order**: Logger can initialize concurrently

**Functional Predicates**:
```javascript
function shouldLogEvent(event): boolean {
  const config = notificationConfig;
  
  // Always log CRITICAL events
  if (event.importance === 'CRITICAL') {
    return true;
  }
  
  // Skip logging if disabled
  if (!config.enableEventHistory) {
    return false;
  }
  
  // Log based on log level
  return shouldLog(event.importance, config.logLevel);
}
```

---

#### 4. Storage Manager (LOW)
**Purpose**: Persist event registry and subscriptions  
**Used For**:
- Persisting event definitions across sessions
- Storing subscription preferences
- Saving correlation data for analysis
- Caching performance metrics

**Initialization Order**: Storage Manager can initialize concurrently

---

#### 5. Analytics Manager (LOW)
**Purpose**: Track event and performance analytics  
**Used For**:
- Reporting event throughput
- Tracking handler performance
- Monitoring error rates
- Identifying performance bottlenecks

**Initialization Order**: Analytics Manager can initialize after Notification Center

---

### Control Interface

The Notification Center exposes these control methods:

#### Event Management
```javascript
// Register new event type
registerEvent(definition: EventDefinition): string

// Fire event to all subscribers
fireEvent(eventId: string, payload: any, metadata?: Partial<EventMetadata>): void

// Fire event synchronously (blocks until all handlers complete)
fireEventSync(eventId: string, payload: any, metadata?: Partial<EventMetadata>): void

// Schedule delayed event
scheduleEvent(eventId: string, payload: any, delayMs: number, metadata?: Partial<EventMetadata>): string

// Cancel scheduled event
cancelScheduledEvent(scheduledEventId: string): boolean
```

#### Subscription Management
```javascript
// Subscribe to event
subscribe(eventId: string, handler: EventHandler, options?: SubscribeOptions): string

// Subscribe once (auto-unsubscribe after first execution)
subscribeOnce(eventId: string, handler: EventHandler, options?: SubscribeOptions): string

// Unsubscribe from event
unsubscribe(subscriptionId: string): void

// Unsubscribe all handlers for a subsystem
unsubscribeAllForSubsystem(subsystemId: string): number
```

#### Control Operations
```javascript
// Pause event dispatch
pauseDispatch(): void

// Resume event dispatch
resumeDispatch(): void

// Clear event queue
clearQueue(): void

// Get queue status
getQueueStatus(): { size: number; capacity: number; utilization: number }

// Get dispatch metrics
getMetrics(): NotificationPerformanceMetrics
```

#### Debugging & Observability
```javascript
// Get event history
getEventHistory(filter?: EventFilter): DispatchedEvent[]

// Get correlation chain
getCorrelation(correlationId: string): CorrelationChain

// Get subscriptions for event
getSubscriptionsForEvent(eventId: string): Subscription[]

// Get circuit breaker status
getCircuitBreakerStatus(subscriptionId: string): CircuitBreakerState

// Export debug information
exportDebugInfo(): NotificationDebugBundle
```

---

### Message Packets

Message packets in the Notification Center follow the standard packet structure with specialized event-specific fields:

#### Basic Packet Structure
```typescript
interface NotificationPacket {
  // Event identification
  eventId: string;
  eventName: string;
  
  // Payload
  payload: any;
  
  // Metadata
  metadata: EventMetadata;
  
  // Fingerprints (array of actions taken)
  fingerprints: Fingerprint[];
  
  // Callbacks
  onComplete?: (result: any) => void;
  onError?: (error: Error) => void;
  onLog?: (fingerprints: Fingerprint[]) => void;
  
  // Permissions (for elevated events)
  permissionToken?: string;
}

interface Fingerprint {
  action: string; // e.g., 'event-enqueued', 'handler-executed'
  valueType: string; // Type of value involved
  timestamp: number;
  subsystemId: string;
  componentId: string | null; // Feature name, handler ID, etc.
  counter: number | null; // Retry count or repeated action count
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string | null;
}
```

#### Packet Types

###### 1. Event Fire Packet
```typescript
interface EventFirePacket extends NotificationPacket {
  eventId: string;
  payload: any;
  metadata: {
    sourceSubsystemId: string;
    sourceComponentId: string | null;
    correlationId: string;
    causationId: string | null;
    timestamp: number;
    fingerprints: Fingerprint[];
    permissionToken: string | null;
  };
  importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  scheduledFor?: number; // For delayed events
}
```

**Produced By**: Any subsystem firing an event  
**Consumed By**: Event Queue Manager → Event Dispatcher

**Fingerprints Added**:
- `event-created` (by originating subsystem)
- `event-enqueued` (by Event Queue Manager)
- `event-dispatched` (by Event Dispatcher)
- `handler-executed` (by Event Dispatcher, one per handler)
- `event-completed` (by Event Dispatcher)

---

###### 2. Subscription Packet
```typescript
interface SubscriptionPacket extends NotificationPacket {
  eventId: string;
  subscriberSubsystemId: string;
  handler: EventHandler;
  options?: {
    priority?: number;
    filter?: (payload: any) => boolean;
    maxExecutions?: number;
  };
}
```

**Produced By**: Any subsystem subscribing to events  
**Consumed By**: Subscription Manager

**Fingerprints Added**:
- `subscription-requested`
- `subscription-validated`
- `subscription-created`

---

###### 3. Event Notification Packet (Dispatched to Handlers)
```typescript
interface EventNotificationPacket {
  eventId: string;
  eventName: string;
  payload: any;
  metadata: EventMetadata;
  
  // Handler-specific
  subscriptionId: string;
  executionNumber: number; // Nth execution of this subscription
}
```

**Produced By**: Event Dispatcher  
**Consumed By**: Event handlers in subscribing subsystems

**Fingerprints Added**:
- `handler-invoked`
- `handler-completed` OR `handler-errored`

---

###### 4. Performance Metrics Packet
```typescript
interface PerformanceMetricsPacket extends NotificationPacket {
  eventId: 'notification:metrics-updated';
  payload: NotificationPerformanceMetrics;
  metadata: {
    sourceSubsystemId: 'notification-center';
    sourceComponentId: 'performance-monitor';
    timestamp: number;
    fingerprints: Fingerprint[];
  };
}
```

**Produced By**: Performance Monitor  
**Consumed By**: Analytics Manager, Global State

**Fingerprints Added**:
- `metrics-calculated`
- `metrics-broadcasted`

---

###### 5. Error Notification Packet
```typescript
interface ErrorNotificationPacket extends NotificationPacket {
  eventId: 'notification:error' | 'notification:handler-error' | 'notification:circuit-opened';
  payload: {
    error: {
      message: string;
      stack: string;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    };
    subscriptionId?: string;
    eventId?: string;
    subsystemId: string;
  };
  metadata: EventMetadata;
}
```

**Produced By**: Event Dispatcher, Circuit Breaker Manager  
**Consumed By**: Logger, Analytics Manager, affected subsystem

**Fingerprints Added**:
- `error-occurred`
- `error-logged`
- `circuit-state-changed`

---

#### Fingerprint Management

Each subsystem interacting with the Notification Center must implement:

```typescript
class FingerprintManager {
  // Create fingerprint for action
  createFingerprint(action: string, options: FingerprintOptions): Fingerprint {
    return {
      action,
      valueType: options.valueType,
      timestamp: Date.now(),
      subsystemId: this.subsystemId,
      componentId: options.componentId || null,
      counter: options.counter || null,
      level: options.level || 'INFO',
      message: options.message || null
    };
  }
  
  // Add fingerprint to packet
  addFingerprint(packet: NotificationPacket, action: string, options: FingerprintOptions): void {
    const fingerprint = this.createFingerprint(action, options);
    packet.fingerprints.push(fingerprint);
  }
  
  // Strip fingerprints (if needed for payload size reduction)
  stripFingerprints(packet: NotificationPacket): Fingerprint[] {
    const fingerprints = packet.fingerprints;
    packet.fingerprints = [];
    return fingerprints;
  }
}
```

---

### Subscriptions (Subscribe to Other Subsystems' Events)

The Notification Center subscribes to these events from other subsystems:

#### From Global State

###### 1. `global-state:platform-status-changed`
```typescript
subscribe('global-state:platform-status-changed', (payload) => {
  const { newStatus, oldStatus } = payload;
  
  if (newStatus === 'STOPPED' || newStatus === 'CRASHED') {
    // Stop accepting new events
    EventQueueManager.applyBackpressure();
    EventDispatcher.pauseDispatch();
  } else if (newStatus === 'BUSY') {
    // Apply backpressure for non-critical events
    EventQueueManager.applyBackpressure();
  } else if (newStatus === 'IDLE' && oldStatus === 'BUSY') {
    // Release backpressure
    EventQueueManager.releaseBackpressure();
  }
}, { priority: 100 }); // High priority
```

###### 2. `global-state:subsystem-registered`
```typescript
subscribe('global-state:subsystem-registered', (payload) => {
  const { subsystemId, subsystemType } = payload;
  
  // Track new subsystem for event validation
  EventValidator.registerSubsystem(subsystemId, subsystemType);
}, { priority: 50 });
```

###### 3. `global-state:subsystem-destroyed`
```typescript
subscribe('global-state:subsystem-destroyed', (payload) => {
  const { subsystemId } = payload;
  
  // Clean up subscriptions from destroyed subsystem
  SubscriptionManager.unsubscribeAll(subsystemId);
  
  // Deregister events owned by subsystem
  EventRegistryManager.deregisterSubsystemEvents(subsystemId);
}, { priority: 100 });
```

---

#### From Message Queue

###### 1. `queue:overflow`
```typescript
subscribe('queue:overflow', (payload) => {
  // Coordinate with message queue on backpressure
  if (!dispatchState.backpressureActive) {
    EventQueueManager.applyBackpressure();
    
    fireEvent('notification:backpressure-coordinated', {
      reason: 'message-queue-overflow',
      timestamp: Date.now()
    });
  }
}, { priority: 100 });
```

###### 2. `queue:space-available`
```typescript
subscribe('queue:space-available', (payload) => {
  // Release backpressure if queue has space
  if (dispatchState.backpressureActive) {
    EventQueueManager.releaseBackpressure();
  }
}, { priority: 100 });
```

---

#### From Logger

###### 1. `logger:storage-full`
```typescript
subscribe('logger:storage-full', (payload) => {
  // Reduce event history storage
  notificationConfig.enableEventHistory = false;
  
  // Clear old history
  eventHistory.clear();
  
  fireEvent('notification:history-disabled', {
    reason: 'logger-storage-full',
    timestamp: Date.now()
  });
}, { priority: 80 });
```

---

### Inter-Subsystem Communication Flows

#### Flow 1: Simple Event Dispatch (Single Subsystem)

```
┌─────────────────────────────────────────────────────────┐
│  AUTH MANAGER - User Login Action                      │
│  - User submits credentials                             │
│  - Validation passes                                     │
│  - Create login event packet                            │
│  - Add fingerprint: "auth-login-initiated"              │
└──────┬──────────────────────────────────────────────────┘
       │ fireEvent('auth:login-success', { userId, token })
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Queue Manager              │
│  - Receive: auth:login-success event                    │
│  - Validate: Event registered? Yes                      │
│  - Validate: Payload matches schema? Yes                │
│  - Add fingerprint: "event-enqueued"                    │
│  - Enqueue with importance: HIGH                        │
│  - Queue size: 5 → not busy                             │
│  - Fire: notification:event-enqueued                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Dispatcher                 │
│  - Dispatch loop iteration (every 16ms)                 │
│  - Dequeue: Get auth:login-success event                │
│  - Lookup subscriptions: 3 subscribers found            │
│  - Sort by priority: [Global State, Storage, UI]        │
│  - Add fingerprint: "event-dispatched"                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ├─────────────────────────────────────────────────┐
       │                                                  │
       ▼                                                  ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  GLOBAL STATE                │  │  STORAGE MANAGER             │
│  - Receive notification      │  │  - Receive notification      │
│  - Update authContext        │  │  - Store session token       │
│  - Set authenticated = true  │  │  - Update user preferences   │
│  - Update lastLoginTime      │  │  - Add fingerprint           │
│  - Add fingerprint           │  │  - Return success            │
│  - Return success            │  │                               │
└──────────────────────────────┘  └──────────────────────────────┘
       │                                   │
       └───────────────┬───────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Dispatcher                 │
│  - All handlers completed successfully                  │
│  - Add fingerprint: "event-completed"                   │
│  - Record to eventHistory                               │
│  - Update metrics: eventsDispatchedTotal++              │
│  - Update metrics: averageDispatchTime                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  LOGGER                                                  │
│  - Receive: onLog callback with fingerprints            │
│  - Log fingerprints: ["auth-login-initiated",           │
│                       "event-enqueued",                 │
│                       "event-dispatched",               │
│                       "state-updated",                  │
│                       "session-stored",                 │
│                       "event-completed"]                │
│  - Store correlation data                               │
└─────────────────────────────────────────────────────────┘
```

---

#### Flow 2: Cross-Subsystem Event Chain (Correlation Tracking)

```
┌─────────────────────────────────────────────────────────┐
│  NETWORK MANAGER - API Request Complete                 │
│  - Request to /api/user/profile completed               │
│  - Create correlation ID: "corr-abc123"                 │
│  - Fire: network:response-received                      │
│    Payload: { url, status: 200, data: {...} }           │
│    Metadata: { correlationId: "corr-abc123" }           │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Correlation Tracker              │
│  - Detect: New correlationId "corr-abc123"              │
│  - Create: New CorrelationChain                         │
│  - Record: Root event = network:response-received       │
│  - Status: ACTIVE                                        │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  STORAGE MANAGER - Subscriber to network:response       │
│  - Receive: Profile data from network                   │
│  - Parse and cache user profile                         │
│  - Fire: storage:cache-updated                          │
│    Metadata: {                                           │
│      correlationId: "corr-abc123",                      │
│      causationId: "network:response-received"           │
│    }                                                     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Correlation Tracker              │
│  - Detect: correlationId "corr-abc123" matches chain    │
│  - Add to chain: storage:cache-updated                  │
│  - Chain events: [network:response-received,            │
│                   storage:cache-updated]                │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  UI MANAGER - Subscriber to storage:cache-updated       │
│  - Receive: Cache update notification                   │
│  - Refresh user profile display                         │
│  - Fire: ui:profile-updated                             │
│    Metadata: {                                           │
│      correlationId: "corr-abc123",                      │
│      causationId: "storage:cache-updated"               │
│    }                                                     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Correlation Tracker              │
│  - Add to chain: ui:profile-updated                     │
│  - Detect: Chain complete (no more causation events)    │
│  - Status: COMPLETED                                     │
│  - Chain events: [network:response-received,            │
│                   storage:cache-updated,                │
│                   ui:profile-updated]                   │
│  - Fire: notification:correlation-completed             │
│  - Send correlation data to Analytics & Logger          │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  ANALYTICS MANAGER                                       │
│  - Receive: Correlation chain data                      │
│  - Track: Profile load end-to-end time                  │
│  - Track: Each step duration                            │
│  - Identify: Bottleneck (if any)                        │
└─────────────────────────────────────────────────────────┘
```

---

#### Flow 3: Backpressure & Circuit Breaking

```
┌─────────────────────────────────────────────────────────┐
│  MULTIPLE SUBSYSTEMS - High Event Volume                │
│  - UI: 20 user interactions/sec                         │
│  - Network: 10 API responses/sec                        │
│  - Storage: 15 write operations/sec                     │
│  - Total: 45 events/sec → Queue filling rapidly         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Queue Manager              │
│  - Queue size: 8500 / 10000 (85% capacity)              │
│  - Threshold check: > 80% = Apply backpressure          │
│  - Action: Set backpressureActive = true                │
│  - Fire: notification:backpressure-active               │
│  - Policy: Reject LOW/MEDIUM importance events          │
│  - Policy: Accept HIGH/CRITICAL events only             │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Subscriber to backpressure-active       │
│  - Receive: Backpressure notification                   │
│  - Update: platformStatus = BUSY                        │
│  - Fire: global-state:platform-status-changed           │
│  - Add pending token for backpressure handling          │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE - Subscriber to platform-status-changed  │
│  - Receive: Platform is BUSY                            │
│  - Action: Pause accepting new packets                  │
│  - Action: Queue incoming LOW/MEDIUM for retry          │
│  - Fire: queue:paused                                   │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Dispatcher                 │
│  - Processing queue at maximum rate                     │
│  - Queue size: 8500 → 7200 → 5800 → ...                │
│  - Dispatch: Process CRITICAL/HIGH first                │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼ (Meanwhile, handler failure scenario)
┌─────────────────────────────────────────────────────────┐
│  ANALYTICS MANAGER - Subscriber with Failing Handler    │
│  - Receive: Event notification                          │
│  - Handler execution: throws Error                      │
│  - Error: "Database connection timeout"                 │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Circuit Breaker Manager          │
│  - Catch: Handler error from analytics-subscription-xyz │
│  - Record failure #1                                     │
│  - Threshold: 3 consecutive failures                    │
│                                                          │
│  (Next event dispatch to same handler)                  │
│  - Handler fails again - failure #2                     │
│                                                          │
│  (Next event dispatch)                                  │
│  - Handler fails again - failure #3                     │
│  - Threshold reached!                                   │
│  - Action: Open circuit breaker                         │
│  - Status: OPEN                                          │
│  - Set nextRetry: now + 30 seconds                      │
│  - Fire: notification:circuit-opened                    │
│    Payload: { subscriptionId, subsystemId: 'analytics' }│
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  LOGGER - Subscriber to circuit-opened                  │
│  - Receive: Circuit opened for analytics subscription   │
│  - Log: HIGH severity error                             │
│  - Fire: logger:critical-error                          │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Dispatcher                 │
│  - Subsequent events for analytics handler:             │
│  - Check circuit: OPEN                                   │
│  - Skip handler execution (fail fast)                   │
│  - Log: Handler skipped due to open circuit             │
│                                                          │
│  (After 30 seconds)                                     │
│  - Time reached: nextRetry                              │
│  - Transition: OPEN → HALF_OPEN                         │
│  - Next event: Attempt handler execution                │
│  - Result: Success!                                     │
│  - Success count: 1 / 3 required                        │
│                                                          │
│  (Next event)                                           │
│  - Result: Success! (2/3)                               │
│                                                          │
│  (Next event)                                           │
│  - Result: Success! (3/3)                               │
│  - Threshold met: Close circuit                         │
│  - Transition: HALF_OPEN → CLOSED                       │
│  - Fire: notification:circuit-closed                    │
│  - Reset: Error counters                                │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Queue Manager              │
│  - Queue processed down to 2000 / 10000 (20%)           │
│  - Below threshold: Release backpressure                │
│  - Set: backpressureActive = false                      │
│  - Fire: notification:backpressure-released             │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Subscriber to backpressure-released     │
│  - Update: platformStatus = IDLE                        │
│  - Fire: global-state:platform-status-changed           │
│  - Remove pending token                                 │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE - Subscriber to platform-status-changed  │
│  - Receive: Platform is IDLE                            │
│  - Resume: Accepting all event priorities               │
│  - Process: Queued LOW/MEDIUM events                    │
│  - Fire: queue:resumed                                  │
└─────────────────────────────────────────────────────────┘
```

---

#### Flow 4: Platform Shutdown Sequence

```
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Initiate Shutdown                       │
│  - Trigger: User closes tab / Manual shutdown           │
│  - Set: platformStatus = STOPPED                        │
│  - Fire: global-state:shutdown-initiated                │
│  - Add fingerprint: "shutdown-started"                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Queue Manager              │
│  - Receive: global-state:shutdown-initiated             │
│  - Action: Reject all new events                        │
│  - Set: backpressureActive = true                       │
│  - Log: Current queue size for processing               │
│  - Fire: notification:shutdown-acknowledged             │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Dispatcher                 │
│  - Continue dispatching queued events                   │
│  - Set timeout: 5 seconds max for shutdown              │
│  - Process: Drain queue with CRITICAL priority first    │
│  - Track: In-flight handler executions                  │
│                                                          │
│  Queue: 150 events remaining                            │
│  ├─ Dispatch: 50 CRITICAL events                        │
│  ├─ Dispatch: 30 HIGH events                            │
│  ├─ Skip: 70 LOW/MEDIUM events (timeout approaching)    │
│  └─ All handlers: Wait for completion                   │
│                                                          │
│  - Timeout reached: 5 seconds                           │
│  - Abort: Remaining in-flight handlers                  │
│  - Status: SHUTDOWN                                      │
│  - Fire: notification:dispatch-stopped                  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Event Registry Manager           │
│  - Export: Event registry snapshot                      │
│  - Count: Total events registered                       │
│  - Count: Total subscriptions active                    │
│  - Data: Event usage statistics                         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Performance Monitor              │
│  - Calculate: Final metrics                             │
│  - Export: Performance report                           │
│    - Events dispatched total: 45,892                    │
│    - Average dispatch time: 2.3ms                       │
│    - Error rate: 0.02%                                  │
│    - Peak queue size: 8750                              │
│  - Fire: notification:final-metrics                     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  STORAGE MANAGER - Subscriber to final-metrics          │
│  - Receive: Final metrics from Notification Center      │
│  - Persist: Event registry snapshot                     │
│  - Persist: Performance metrics                         │
│  - Persist: Event history (last 1000)                   │
│  - Return: storage:persist-complete                     │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  NOTIFICATION CENTER - Lifecycle Manager                │
│  - Receive: storage:persist-complete                    │
│  - Destroy: Features in reverse order                   │
│    ├─ Event Dispatcher (DESTROYED)                      │
│    ├─ Performance Monitor (DESTROYED)                   │
│    ├─ Correlation Tracker (DESTROYED)                   │
│    ├─ Circuit Breaker Manager (DESTROYED)               │
│    ├─ Event Validator (DESTROYED)                       │
│    ├─ Event Queue Manager (DESTROYED)                   │
│    ├─ Subscription Manager (DESTROYED)                  │
│    └─ Event Registry Manager (DESTROYED)                │
│                                                          │
│  - Unsubscribe: All event listeners                     │
│  - Clear: All state maps and registries                 │
│  - Final log: Shutdown complete                         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  MESSAGE QUEUE - Direct communication                   │
│  - Send: notification:shutdown-complete                 │
│    (Bypasses Notification Center since it's destroyed)  │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  GLOBAL STATE - Shutdown Coordinator                    │
│  - Receive: notification:shutdown-complete              │
│  - Mark: Notification Center destroyed                  │
│  - Continue: Shutdown other subsystems                  │
└─────────────────────────────────────────────────────────┘
```

---

### Special Considerations

#### 1. Event Ordering & Consistency

**Challenge**: Events must be dispatched in strict order while maintaining high throughput.

**Solution**:
- Priority queue ensures CRITICAL events dispatch first
- Within same priority, FIFO ordering maintained
- Sequential dispatch to same subscriber preserves causality
- Correlation IDs track event chains across subsystems

**Implementation**:
```javascript
class PriorityQueue {
  constructor() {
    this.queues = {
      CRITICAL: [],
      HIGH: [],
      MEDIUM: [],
      LOW: []
    };
  }
  
  enqueue(event) {
    this.queues[event.importance].push(event);
  }
  
  dequeue() {
    // Always dequeue from highest priority first
    for (const priority of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
      if (this.queues[priority].length > 0) {
        return this.queues[priority].shift(); // FIFO within priority
      }
    }
    return null;
  }
}
```

---

#### 2. Performance Optimization

**Challenge**: Event dispatch is on critical path for all subsystem communication.

**Optimizations**:
- **Async Handlers**: Non-blocking handler execution with Promise.all
- **Handler Caching**: Cache subscription lookups by eventId
- **Batch Dispatch**: Process multiple events per loop iteration
- **Lazy Validation**: Only validate when explicitly enabled
- **Event Pooling**: Reuse event objects to reduce GC pressure

**Example**:
```javascript
async function dispatchEvent(event) {
  // Cached subscription lookup
  const subscriptions = subscriptionCache.get(event.eventId);
  
  if (!subscriptions || subscriptions.length === 0) {
    return; // Fast path: no subscribers
  }
  
  // Parallel handler execution
  const handlers = subscriptions.map(sub => {
    return executeHandler(sub, event.payload, event.metadata)
      .catch(error => recordHandlerError(sub, error));
  });
  
  await Promise.allSettled(handlers); // Don't block on individual failures
}
```

---

#### 3. Memory Management

**Challenge**: Event history and correlation data can grow unbounded.

**Memory Controls**:
- **Circular Buffers**: Fixed-size history (last 1000 events)
- **TTL Expiration**: Auto-cleanup old correlations
- **Payload Sanitization**: Remove sensitive data from history
- **Subscription Limits**: Max subscriptions per event
- **Queue Capacity**: Hard limit on queue size

**Example**:
```javascript
class CircularBuffer {
  constructor(maxSize) {
    this.buffer = new Array(maxSize);
    this.index = 0;
    this.size = 0;
    this.maxSize = maxSize;
  }
  
  add(item) {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.maxSize;
    this.size = Math.min(this.size + 1, this.maxSize);
  }
  
  getAll() {
    if (this.size < this.maxSize) {
      return this.buffer.slice(0, this.size);
    }
    return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)];
  }
}
```

---

#### 4. Error Isolation & Recovery

**Challenge**: Handler failures must not crash the dispatcher or affect other handlers.

**Resilience Mechanisms**:
- **Try-Catch Isolation**: Each handler wrapped in try-catch
- **Circuit Breakers**: Auto-disable failing handlers
- **Error Rate Limiting**: Throttle error notifications
- **Graceful Degradation**: Continue dispatch even if some handlers fail
- **Handler Timeouts**: Kill long-running handlers

**Example**:
```javascript
async function executeHandler(subscription, payload, metadata) {
  const { handler, subscriptionId } = subscription;
  
  // Check circuit breaker
  if (!shouldExecuteHandler(subscriptionId)) {
    return; // Circuit is open, skip execution
  }
  
  try {
    // Execute with timeout
    await Promise.race([
      handler(payload, metadata),
      timeout(notificationConfig.maxHandlerExecutionTime)
    ]);
    
    // Record success
    CircuitBreakerManager.recordSuccess(subscriptionId);
    
  } catch (error) {
    // Record failure
    CircuitBreakerManager.recordFailure(subscriptionId, error);
    
    // Emit error event
    fireEvent('notification:handler-error', {
      subscriptionId,
      error: sanitizeError(error),
      eventId: metadata.eventId
    });
  }
}
```

---

#### 5. Debugging & Observability

**Challenge**: Debugging event flows across multiple subsystems is complex.

**Observability Tools**:
- **Event History**: Circular buffer of recent events
- **Correlation Tracking**: Link related events across subsystems
- **Performance Metrics**: Real-time dispatch metrics
- **Handler Profiling**: Track execution time per handler
- **Circuit Breaker Dashboard**: Monitor handler health
- **Event Replay**: Reconstruct event sequences

**Example**:
```javascript
function exportDebugBundle() {
  return {
    // Current state
    dispatchState,
    queueSize: eventQueue.size(),
    activeSubscriptions: Array.from(subscriptions.values()).flat().length,
    
    // Event history
    recentEvents: eventHistory.getAll(),
    
    // Correlation chains
    activeCorrelations: Array.from(correlationRegistry.values())
      .filter(c => c.status === 'ACTIVE'),
    
    // Circuit breakers
    openCircuits: Array.from(errorTracking.circuitBreakers.values())
      .filter(cb => cb.status === 'OPEN'),
    
    // Performance
    metrics: performanceMetrics,
    
    // Event registry
    registeredEvents: Array.from(eventRegistry.values()),
    
    timestamp: Date.now()
  };
}
```

---

#### 6. Security & Access Control

**Challenge**: Prevent unauthorized event firing or subscription.

**Security Measures**:
- **Permission Tokens**: Validate tokens for privileged events
- **Event ACLs**: Control which subsystems can fire which events
- **Payload Sanitization**: Strip sensitive data from logs
- **Subscription Limits**: Prevent subscription DoS attacks
- **Audit Trail**: Log all privileged operations

**Example**:
```javascript
function fireEvent(eventId, payload, metadata = {}) {
  const eventDef = eventRegistry.get(eventId);
  
  // Check if event requires elevated permissions
  if (eventDef.requiresPermission) {
    const token = metadata.permissionToken;
    
    if (!validatePermission(token, eventDef.requiredPermissionLevel)) {
      throw new PermissionError(
        `Insufficient permissions to fire event: ${eventDef.eventName}`
      );
    }
    
    // Audit log
    Logger.log({
      action: 'privileged-event-fired',
      eventId,
      eventName: eventDef.eventName,
      userId: extractUserId(token),
      timestamp: Date.now()
    });
  }
  
  // Proceed with event dispatch
  enqueueEvent({ eventId, payload, metadata });
}
```

---

#### 7. Testing & Validation

**Challenge**: Testing event flows requires coordinating multiple subsystems.

**Testing Strategies**:
- **Event Mocking**: Mock event firing for unit tests
- **Handler Spies**: Verify handler invocations
- **Queue Inspection**: Assert queue state during tests
- **Performance Tests**: Load test with high event volume
- **Chaos Testing**: Inject handler failures randomly
- **Integration Tests**: Test complete event chains

**Example**:
```javascript
// Test helper for mocking events
class EventTestHelper {
  constructor() {
    this.firedEvents = [];
    this.handlerCalls = new Map();
  }
  
  // Mock event firing
  mockFireEvent(eventId, payload, metadata) {
    this.firedEvents.push({ eventId, payload, metadata, timestamp: Date.now() });
  }
  
  // Spy on handler
  spyOnHandler(subscriptionId, handler) {
    const spy = jest.fn(handler);
    this.handlerCalls.set(subscriptionId, spy);
    return spy;
  }
  
  // Assert event was fired
  assertEventFired(eventId, times = 1) {
    const count = this.firedEvents.filter(e => e.eventId === eventId).length;
    expect(count).toBe(times);
  }
  
  // Assert handler was called
  assertHandlerCalled(subscriptionId, times = 1) {
    const spy = this.handlerCalls.get(subscriptionId);
    expect(spy).toHaveBeenCalledTimes(times);
  }
  
  // Reset for next test
  reset() {
    this.firedEvents = [];
    this.handlerCalls.clear();
  }
}
```

---

### Summary

This comprehensive redesign of the Notification Center subsystem:

1. **Aligns with established patterns** from Global State, Network Request, Storage, Auth, and Sync managers
2. **Provides detailed specifications** for all components (States, Features, Message Packets, Worker, etc.)
3. **Illustrates inter-subsystem communication** with comprehensive flow diagrams showing:
   - Simple event dispatch
   - Correlation tracking across subsystems
   - Backpressure and circuit breaking
   - Graceful shutdown coordination
4. **Addresses special considerations** around performance, memory management, error isolation, observability, security, and testing
5. **Establishes Notification Center as the backbone** for all event-driven inter-subsystem communication

The design emphasizes:
- **Reliability**: Guaranteed event delivery with retry and circuit breaking
- **Performance**: Optimized for high-throughput event dispatch
- **Observability**: Comprehensive tracking of event flows and handler performance
- **Resilience**: Graceful degradation and error recovery mechanisms
- **Decoupling**: Loose coupling between subsystems through events
- **Scalability**: Handles high event volumes with backpressure management