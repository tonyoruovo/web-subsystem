# @webkrnl/analytics

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/analytics) and [JSR](https://jsr.io/@webkrnl/analytics).

The **Analytics** subsystem (id `analytics`, featurized, Tab scope, requires Consent). It collects metrics and usage events, and sends them in batches. It is the sink of the platform: units report to it, and no unit depends on it.

- **Consent first**: nothing is collected without the `analytics` grant of Consent. A revoke deletes the buffer and every waiting batch.
- **Sampling by session**: `sampleRate` is decided once for each session, so a sampled session is complete.
- **Metrics**: counters, gauges, histograms (with count, sum, min, max, p50, p90, p99) and events.
- **Batches**: they go out when `batchSize` events wait, every `flushIntervalMs`, or on `flush()`. Each batch has an id, sent as `Idempotency-Key`, so a batch sent twice counts once.
- **Offline**: a batch that cannot go out waits in the outbox (in Storage, `analytics.outbox`, when Storage runs), and goes out when the platform is online.
- **When the page hides**: the last batches go with `navigator.sendBeacon`.
- **The data saver**: with `dataSaver` or a `bandwidthMode` that is not `FULL` (Settings), batches go out only when full or when the page hides.

It runs on the main thread. The proposal asked for a worker, but the beacon in `pagehide` must build its payload at once, and the work is small. Design: [ARCHITECTURE §21.3](../../docs/ARCHITECTURE.md#213-analytics) and the [Analytics proposal](../../docs/proposals/analytics_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/consent": "workspace:*",
    "@webkrnl/analytics": "workspace:*"
  }
}
```

## Entry points

| Import               | Contents                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `@webkrnl/analytics` | `createAnalytics`, `summarize`, `ANALYTICS_ID`, `ANALYTICS_OUTBOX`, types |

## Usage

```ts
import { createAnalytics, type AnalyticsControl } from '@webkrnl/analytics';

const kernel = new Kernel(
  [
    ...centralized,
    createConsent(),
    createSettings(),
    createNetwork(),
    createStorage({ keys }),
    createAnalytics({ endpoint: '/t/batch', sampleRate: 0.25 }),
  ],
  { router: queue.router },
);
await kernel.start();

const analytics = kernel.unit<AnalyticsControl>('analytics').control!;
analytics.commands.increment('page.view');
analytics.commands.histogram('route.ms', duration);
analytics.commands.track('purchase', { plan: 'pro' });
```

The server gets `POST /t/batch` with an `Idempotency-Key` header and a JSON `AnalyticsBatch`:

```json
{
  "id": "6f1c…",
  "sessionId": "0b8f…",
  "createdAt": 1767225600000,
  "counters": { "page.view": 3 },
  "gauges": { "cart.size": 4 },
  "histograms": {
    "route.ms": { "count": 4, "sum": 595, "min": 80, "max": 300, "p50": 95, "p90": 300, "p99": 300 }
  },
  "events": [{ "name": "purchase", "properties": { "plan": "pro" }, "timestamp": 1767225599000 }]
}
```

A beacon has the same body. Drop a batch whose id you have seen.

## Behaviour

| Situation                                                    | Result                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| No `analytics` grant (undecided, or revoked)                 | Recording does nothing. `collecting: false`                                                         |
| The session is not in the sample                             | Recording does nothing for the whole session                                                        |
| The grant is revoked                                         | The buffer and the outbox (memory and Storage) are deleted                                          |
| `batchSize` events wait, the interval passes, or `flush()`   | The buffer becomes a batch in the outbox, and the outbox is sent in order                           |
| A send fails                                                 | The batch stays (`lastError`); the next flush sends the same batch, with the same id                |
| Offline (Global State, or `navigator.onLine`)                | Batches wait; they go out when the platform is online                                               |
| The outbox has `maxStored` batches                           | The oldest is dropped (`dropped`)                                                                   |
| A reload with Storage                                        | Waiting batches come back, and go out with the grant                                                |
| The page hides (`pagehide`, or `visibilitychange` to hidden) | Each batch goes with `sendBeacon` to `endpoint`. With only `send`, the outbox is sent the usual way |
| Data saver on, or `bandwidthMode` not `FULL`                 | No interval: batches go out when full or when the page hides                                        |
| Sign-out, or another user signs in (ARCHITECTURE §5.1)       | The buffer and the outbox are deleted, and a new session (and sample) starts                        |

## Options

| Option                    | Default                                           | Purpose                                                                                |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `endpoint`                | none                                              | The URL that receives batches (`POST`, and beacons).                                   |
| `send(batch)`             | none                                              | Sends a batch another way, for example a vendor SDK. `endpoint` or `send` is required. |
| `batchSize`               | `50`                                              | Events that make a batch go out.                                                       |
| `flushIntervalMs`         | `30000`                                           | The time between batches.                                                              |
| `sampleRate`              | `1`                                               | The part of sessions that collect (0 to 1).                                            |
| `maxStored`               | `100`                                             | Batches that wait to be sent.                                                          |
| `maxHistogramValues`      | `1000`                                            | Values of one histogram in one batch.                                                  |
| `now`, `random`, `beacon` | `Date.now`, `Math.random`, `navigator.sendBeacon` | For tests.                                                                             |

## Testing

```bash
pnpm exec vitest run --project node packages/analytics
```
