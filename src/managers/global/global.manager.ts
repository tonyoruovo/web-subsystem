import type { PlatformErrorEvent } from '../manager.dto';
import { runCleanup, tryRun } from '../util';

import type { IGlobalEventMap } from './global.dto';
import { useGlobalStore } from './global.store';
import { usePortal } from './portal';
import { useTab } from './tab';

import { GLOBAL_ERROR_EVENT } from '@/constants';
import { detectBrowser } from '@/libs';
import type { FunctionLike } from '@/modules';

function detectWorkers() {
  return {
    webWorker: typeof Worker !== 'undefined',
    sharedWorker: typeof SharedWorker !== 'undefined',
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  };
}

function detectNotifications() {
  return {
    // BroadcastChannel is widely supported but not in every environment
    broadcastChannel: typeof BroadcastChannel !== 'undefined',
  };
}

export function useGlobalManager() {
  const tab = useTab();
  const portal = usePortal();
  const store = useGlobalStore();

  /*---------------------------------------
   * Private
   *-------------------------------------*/
  function defineEvent<K extends keyof IGlobalEventMap>(
    key: K,
    callback: FunctionLike<[IGlobalEventMap[K]], void>,
  ) {
    document.addEventListener(key as keyof DocumentEventMap, callback as unknown as EventListener);
  }
  function declareEvents() {
    defineEvent(GLOBAL_ERROR_EVENT, onManagerError);
  }
  async function scaffoldSupportTable() {
    const workers = detectWorkers();
    const notifications = detectNotifications();

    store.support.workers = {
      service: { native: workers.serviceWorker },
      shared: { native: workers.sharedWorker },
      web: { native: workers.webWorker },
    };

    // Expose BroadcastChannel availability so strategy selection can use it
    store.support.notification = {
      broadcastChannel: { native: notifications.broadcastChannel },
    };

    store.support.userAgent = await detectBrowser();
  }

  /*---------------------------------------
   * Public
   *-------------------------------------*/
  function onManagerError(e: PlatformErrorEvent) {
    store.errors.push(e.detail);
  }
  async function preInitialize() {
    declareEvents();
    await scaffoldSupportTable();

    tab.preInitialize(store);
  }
  async function bootstrap(app: unknown) {
    const tabCleanup = (await tab.bootstrap(app))!;
    return async () => {
      await tryRun(async () => await runCleanup(tabCleanup, app));
    };
  }
  async function show() {
    await tab.show();
  }
  async function hide() {
    await tab.hide();
  }
  async function restart() {
    await tab.restart();
  }
  async function stop() {
    await tab.stop();
  }

  return {
    tab,
    portal,

    preInitialize,
    bootstrap,
    restart,
    stop,
    show,
    hide,
  };
}

export type GlobalManager = ReturnType<typeof useGlobalManager>;
