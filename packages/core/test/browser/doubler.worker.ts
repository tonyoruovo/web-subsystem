// Worker entry for both dedicated and shared workers.
import { serveProcessor } from '../../src/worker';

import { doubler } from './doubler.processor';

serveProcessor(doubler);
