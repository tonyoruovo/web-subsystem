import { v4 as uuidV4 } from 'uuid';

import { BasicError, PlatformErrorEvent } from '../../../manager.dto';
import { TabCountTransactionType } from '../tab.types';
import type {
  ITabCountError,
  ITabCountRequest,
  ITabCountResponse,
  ITabCountResponseData,
  TabOperative,
} from '../tab.types';

import TabCountWorker from './tab-count.worker?sharedworker';

import {
  TAB_COUNTER_CHANNEL,
  TAB_COUNTER_STORAGE_KEY,
  WORKER_ERROR,
  WORKER_PORT_ERROR,
} from '@/constants';
import { stringToHash } from '@/libs';
import type { FunctionLike } from '@/modules';

// ─────────────────────────────────────────────────────────────────────────────
// Shared promise-callback helpers
// ─────────────────────────────────────────────────────────────────────────────

function registerPromise(
  id: string,
  tab: TabOperative,
  resolve: (v: ITabCountResponseData) => void,
  reject: (e: unknown) => void,
) {
  tab.store.countCallbacks[id] = ((args) => {
    resolve(args as ITabCountResponseData);
    unregisterPromise(id, tab);
  }) as FunctionLike<[unknown]>;

  tab.store.countCallbacks[`${id}-error`] = (args) => {
    reject(args);
    unregisterPromise(id, tab);
  };
}

function unregisterPromise(id: string, tab: TabOperative) {
  delete tab.store.countCallbacks[id];
  delete tab.store.countCallbacks[`${id}-error`];
}

function rejectPromise(id: string, tab: TabOperative, error: unknown) {
  const cb = tab.store.countCallbacks[`${id}-error`];
  if (cb) cb(error);
}

function resolvePromise(id: string, tab: TabOperative, data: ITabCountResponseData) {
  const cb = tab.store.countCallbacks[id];
  if (cb) cb(data);
}

export type IWorkerStrategy = {
  worker?: InstanceType<typeof TabCountWorker>;
};

export function useWorkerStrategy() {
  function bootstrap(tab: TabOperative<IWorkerStrategy>) {
    tab.store.metadata.worker = new TabCountWorker({ name: TAB_COUNTER_CHANNEL });

    tab.store.metadata.worker.port.onmessage = (event) => {
      const { metadata, payload } = event.data as ITabCountResponse | ITabCountError;
      if ('error' in payload) {
        if (metadata?.actionId) rejectPromise(metadata.actionId, tab, payload.error);
        return;
      }
      const data = payload as ITabCountResponseData;
      tab.store.count = data.count;
      if (metadata?.actionId) resolvePromise(metadata.actionId, tab, data);
    };

    tab.store.metadata.worker.port.onmessageerror = (event) => {
      document.dispatchEvent(
        new PlatformErrorEvent(
          new BasicError({
            id: stringToHash(WORKER_PORT_ERROR),
            message: '[TAB_COUNT] Worker port error',
            cause: event.data,
          }),
        ),
      );
    };

    tab.store.metadata.worker.onerror = (event) => {
      document.dispatchEvent(
        new PlatformErrorEvent(
          new BasicError({
            id: stringToHash(WORKER_ERROR),
            message: `[TAB_COUNT] Worker error: ${event.message}`,
            cause: event.error,
          }),
        ),
      );
    };

    tab.store.metadata.worker.port.start();

    return () => {
      for (const h of Object.keys(tab.store.countCallbacks)) delete tab.store.countCallbacks[h];
      tab.store.metadata.worker?.port.close();
      delete tab.store.metadata.worker;
    };
  }

  function request(type: TabCountTransactionType, tab: TabOperative<IWorkerStrategy>) {
    return new Promise<ITabCountResponseData>((resolve, reject) => {
      const actionId = uuidV4();
      registerPromise(actionId, tab, resolve, reject);
      tab.store.metadata.worker?.port.postMessage({
        payload: { id: tab.getOrCreateTabId() },
        type,
        metadata: { actionId },
      } as ITabCountRequest);
    });
  }

  const show = (tab: TabOperative<IWorkerStrategy>) => request(TabCountTransactionType.INCR, tab);
  const hide = (tab: TabOperative<IWorkerStrategy>) => request(TabCountTransactionType.DECR, tab);

  return { bootstrap, show, hide };
}

/**
 * **BroadcastChannel strategy** - leader-election model
 *
 * **WHY** - the previous version was broken:
 *   Each tab held its own in-memory `tabs` map. Tab B opened, found an empty
 *   map, counted 1 tab, and was forever unaware of Tab A.
 *
 * **FIX** - one tab is the "leader" and owns all state:
 *   - On connect every tab announces itself with HELLO.
 *   - The leader replies with WELCOME (containing the authoritative tab list).
 *   - If no WELCOME arrives within ELECTION_TIMEOUT_MS the tab self-elects.
 *   - Followers send INCR/DECR; the leader processes them and broadcasts COUNT.
 *   - When the leader closes it sends HANDOFF to nominate its successor.
 */
const enum BCMsgType {
  HELLO = 'hello',
  WELCOME = 'welcome',
  INCR = 'incr',
  DECR = 'decr',
  COUNT = 'count',
  HANDOFF = 'handoff',
  ELECTION = 'election',
  CLAIM = 'claim',
}

type BCMsg =
  | { type: BCMsgType.HELLO; tabId: string }
  | { type: BCMsgType.WELCOME; tabId: string; count: number; allTabs: string[] }
  | { type: BCMsgType.INCR; tabId: string; actionId: string }
  | { type: BCMsgType.DECR; tabId: string; actionId: string }
  | { type: BCMsgType.COUNT; count: number; actionId?: string; tabId?: string }
  | { type: BCMsgType.HANDOFF; nextLeaderId: string; tabs: string[] }
  | { type: BCMsgType.ELECTION; tabId: string }
  | { type: BCMsgType.CLAIM; tabId: string };

export type IBroadcastStrategy = {
  channel?: BroadcastChannel;
  tabs?: Set<string>;
  isLeader?: boolean;
  electionTimer?: ReturnType<typeof setTimeout>;
  pendingHello?: { resolve: () => void };
};
export function useBroadcastStrategy() {
  const ELECTION_TIMEOUT_MS = 150;

  function send(tab: TabOperative<IBroadcastStrategy>, msg: BCMsg) {
    tab.store.metadata.channel?.postMessage(msg);
  }

  function broadcastCount(
    tab: TabOperative<IBroadcastStrategy>,
    actionId?: string,
    targetTabId?: string,
  ) {
    const count = tab.store.metadata.tabs!.size;
    tab.store.count = count;
    send(tab, { type: BCMsgType.COUNT, count, actionId, tabId: targetTabId });
  }

  function becomeLeader(tab: TabOperative<IBroadcastStrategy>, initialTabs: string[]) {
    tab.store.metadata.isLeader = true;
    tab.store.metadata.tabs = new Set(initialTabs);
    tab.store.count = tab.store.metadata.tabs.size;
  }

  function handleAsLeader(tab: TabOperative<IBroadcastStrategy>, msg: BCMsg) {
    switch (msg.type) {
      case BCMsgType.HELLO: {
        tab.store.metadata.tabs!.add(msg.tabId);
        send(tab, {
          type: BCMsgType.WELCOME,
          tabId: msg.tabId,
          count: tab.store.metadata.tabs!.size,
          allTabs: [...tab.store.metadata.tabs!],
        });
        tab.store.count = tab.store.metadata.tabs!.size;
        break;
      }
      case BCMsgType.INCR: {
        tab.store.metadata.tabs!.add(msg.tabId);
        broadcastCount(tab, msg.actionId, msg.tabId);
        break;
      }
      case BCMsgType.DECR: {
        tab.store.metadata.tabs!.delete(msg.tabId);
        broadcastCount(tab, msg.actionId, msg.tabId);
        break;
      }
      case BCMsgType.ELECTION: {
        send(tab, { type: BCMsgType.CLAIM, tabId: tab.getOrCreateTabId() });
        break;
      }
      default:
        break;
    }
  }

  function handleAsFollower(tab: TabOperative<IBroadcastStrategy>, msg: BCMsg) {
    switch (msg.type) {
      case BCMsgType.WELCOME: {
        if (msg.tabId !== tab.getOrCreateTabId()) break;
        tab.store.count = msg.count;
        tab.store.metadata.pendingHello?.resolve();
        break;
      }
      case BCMsgType.COUNT: {
        tab.store.count = msg.count;
        if (msg.actionId && msg.tabId === tab.getOrCreateTabId()) {
          resolvePromise(msg.actionId, tab, { count: msg.count, index: 0, id: msg.tabId! });
        }
        break;
      }
      case BCMsgType.HANDOFF: {
        if (msg.nextLeaderId === tab.getOrCreateTabId()) {
          becomeLeader(tab, msg.tabs);
        }
        break;
      }
      default:
        break;
    }
  }

  function bootstrap(tab: TabOperative<IBroadcastStrategy>) {
    tab.store.metadata.channel = new BroadcastChannel(TAB_COUNTER_CHANNEL);
    tab.store.metadata.isLeader = false;

    tab.store.metadata.channel.onmessageerror = (event) => {
      document.dispatchEvent(
        new PlatformErrorEvent(
          new BasicError({
            id: stringToHash(WORKER_PORT_ERROR),
            message: '[TAB_COUNT] BroadcastChannel error',
            cause: event.data,
          }),
        ),
      );
    };

    tab.store.metadata.channel.onmessage = (event: MessageEvent<BCMsg>) => {
      if (tab.store.metadata.isLeader) {
        handleAsLeader(tab, event.data);
      } else {
        handleAsFollower(tab, event.data);
      }
    };

    return () => {
      if (tab.store.metadata.isLeader) {
        const myId = tab.getOrCreateTabId();
        const remaining = [...(tab.store.metadata.tabs ?? [])].filter((id) => id !== myId);
        if (remaining.length > 0) {
          send(tab, { type: BCMsgType.HANDOFF, nextLeaderId: remaining[0], tabs: remaining });
        }
      }
      if (tab.store.metadata.electionTimer) {
        clearTimeout(tab.store.metadata.electionTimer);
      }
      for (const h of Object.keys(tab.store.countCallbacks)) delete tab.store.countCallbacks[h];
      tab.store.metadata.channel?.close();
      delete tab.store.metadata.channel;
      delete tab.store.metadata.tabs;
      delete tab.store.metadata.isLeader;
      delete tab.store.metadata.electionTimer;
      delete tab.store.metadata.pendingHello;
    };
  }

  function show(tab: TabOperative<IBroadcastStrategy>): Promise<ITabCountResponseData> {
    const myId = tab.getOrCreateTabId();

    return new Promise<ITabCountResponseData>((resolve, reject) => {
      // Announce ourselves; wait briefly for a leader to respond
      send(tab, { type: BCMsgType.HELLO, tabId: myId });

      const timer = setTimeout(() => {
        // No leader replied - self-elect
        delete tab.store.metadata.pendingHello;
        delete tab.store.metadata.electionTimer;
        becomeLeader(tab, [myId]);
        resolve({ count: 1, index: 0, id: myId });
      }, ELECTION_TIMEOUT_MS);

      tab.store.metadata.electionTimer = timer;
      tab.store.metadata.pendingHello = {
        resolve: () => {
          clearTimeout(timer);
          delete tab.store.metadata.electionTimer;
          delete tab.store.metadata.pendingHello;
          // Leader welcomed us; now formally register via INCR
          const actionId = uuidV4();
          registerPromise(actionId, tab, resolve, reject);
          send(tab, { type: BCMsgType.INCR, tabId: myId, actionId });
        },
      };
    });
  }

  function hide(tab: TabOperative<IBroadcastStrategy>): Promise<ITabCountResponseData> {
    const myId = tab.getOrCreateTabId();

    if (tab.store.metadata.isLeader) {
      tab.store.metadata.tabs?.delete(myId);
      const count = tab.store.metadata.tabs?.size ?? 0;
      tab.store.count = count;
      send(tab, { type: BCMsgType.COUNT, count });
      return Promise.resolve({ count, index: 0, id: myId });
    }

    return new Promise<ITabCountResponseData>((resolve, reject) => {
      const actionId = uuidV4();
      registerPromise(actionId, tab, resolve, reject);
      send(tab, { type: BCMsgType.DECR, tabId: myId, actionId });
    });
  }

  return { bootstrap, show, hide };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential (localStorage) strategy  - leader-election via storage events
//
// WHY the previous version was broken:
//   sessionStorage is completely isolated per tab - it cannot be shared.
//   Even localStorage's `storage` event is suppressed in the writer, so
//   the in-memory-only approach never worked cross-tab.
//
// FIX - leader-election using localStorage as the shared bus:
//   • LS_LEADER_KEY  holds the current leader's tabId.
//   • LS_TABS_KEY    holds JSON array of all live tab IDs (leader writes only).
//   • LS_REQ_KEY     followers write INCR/DECR requests here.
//   • LS_RES_KEY     leader writes the response here; followers read it.
//
//   The `storage` event fires in every tab EXCEPT the writer, which is exactly
//   what we need: the leader writes LS_RES_KEY -> followers update their count.
//   Followers write LS_REQ_KEY -> leader processes it.
// ─────────────────────────────────────────────────────────────────────────────

const LS_LEADER_KEY = TAB_COUNTER_STORAGE_KEY + ':leader';
const LS_TABS_KEY = TAB_COUNTER_STORAGE_KEY + ':tabs';
const LS_REQ_KEY = TAB_COUNTER_STORAGE_KEY + ':req';
const LS_RES_KEY = TAB_COUNTER_STORAGE_KEY + ':res';

type LSRequest = { type: 'incr' | 'decr'; tabId: string; actionId: string; ts: number };
type LSResponse = { count: number; actionId: string; tabId: string };

export type ISequentialStrategy = {
  isLeader?: boolean;
  tabs?: Set<string>;
  electionTimer?: ReturnType<typeof setTimeout>;
  followerTimer?: ReturnType<typeof setTimeout>;
  pendingShow?: {
    resolve: (v: ITabCountResponseData) => void;
    reject: (e: unknown) => void;
    actionId: string;
  };
  storageHandler?: (e: StorageEvent) => void;
};

export function useSequentialStrategy() {
  const ELECTION_TIMEOUT_MS = 200;

  // ── localStorage helpers ─────────────────────────────────────────────────

  function lsRead<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  }
  function lsWrite(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /**/
    }
  }
  function lsRemove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /**/
    }
  }

  function readTabs(): string[] {
    return lsRead<string[]>(LS_TABS_KEY) ?? [];
  }
  function writeTabs(tabs: Set<string>) {
    lsWrite(LS_TABS_KEY, [...tabs]);
  }
  function readLeader(): string | null {
    return lsRead<string>(LS_LEADER_KEY);
  }
  function writeLeader(id: string) {
    lsWrite(LS_LEADER_KEY, id);
  }
  function clearLeader() {
    lsRemove(LS_LEADER_KEY);
  }

  // ── leader setup ─────────────────────────────────────────────────────────

  function becomeLeader(tab: TabOperative<ISequentialStrategy>, initialTabs: string[]) {
    tab.store.metadata.isLeader = true;
    tab.store.metadata.tabs = new Set(initialTabs);
    writeLeader(tab.getOrCreateTabId());
    writeTabs(tab.store.metadata.tabs);
    tab.store.count = tab.store.metadata.tabs.size;
  }

  // ── leader: handle a follower request ────────────────────────────────────

  function processRequest(tab: TabOperative<ISequentialStrategy>, req: LSRequest) {
    if (!tab.store.metadata.isLeader) return;
    if (req.type === 'incr') tab.store.metadata.tabs!.add(req.tabId);
    else tab.store.metadata.tabs!.delete(req.tabId);

    writeTabs(tab.store.metadata.tabs!);
    const count = tab.store.metadata.tabs!.size;
    tab.store.count = count;
    // Write response - will fire `storage` in all tabs including the requester
    lsWrite(LS_RES_KEY, { count, actionId: req.actionId, tabId: req.tabId } as LSResponse);
  }

  // ── storage event handler ────────────────────────────────────────────────

  function makeStorageHandler(tab: TabOperative<ISequentialStrategy>) {
    return (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;

      switch (event.key) {
        case LS_LEADER_KEY: {
          // A leader announced itself while we were in our election wait
          if (!tab.store.metadata.isLeader && tab.store.metadata.electionTimer) {
            clearTimeout(tab.store.metadata.electionTimer);
            delete tab.store.metadata.electionTimer;

            if (tab.store.metadata.pendingShow) {
              const { resolve, reject, actionId } = tab.store.metadata.pendingShow;
              delete tab.store.metadata.pendingShow;
              sendFollowerRequest(tab, 'incr', actionId, resolve, reject);
            }
          }
          break;
        }
        case LS_REQ_KEY: {
          if (tab.store.metadata.isLeader && event.newValue) {
            try {
              processRequest(tab, JSON.parse(event.newValue) as LSRequest);
            } catch {
              /**/
            }
          }
          break;
        }
        case LS_RES_KEY: {
          if (!tab.store.metadata.isLeader && event.newValue) {
            try {
              const res = JSON.parse(event.newValue) as LSResponse;
              tab.store.count = res.count;
              if (res.tabId === tab.getOrCreateTabId()) {
                if (tab.store.metadata.followerTimer) {
                  clearTimeout(tab.store.metadata.followerTimer);
                  delete tab.store.metadata.followerTimer;
                }
                resolvePromise(res.actionId, tab, { count: res.count, index: 0, id: res.tabId });
              }
            } catch {
              /**/
            }
          }
          break;
        }
        case LS_TABS_KEY: {
          if (!tab.store.metadata.isLeader && event.newValue) {
            try {
              const tabs: string[] = JSON.parse(event.newValue);
              tab.store.count = tabs.length;
            } catch {
              /**/
            }
          }
          break;
        }
      }
    };
  }

  // ── follower: write a request for the leader ──────────────────────────────

  function sendFollowerRequest(
    tab: TabOperative<ISequentialStrategy>,
    type: 'incr' | 'decr',
    actionId: string,
    resolve: (v: ITabCountResponseData) => void,
    reject: (e: unknown) => void,
  ) {
    registerPromise(actionId, tab, resolve, reject);
    const req: LSRequest = { type, tabId: tab.getOrCreateTabId(), actionId, ts: Date.now() };
    try {
      localStorage.setItem(LS_REQ_KEY, JSON.stringify(req));
    } catch (e) {
      rejectPromise(actionId, tab, e);
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function bootstrap(tab: TabOperative<ISequentialStrategy>) {
    const handler = makeStorageHandler(tab);
    tab.store.metadata.storageHandler = handler;
    window.addEventListener('storage', handler);

    return () => {
      if (tab.store.metadata.storageHandler) {
        window.removeEventListener('storage', tab.store.metadata.storageHandler);
      }
      if (tab.store.metadata.electionTimer) {
        clearTimeout(tab.store.metadata.electionTimer);
      }
      if (tab.store.metadata.isLeader) {
        const myId = tab.getOrCreateTabId();
        tab.store.metadata.tabs?.delete(myId);
        if ((tab.store.metadata.tabs?.size ?? 0) === 0) {
          clearLeader();
          lsRemove(LS_TABS_KEY);
        } else {
          writeTabs(tab.store.metadata.tabs!);
          clearLeader(); // Remaining tabs will self-elect on next show()
        }
      } else {
        // Fire-and-forget DECR so leader can clean up
        const req: LSRequest = {
          type: 'decr',
          tabId: tab.getOrCreateTabId(),
          actionId: uuidV4(),
          ts: Date.now(),
        };
        try {
          localStorage.setItem(LS_REQ_KEY, JSON.stringify(req));
        } catch {
          /**/
        }
      }
      if (tab.store.metadata.followerTimer) {
        clearTimeout(tab.store.metadata.followerTimer);
      }
      for (const h of Object.keys(tab.store.countCallbacks)) delete tab.store.countCallbacks[h];
      delete tab.store.metadata.isLeader;
      delete tab.store.metadata.tabs;
      delete tab.store.metadata.electionTimer;
      delete tab.store.metadata.followerTimer;
      delete tab.store.metadata.pendingShow;
      delete tab.store.metadata.storageHandler;
    };
  }

  // ── public show / hide ───────────────────────────────────────────────────

  function show(tab: TabOperative<ISequentialStrategy>): Promise<ITabCountResponseData> {
    const myId = tab.getOrCreateTabId();

    return new Promise<ITabCountResponseData>((resolve, reject) => {
      const currentLeader = readLeader();

      if (!currentLeader) {
        // No leader - start election wait, then self-elect if no one responds
        tab.store.metadata.electionTimer = setTimeout(() => {
          delete tab.store.metadata.electionTimer;
          delete tab.store.metadata.pendingShow;
          const existingTabs = readTabs().filter((id) => id !== myId);
          becomeLeader(tab, [myId, ...existingTabs]);
          resolve({ count: tab.store.metadata.tabs!.size, index: 0, id: myId });
        }, ELECTION_TIMEOUT_MS);

        tab.store.metadata.pendingShow = { resolve, reject, actionId: uuidV4() };
      } else {
        // Leader exists - send INCR request and wait for LS_RES_KEY storage event
        const actionId = uuidV4();
        sendFollowerRequest(tab, 'incr', actionId, resolve, reject);

        // Stale leader guard: if the leader never responds, self-elect.
        tab.store.metadata.followerTimer = setTimeout(() => {
          delete tab.store.metadata.followerTimer;
          unregisterPromise(actionId, tab);
          const existingTabs = readTabs().filter((id) => id !== myId);
          becomeLeader(tab, [myId, ...existingTabs]);
          resolve({ count: tab.store.metadata.tabs!.size, index: 0, id: myId });
        }, ELECTION_TIMEOUT_MS);
      }
    });
  }

  function hide(tab: TabOperative<ISequentialStrategy>): Promise<ITabCountResponseData> {
    const myId = tab.getOrCreateTabId();

    if (tab.store.metadata.isLeader) {
      tab.store.metadata.tabs?.delete(myId);
      const count = tab.store.metadata.tabs?.size ?? 0;
      writeTabs(tab.store.metadata.tabs ?? new Set());
      tab.store.count = count;
      if (count === 0) clearLeader();
      return Promise.resolve({ count, index: 0, id: myId });
    }

    return new Promise<ITabCountResponseData>((resolve, reject) => {
      const actionId = uuidV4();
      sendFollowerRequest(tab, 'decr', actionId, resolve, reject);

      // Stale leader guard: resolve with the current count if no response.
      tab.store.metadata.followerTimer = setTimeout(() => {
        delete tab.store.metadata.followerTimer;
        unregisterPromise(actionId, tab);
        resolve({ count: tab.store.count, index: 0, id: myId });
      }, ELECTION_TIMEOUT_MS);
    });
  }

  return { bootstrap, show, hide };
}
