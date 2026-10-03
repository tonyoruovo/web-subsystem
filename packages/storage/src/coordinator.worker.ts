/**
 * @fileoverview
 * @summary The worker entry of Storage. It serves the coordinator processor.
 * @description `createStorage` starts this file as a shared worker. You do not import it yourself.
 * @example
 * How the subsystem starts it
 * ```ts
 * new SharedWorker(new URL('./coordinator.worker.ts', import.meta.url), { type: 'module' });
 * ```
 * @author MathAid
 */

import { serveProcessor } from '@platform/core/worker';

import { createCoordinator } from './coordinator';

serveProcessor(createCoordinator());
