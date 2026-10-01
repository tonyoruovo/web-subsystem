# Consent Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **MEDIUM** - It gates telemetry and beacons, but it is not on the failure-critical path.

The Consent Manager records what the user agrees to, and it enforces that
agreement. It gates analytics and beacons by category, enforces data retention,
and supports data-subject requests. It is the enforcement point for the
"intentionality on the user" requirement.

---

## States

- **consentState**: `Map<category, ConsentRecord>` - the current grants
  ```typescript
  type ConsentCategory = 'necessary' | 'functional' | 'analytics' | 'marketing';

  interface ConsentRecord {
    category: ConsentCategory;
    granted: boolean;
    timestamp: number;
    policyVersion: number;   // re-ask when this changes
  }
  ```
- **retentionRules**: `Map<ConsentCategory, { ttl: number | null; minimize: boolean }>`.
- **consentConfig**: `{ policyVersion: number; defaultCategory: ConsentCategory }`.

---

## Features

### Consent Registry
**Purpose**: Record grants and revocations.  
**Responsibilities**:
- Grant and revoke per category.
- Keep `necessary` always granted.
- Persist the grants through Storage.
- **Weight**: HIGH.

### Policy Enforcer
**Purpose**: Gate telemetry and beacons.  
**Responsibilities**:
- Answer `isGranted(category)`.
- Block analytics and beacon flushes for ungranted categories.
- **Weight**: HIGH.

### Retention Manager
**Purpose**: Enforce retention and minimization.  
**Responsibilities**:
- Delete stored data whose category TTL has passed.
- Minimize stored data to what the grant allows.
- **Weight**: MEDIUM.

### Data-Subject Requests
**Purpose**: Export and erase user data.  
**Responsibilities**:
- Collect the user's stored data for export.
- Erase the user's stored data on request.
- **Weight**: MEDIUM.

---

## Life Cycle Manager

### Initialization Sequence
1. Read the persisted grants from Storage.
2. Re-ask the user if `policyVersion` changed.
3. Register `consent:granted` and `consent:revoked` events.
4. Log initialization complete (grant count, never the grants themselves).

### Destruction Sequence
1. Persist the current grants.
2. Unsubscribe from events.
3. Log shutdown complete.

---

## Worker

**Type**: Virtual Worker (main thread).

Consent checks must be synchronous and cheap. A worker round-trip would add
latency to every beacon and analytics write. The operative runs on the main
thread.

---

## Dependencies

Ordered by initialization priority:

1. **Global State** (MEDIUM) - configuration.
2. **Storage** (MEDIUM) - persist grants.
3. **Logger** (LOW) - audit grant and revocation.

### Functional Predicates

```javascript
function isGranted(category) {
  if (category === 'necessary') return true;
  const record = consentState.get(category);
  return record && record.granted && record.policyVersion === consentConfig.policyVersion;
}

function shouldFlushBeacon(category) {
  return isGranted(category) && !globalState.isMaintenanceMode();
}
```

---

## Control Interface

### Getters (No-arg)
- `isGranted(category): boolean`.
- `getConsent(): ConsentRecord[]`.
- `getPolicyVersion(): number`.

### Actions
- `grant(category): void`.
- `revoke(category): void`.
- `grantAll(): void`.
- `revokeAll(): void` - keeps `necessary` granted.
- `exportData(): Promise<unknown>`.
- `eraseData(): Promise<void>`.

### Subscriptions
- `consent:policy-version-changed` - re-ask the user.

---

## Message Packets

```typescript
export interface BasePacket<P, R = any> {
  eventId: symbol;
  actionName: string;
  payload: P;
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  onComplete: (result: R) => void;
  onError: (error: Error) => void;
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
  fingerprints: Fingerprint[];
}

export interface ConsentChangePayload {
  category: string;
  granted: boolean;
  timestamp: number;
}
export type ConsentChangePacket = BasePacket<ConsentChangePayload, void>;
// Event ID: consent:changed | Importance: MEDIUM | Broadcast: Yes

export type ConsentPacket = ConsentChangePacket;
```

---

## Special Considerations

### Necessary is always granted
The `necessary` category cannot be revoked. Essential use must work with no
consent. This matches the settings requirement: opting out never breaks essential
use.

### Policy versioning
When the policy version changes, the user is asked again. A stale grant does not
count.

### Gating, not blocking
Consent gates analytics and beacons. It never blocks storage, sync, or network
for the `necessary` and `functional` categories.

---

## Summary

The Consent Manager records and enforces user agreement. It gates telemetry by
category, enforces retention, and supports export and erase. It is featurized and
MEDIUM. Its reliability guarantee is that a consent failure fails closed: an
ungranted category stays off.
