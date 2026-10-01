import type { PlatformErrorEvent } from '../manager.dto';

import type { GLOBAL_ERROR_EVENT } from '@/constants';

export type IGlobalEventMap = DocumentEventMap & {
  [GLOBAL_ERROR_EVENT]: PlatformErrorEvent;
};
