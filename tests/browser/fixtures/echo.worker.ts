/**
 * @fileoverview
 * @summary Echoes every message back. Used to prove module workers load
 * through the bundler-neutral `new URL(..., import.meta.url)` pattern.
 */
self.addEventListener('message', (event: MessageEvent) => {
  (self as unknown as Worker).postMessage({ echo: event.data });
});
