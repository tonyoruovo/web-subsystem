/**
 * @fileoverview
 * @summary Ambient declarations for non-standard browser APIs and bundler imports.
 */

/**
 * @summary Brave exposes `navigator.brave` so pages can detect it.
 */
interface Navigator {
  readonly brave?: {
    isBrave(): Promise<boolean>;
  };
}

/**
 * @summary Vite's `?sharedworker` import suffix.
 * @todo M2 replaces this with the bundler-neutral
 * `new SharedWorker(new URL('./x.worker.js', import.meta.url), { type: 'module' })` pattern.
 */
declare module '*?sharedworker' {
  const SharedWorkerConstructor: {
    new (options?: { name?: string }): SharedWorker;
  };
  export default SharedWorkerConstructor;
}
