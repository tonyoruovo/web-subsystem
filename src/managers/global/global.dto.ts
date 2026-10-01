import type { GLOBAL_ERROR_EVENT } from '@/constants';
import type { PlatformErrorEvent } from '../manager.dto';

export type IGlobalEventMap = DocumentEventMap & {
  [GLOBAL_ERROR_EVENT]: PlatformErrorEvent;
};
