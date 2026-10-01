import type { GlobalStore } from '../../global.store';
import type { TabOperative } from '../tab.types';

import { runCleanup } from '../../../util';
import {
  useBroadcastStrategy,
  useSequentialStrategy,
  useWorkerStrategy,
} from './tab-count.strategy';

export function useTabCount(tab: TabOperative) {
  // Track whether this tab has already been counted so we never double-increment
  tab.store.metadata.registered = false;

  function preInitialize(globalState: GlobalStore) {
    if (globalState.support.workers?.shared?.native) {
      // load worker
      tab.store.strategy = useWorkerStrategy();
    } else if (globalState.support.notification?.broadcastChannel?.native) {
      // load BroadcastChannel-type
      tab.store.strategy = useBroadcastStrategy();
    } else {
      // run cloudflare's rv store
      tab.store.strategy = useSequentialStrategy();
    }
  }
  function bootstrap(tab: TabOperative) {
    const cleanup = tab.store.strategy?.bootstrap(tab);

    // Avoid closing over a stale `registered` flag across strategy switches
    let localRegistered = false;

    async function tabShow() {
      if (localRegistered) return;
      localRegistered = true;
      await show(tab);
    }

    async function tabHide() {
      if (!localRegistered) return;
      localRegistered = false;
      await hide(tab);
    }

    // async function onVisibilityChange() {
    //   if (document.visibilityState === 'hidden') {
    //     await tabHide()
    //   } else if (document.visibilityState === 'visible') {
    //     await tabShow()
    //   }
    // }

    // pagehide fires reliably before the page is torn down (unlike beforeunload)
    // and also covers BFCache navigation (back/forward).
    // pageshow fires when the page is restored from BFCache.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function onPageShow(e: PageTransitionEvent) {
      // e.persisted = true means page was restored from BFCache
      void tabShow();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function onPageHide(e: PageTransitionEvent) {
      void tabHide();
    }

    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    // document.addEventListener('visibilitychange', onVisibilityChange)

    return async (app: unknown) => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      // document.removeEventListener('visibilitychange', onVisibilityChange)

      if (cleanup) await runCleanup(cleanup, app);
    };
  }

  function hide(tab: TabOperative) {
    tab.store.metadata.registered = false;
    return tab.store.strategy?.hide(tab);
  }

  function show(tab: TabOperative) {
    tab.store.metadata.registered = true;
    return tab.store.strategy?.show(tab);
  }
  /**
   * A check for whether or not this platform is open on other tabs
   * @returns {boolean} returns`true` if the current tab is the one and only tab open else returns false
   */
  function isSingle(): boolean {
    return tab.store.count === 1;
  }

  return { isSingle, preInitialize, bootstrap, hide, show };
}
