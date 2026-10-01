import type { GlobalStore } from '../global.store';
import type { TabCountOperative, TabStore } from './tab.types';
import type { ICleanUp } from '../../manager.dto';

import { runCleanup } from '../../util';
import { useTabStore } from './tab-store';
import { useTabCount } from './tab-count';

export function useTab() {
  let store: TabStore | null = null;
  let tabCount: TabCountOperative | null = null;
  let cleanup: ICleanUp | null = null;
  let appRef: unknown = null;

  function preInitialize(state: GlobalStore) {
    store = useTabStore();
    tabCount = useTabCount({
      getOrCreateTabId,
      store,
    });

    tabCount.preInitialize(state);
  }
  async function bootstrap(app: unknown) {
    appRef = app;
    const operative = { getOrCreateTabId, store: store! };

    // bootstrap() sets up event listeners and the strategy's internal state.
    // It does NOT call show() itself - we call show() once here explicitly
    // so there is exactly one registration per bootstrap.
    cleanup = tabCount?.bootstrap(operative) ?? null;
    await show();
    return cleanup;
  }
  function getName() {
    return window.name;
  }
  function show() {
    return tabCount?.show({
      getOrCreateTabId,
      store: store!,
    });
  }
  function hide() {
    return tabCount?.hide({
      getOrCreateTabId,
      store: store!,
    });
  }
  function stop() {
    return hide();
  }
  async function restart() {
    await hide();
    // Run the previous cleanup before re-bootstrapping so listeners do not leak.
    if (cleanup && appRef) {
      await runCleanup(cleanup, appRef);
    }
    cleanup = null;
    if (appRef) {
      await bootstrap(appRef);
    }
  }

  /**
   * Generates or reuses a stable identity for this browser tab.
   *
   * Strategy:
   * - `window.name` survives same-tab navigations (including back/forward).
   * - `sessionStorage` survives page refreshes.
   * - When both agree we have a confirmed identity from a previous load.
   * - When they disagree (duplicated tab, first visit) we mint a new UUID.
   */
  function getOrCreateTabId(): string {
    const STORAGE_KEY = 'latest_tab_id';

    // window.name survives navigation, sessionStorage survives refresh.
    // If both agree, we have a confirmed identity.
    const nameId = window.name;
    const storageId = sessionStorage.getItem(STORAGE_KEY);

    if (nameId && nameId === storageId) {
      // Confirmed stable identity from a previous load in this tab
      return nameId;
    }

    // Generate a new ID (first visit, or tab was duplicated and needs its own)
    const newId = `tab_${crypto.randomUUID()}`;
    window.name = newId;
    sessionStorage.setItem(STORAGE_KEY, newId);
    return newId;
  }

  return {
    getOrCreateTabId,
    get store() {
      return store!;
    },
    get tabCount() {
      return tabCount!;
    },
    show,
    bootstrap,
    hide,
    stop,
    restart,
    preInitialize,
    getName,
  };
}
