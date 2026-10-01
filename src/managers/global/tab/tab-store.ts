import type { ITabCountStrategy, ITabCountResponseData } from './tab.types';

import type { FunctionLike } from '@/modules';

/**
 * @summary Compose a fresh tab-count store, a plain framework-agnostic object.
 * @description
 * Holds the tab count, the active strategy, the strategy's mutable metadata
 * bag, and the pending-request callback registry. All fields are plain mutable
 * values (no Vue reactivity or Pinia), so any framework can consume it.
 */
export function composeTabStore<M extends object = Record<string, unknown>>() {
  return {
    count: 0,
    strategy: undefined as ITabCountStrategy | undefined,
    metadata: {} as M,
    countCallbacks: {} as Record<string, FunctionLike<[ITabCountResponseData | unknown], void>>,
  };
}

/**
 * @summary Returns a fresh tab-count store.
 * @returns The plain store object.
 */
export function useTabStore<M extends object = Record<string, unknown>>() {
  return composeTabStore<M>();
}
