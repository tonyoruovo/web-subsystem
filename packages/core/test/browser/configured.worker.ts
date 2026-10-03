// Worker entry for the configured processor (dedicated and shared).
import { serveProcessor } from '../../src/worker';

import { configured } from './configured.processor';

serveProcessor(configured);
