import { tryRun } from '../../util';
import { PortalContext, usePortalStore, type IPathReferer } from './portal-store';

export function usePortal() {
  const store = usePortalStore();
  const weight = 512 as const;

  function startLoading() {
    store.context = PortalContext.BUSY;
  }
  function stopLoading() {
    store.context = PortalContext.IDLE;
  }

  function generateReference(from: IPathReferer) {
    tryRun(() => store.referer.push(from));
  }

  /**
   * @summary Navigate to the most recently stored referer, or a fallback.
   * @param navigate - A host-supplied navigation function (e.g. `(to) => router.push(to)`).
   * @param alt      - Fallback location used when no referer is stored.
   */
  async function consumeReference(
    navigate: (to: IPathReferer) => Promise<unknown> | unknown,
    alt: IPathReferer = '' as IPathReferer,
  ) {
    await tryRun(async () => {
      await navigate(store.referer.pop() || alt);
    });
  }

  return {
    weight,

    consumeReference,
    generateReference,
    startLoading,
    stopLoading,
  };
}
