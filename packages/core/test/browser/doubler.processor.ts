/**
 * The processor used by the browser host tests. The same module runs on the
 * virtual host and inside the worker entries.
 */
import { defineProcessor } from '../../src';

export type DoublerInput = number | 'where' | 'freeze';

export const doubler = defineProcessor<DoublerInput, number | string>({
  handle(message, scope) {
    if (message === 'where') return scope.host;
    if (message === 'freeze') {
      // Blocks a worker thread long enough to miss heartbeats; instant on the main thread.
      if (scope.host !== 'virtual') {
        const until = performance.now() + 1_500;
        while (performance.now() < until) {
          /* busy */
        }
        return 'frozen';
      }
      return 'thawed';
    }
    return message * 2;
  },
});
