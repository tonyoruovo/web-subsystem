/// <reference lib="WebWorker" />

import { isNil, pick } from 'lodash';

import type { ITabCountError, ITabCountRequest, ITabCountResponse } from '../tab.types';

import { TabCountTransactionType } from '../tab.types';
import { clientIsSameOriginWithWorker } from '@/libs';

/*************************************************************************************
 * Types                                                                            **
 ************************************************************************************/
interface TabIdentityWorkerState {
  ports: MessagePort[];
  tabs: Record<string, number>;
  nextIndex: number;
  /** any index that was removed */
  danglingIndex: number[];
}
/*************************************************************************************
 * State
 ***********************************************************************************/
const state: TabIdentityWorkerState = {
  ports: [],
  tabs: {},
  nextIndex: 0,
  danglingIndex: [],
};
/*************************************************************************************
 * Life Cycle
 ***********************************************************************************/

///////////////////////// Input capturing //////////////////////////////////////////
/** Captures the input */
function captureRequest(port: MessagePort, event: MessageEvent<ITabCountRequest>) {
  if (!clientIsSameOriginWithWorker(event.origin)) {
    console.warn('[TabIdentityWorker] Rejected message from unauthorized origin:', event.origin);
    return;
  }
  process(port, event.data);
}
///////////////////////// Handle processing //////////////////////////////////////////
/** Processes the input */
function process(port: MessagePort, request: ITabCountRequest) {
  if (isNil(request)) throw new Error('No request found');
  if (isNil(request.payload.id)) {
    const error = new Error('No request ID found');
    return reportError(port, error, request.type, request.metadata?.actionId as unknown as string);
  }

  switch (request.type) {
    case TabCountTransactionType.DECR:
      return endSession(request);
    default:
    case TabCountTransactionType.INCR:
      return processPing(request);
  }
}
function endSession(request: ITabCountRequest) {
  const index = state.tabs[request.payload.id!];
  if (!isNil(index)) {
    delete state.tabs[request.payload.id!];
    state.danglingIndex.push(index);
    const closedPortIndexes: number[] = [];
    for (let i = 0; i < state.ports.length; i++) {
      const p = state.ports[i];
      try {
        dispatchResponse(p, {
          metadata: request.metadata,
          payload: {
            count: Object.keys(state.tabs).length,
            index,
            id: request.payload.id,
          },
          type: request.type,
        } as ITabCountResponse);
      } catch {
        // port already closed, ignore
        closedPortIndexes.push(i);
      }
    }
    for (let i = 0; i < closedPortIndexes.length; i++) {
      state.ports.splice(closedPortIndexes[i], 1);
    }
  }
}
function processPing(request: ITabCountRequest) {
  let index = state.tabs[request.payload.id!];
  if (isNil(index)) {
    index = state.danglingIndex.shift() || state.nextIndex++;
    state.tabs[request.payload.id!] = index;
  }
  const closedPortIndexes: number[] = [];
  for (let i = 0; i < state.ports.length; i++) {
    const p = state.ports[i];
    try {
      dispatchResponse(p, {
        metadata: request.metadata,
        payload: {
          count: Object.keys(state.tabs).length,
          index,
          id: request.payload.id,
        },
        type: request.type,
      } as ITabCountResponse);
    } catch {
      // port already closed, ignore
      closedPortIndexes.push(i);
    }
  }
  for (let i = 0; i < closedPortIndexes.length; i++) {
    state.ports.splice(closedPortIndexes[i], 1);
  }
}
///////////////////////// Dispatch output //////////////////////////////////////////
/** returns the processing result */
function dispatchResponse(port: MessagePort, result: ITabCountResponse | ITabCountError) {
  port.postMessage(result);
}
function reportError(
  port: MessagePort,
  error: unknown,
  type: TabCountTransactionType,
  actionId: string,
) {
  dispatchResponse(port, {
    payload: {
      error,
    },
    type,
    metadata: {
      actionId,
    },
  } as ITabCountError);
}
/*************************************************************************************
 * Event handling
 ***********************************************************************************/
function onMessageError(error: unknown) {
  console.warn('Something went wrong with either the worker end of the port, or the message sent');
  console.error(error);
}
function onError(event: ErrorEvent) {
  console.warn(
    'Something went wrong with this thread',
    pick(event, ['colno', 'filename', 'lineno', 'message']),
  );
  console.error(event.error);
}
function onConnect(event: MessageEvent) {
  const port = event.ports[0] as MessagePort;
  state.ports.push(port);
  port.onmessage = (e) => captureRequest(port, e);
  port.onmessageerror = onMessageError;
  port.start();
}
/*************************************************************************************
 * Bootstrapping
 ***********************************************************************************/
function bootstrap() {
  (self as unknown as SharedWorkerGlobalScope).onconnect = onConnect;
  (self as unknown as SharedWorkerGlobalScope).onerror = onError;
}

bootstrap();
