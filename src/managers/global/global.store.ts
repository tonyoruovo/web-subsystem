import { PlatformManagerExecutionState } from '../manager.dto';

import type { IPlatformManagerError } from '../manager.dto';
import type { ISupport } from './global.types';

/**
 * @summary The Global State store, a plain framework-agnostic singleton.
 * @description
 * Holds platform errors, the manager weight, the execution state, and the
 * capability support table. It is a plain object, not a Pinia store, so any
 * framework or plain JavaScript can consume it. A framework adapter may wrap it
 * in reactivity later.
 */
export interface GlobalStore {
  errors: IPlatformManagerError[];
  weight: number;
  state: PlatformManagerExecutionState;
  support: ISupport;
}

const store: GlobalStore = {
  errors: [],
  weight: 2048,
  state: PlatformManagerExecutionState.INIT,
  support: {},
};

/**
 * @summary Returns the shared Global State store.
 * @returns {GlobalStore} The singleton store.
 */
export function useGlobalStore(): GlobalStore {
  return store;
}
