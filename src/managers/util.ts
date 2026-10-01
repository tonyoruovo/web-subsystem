import { isNil } from 'lodash';

import type { FunctionLike } from '@/modules/util.dto';
import type { ICleanUp, ICleanUpRecord } from './manager.dto';

import { BasicError, PlatformErrorEvent } from './manager.dto';

export async function tryRun<F extends FunctionLike<never[]>>(
  op: F,
): Promise<ReturnType<typeof op> | void> {
  try {
    const res = op() as ReturnType<typeof op>;
    if (res instanceof Promise) return await res;
    return res;
  } catch (e) {
    const error = new BasicError({ cause: e });
    if (!isNil(window) && !isNil(window.dispatchEvent)) {
      window.dispatchEvent(new PlatformErrorEvent(error));
    } else {
      throw e;
    }
  }
}
export async function runCleanup(cb: ICleanUp, a: unknown) {
  if (typeof cb === 'function') return await cb(a);
  else if (typeof cb === 'object') return (await (cb as Promise<ICleanUpRecord>)).cleanup(a);
}
