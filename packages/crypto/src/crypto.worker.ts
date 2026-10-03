/**
 * @fileoverview
 * @summary The worker entry of the Crypto processor, for shared and dedicated workers.
 * @description
 * `createCrypto` starts this file with
 * `new SharedWorker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })`.
 * Bundlers such as Vite, webpack 5 and Rollup find the file from that
 * expression and emit it as a separate chunk. The file serves the processor on
 * every port that connects, so all tabs of the origin share one key store.
 *
 * @example
 * What `createCrypto` does
 * ```ts
 * shared: () => new SharedWorker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module', name: 'platform-crypto' }),
 * ```
 *
 * @author MathAid
 */

import { serveProcessor } from '@platform/core/worker';

import { createCryptoProcessor } from './processor';

serveProcessor(createCryptoProcessor());
