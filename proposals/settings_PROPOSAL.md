# Settings Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **MEDIUM** - It surfaces user preferences and consent, but is not on the failure-critical path.

The Settings Manager holds user-tunable preferences and delegates analytics
opt-out to the Consent manager. It is the state behind the settings page. A
change applies live and never breaks essential use. The `optimisticUpdate`
helper implements the optimistic-UI primitive: apply locally, commit remotely,
and roll back on failure.

---

## States

- **settings**: `{ syncInterval, bandwidthMode, dataSaver }`
  ```typescript
  interface UserSettings {
    syncInterval: number;              // auto-sync interval, milliseconds
    bandwidthMode: 'FULL' | 'CONSERVATIVE' | 'MINIMAL';
    dataSaver: boolean;
  }
  ```

---

## Features

### Preference Store
**Purpose**: Hold user-tunable preferences.  
**Responsibilities**:
- Read and update `syncInterval`, `bandwidthMode`, and `dataSaver`.
- Expose a plain `getSettings()` snapshot.
- **Weight**: MEDIUM.

### Consent Delegation
**Purpose**: Route analytics opt-out to Consent.  
**Responsibilities**:
- `isAnalyticsEnabled()` reads `consent.isGranted('analytics')`.
- `enableAnalytics()` and `disableAnalytics()` grant and revoke through Consent.
- **Weight**: MEDIUM.

### Optimistic Update
**Purpose**: Apply-then-reconcile with rollback.  
**Responsibilities**:
- `optimisticUpdate(apply, commit, rollback)` applies a change optimistically,
  commits remotely, and rolls back locally on failure.
- **Weight**: MEDIUM.

---

## Life Cycle Manager

### Initialization Sequence
1. Read the initial preferences (defaults or persisted overrides).
2. Attach the Consent surface for analytics opt-out.
3. Log initialization complete.

### Destruction Sequence
1. Persist the current preferences.
2. Log shutdown complete.

---

## Worker

**Type**: Virtual Worker (main thread). Preference reads and updates are
synchronous and trivial. No worker is needed.

---

## Dependencies

Ordered by initialization priority:

1. **Consent** (MEDIUM) - analytics opt-out.

### Functional Predicates

```javascript
function isAnalyticsEnabled() {
  return consent.isGranted('analytics');
}
```

---

## Control Interface

### Getters (No-arg)
- `getSettings(): UserSettings`.
- `isAnalyticsEnabled(): boolean`.

### Actions
- `setSyncInterval(ms)`.
- `setBandwidthMode(mode)`.
- `setDataSaver(enabled)`.
- `enableAnalytics()` / `disableAnalytics()`.

---

## Special Considerations

### Opt-out never breaks essential use
Disabling analytics only stops telemetry. Storage, sync, and network for the
`necessary` and `functional` categories are unaffected.

### Live application
A settings change applies immediately. No reload is required.

---

## Summary

The Settings Manager holds user preferences and delegates analytics opt-out to
Consent. It is the state behind the settings page. Its reliability guarantee is
that opting out only disables the opted-out feature. It never breaks essential
use.
