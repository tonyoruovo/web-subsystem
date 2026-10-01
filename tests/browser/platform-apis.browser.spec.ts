/**
 * @fileoverview
 * @summary Smoke test for the browser test matrix.
 * @description
 * Checks that every supported browser exposes the APIs the architecture
 * relies on without a fallback, and that a module worker loads through the
 * bundler-neutral pattern (docs/ARCHITECTURE.md §14). APIs that may be
 * missing (for example `SharedWorker`) are not asserted here: the runtime
 * falls back for those (§8.3).
 */
import { describe, expect, it } from 'vitest';

describe('platform APIs', () => {
  it('exposes the APIs used without a fallback', () => {
    expect(typeof MessageChannel).toBe('function');
    expect(typeof BroadcastChannel).toBe('function');
    expect(typeof Worker).toBe('function');
    expect(typeof structuredClone).toBe('function');
    expect(typeof indexedDB).toBe('object');
    expect(typeof crypto.subtle).toBe('object');
  });

  it('round-trips a message through a module worker', async () => {
    const worker = new Worker(new URL('./fixtures/echo.worker.ts', import.meta.url), {
      type: 'module',
    });
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ ping: 1 });
      });
      expect(reply).toEqual({ echo: { ping: 1 } });
    } finally {
      worker.terminate();
    }
  });

  it('delivers a BroadcastChannel message to another channel of the same name', async () => {
    const name = `smoke-${crypto.randomUUID()}`;
    const sender = new BroadcastChannel(name);
    const receiver = new BroadcastChannel(name);
    try {
      const received = new Promise<unknown>((resolve) => {
        receiver.onmessage = (event) => resolve(event.data);
      });
      sender.postMessage({ hello: 'tab' });
      expect(await received).toEqual({ hello: 'tab' });
    } finally {
      sender.close();
      receiver.close();
    }
  });
});
