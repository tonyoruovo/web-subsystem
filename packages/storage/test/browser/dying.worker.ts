/**
 * A coordinator that dies (`self.close()`) when it receives a write of the
 * key "die", before it writes anything. The gate test of M6 uses it.
 */
import { fromPortable } from '@platform/core';
import { serveProcessor } from '@platform/core/worker';

import { createCoordinator, type StorageRequest } from '../../src/coordinator';

const coordinator = createCoordinator();
serveProcessor({
  ...coordinator,
  handle(message, scope) {
    const request = fromPortable<StorageRequest>(message);
    if (request.op === 'set' && request.key === 'die') {
      (self as unknown as { close(): void }).close();
      return new Promise<never>(() => {});
    }
    return coordinator.handle(message as StorageRequest, scope);
  },
});
