import type { ICleanUp } from '../../manager.dto';
import type { useTabCount } from './tab-count/tab-count';
import type { useTabStore } from './tab-store';

export enum TabCountTransactionType {
  INCR,
  DECR,
}
export type TabStore<M extends object = Record<string, unknown>> = ReturnType<
  typeof useTabStore
> & {
  metadata: M;
};
export type TabCountOperative = ReturnType<typeof useTabCount>;
export type TabOperative<M extends object = Record<string, unknown>> = {
  store: TabStore<M>;
  getOrCreateTabId(): string;
};

/**
 * # Tab Count Strategies
 *
 * Implements three cross-tab coordination strategies for counting open tabs,
 * selected at boot time based on the available browser capabilities detected
 * in the global support table.
 *
 * ## Strategy selection (decided in `tab-count.ts -> preInitialize`)
 *
 * ```
 *   SharedWorker available?
 *         │
 *         ├── YES ──► WorkerStrategy   (authoritative, zero race conditions)
 *         │
 *         └── NO
 *               │
 *               BroadcastChannel available?
 *               │
 *               ├── YES ──► BroadcastStrategy  (leader-election, in-memory)
 *               │
 *               └── NO ──►  SequentialStrategy (leader-election, localStorage)
 * ```
 *
 * ---
 *
 * ## WorkerStrategy
 *
 * The SharedWorker is the single source of truth. All tabs connect to the
 * same worker instance via MessagePort. The worker owns the `tabs` map and
 * `ports` array; tabs are purely clients.
 *
 * ```
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │                         SHARED WORKER THREAD                           │
 * │                                                                        │
 * │  state {                                                               │
 * │    ports:        MessagePort[]           <- one per connected tab       │
 * │    tabs:         Record<tabId, index>    <- live tab registry           │
 * │    nextIndex:    number                  <- monotonic counter           │
 * │    danglingIndex: number[]               <- recycled indices            │
 * │  }                                                                     │
 * │                                                                        │
 * │  onconnect(event)                                                      │
 * │    port = event.ports[0]                                               │
 * │    state.ports.push(port)                                              │
 * │    port.onmessage = captureRequest                                     │
 * │                                                                        │
 * │  process(port, request)                                                │
 * │    ├── INCR ──► processPing()                                          │
 * │    │              tabs[tabId] = nextIndex (or recycled)                │
 * │    │              broadcast response to ALL ports                      │
 * │    └── DECR ──► endSession()                                           │
 * │                   delete tabs[tabId]                                   │
 * │                   danglingIndex.push(freedIndex)                       │
 * │                   broadcast response to ALL ports                      │
 * └────────────────────────────────────────────────────────────────────────┘
 *         ▲  MessagePort (postMessage / onmessage)  │
 *         │                                         ▼
 * ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
 * │    Tab A     │       │    Tab B     │       │    Tab C     │
 * │              │       │              │       │              │
 * │  show()      │       │  show()      │       │  show()      │
 * │  └─► INCR ──►│──────►│──────────────│──────►│──► worker    │
 * │              │       │              │       │    updates   │
 * │  ◄── COUNT ──│◄──────│◄─────────────│◄──────│── all ports  │
 * │  store.count │       │  store.count │       │  store.count │
 * │  updated     │       │  updated     │       │  updated     │
 * │              │       │              │       │              │
 * │  hide()      │       │              │       │              │
 * │  └─► DECR ──►│──────►│              │       │              │
 * │  ◄── COUNT ──│◄──────│◄─────────────│◄──────│              │
 * └──────────────┘       └──────────────┘       └──────────────┘
 *
 * Promise resolution:
 *   Tab stores { actionId -> resolve/reject } in countCallbacks.
 *   Worker echoes actionId back in response metadata.
 *   Only the requesting tab resolves its own promise;
 *   all other tabs update store.count silently.
 * ```
 *
 * **Failure mode:** Worker crashes -> onerror fires -> PlatformErrorEvent
 * dispatched. Port is closed in cleanup; next bootstrap() reconnects.
 *
 * ---
 *
 * ## BroadcastStrategy
 *
 * Leader-election over BroadcastChannel. One tab owns the tab map and
 * responds to INCR/DECR from followers. Leadership transfers on close.
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    BroadcastChannel('tab-counter')                  │
 * │  (every tab can send and receive; the LEADER owns the tabs Set)     │
 * └──────────────────────────────┬──────────────────────────────────────┘
 *           receives/sends       │        receives/sends
 *                  ┌─────────────┤─────────────┐
 *                  │             │             │
 *           ┌──────▼──────┐      │      ┌──────▼──────┐
 *           │    Tab A    │      │      │    Tab C    │
 *           │  (LEADER)   │      │      │ (follower)  │
 *           │             │      │      │             │
 *           │ tabs: Set{  │      │      │             │
 *           │   A, B, C } │      │      │             │
 *           └──────┬──────┘      │      └─────────────┘
 *                  │             │
 *           ┌──────▼──────┐      │
 *           │    Tab B    │      │
 *           │ (follower)  │      │
 *           └─────────────┘      │
 *                           ┌────▼────┐
 *                           │  Tab D  │
 *                           │  (NEW)  │
 *                           └────┬────┘
 *
 * New tab join sequence:
 *   Tab D opens
 *     │
 *     ├── broadcasts HELLO { tabId: D }
 *     │
 *     ├── starts ELECTION_TIMEOUT (150 ms)
 *     │     "if no WELCOME arrives, self-elect"
 *     │
 *     │   Tab A (leader) receives HELLO
 *     │     ├── adds D to tabs Set
 *     │     └── broadcasts WELCOME { tabId: D, count, allTabs }
 *     │
 *     ├── Tab D receives WELCOME (within timeout)
 *     │     ├── clearTimeout(electionTimer)
 *     │     └── sends INCR { tabId: D, actionId }
 *     │
 *     │   Tab A processes INCR
 *     │     └── broadcasts COUNT { count, actionId, tabId: D }
 *     │
 *     └── Tab D receives COUNT
 *           └── resolvePromise(actionId) -> show() resolves
 *
 * Leader close / HANDOFF sequence:
 *   Tab A closes
 *     └── cleanup()
 *           ├── remaining = tabs minus A
 *           └── broadcasts HANDOFF { nextLeaderId: remaining[0], tabs }
 *
 *   Tab B (nominated)
 *     └── receives HANDOFF where nextLeaderId === myId
 *           └── becomeLeader(tabs)
 *
 * Self-election (no leader present, e.g. first tab):
 *   ELECTION_TIMEOUT elapses with no WELCOME
 *     └── becomeLeader([myId])
 *           └── show() resolves with count: 1
 * ```
 *
 * **Failure mode:** Leader closes without HANDOFF (crash/kill) ->
 * next tab to call show() runs the ELECTION_TIMEOUT path and self-elects,
 * rebuilding state from scratch. Count may briefly show stale value.
 *
 * ---
 *
 * ## SequentialStrategy
 *
 * Leader-election using `localStorage` as a shared message bus.
 * Designed for environments where both SharedWorker and BroadcastChannel
 * are unavailable (e.g. Safari private browsing, old WebViews).
 *
 * Four localStorage keys form the protocol:
 *
 * ```
 *   LS_LEADER_KEY  -> tabId of current leader       (written by leader)
 *   LS_TABS_KEY    -> JSON array of live tab IDs     (written by leader)
 *   LS_REQ_KEY     -> LSRequest JSON                 (written by followers)
 *   LS_RES_KEY     -> LSResponse JSON                (written by leader)
 * ```
 *
 * The `storage` event fires in every tab EXCEPT the one that wrote it -
 * this asymmetry is load-bearing for the protocol:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                         localStorage (shared)                       │
 * │                                                                     │
 * │  leader_key = "tab_abc"                                             │
 * │  tabs_key   = ["tab_abc", "tab_def"]                                │
 * │  req_key    = { type:"incr", tabId:"tab_xyz", actionId:"1", ts:… }  │
 * │  res_key    = { count:3, actionId:"1", tabId:"tab_xyz" }            │
 * └──────┬──────────────────────────────────────────┬───────────────────┘
 *        │ storage event                             │ storage event
 *        │ (key=req_key)                             │ (key=res_key)
 *        ▼                                           ▼
 * ┌──────────────┐                          ┌------------------┐
 * │  Tab A       │                          │  Tab Z           │
 * │  (LEADER)    │                          │  (NEW/follower)  │
 * │              │                          │                  │
 * │  reads req   │                          │  reads res       │
 * │  ├─ add Z    │                          │  ├─ if res.      │
 * │  │  to tabs  │                          │  │  tabId==      │
 * │  └─ writes   │                          │  │  myId         │
 * │     res_key ─┼─────────────────────────►│  └─ resolve      │
 * │     { count, │  storage event fires     │     promise      │
 * │       actionId,  only in followers      │                  │
 * │       tabId }│                          └------------------┘
 * └──────────────┘
 *
 * Tab Z join sequence:
 *   Tab Z opens, calls show()
 *     │
 *     ├── reads LS_LEADER_KEY
 *     │
 *     ├── leader exists?
 *     │     YES ──► sendFollowerRequest(type: 'incr', actionId)
 *     │               writes LS_REQ_KEY
 *     │               storage event fires in leader (Tab A)
 *     │               leader writes LS_RES_KEY
 *     │               storage event fires in Tab Z
 *     │               Tab Z resolves promise
 *     │
 *     └── leader absent?
 *           ├── start ELECTION_TIMEOUT (200 ms)
 *           │     listens for LS_LEADER_KEY storage event
 *           │     (another tab may elect itself and write the key)
 *           │
 *           └── timeout elapses, no leader appeared?
 *                 becomeLeader([myId, ...existingTabs])
 *                 writes LS_LEADER_KEY, LS_TABS_KEY
 *
 * Leader close sequence (cleanup):
 *   Leader removes itself from tabs Set
 *   If remaining > 0:
 *     writeTabs(remaining)
 *     clearLeader()        <- next tab to show() will self-elect
 *   If no remaining:
 *     clearLeader()
 *     removeItem(LS_TABS_KEY)
 *
 * Follower close sequence (cleanup):
 *   Fire-and-forget DECR to LS_REQ_KEY
 *   (leader will process asynchronously via storage event)
 * ```
 *
 * **Failure mode:** Leader crashes without cleanup -> LS_LEADER_KEY remains
 * stale. Next tab that calls show() checks the key, sends a follower request,
 * gets no response (no leader is listening), and eventually times out into
 * self-election. The ELECTION_TIMEOUT (200 ms) is intentionally longer than
 * BroadcastStrategy's (150 ms) to accommodate LS event propagation latency.
 *
 * ---
 *
 * ## Promise / callback plumbing (shared by all strategies)
 *
 * ```
 *   show() / hide()
 *     │
 *     ├── generate actionId (uuidV4)
 *     │
 *     ├── registerPromise(actionId, tab, resolve, reject)
 *     │     tab.store.countCallbacks[actionId]         = resolve wrapper
 *     │     tab.store.countCallbacks[actionId-error]   = reject wrapper
 *     │
 *     ├── send request with { metadata: { actionId } }
 *     │
 *     └── (async) response arrives
 *           │
 *           ├── error?   rejectPromise(actionId)
 *           │              calls countCallbacks[actionId-error]
 *           │              deletes both callback entries
 *           │
 *           └── success? resolvePromise(actionId)
 *                          calls countCallbacks[actionId]
 *                          deletes both callback entries
 * ```
 *
 * Cleanup (all strategies): `for (const h of Object.keys(countCallbacks))
 * delete countCallbacks[h]` - drains unresolved promises on teardown to
 * prevent memory leaks and dangling microtasks.
 *
 * @module tab-count.strategy
 * @see {useBroadcastStrategy}
 * @see {useWorkerStrategy}
 * @see {useSequentialStrategy}
 * @version 0.1.0
 */
export interface ITabCountStrategy<M extends object = Record<string, unknown>> {
  hide(tab: TabOperative<M>): Promise<unknown>;
  show(tab: TabOperative<M>): Promise<unknown>;
  bootstrap(tab: TabOperative<M>): ICleanUp;
}
export interface ITabCountTransaction<T> {
  type: TabCountTransactionType;
  metadata?: ITabCountMetadata;
  payload: T;
}
export type ITabCountRequestParam = {
  /** The tab id for used for requesting a new tab */
  id: string;
};
export type ITabCountRequest = ITabCountTransaction<ITabCountRequestParam>;
export interface ITabCountResponseData extends ITabCountRequestParam {
  /** The current number of open tabs */
  count: number;
  /** This is the index of the tab that was discontinued or pinged */
  index: number;
}
export interface ITabCountMetadata {
  /** Used for tracking this action for resolution of promise based requests/response */
  actionId?: string;
}
export type ITabCountResponse = ITabCountTransaction<ITabCountResponseData>;
export type ITabCountError = ITabCountTransaction<{ error: unknown }>;
