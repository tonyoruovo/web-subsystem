import { createBrowserEnvironment } from '@platform/global-state';
import { it } from 'vitest';

import { runFlows } from './flows';

it('M3 gate: the 1-to-1 and 1-to-many flows run end to end with complete trails', async () => {
  await runFlows(createBrowserEnvironment());
});
