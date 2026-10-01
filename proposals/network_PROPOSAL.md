# Network Manager

## Initial Proposal

### States

The state object for the Network Request Manager subsystem contains:

- **importance/priority/weight**: `CRITICAL` - Network operations are fundamental to all data-dependent subsystems
- **requestRegistry**: Map of active request IDs to their metadata and AbortController instances
  ```javascript
  {
    requestId: {
      url: string,
      method: string,
      abortController: AbortController,
      promise: Promise<Response>,
      startTime: number,
      retryCount: number,
      priority: number,
      subsystemId: string,
      status: 'PENDING' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED' | 'ABORTED'
    }
  }
  ```
- **cacheRegistry**: Map tracking cached responses and their metadata
  ```javascript
  {
    cacheKey: {
      url: string,
      method: string,
      cachedAt: number,
      expiresAt: number,
      etag: string | null,
      size: number,
      hitCount: number
    }
  }
  ```
- **requestQueue**: Priority queue for pending requests when throttling is active
- **connectionStatus**: Current network connection state
  ```javascript
  {
    type: 'none' | 'wifi' | 'cellular' | '2g' | '3g' | '4g' | '5g' | 'ethernet' | 'unknown',
    effectiveType: 'slow-2g' | '2g' | '3g' | '4g',
    downlink: number, // Mbps
    rtt: number, // ms
    saveData: boolean
  }
  ```
- **requestSettings**: Configuration object:
  - **defaultTimeout**: Default request timeout in milliseconds (default: 30000)
  - **maxConcurrentRequests**: Maximum simultaneous requests (default: 6)
  - **maxRetries**: Default maximum retry attempts (default: 3)
  - **retryDelayBase**: Base delay for exponential backoff (ms) (default: 1000)
  - **retryableStatusCodes**: HTTP status codes that trigger retry (default: [408, 429, 500, 502, 503, 504])
  - **cacheStrategy**: Default caching strategy ('no-cache' | 'network-first' | 'cache-first' | 'cache-only' | 'network-only')
  - **cacheTTL**: Default cache time-to-live in milliseconds (default: 300000 - 5 minutes)
  - **compressionEnabled**: Flag for request/response compression
  - **throttleEnabled**: Flag for request throttling
  - **throttleDelay**: Delay between throttled requests (ms)
  - **batchingEnabled**: Flag for request batching
  - **batchWindow**: Time window for collecting batchable requests (ms)
  - **credentialsMode**: Default credentials mode ('omit' | 'same-origin' | 'include')
  - **redirectMode**: Default redirect handling ('follow' | 'error' | 'manual')
- **statistics**: Real-time network statistics
  ```javascript
  {
    totalRequests: number,
    successfulRequests: number,
    failedRequests: number,
    abortedRequests: number,
    cacheHits: number,
    cacheMisses: number,
    averageLatency: number,
    bandwidthUsed: number,
    requestsByMethod: Record<string, number>,
    requestsByStatus: Record<number, number>
  }
  ```
- **rateLimits**: Map of rate limit configurations per endpoint/domain
  ```javascript
  {
    pattern: {
      requestsPerWindow: number,
      windowSize: number, // ms
      currentCount: number,
      windowStart: number
    }
  }
  ```
- **interceptors**: Registered request/response interceptors
  ```javascript
  {
    request: Array<(config) => config | Promise<config>>,
    response: Array<(response) => response | Promise<response>>,
    error: Array<(error) => error | Promise<error>>
  }
  ```
- **pendingBatches**: Map of batch IDs to pending batchable requests

### Features

#### Request Manager

- Creates and manages fetch requests
- Assigns unique IDs to each request
- Maintains AbortController instances
- Tracks request lifecycle and status
- Implements request deduplication
- **Weight**: HIGH - Core request handling

#### Cache Manager

- Implements Cache API integration
- Manages cache strategies (network-first, cache-first, etc.)
- Handles cache invalidation and expiration
- Implements ETags and conditional requests
- Provides cache statistics and monitoring
- Manages cache storage limits
- **Weight**: HIGH - Performance critical

#### Retry Manager

- Implements exponential backoff for failed requests
- Tracks retry attempts per request
- Distinguishes retryable vs non-retryable errors
- Manages retry queue and scheduling
- Implements circuit breaker pattern
- **Weight**: MEDIUM - Resilience

#### Request Queue Manager

- Manages priority queue of pending requests
- Implements request throttling
- Handles concurrent request limits
- Schedules requests based on priority and conditions
- Implements request cancellation and cleanup
- **Weight**: MEDIUM - Traffic management

#### Connection Monitor

- Monitors network connection via Navigator API
- Tracks connection quality and type
- Detects online/offline transitions
- Estimates bandwidth and latency
- Adapts request behavior to connection quality
- **Weight**: MEDIUM - Adaptive behavior

#### Batch Processor

- Groups similar requests into batches
- Implements batching strategies per endpoint
- Manages batch windows and thresholds
- Handles batch splitting and optimization
- Processes batch responses and distribution
- **Weight**: LOW - Optimization

#### Rate Limiter

- Enforces rate limits per endpoint/domain
- Implements token bucket or sliding window algorithms
- Queues requests exceeding limits
- Provides rate limit status and headers
- Configurable per-route rate limiting
- **Weight**: MEDIUM - API compliance

#### Interceptor Manager

- Registers and manages request interceptors
- Executes interceptor chains
- Handles interceptor errors gracefully
- Provides pre-request and post-response hooks
- Enables request/response transformation
- **Weight**: MEDIUM - Extensibility

#### Response Parser

- Parses response bodies (JSON, text, blob, etc.)
- Handles content negotiation
- Implements streaming for large responses
- Validates response schemas
- Handles malformed responses gracefully
- **Weight**: MEDIUM - Data handling

#### Timeout Manager

- Implements request timeouts
- Provides configurable timeout per request
- Handles timeout cleanup
- Distinguishes timeout from network errors
- **Weight**: LOW - Error handling

#### Compression Handler

- Compresses request payloads (gzip, brotli)
- Decompresses response payloads
- Negotiates compression with servers
- Selective compression based on content type
- **Weight**: LOW - Performance enhancement

#### Network Analytics

- Tracks request performance metrics
- Monitors error rates and patterns
- Analyzes cache effectiveness
- Provides bandwidth usage statistics
- Identifies slow endpoints
- Sends data to Analytics Manager
- **Weight**: LOW - Observability

#### Abort Controller Manager

- Manages AbortSignal instances
- Implements request cancellation
- Handles cascading cancellations
- Cleanup of aborted requests
- Groups related requests for bulk abort
- **Weight**: MEDIUM - Resource management

### Life Cycle Manager

#### Initialization Sequence

1. Initialize connection status from Navigator API
2. Register all event IDs with action names in notification center
3. Initialize Cache API and verify browser support
4. Load persisted configuration from Storage Manager:
   - Cache strategies
   - Rate limit configurations
   - Request settings
   - Interceptors
5. Initialize feature components in order:
   - Connection Monitor (first - needed by others)
   - Abort Controller Manager
   - Timeout Manager
   - Compression Handler
   - Cache Manager
   - Retry Manager
   - Rate Limiter
   - Request Queue Manager
   - Batch Processor
   - Request Manager
   - Interceptor Manager
   - Response Parser
   - Network Analytics
6. Subscribe to critical events:
   - Global State online/offline changes
   - Browser visibility changes
   - Network information API changes
7. Initialize default interceptors (auth token injection, error handling)
8. Start connection quality monitoring
9. Restore interrupted requests from previous session (if applicable)
10. Log initialization complete event

#### Destruction Sequence

1. Abort all active requests gracefully
2. Unsubscribe from all notification center events
3. Process pending batches immediately or discard
4. Flush cache statistics
5. Persist current configuration:
   - Rate limit states
   - Cache metadata
   - Request statistics
6. Clear request and cache registries
7. Stop connection monitoring
8. Terminate worker connections
9. Log shutdown complete event

### Worker

The Network Request Manager uses a **Hybrid Worker** approach: Physical Worker for heavy operations with Virtual Worker fallback for lightweight requests.

#### Receiver

- Receives fetch request commands from main thread
- Accepts cache operation requests (get, set, delete, clear)
- Receives abort commands for specific requests or groups
- Accepts configuration updates
- Receives interceptor registration/removal commands
- Accepts batch processing triggers

#### Processor

##### Request Processor

- Validates request configuration
- Applies interceptors to request
- Determines caching strategy
- Checks rate limits and throttling
- Assigns priority and scheduling
- Generates request ID and metadata

##### Fetch Executor

- Executes fetch API calls
- Manages AbortSignal integration
- Handles request timeout
- Implements retry logic with backoff
- Tracks request progress
- Monitors request lifecycle

##### Cache Processor

- Queries Cache API for matching entries
- Evaluates cache freshness and validity
- Stores responses in cache
- Implements cache invalidation rules
- Manages cache size and eviction (LRU)
- Handles conditional requests (ETags, If-Modified-Since)

##### Batch Coordinator

- Collects batchable requests in time window
- Combines requests into batch payloads
- Splits batches exceeding size limits
- Coordinates batch execution
- Distributes batch responses to individual requesters

##### Response Processor

- Parses response based on content type
- Applies response interceptors
- Validates response schemas
- Handles error responses
- Extracts headers and metadata
- Implements streaming for large responses

##### Network Quality Processor

- Analyzes connection metrics
- Computes effective bandwidth
- Predicts request duration
- Adjusts strategies based on quality
- Implements adaptive behavior

##### Statistics Aggregator

- Collects request metrics
- Computes performance statistics
- Tracks cache effectiveness
- Monitors error patterns
- Generates reports for Analytics Manager

#### Dispatcher

- Returns response data to main thread
- Emits progress events for long requests
- Sends cache update notifications
- Posts error events for failed requests
- Emits rate limit warnings
- Sends statistics to Analytics Manager
- Notifies Logger of request lifecycle events
- Broadcasts connection quality changes

#### Additional Worker Requirements

- **Pausable**: Can pause non-critical requests during poor network
- **Resumable**: Resumes paused requests when conditions improve
- **Abortable**: Can abort all or specific requests cleanly
- **Error Handling**:
  - Isolates request errors to prevent system-wide failures
  - Implements graceful degradation
  - Provides detailed error metadata
  - Handles worker crashes with automatic restart
- **Visibility API**:
  - Reduces background request frequency
  - Pauses non-essential requests when hidden
  - Prioritizes critical requests
- **Cleanup Protocols**:
  - Automatic timeout cleanup
  - Aborted request cleanup
  - Memory leak prevention
  - Cache overflow management
  - Orphaned promise handling

#### Virtual Worker Fallback

- Used for simple, quick requests when Physical Worker unavailable
- Implements synchronous request handling
- Limited retry and caching capabilities
- Minimal overhead for small payloads

### Dependencies

Ordered by initialization priority:

1. **Global State** (CRITICAL) - Required for online/offline status, timestamps, auth state
2. **Notification Center** (CRITICAL) - Required for event coordination
3. **Message Queue** (HIGH) - For sending request event packets
4. **Storage Manager** (HIGH) - For cache persistence and configuration
5. **Auth Manager** (HIGH) - For authentication token injection
6. **Logger** (MEDIUM) - For logging network operations
7. **Analytics Manager** (LOW) - For network performance metrics

### Control Interface

#### Getters (No-arg)

- `getActiveRequestCount()` - Returns number of in-flight requests
- `getConnectionStatus()` - Returns current network connection metadata
- `getCacheStatistics()` - Returns cache hit/miss rates and size
- `getRequestStatistics()` - Returns comprehensive request statistics
- `getPendingRequestCount()` - Returns number of queued requests
- `getAverageLatency()` - Returns average request latency
- `getBandwidthUsage()` - Returns total bandwidth consumed
- `isOnline()` - Returns online status (delegates to Global State)
- `getRateLimitStatus(url?)` - Returns rate limit info for URL or all endpoints

#### Setters

- `setDefaultTimeout(ms)` - Updates default request timeout
- `setCacheStrategy(strategy)` - Updates default caching strategy
- `setCacheTTL(ms)` - Updates default cache time-to-live
- `setMaxConcurrentRequests(count)` - Updates concurrent request limit
- `setThrottleEnabled(enabled)` - Enables/disables request throttling
- `setBatchingEnabled(enabled)` - Enables/disables request batching
- `setCompressionEnabled(enabled)` - Enables/disables compression
- `setRateLimit(pattern, limit)` - Configures rate limit for endpoint pattern

#### Actions (Fire events to message queue)

##### Core Request Methods

- `request(config)` - Generic request method

  ```javascript
  config: {
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
    headers?: Record<string, string>,
    body?: any,
    timeout?: number,
    retries?: number,
    priority?: number,
    cacheStrategy?: 'network-first' | 'cache-first' | 'cache-only' | 'network-only',
    cacheTTL?: number,
    skipCache?: boolean,
    batchable?: boolean,
    critical?: boolean,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal
  }
  ```

- `get(url, config?)` - GET request shorthand
- `post(url, data, config?)` - POST request shorthand
- `put(url, data, config?)` - PUT request shorthand
- `patch(url, data, config?)` - PATCH request shorthand
- `delete(url, config?)` - DELETE request shorthand

##### Request Management

- `abortRequest(requestId)` - Aborts specific request
- `abortAllRequests()` - Aborts all active requests
- `abortRequestsBySubsystem(subsystemId)` - Aborts requests from specific subsystem
- `retryRequest(requestId)` - Manually retries failed request

##### Cache Management

- `getCacheEntry(key)` - Retrieves cached response
- `setCacheEntry(key, response, ttl?)` - Manually caches response
- `invalidateCache(pattern?)` - Invalidates cache entries matching pattern
- `clearCache()` - Clears entire cache
- `purgeStaleCacheEntries()` - Removes expired cache entries

##### Interceptor Management

- `addRequestInterceptor(fn)` - Adds request interceptor
- `addResponseInterceptor(fn)` - Adds response interceptor
- `addErrorInterceptor(fn)` - Adds error interceptor
- `removeInterceptor(id)` - Removes specific interceptor

##### Utility Methods

- `downloadFile(url, filename, config?)` - Downloads file with progress
- `uploadFile(url, file, config?)` - Uploads file with progress
- `prefetch(urls)` - Prefetches and caches resources
- `warmCache(urls)` - Warms cache with common requests

#### Subscriptions (Subscribe to notification center events)

- Subscribes to Global State online/offline changes
- Subscribes to Auth Manager token refresh events
- Subscribes to browser visibility changes
- Subscribes to Network Information API changes
- Subscribes to Global State stop events for cleanup

### Message Packets

```typescript
/**
 * Shared Type Definitions
 */
export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
export type CacheStrategy =
  | 'network-first'
  | 'cache-first'
  | 'cache-only'
  | 'network-only'
  | 'no-cache'
export type RequestStatus = 'PENDING' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED' | 'ABORTED'
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
 * 1. Request Packet
 */
export interface RequestPayload {
  requestId: string
  url: string
  method: HTTPMethod
  headers: Record<string, string>
  body: any
  timeout: number
  maxRetries: number
  priority: number
  cacheStrategy: CacheStrategy
  cacheTTL: number | null
  skipCache: boolean
  batchable: boolean
  critical: boolean
  subsystemId: string
  signal: AbortSignal | null
}

export interface RequestResult {
  requestId: string
  status: number
  statusText: string
  headers: Record<string, string>
  data: any
  fromCache: boolean
  latency: number
  timestamp: number
}

export type RequestPacket = BasePacket<RequestPayload, RequestResult>

/**
 * 2. Abort Request Packet
 */
export interface AbortRequestPayload {
  requestId?: string // Specific request
  subsystemId?: string // All requests from subsystem
  abortAll?: boolean // All requests
  reason?: string
}

export type AbortRequestPacket = BasePacket<AbortRequestPayload, { aborted: string[] }>

/**
 * 3. Cache Operation Packet
 */
export interface CacheOperationPayload {
  operation: 'GET' | 'SET' | 'DELETE' | 'CLEAR' | 'INVALIDATE'
  key?: string
  pattern?: string // For invalidate
  value?: any // For set
  ttl?: number // For set
}

export interface CacheOperationResult {
  success: boolean
  value?: any // For get
  keysAffected?: string[] // For delete/invalidate/clear
}

export type CacheOperationPacket = BasePacket<CacheOperationPayload, CacheOperationResult>

/**
 * 4. Request Progress Packet
 */
export interface RequestProgressPayload {
  requestId: string
  loaded: number
  total: number
  progress: number // 0-100
  phase: 'UPLOADING' | 'DOWNLOADING' | 'PROCESSING'
}

export type RequestProgressPacket = BasePacket<RequestProgressPayload, void>

/**
 * 5. Connection Status Packet
 */
export interface ConnectionStatusPayload {
  type: 'none' | 'wifi' | 'cellular' | 'ethernet' | 'unknown'
  effectiveType: 'slow-2g' | '2g' | '3g' | '4g'
  downlink: number // Mbps
  rtt: number // ms
  saveData: boolean
  timestamp: number
}

export type ConnectionStatusPacket = BasePacket<ConnectionStatusPayload, void>

/**
 * 6. Batch Request Packet
 */
export interface BatchRequestPayload {
  batchId: string
  requests: RequestPayload[]
  batchEndpoint: string
  priority: number
}

export interface BatchRequestResult {
  batchId: string
  responses: RequestResult[]
  duration: number
}

export type BatchRequestPacket = BasePacket<BatchRequestPayload, BatchRequestResult>

/**
 * 7. Interceptor Registration Packet
 */
export interface InterceptorPayload {
  operation: 'ADD' | 'REMOVE'
  type: 'REQUEST' | 'RESPONSE' | 'ERROR'
  interceptorId?: string // For remove
  handler?: Function // For add
}

export type InterceptorPacket = BasePacket<InterceptorPayload, { interceptorId: string }>

/**
 * 8. Rate Limit Status Packet
 */
export interface RateLimitStatusPayload {
  url: string
  limit: number
  remaining: number
  reset: number // Timestamp
  retryAfter: number | null // Seconds
}

export type RateLimitStatusPacket = BasePacket<RateLimitStatusPayload, void>

/**
 * Unified Network Packet Type
 */
export type NetworkPacket =
  | RequestPacket
  | AbortRequestPacket
  | CacheOperationPacket
  | RequestProgressPacket
  | ConnectionStatusPacket
  | BatchRequestPacket
  | InterceptorPacket
  | RateLimitStatusPacket
```

### Special Considerations

#### Performance Optimization

- Request deduplication prevents redundant calls
- Intelligent caching reduces network traffic by 60-80%
- Batch processing reduces round trips
- Compression reduces payload sizes
- Connection-aware strategies adapt to network quality
- Concurrent request limiting prevents browser bottlenecks

#### Cache Strategies

**network-first**: Fetch from network, fallback to cache on failure
**cache-first**: Check cache first, fetch from network if miss
**cache-only**: Only use cache, fail if not cached
**network-only**: Always fetch from network, bypass cache
**no-cache**: Same as network-only but validates with server

#### Error Handling

- Comprehensive error categorization (network, timeout, server, etc.)
- Automatic retry with exponential backoff
- Circuit breaker prevents cascading failures
- Fallback strategies for degraded service
- Detailed error metadata for debugging

#### Security

- CORS handling and validation
- Credential management (cookies, auth tokens)
- Content Security Policy compliance
- Request sanitization and validation
- Response validation against schemas
- XSS and injection prevention in payloads

#### Offline Support

- Queue requests when offline
- Replay queued requests when online
- Optimistic updates with eventual consistency
- Background sync integration
- Service Worker coordination

#### Developer Experience

- Promise-based API
- Async/await support
- Progress callbacks for uploads/downloads
- Request/response interceptors for extensibility
- Comprehensive error messages
- Request retry and abort control
- TypeScript definitions

#### Browser Compatibility

- Fetch API with polyfill fallback
- AbortController with polyfill
- Cache API with fallback to memory cache
- Network Information API with graceful degradation
- Feature detection for all APIs
