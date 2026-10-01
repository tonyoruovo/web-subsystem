# Tab Count

**Location:** `src/composables/managers/global/tab/tab-count`

Tracks how many browser tabs have the platform open simultaneously. Exposes a mutable `store.count` that updates across all tabs in real time (framework-agnostic; a host framework may wrap it for reactivity). Uses one of three cross-tab communication strategies depending on what the browser supports, selected once at boot and never changed at runtime.

---

## Files

| File | Purpose |
|---|---|
| `tab-count.ts` | `useTabCount()` - lifecycle orchestration, strategy delegation, double-increment guard |
| `tab-count.strategy.ts` | Three strategy implementations: Worker, BroadcastChannel, localStorage |
| `tab-count.worker.ts` | SharedWorker script - the coordinator for `useWorkerStrategy` |
| `index.ts` | Barrel export |

---

## Strategy selection

Selected once in `preInitialize()` and never changed:

```
SharedWorker available?
  YES -> useWorkerStrategy      (preferred)
  NO  -> BroadcastChannel available?
          YES -> useBroadcastStrategy
          NO  -> useSequentialStrategy
```

Capabilities are read from the global support table (`GlobalStore.support`) that the global manager pre-computes at boot. No capability detection happens inside this module.

---

## Architecture

```
Global manager
  │
  ▼
useTab
  │
  ▼
useTabCount(tab: TabOperative)
  │
  ├── preInitialize(globalStore)
  │     └── selects strategy, assigns tab.store.strategy
  │
  ├── bootstrap(tab)
  │     ├── strategy.bootstrap(tab)  <- opens channel / worker / storage handler
  │     ├── pageshow listener        <- tabShow() on page visible / BFCache restore
  │     ├── pagehide listener        <- tabHide() on page hidden / navigation away
  │     └── returns cleanup fn
  │
  ├── show(tab) -> strategy.show(tab) -> INCR -> store.count updated
  └── hide(tab) -> strategy.hide(tab) -> DECR -> store.count updated
```

---

## The three strategies

### `useWorkerStrategy` - SharedWorker

The SharedWorker (`tab-count.worker.ts`) is the single authoritative source of truth. All tabs connect to the same worker instance via MessagePort. The worker holds `state.tabs: Record<tabId, index>` and broadcasts updated counts to every connected port after each INCR or DECR.

**Why this works for cross-tab counting:** the worker process outlives any individual tab. State is never duplicated across tabs - there is exactly one copy, in the worker.

**Lifecycle:**
```
bootstrap()
  -> new TabCountWorker({ name: TAB_COUNTER_CHANNEL })
  -> port.start()
  -> port.onmessage = captureResponse

show(tab) / hide(tab)
  -> postMessage({ type: INCR|DECR, payload: { id: tabId }, metadata: { actionId } })
  -> worker receives, updates state.tabs, broadcasts count to ALL ports
  -> captureResponse resolves the promise via countCallbacks[actionId]

cleanup()
  -> port.close()
  -> countCallbacks cleared
```

**Promise tracking:** every request carries a UUID `actionId`. `registerPromise(actionId, tab, resolve, reject)` stores the resolve/reject pair in `tab.store.countCallbacks`. When the worker response arrives with a matching `actionId`, the promise is resolved and the callbacks are removed.

**Decrement reliability:** `pagehide` is used instead of `beforeunload`. `beforeunload` fires when the page is already tearing down - postMessage to a SharedWorker from a closing port is unreliable at that point. `pagehide` fires earlier in the lifecycle and is also triggered by BFCache navigation (back/forward button), which makes it the correct event for both close and navigation scenarios.

---

### `useBroadcastStrategy` - BroadcastChannel + leader election

**The core problem with naive BroadcastChannel counting:** `BroadcastChannel.postMessage` delivers to every context on the same channel *except the sender*. Each tab also starts with its own empty in-memory state. If Tab B opens and creates its own `tabs: Set`, it counts itself as the only tab and never learns about Tab A.

**The fix - leader election:** one tab owns all state. Others are followers that send requests to the leader.

#### Protocol messages

| Message | Direction | Meaning |
|---|---|---|
| `HELLO` | Any -> All | "I just opened, is there a leader?" |
| `WELCOME` | Leader -> sender | "Yes, here's the current tab list" |
| `INCR` | Follower -> All | "Register me as active" |
| `DECR` | Follower -> All | "Remove me" |
| `COUNT` | Leader -> All | "Updated count after a mutation" |
| `HANDOFF` | Leader -> All | "I'm closing, here's your new leader" |
| `ELECTION` | Any -> All | "Is there a leader?" |
| `CLAIM` | Leader -> All | "I am the leader" |

#### `show()` sequence

```
tab opens -> send HELLO -> start 150ms election timer
  │
  ├── WELCOME arrives before timer?
  │     YES -> clearTimeout -> become follower
  │           send INCR(actionId) -> wait for COUNT(actionId) -> resolve promise
  │
  └── Timer fires with no WELCOME?
        -> self-elect (becomeLeader([myId]))
        -> resolve({ count: 1 })
```

#### `hide()` sequence

```
if leader:
  -> tabs.delete(myId)
  -> broadcast COUNT(newCount)
  -> resolve immediately (leader owns state, no round-trip needed)

if follower:
  -> send DECR(actionId)
  -> wait for COUNT(actionId) -> resolve promise
```

#### Leader closing

```
cleanup() [leader]
  -> find remaining = tabs.filter(id !== myId)
  -> send HANDOFF({ nextLeaderId: remaining[0], tabs: remaining })
  -> remaining[0] receives HANDOFF -> becomeLeader(tabs)
```

---

### `useSequentialStrategy` - localStorage + leader election

Same leader-election model as BroadcastChannel but over `localStorage`. Used when BroadcastChannel is unavailable (some private-mode browsers, older environments).

**Why `localStorage` instead of `sessionStorage`:** `sessionStorage` is completely isolated per tab - it cannot be shared. `localStorage` is shared across tabs from the same origin. The `storage` event fires in every tab *except* the one that wrote, which is exactly what enables the cross-tab messaging pattern.

#### Storage keys

| Key | Writer | Purpose |
|---|---|---|
| `TAB_COUNTER_STORAGE_KEY:leader` | Leader | Holds the current leader's `tabId` |
| `TAB_COUNTER_STORAGE_KEY:tabs` | Leader | JSON array of all live tab IDs |
| `TAB_COUNTER_STORAGE_KEY:req` | Followers | INCR/DECR requests for the leader |
| `TAB_COUNTER_STORAGE_KEY:res` | Leader | Response with updated count |

#### `show()` sequence

```
readLeader()
  │
  ├── No leader exists?
  │     -> set electionTimer (200ms)
  │     -> stash { resolve, reject, actionId } in pendingShow
  │     │
  │     ├── LS_LEADER_KEY storage event fires before timer?
  │     │     -> clearTimeout
  │     │     -> sendFollowerRequest('incr', actionId, resolve, reject)
  │     │     -> wait for LS_RES_KEY storage event -> resolve
  │     │
  │     └── Timer fires?
  │           -> becomeLeader([myId, ...existingTabs])
  │           -> resolve({ count: tabs.size })
  │
  └── Leader exists?
        -> sendFollowerRequest('incr', actionId, resolve, reject)
        -> leader reads LS_REQ_KEY storage event -> processRequest
        -> leader writes LS_RES_KEY
        -> follower reads LS_RES_KEY storage event -> resolve
```

**The storage event suppression advantage:** the leader writes `LS_RES_KEY` -> the `storage` event fires in the requesting follower but NOT in the leader. This is intentional - the leader already updated its own state before writing, so it does not need the event. The follower reads the response, updates `store.count`, and resolves its promise.

---

## The double-increment guard

`bootstrap()` maintains a local `localRegistered` boolean. `tabShow()` is a no-op if `localRegistered === true`; `tabHide()` is a no-op if `localRegistered === false`. This prevents double-incrementing when:

- `pageshow` fires on initial load at the same time as an explicit `show()` call
- A rapid hide/show sequence arrives before the previous one completes

---

## Tab identity (`getOrCreateTabId`)

Each tab needs a stable identity that:
- Survives **page refresh** (same tab, same ID)
- Changes when a **tab is duplicated** (new tab, new ID)
- Survives **back/forward navigation** (same tab, same ID)

The solution uses two storage locations that complement each other:

```
window.name         <- survives same-tab navigation; shared with duplicated tabs initially
sessionStorage      <- survives refresh; isolated per tab (not shared with duplicates)

if window.name === sessionStorage.getItem(STORAGE_KEY):
  -> confirmed stable identity from a previous load -> return it

else:
  -> generate newId = `tab_${crypto.randomUUID()}`
  -> window.name = newId
  -> sessionStorage.setItem(STORAGE_KEY, newId)
  -> return newId
```

A duplicated tab inherits `window.name` from its parent but starts with a fresh `sessionStorage`, so the two values differ, triggering a new UUID. After the first load of the duplicate, both agree on the new ID and it remains stable.

---

## Worker internals (`tab-count.worker.ts`)

The SharedWorker maintains:

```ts
state = {
  ports:         MessagePort[]   // one per connected tab
  tabs:          Record<tabId, index>  // tabId -> sequential slot index
  nextIndex:     number          // next available slot
  danglingIndex: number[]        // freed slots available for reuse
}
```

**Slot reuse:** when a tab disconnects (DECR), its index is pushed to `danglingIndex`. When a new tab connects (INCR), `danglingIndex.shift()` is tried before incrementing `nextIndex`. This keeps slot numbers compact even after many open/close cycles.

**Broadcast on every mutation:** after every INCR or DECR, the worker iterates `state.ports` and posts the updated count to every port. Stale ports (tabs whose `close()` call raced with the broadcast) are caught in a try/catch and removed from the list.

**Origin validation:** `clientIsSameOriginWithWorker(event.origin)` is checked on every incoming message. Messages from unexpected origins are silently discarded with a warning log.

---

## Events used and why

| Event | Used for | Why not the alternative |
|---|---|---|
| `pageshow` | Tab becoming active / BFCache restore | `pagereveal` has worse support |
| `pagehide` | Tab closing / navigating away | `beforeunload` is unreliable for postMessage during teardown; `pagehide` fires earlier |
| `storage` | Sequential strategy cross-tab messaging | Only cross-tab event available without a SharedWorker or BroadcastChannel |
| `visibilitychange` | *(commented out)* | Caused always-1 bug: incremented on focus but decremented on blur; pagehide/pageshow is more appropriate for tab lifecycle |

---

## Known limitations

**No decrement on hard close (sequential strategy).** When a tab is force-closed (process kill, browser crash), the leader's cleanup code does not run. The stale tab remains in `LS_TABS_KEY` until the leader next writes it. A future improvement would add a heartbeat key with a TTL - the leader periodically writes a timestamp, and on the next boot, tabs older than `2 × heartbeat_interval` are pruned.

**BroadcastChannel leader dies without handoff.** If the leader tab crashes (as opposed to closing normally), no `HANDOFF` message is sent. Remaining followers continue as followers with no leader until one of them calls `show()`, triggers an election timer, gets no `CLAIM` response, and self-elects. This window is at most `ELECTION_TIMEOUT_MS` (150ms) and resolves automatically.

**LFU tie-breaking not applicable.** The tab count subsystem has no eviction. `_readCount` patterns from the storage subsystem do not apply here.