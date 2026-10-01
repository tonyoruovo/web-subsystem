/**
 * @fileoverview
 * @summary The Notification Center manager: one-to-many event fan-out.
 * @description
 * Implements the SNS pattern. A manager fires one event and the center fans it
 * out to every subscriber, in priority order, each isolated by its own circuit
 * breaker. This is the fan-out half of the bus. The point-to-point half is the
 * Message Queue.
 *
 * ```text
 *   fireEvent(eventId, payload)
 *        |
 *        v
 *   event queue (priority, FIFO within priority)
 *        |
 *        v
 *   subscriptions(eventId) (sorted by priority)
 *        |
 *        v
 *   run each handler, isolated by a circuit breaker
 *   ```
 *
 * Same-thread fan-out runs through the in-memory subscription map. The
 * `BroadcastChannel` cross-tab leg re-fires events into other tabs. The string
 * `eventId` is mapped to a symbol internally for fast in-realm lookup.
 *
 * @see {@linkcode EventDefinition}
 * @see {@linkcode Subscription}
 * @author MathAid
 */

import { makeFingerprint, type Importance } from '../packet.dto';

import type {
  CircuitBreakerState,
  DispatchStatus,
  EventDefinition,
  EventHandler,
  EventMetadata,
  QueuedEvent,
  Subscription,
} from './notification.dto';

/**
 * @summary Options for constructing a {@linkcode NotificationCenter}.
 */
export interface NotificationCenterOptions {
  /** Consecutive failures before a breaker opens. Defaults to 3. */
  failureThreshold?: number;
  /** Milliseconds an open breaker waits before a half-open test. Defaults to 30000. */
  resetTimeout?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
}

/**
 * @summary The priority tiers, in dispatch order.
 */
const PRIORITY_ORDER: Importance[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * @summary The Notification Center manager.
 * @description
 * Holds the event registry, the subscription map, the dispatch queue, and a
 * circuit breaker per subscription. One instance serves one realm.
 *
 * @example
 * Example 1: Register, subscribe, and fire an event
 * ```ts
 * const center = new NotificationCenter();
 * center.registerEvent({
 *   eventId: 'auth:login-success',
 *   eventName: 'Login success',
 *   subsystemId: 'auth',
 *   category: 'USER',
 *   importance: 'HIGH',
 *   description: 'Fired when a user signs in.',
 *   payloadSchema: null,
 *   registeredAt: Date.now(),
 *   usageCount: 0,
 *   lastFiredAt: null,
 *   averageHandlerCount: 0,
 * });
 * center.subscribe('auth:login-success', (user) => console.log(user), { priority: 10 });
 * center.fireEvent('auth:login-success', { userId: 'abc' });
 * await center.dispatchOnce();
 * ```
 */
export class NotificationCenter {
  /** @internal string eventId to definition and internal symbol. */
  private readonly events = new Map<string, { definition: EventDefinition; symbol: symbol }>();

  /** @internal eventId to subscriptions, kept sorted by priority descending. */
  private readonly subscriptions = new Map<string, Subscription[]>();

  /** @internal The dispatch queue. */
  private readonly queue: QueuedEvent[] = [];

  /** @internal subscriptionId to circuit breaker. */
  private readonly breakers = new Map<string, CircuitBreakerState>();

  /** @internal The failure threshold. */
  private readonly failureThreshold: number;

  /** @internal The reset timeout in milliseconds. */
  private readonly resetTimeout: number;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /** @internal The current status. */
  private status: DispatchStatus = 'IDLE';

  /**
   * @summary Creates a NotificationCenter.
   * @param {NotificationCenterOptions} [options] The configuration and injectables.
   */
  constructor(options: NotificationCenterOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeout = options.resetTimeout ?? 30_000;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? makeCounter();
  }

  /**
   * @summary Registers an event definition.
   * @description
   * Maps the string `eventId` to an internal symbol for fast in-realm lookup.
   * The string form is what crosses the wire. A duplicate id overwrites.
   *
   * @param {EventDefinition} definition The event definition.
   * @returns {void}
   */
  registerEvent(definition: EventDefinition): void {
    this.events.set(definition.eventId, { definition, symbol: Symbol(definition.eventId) });
  }

  /**
   * @summary True when an event id is registered.
   * @param {string} eventId The id to check.
   * @returns {boolean} `true` when the event is registered.
   */
  hasEvent(eventId: string): boolean {
    return this.events.has(eventId);
  }

  /**
   * @summary Subscribes a handler to an event.
   * @description
   * Adds a subscription and keeps the list sorted by priority descending, so
   * higher priority runs first. The handler runs with the payload and metadata.
   *
   * @param {string} eventId The event to subscribe to.
   * @param {EventHandler} handler The handler to run.
   * @param {object} [options] Subscription options.
   * @param {number} [options.priority=0] Higher runs first.
   * @param {(payload: unknown) => boolean} [options.filterPredicate] Skips the handler when it returns `false`.
   * @param {number} [options.maxExecutions] One-shot limit.
   * @returns {string} The subscription id.
   */
  subscribe(
    eventId: string,
    handler: EventHandler,
    options: {
      priority?: number;
      filterPredicate?: (payload: unknown) => boolean;
      maxExecutions?: number;
    } = {},
  ): string {
    const subscriptionId = this.makeId();
    const subscription: Subscription = {
      subscriptionId,
      eventId,
      subscriberSubsystemId: 'unknown',
      handler,
      priority: options.priority ?? 0,
      filterPredicate: options.filterPredicate ?? null,
      maxExecutions: options.maxExecutions ?? null,
      executionCount: 0,
      subscribedAt: this.now(),
      lastExecutedAt: null,
      errorCount: 0,
      enabled: true,
    };

    const list = this.subscriptions.get(eventId) ?? [];
    list.push(subscription);
    list.sort((a, b) => b.priority - a.priority);
    this.subscriptions.set(eventId, list);
    this.breakers.set(subscriptionId, {
      status: 'CLOSED',
      failureCount: 0,
      lastFailure: null,
      nextRetry: null,
    });

    return subscriptionId;
  }

  /**
   * @summary Removes a subscription by id.
   * @param {string} subscriptionId The id to remove.
   * @returns {void}
   */
  unsubscribe(subscriptionId: string): void {
    for (const [eventId, list] of this.subscriptions) {
      const next = list.filter((s) => s.subscriptionId !== subscriptionId);
      if (next.length !== list.length) {
        this.subscriptions.set(eventId, next);
      }
    }
    this.breakers.delete(subscriptionId);
  }

  /**
   * @summary Fires an event into the dispatch queue.
   * @description
   * Validates the event id, builds the metadata, and enqueues a queued event.
   * An unknown event id is dropped with a warning. This matches best-effort
   * SNS semantics.
   *
   * @param {string} eventId The event to fire.
   * @param {unknown} payload The payload to pass to handlers.
   * @param {Partial<EventMetadata>} [metadata] Optional metadata overrides.
   * @returns {EventMetadata | null} The full metadata built for the event, or
   * `null` when the event id is unknown.
   */
  fireEvent(
    eventId: string,
    payload: unknown,
    metadata: Partial<EventMetadata> = {},
  ): EventMetadata | null {
    const registered = this.events.get(eventId);
    if (!registered) {
      console.warn(`[NotificationCenter] unknown event "${eventId}"`);
      return null;
    }

    const fullMetadata: EventMetadata = {
      sourceSubsystemId: metadata.sourceSubsystemId ?? 'unknown',
      sourceComponentId: metadata.sourceComponentId ?? null,
      correlationId: metadata.correlationId ?? this.makeId(),
      causationId: metadata.causationId ?? null,
      timestamp: metadata.timestamp ?? this.now(),
      fingerprints: metadata.fingerprints ?? [],
      permissionToken: metadata.permissionToken ?? null,
      isRetry: metadata.isRetry ?? false,
    };

    fullMetadata.fingerprints.push(
      makeFingerprint('notification-center', 'enqueued', { timestamp: this.now() }),
    );

    this.queue.push({
      queueId: this.makeId(),
      eventId,
      payload,
      metadata: fullMetadata,
      importance: registered.definition.importance,
      enqueuedAt: this.now(),
      scheduledFor: null,
      retryCount: 0,
      maxRetries: 0,
    });

    registered.definition.usageCount += 1;
    registered.definition.lastFiredAt = this.now();
    return fullMetadata;
  }

  /**
   * @summary Dispatches one queued event to its subscribers.
   * @returns {Promise<boolean>} `true` when an event was dispatched, `false` when the queue was empty.
   */
  async dispatchOnce(): Promise<boolean> {
    const queued = this.popNext();
    if (!queued) return false;

    this.status = 'DISPATCHING';
    const list = this.subscriptions.get(queued.eventId) ?? [];
    for (const subscription of list) {
      await this.runHandler(subscription, queued);
    }
    this.status = 'IDLE';
    return true;
  }

  /**
   * @summary Dispatches every queued event until the queue is empty.
   * @returns {Promise<void>}
   */
  async drain(): Promise<void> {
    while (await this.dispatchOnce()) {
      // keep dispatching until empty
    }
  }

  /**
   * @summary Number of events waiting in the queue.
   * @returns {number} The queue depth.
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * @summary The current dispatch status.
   * @returns {DispatchStatus} The status.
   */
  getStatus(): DispatchStatus {
    return this.status;
  }

  /**
   * @summary The subscriptions for one event, in priority order.
   * @param {string} eventId The event id.
   * @returns {ReadonlyArray<Subscription>} The subscriptions.
   */
  getSubscriptions(eventId: string): ReadonlyArray<Subscription> {
    return this.subscriptions.get(eventId) ?? [];
  }

  /**
   * @summary The circuit breaker state for one subscription.
   * @param {string} subscriptionId The subscription id.
   * @returns {CircuitBreakerState | undefined} The state, or `undefined` when unknown.
   */
  getBreaker(subscriptionId: string): CircuitBreakerState | undefined {
    return this.breakers.get(subscriptionId);
  }

  /**
   * @summary Pops the highest-priority queued event.
   * @returns {QueuedEvent | undefined} The next event, or `undefined` when empty.
   * @internal
   */
  private popNext(): QueuedEvent | undefined {
    for (const priority of PRIORITY_ORDER) {
      const index = this.queue.findIndex((e) => e.importance === priority);
      if (index >= 0) {
        return this.queue.splice(index, 1)[0];
      }
    }
    return undefined;
  }

  /**
   * @summary Runs one subscription's handler for a queued event.
   * @description
   * Applies the filter, the execution limit, and the circuit breaker. Records
   * success or failure on the breaker. A failure that reaches the threshold
   * opens the breaker.
   *
   * @param {Subscription} subscription The subscription to run.
   * @param {QueuedEvent} queued The queued event.
   * @returns {Promise<void>}
   * @internal
   */
  private async runHandler(subscription: Subscription, queued: QueuedEvent): Promise<void> {
    if (!subscription.enabled) return;
    if (
      subscription.maxExecutions !== null &&
      subscription.executionCount >= subscription.maxExecutions
    ) {
      return;
    }
    if (subscription.filterPredicate && !subscription.filterPredicate(queued.payload)) {
      return;
    }

    const breaker = this.breakers.get(subscription.subscriptionId);
    if (breaker && breaker.status === 'OPEN') {
      if (breaker.nextRetry !== null && this.now() < breaker.nextRetry) {
        return; // fail fast
      }
      breaker.status = 'HALF_OPEN';
    }

    subscription.executionCount += 1;
    subscription.lastExecutedAt = this.now();

    try {
      await subscription.handler(queued.payload, queued.metadata);
      queued.metadata.fingerprints.push(
        makeFingerprint('notification-center', 'handler-executed', {
          componentId: subscription.subscriptionId,
          timestamp: this.now(),
        }),
      );
      this.recordSuccess(subscription);
    } catch (error) {
      this.recordFailure(subscription, error);
    }
  }

  /**
   * @summary Records a successful handler execution.
   * @param {Subscription} subscription The subscription.
   * @returns {void}
   * @internal
   */
  private recordSuccess(subscription: Subscription): void {
    const breaker = this.breakers.get(subscription.subscriptionId);
    if (!breaker) return;
    breaker.failureCount = 0;
    breaker.status = 'CLOSED';
    breaker.nextRetry = null;
  }

  /**
   * @summary Records a failed handler execution and opens the breaker if due.
   * @param {Subscription} subscription The subscription.
   * @param {unknown} error The error the handler raised.
   * @returns {void}
   * @internal
   */
  private recordFailure(subscription: Subscription, error: unknown): void {
    subscription.errorCount += 1;
    const breaker = this.breakers.get(subscription.subscriptionId);
    if (!breaker) return;

    breaker.failureCount += 1;
    breaker.lastFailure = this.now();

    if (breaker.failureCount >= this.failureThreshold) {
      breaker.status = 'OPEN';
      breaker.nextRetry = this.now() + this.resetTimeout;
      console.warn(
        `[NotificationCenter] circuit opened for subscription "${subscription.subscriptionId}"`,
        error,
      );
    }
  }
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `id-${++counter}`;
}
