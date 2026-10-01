# Analytics Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **LOW** - Telemetry is useful, never essential.

The Analytics Manager collects performance, health, and usage metrics. It batches
them, flushes them to the server, and respects consent. It is the manager every
other manager reports to, but no manager depends on it.

---

## States

- **metricsRegistry**: `Map<name, Metric>` - counters, gauges, and histograms
  ```typescript
  type Metric =
    | { kind: 'counter'; value: number }
    | { kind: 'gauge'; value: number }
    | { kind: 'histogram'; buckets: number[]; count: number };
  ```
- **sessionStats**: `{ startTime: number; events: number; errors: number }`.
- **analyticsConfig**: `{ endpoint: string; batchSize: number; flushInterval: number; sampleRate: number }`.

---

## Features

### Metric Collector
**Purpose**: Record metrics.  
**Responsibilities**:
- Increment counters, set gauges, and fill histograms.
- **Weight**: MEDIUM.

### Event Tracker
**Purpose**: Track usage events.  
**Responsibilities**:
- Record an event with a name and properties.
- Respect sampling.
- **Weight**: MEDIUM.

### Aggregator
**Purpose**: Roll up metrics.  
**Responsibilities**:
- Compute totals, averages, and percentiles before flush.
- **Weight**: LOW.

### Flusher
**Purpose**: Send metrics to the server.  
**Responsibilities**:
- Batch metrics and flush on an interval.
- Queue offline and flush on reconnect.
- Respect consent and data-saver.
- **Weight**: MEDIUM.

---

## Life Cycle Manager

### Initialization Sequence
1. Read `analyticsConfig` from Global State.
2. Check consent. If analytics is not granted, stay idle.
3. Subscribe to `global:network-status-changed` to flush on reconnect.
4. Start the flush timer.
5. Log initialization complete.

### Destruction Sequence
1. Stop the flush timer.
2. Flush once more if the tab closes abruptly (via `sendBeacon`).
3. Log shutdown complete.

---

## Worker

**Type**: Physical Worker (dedicated worker default, virtual worker fallback).

Aggregation and serialization can run off the main thread. A dedicated worker is
the default. A virtual worker on the main thread is the fallback.

### Receiver
- Receives increment, record, and flush commands.

### Processor
- **Aggregation Processor**: rolls up metrics.
- **Serialization Processor**: builds the payload.

### Dispatcher
- Sends the payload through Network.
- Reports flush failures to the Logger.

---

## Dependencies

Ordered by initialization priority:

1. **Global State** (LOW) - configuration and health.
2. **Consent** (HIGH) - gate collection and flush.
3. **Network** (MEDIUM) - send the payload.
4. **Storage** (LOW) - the offline queue.
5. **Logger** (LOW) - report flush failures.

### Functional Predicates

```javascript
function shouldCollect() {
  return consent.isGranted('analytics') && Math.random() < analyticsConfig.sampleRate;
}

function shouldFlush() {
  return consent.isGranted('analytics') && globalState.isOnline();
}
```

---

## Control Interface

### Getters (No-arg)
- `getMetrics(): Metric[]`.
- `getSessionStats(): unknown`.

### Actions
- `increment(name, amount?): void`.
- `recordGauge(name, value): void`.
- `recordHistogram(name, value): void`.
- `trackEvent(name, properties?): void`.
- `flush(): Promise<void>`.

### Subscriptions
- `global:network-status-changed` - flush on reconnect.
- `consent:changed` - start or stop collection.

---

## Message Packets

```typescript
export interface BasePacket<P, R = any> {
  eventId: symbol;
  actionName: string;
  payload: P;
  importance: 'LOW';
  onComplete: (result: R) => void;
  onError: (error: Error) => void;
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
  fingerprints: Fingerprint[];
}

export interface MetricsPayload {
  metrics: Array<{ name: string; kind: string; value: number }>;
  sessionId: string;
  timestamp: number;
}
export type MetricsPacket = BasePacket<MetricsPayload, void>;
// Event ID: analytics:metrics | Importance: LOW | Broadcast: No

export type AnalyticsPacket = MetricsPacket;
```

---

## Special Considerations

### Consent first
Collection and flush both check consent. If analytics is not granted, the manager
stays idle and collects nothing.

### Batching
Metrics flush in batches, not one request per event. This conserves bandwidth and
matches the data-saver requirement.

### Offline queue
When offline, metrics queue in Storage. They flush on reconnect.

### Sampling
The sample rate caps collection volume. Low-value events drop when the rate is
below one.

### Shutdown
On abrupt shutdown, the manager flushes a final batch with `sendBeacon`.

---

## Summary

The Analytics Manager collects metrics, batches them, and flushes them with
consent and sampling. It is featurized and LOW. It is the sink of the platform,
not a dependency. Its reliability guarantee is that telemetry never slows the
app: it batches, samples, and gates on consent.
