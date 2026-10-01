import type { FunctionLike } from '@/modules';

import { GLOBAL_ERROR_EVENT } from '@/constants';

export enum PlatformManagerExecutionState {
  IDLE = 0,
  BUSY,
  SLEEP,
  DEAD = 4,
  INIT = 8,
}

export type IActionFunctionLike = FunctionLike<[unknown, IPlatformManager | void]>;
export type INothing = void | Promise<void>;
export type ICleanUp = IActionCleanup | Promise<IActionCleanup>;
export type ICleanUpRecord = { cleanup: IActionFunctionLike };
export type IActionCleanup = IActionFunctionLike | ICleanUpRecord;
/**
 * If any of the methods fail, they should throw an error. This is the expected behaviour
 */
export interface IPlatformWorker<S extends IPlatformManagerState> {
  /**
   * Initializes configuration required to boot up this manage and it's operatives
   */
  preInitialize(state?: S): INothing;
  /**
   * boots up it's operatives
   */
  bootstrap(app: unknown, state?: S): ICleanUp;
  /**
   * pause operative run/execution
   */
  hide(state?: S): INothing;
  /**
   * resume operative run/execution
   */
  show(state?: S): INothing;
  /**
   * hard-stop for operative run/execution
   */
  stop(state?: S): INothing;
  /**
   * hard-start for operative run/execution
   */
  restart(state?: S): INothing;
}
export interface IPlatformManagerState {
  state: PlatformManagerExecutionState;
  weight: number;
  errors: IPlatformManagerError[];
}
export interface IPlatformManagerError extends Error {
  id: number;
  message: string;
}
export class BasicError extends Error implements IPlatformManagerError {
  id: number;
  constructor(
    options: Partial<IPlatformManagerError> = {
      message: 'An error occurred',
      id: 0,
    },
  ) {
    super(options?.message || 'An error occurred', {
      cause: options?.cause,
    });
    const { id = 0 } = options;
    this.id = id;
  }
}
export class PlatformErrorEvent extends CustomEvent<IPlatformManagerError> {
  constructor(payload: IPlatformManagerError) {
    super(GLOBAL_ERROR_EVENT, {
      detail: payload,
      cancelable: false,
      bubbles: false,
    });
  }
}
export type IPlatformManager<M extends IPlatformManagerState = IPlatformManagerState> =
  IPlatformWorker<M> & {
    store: IPlatformManagerState;
  };
export type IPlatformOperative<M extends IPlatformManagerState = IPlatformManagerState> =
  Partial<M>;
