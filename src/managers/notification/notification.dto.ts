/**
 * @fileoverview
 * @summary Typed interfaces for the Notification Center subscription model.
 * @description
 * Defines the shapes the Notification Center uses to fan one emission out to
 * many subscribers. The notification center is the SNS pattern. It holds an
 * event registry, a set of subscriptions per event, and a dispatch queue. These
 * types describe the state. The dispatch logic lives in the notification
 * manager.
 *
 * ```text
 *   fireEvent(eventId, payload, metadata)
 *        |
 *        v
 *   eventQueue  (priority, FIFO within priority)
 *        |
 *        v
 *   subscriptions(eventId)  (sorted by priority)
 *        |
 *        v
 *   handlers run, each isolated by a circuit breaker
 *   ```
 *
 * @see {@linkcode Fingerprint}
 * @see {@linkcode Importance}
 * @author MathAid
 */

import type { Fingerprint, Importance } from '../packet.dto';

/**
 * @summary The category an event belongs to.
 */
export type EventCategory =
  'LIFECYCLE' | 'DATA' | 'STATE' | 'ERROR' | 'USER' | 'SYSTEM' | 'NETWORK';

/**
 * @summary Status of the dispatch loop.
 */
export type DispatchStatus = 'IDLE' | 'DISPATCHING' | 'PAUSED' | 'ERROR' | 'SHUTDOWN';

/**
 * @summary A registered event in the notification center.
 * @description
 * Every event is registered once. The registry maps the string `eventId` to an
 * internal symbol for fast in-realm dispatch. The string form is what crosses
 * the wire.
 */
export interface EventDefinition {
  /** Stable string id, for example `auth:login-success`. */
  eventId: string;
  /** Human-readable name. */
  eventName: string;
  /** The manager that owns the event. */
  subsystemId: string;
  /** Category for routing and filtering. */
  category: EventCategory;
  /** Scheduling priority. */
  importance: Importance;
  /** One-line description. */
  description: string;
  /** Optional JSON Schema for payload validation, or `null`. */
  payloadSchema: object | null;
  /** Unix milliseconds when the event was registered. */
  registeredAt: number;
  /** Number of times the event fired. */
  usageCount: number;
  /** Unix milliseconds of the last fire, or `null`. */
  lastFiredAt: number | null;
  /** Rolling average of handler count per fire. */
  averageHandlerCount: number;
}

/**
 * @summary A handler that consumes an event.
 * @description
 * The handler may be synchronous or asynchronous. The dispatcher awaits
 * asynchronous handlers and isolates their failures with a circuit breaker.
 */
export type EventHandler = (payload: unknown, metadata: EventMetadata) => void | Promise<void>;

/**
 * @summary One subscription to one event.
 * @description
 * A manager subscribes a handler to an event. Subscriptions run in priority
 * order. A `filterPredicate` may skip the handler for some payloads. A
 * `maxExecutions` limit supports one-shot subscriptions.
 */
export interface Subscription {
  /** Unique id of the subscription. */
  subscriptionId: string;
  /** The event id this subscription listens to. */
  eventId: string;
  /** The manager that subscribed. */
  subscriberSubsystemId: string;
  /** The handler to run. */
  handler: EventHandler;
  /** Higher runs first. */
  priority: number;
  /** Optional predicate that skips the handler when it returns `false`. */
  filterPredicate: ((payload: unknown) => boolean) | null;
  /** Max executions, or `null` for unlimited. */
  maxExecutions: number | null;
  /** Number of executions so far. */
  executionCount: number;
  /** Unix milliseconds when the subscription was created. */
  subscribedAt: number;
  /** Unix milliseconds of the last execution, or `null`. */
  lastExecutedAt: number | null;
  /** Number of handler errors. */
  errorCount: number;
  /** Whether the subscription is active. */
  enabled: boolean;
}

/**
 * @summary Metadata attached to every fired event.
 * @description
 * Carries the source, correlation, and permission fields. `correlationId` links
 * related events. `causationId` names the event that caused this one. This is
 * what the correlation tracker consumes.
 */
export interface EventMetadata {
  /** The manager that fired the event. */
  sourceSubsystemId: string;
  /** Feature name or `null`. */
  sourceComponentId: string | null;
  /** Id that links this event to its cause chain. */
  correlationId: string;
  /** Id of the event that caused this one, or `null`. */
  causationId: string | null;
  /** Unix milliseconds when the event was created. */
  timestamp: number;
  /** Accumulated fingerprint trail. */
  fingerprints: Fingerprint[];
  /** Optional elevation token for protected events, or `null`. */
  permissionToken: string | null;
  /** Whether this is a retried dispatch. */
  isRetry: boolean;
}

/**
 * @summary An event waiting in the dispatch queue.
 * @description
 * A fired event becomes a queued event. It dispatches in priority order, FIFO
 * within priority. `scheduledFor` supports delayed events.
 */
export interface QueuedEvent {
  /** Unique id of the queued entry. */
  queueId: string;
  /** The event id to dispatch. */
  eventId: string;
  /** The payload to pass to handlers. */
  payload: unknown;
  /** Metadata for correlation and tracing. */
  metadata: EventMetadata;
  /** Scheduling priority. */
  importance: Importance;
  /** Unix milliseconds when the event entered the queue. */
  enqueuedAt: number;
  /** Unix milliseconds to dispatch at, or `null` for immediate. */
  scheduledFor: number | null;
  /** Number of dispatch attempts so far. */
  retryCount: number;
  /** Max retry attempts before the event is dropped. */
  maxRetries: number;
}

/**
 * @summary Status of a per-handler circuit breaker.
 * @description
 * `CLOSED` runs the handler normally. `OPEN` skips the handler (fail fast).
 * `HALF_OPEN` allows one test execution to decide whether to close or reopen.
 */
export type CircuitBreakerStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * @summary The circuit breaker state for one subscription.
 * @description
 * Tracks consecutive handler failures. After `failureThreshold` consecutive
 * failures the breaker opens and skips the handler until `nextRetry`. At that
 * point it moves to `HALF_OPEN` and allows one test.
 */
export interface CircuitBreakerState {
  /** Current status. */
  status: CircuitBreakerStatus;
  /** Consecutive failures since the last success. */
  failureCount: number;
  /** Unix milliseconds of the last failure, or `null`. */
  lastFailure: number | null;
  /** Unix milliseconds when a half-open test may run, or `null`. */
  nextRetry: number | null;
}
