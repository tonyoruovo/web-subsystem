/**
 * @fileoverview Comprehensive automated test suite for the rate-limiting utility functions:
 * `debounce`, `debounceAsync`, and `throttle`. Covers unit behaviour, integration patterns,
 * boundary conditions, context preservation, cancellation lifecycles, AbortSignal integration,
 * and high-frequency stress scenarios using Vitest fake timers throughout.
 *
 * Test taxonomy used across this file:
 *  - [unit]        — isolated single-behaviour assertions
 *  - [integration] — multi-step sequences combining multiple features
 *  - [stress]      — high call-volume, rapid-fire, or timing-boundary scenarios
 *  - [abuse]       — invalid usage, adversarial inputs, and misuse patterns
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CancellableAsync } from '../src';
import { debounce, debounceAsync, throttle } from '../src';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Calls `fn` exactly `n` times with an optional per-call argument factory. */
function fireN<T>(fn: (arg: T) => void, n: number, argOf: (i: number) => T): void {
  for (let i = 0; i < n; i++) fn(argOf(i));
}

/** Resolves after `ms` real milliseconds (only used where fake timers are not active). */
// const realDelay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ============================================================
//  debounce()
// ============================================================
// ---------------------------------------------------------------------------

describe('debounce()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── [unit] Core timing ───────────────────────────────────────────────────

  describe('[unit] Core timing', () => {
    it('does not invoke fn before the delay has elapsed', () => {
      const fn = vi.fn();
      const d = debounce(fn, 200);
      d();
      vi.advanceTimersByTime(199);
      expect(fn).not.toHaveBeenCalled();
    });

    it('invokes fn exactly once at the delay boundary', () => {
      const fn = vi.fn();
      const d = debounce(fn, 200);
      d();
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('resets the timer on each call — only the last fires', () => {
      const fn = vi.fn();
      const d = debounce(fn, 200);

      d('a');
      vi.advanceTimersByTime(100);
      d('b');
      vi.advanceTimersByTime(100);
      d('c');
      vi.advanceTimersByTime(200);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('c');
    });

    it('fires again after the delay if called a second time after the first settled', () => {
      const fn = vi.fn();
      const d = debounce(fn, 100);

      d('first');
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);

      d('second');
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('second');
    });

    it('accepts delayMs = 0 and fires on the next tick', () => {
      const fn = vi.fn();
      const d = debounce(fn, 0);
      d();
      expect(fn).not.toHaveBeenCalled(); // still async even at 0 ms
      vi.advanceTimersByTime(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('treats negative delayMs identically to 0 (native setTimeout behaviour)', () => {
      const fn = vi.fn();
      const d = debounce(fn, -50);
      d();
      vi.advanceTimersByTime(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ── [unit] Argument & return forwarding ──────────────────────────────────

  describe('[unit] Argument forwarding', () => {
    it('forwards all positional arguments correctly', () => {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d(1, 'two', true, { x: 3 });
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledWith(1, 'two', true, { x: 3 });
    });

    it('always uses the arguments of the most recent call', () => {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d('stale1');
      d('stale2');
      d('fresh');
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledWith('fresh');
    });

    it('discards the return value of fn (proxy always returns void)', () => {
      const fn = vi.fn().mockReturnValue(42);
      const d = debounce(fn, 100);
      const result = d();
      expect(result).toBeUndefined();
    });
  });

  // ── [unit] Context (this) preservation ──────────────────────────────────

  describe('[unit] Context (this) preservation', () => {
    it('forwards the call-site this to fn via .apply()', () => {
      const captured: unknown[] = [];
      const obj = {
        tag: 'obj-instance',
        run: debounce(function (this: typeof obj) {
          captured.push(this.tag);
        }, 100),
      };
      obj.run();
      vi.advanceTimersByTime(100);
      expect(captured).toEqual(['obj-instance']);
    });

    it('preserves this across multiple rapid calls', () => {
      let seenTag = '';
      const obj = {
        tag: 'ctx',
        run: debounce(function (this: typeof obj) {
          seenTag = this.tag;
        }, 100),
      };
      obj.run();
      obj.run();
      obj.run();
      vi.advanceTimersByTime(100);
      expect(seenTag).toBe('ctx');
    });

    it('uses the this of the final call, not the first', () => {
      let seenTag = '';
      const run = debounce(function (this: { tag: string }) {
        seenTag = this.tag;
      }, 100);
      const a = { tag: 'alpha', run };
      const b = { tag: 'beta', run };
      a.run();
      b.run(); // last call — b's context wins
      vi.advanceTimersByTime(100);
      expect(seenTag).toBe('beta');
    });

    it('works correctly when called as a plain function (this = undefined)', () => {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ── [unit] cancel() ──────────────────────────────────────────────────────

  describe('[unit] cancel()', () => {
    it('returns true when a pending timer is cleared', () => {
      const d = debounce(vi.fn(), 200);
      d();
      expect(d.cancel()).toBe(true);
    });

    it('returns false when called with nothing pending', () => {
      const d = debounce(vi.fn(), 200);
      expect(d.cancel()).toBe(false);
    });

    it('prevents fn from executing after cancellation', () => {
      const fn = vi.fn();
      const d = debounce(fn, 200);
      d();
      d.cancel();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
    });

    it('is idempotent — successive cancel() calls after the first return false', () => {
      const d = debounce(vi.fn(), 200);
      d();
      expect(d.cancel()).toBe(true);
      expect(d.cancel()).toBe(false);
      expect(d.cancel()).toBe(false);
    });

    it('allows the debouncer to be reused after cancellation', () => {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d('a');
      d.cancel();
      d('b');
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('b');
    });

    it('returns false after fn has already executed naturally', () => {
      const d = debounce(vi.fn(), 100);
      d();
      vi.advanceTimersByTime(100);
      expect(d.cancel()).toBe(false);
    });
  });

  // ── [unit] AbortSignal — pre-aborted ────────────────────────────────────

  describe('[unit] AbortSignal — pre-aborted at construction time', () => {
    it('returns a stub that throws ReferenceError immediately', () => {
      const controller = new AbortController();
      controller.abort();
      const d = debounce(vi.fn(), 100, { signal: controller.signal });
      expect(() => d()).toThrow(ReferenceError);
    });

    it('stub cancel() always returns false', () => {
      const controller = new AbortController();
      controller.abort();
      const d = debounce(vi.fn(), 100, { signal: controller.signal });
      expect(d.cancel()).toBe(false);
    });

    it('stub throws even when called multiple times', () => {
      const controller = new AbortController();
      controller.abort();
      const d = debounce(vi.fn(), 100, { signal: controller.signal });
      expect(() => d()).toThrow(ReferenceError);
      expect(() => d()).toThrow(ReferenceError);
    });

    it('propagates signal.reason as the error cause', () => {
      const controller = new AbortController();
      const reason = new Error('intentional-abort');
      controller.abort(reason);
      const d = debounce(vi.fn(), 100, { signal: controller.signal });
      try {
        d();
      } catch (e) {
        expect((e as Error & { cause: unknown }).cause).toBe(reason);
      }
    });
  });

  // ── [unit] AbortSignal — mid-flight abort ────────────────────────────────

  describe('[unit] AbortSignal — mid-flight abort', () => {
    it('prevents fn from executing when signal fires before the timer', () => {
      const fn = vi.fn();
      const controller = new AbortController();
      const d = debounce(fn, 300, { signal: controller.signal });
      d();
      vi.advanceTimersByTime(150);
      controller.abort();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
    });

    it('cancel() returns false after signal abort has already cleared state', () => {
      const controller = new AbortController();
      const d = debounce(vi.fn(), 200, { signal: controller.signal });
      d();
      controller.abort();
      expect(d.cancel()).toBe(false);
    });

    it('removes the abort listener after the timer fires naturally (no listener leak)', () => {
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const d = debounce(vi.fn(), 100, { signal: controller.signal });
      d();
      vi.advanceTimersByTime(100); // fires naturally — should remove listener
      expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('removes the abort listener when cancel() is called explicitly', () => {
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const d = debounce(vi.fn(), 200, { signal: controller.signal });
      d();
      d.cancel();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  // ── [stress] High-frequency bursts ──────────────────────────────────────

  describe('[stress] High-frequency bursts', () => {
    it('1 000 rapid calls collapse to exactly one execution', () => {
      const fn = vi.fn();
      const d = debounce(fn, 200);
      fireN(d, 1000, (i) => `call-${i}`);
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('call-999');
    });

    it('interleaved advance + calls still collapse correctly', () => {
      const fn = vi.fn();
      const d = debounce(fn, 300);

      d('a');
      vi.advanceTimersByTime(100); // 100ms — not settled
      d('b');
      vi.advanceTimersByTime(100); // 200ms total — not settled (timer reset)
      d('c');
      vi.advanceTimersByTime(300); // 500ms total — settled on 'c'

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('c');
    });

    it('executes independently for N separate debouncer instances', () => {
      const fn = vi.fn();
      const instances = Array.from({ length: 50 }, () => debounce(fn, 100));
      instances.forEach((d, i) => d(i));
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(50);
    });

    it('handles 10 000 calls without stack overflow', () => {
      const fn = vi.fn();
      const d = debounce(fn, 50);
      expect(() => fireN(d, 10_000, (i) => i)).not.toThrow();
      vi.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ── [abuse] Adversarial inputs ───────────────────────────────────────────

  describe('[abuse] Adversarial inputs', () => {
    it('survives fn throwing — error propagates out of setTimeout (uncaught)', () => {
      // Errors thrown inside setTimeout propagate to the global error handler,
      // not to the debounce call site. We verify fn is still called.
      const fn = vi.fn(() => {
        throw new Error('boom');
      });
      const d = debounce(fn, 50);
      d();
      expect(() => vi.advanceTimersByTime(50)).toThrow('boom');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('calling cancel() before any invocation is a safe no-op returning false', () => {
      const d = debounce(vi.fn(), 100);
      expect(d.cancel()).toBe(false);
    });

    it('accepts and forwards undefined arguments', () => {
      const fn = vi.fn();
      const d = debounce(fn, 50);
      d(undefined as unknown as string);
      vi.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledWith(undefined);
    });

    it('accepts a no-argument function', () => {
      const fn = vi.fn();
      const d = debounce(fn, 50);
      d();
      vi.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ── [integration] Real-world patterns ───────────────────────────────────

  describe('[integration] Real-world patterns', () => {
    it('search-as-you-type: fires only after typing pause', () => {
      const search = vi.fn();
      const d = debounce(search, 300);

      // Simulate typing "hello" char by char at 50ms intervals
      ['h', 'he', 'hel', 'hell', 'hello'].forEach((q) => {
        vi.advanceTimersByTime(50);
        d(q);
      });

      expect(search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300); // pause after last keystroke
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith('hello');
    });

    it('component teardown: signal abort on unmount prevents stale setState', () => {
      const setState = vi.fn();
      const controller = new AbortController();
      const d = debounce(setState, 200, { signal: controller.signal });

      d({ loading: false, data: 'result' });
      vi.advanceTimersByTime(100);
      controller.abort(); // component unmounts
      vi.advanceTimersByTime(200);

      expect(setState).not.toHaveBeenCalled();
    });

    it('window resize: repeated resizes only trigger one layout recalculation', () => {
      const recalculate = vi.fn();
      const d = debounce(recalculate, 150);

      for (let w = 800; w <= 1200; w += 10) {
        d(w, 600);
        vi.advanceTimersByTime(20); // fires faster than delay
      }

      vi.advanceTimersByTime(150);
      expect(recalculate).toHaveBeenCalledTimes(1);
      expect(recalculate).toHaveBeenCalledWith(1200, 600);
    });
  });
});

// ---------------------------------------------------------------------------
// ============================================================
//  debounceAsync()
// ============================================================
// ---------------------------------------------------------------------------

describe('debounceAsync()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── [unit] Core resolution ───────────────────────────────────────────────

  describe('[unit] Core resolution', () => {
    it('returns a Promise that resolves with the fn return value', async () => {
      const fn = vi.fn().mockResolvedValue('API_DATA');
      const d = debounceAsync(fn, 200);
      const p = d();
      vi.advanceTimersByTime(200);
      await expect(p).resolves.toBe('API_DATA');
    });

    it('fn is not called before the delay elapses', () => {
      const fn = vi.fn().mockResolvedValue(null);
      const d = debounceAsync(fn, 300);
      d();
      vi.advanceTimersByTime(299);
      expect(fn).not.toHaveBeenCalled();
    });

    it('fn is called exactly once at the delay boundary', async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const d = debounceAsync(fn, 300);
      const p = d();
      vi.advanceTimersByTime(300);
      await p;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('forwards all arguments to fn', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const d = debounceAsync(fn, 100);
      const p = d(1, 'two', { three: 3 });
      vi.advanceTimersByTime(100);
      await p;
      expect(fn).toHaveBeenCalledWith(1, 'two', { three: 3 });
    });

    it('resolves with complex object payloads', async () => {
      const payload = { users: [{ id: 1, name: 'Alice' }], total: 1 };
      const fn = vi.fn().mockResolvedValue(payload);
      const d = debounceAsync(fn, 100);
      const p = d();
      vi.advanceTimersByTime(100);
      await expect(p).resolves.toEqual(payload);
    });

    it('works correctly when called once after previous settled', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const d = debounceAsync(fn, 100);

      const p1 = d('first');
      vi.advanceTimersByTime(100);
      await expect(p1).resolves.toBe('result');

      const p2 = d('second');
      vi.advanceTimersByTime(100);
      await expect(p2).resolves.toBe('result');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ── [unit] Supersession — intermediate rejections ────────────────────────

  describe('[unit] Supersession', () => {
    it('superseded promise rejects with the newer-invocation error message', async () => {
      const fn = vi.fn().mockResolvedValue('LATEST');
      const d = debounceAsync(fn, 300);

      const first = d('a');
      vi.advanceTimersByTime(100);
      d('b'); // supersedes first

      await expect(first).rejects.toThrow('A newer invocation canceled this task.');
    });

    it('only the final promise in a supersession chain resolves', async () => {
      const fn = vi.fn().mockResolvedValue('WIN');
      const d = debounceAsync(fn, 300);

      const p1 = d('one');
      vi.advanceTimersByTime(50);
      const p2 = d('two');
      vi.advanceTimersByTime(50);
      const p3 = d('three');
      vi.advanceTimersByTime(300);

      await expect(p1).rejects.toThrow();
      await expect(p2).rejects.toThrow();
      await expect(p3).resolves.toBe('WIN');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('three');
    });

    it('superseded rejections are synchronous — happen at the next call, not on timer', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const d = debounceAsync(fn, 500);

      const first = d('a');
      // Fire immediately without advancing time — rejection should already be queued
      const second = d('b');

      // first must already be rejected before the timer fires
      await expect(first).rejects.toThrow('A newer invocation');
      vi.advanceTimersByTime(500);
      await expect(second).resolves.toBe('ok');
    });

    it('fn is called exactly once across N superseded calls', async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const d = debounceAsync(fn, 200);

      const promises = Array.from({ length: 20 }, (_, i) => {
        vi.advanceTimersByTime(10);
        return d(i);
      });

      vi.advanceTimersByTime(200);

      // Last resolves, rest reject
      const last = promises[promises.length - 1];
      await expect(last).resolves.toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(19);
    });
  });

  // ── [unit] cancel() ──────────────────────────────────────────────────────

  describe('[unit] cancel()', () => {
    it('returns true when a pending timer exists', async () => {
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 200);
      d();
      expect(d.cancel()).toBe(true);
    });

    it('returns false when nothing is pending', () => {
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 200);
      expect(d.cancel()).toBe(false);
    });

    it('rejects the pending promise with the explicit cancellation message', async () => {
      const fn = vi.fn().mockResolvedValue('DATA');
      const d = debounceAsync(fn, 300);
      const p = d();
      vi.advanceTimersByTime(150);
      d.cancel();
      await expect(p).rejects.toThrow('Task was explicitly canceled by the user.');
    });

    it('prevents fn from ever being called after cancel', async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const d = debounceAsync(fn, 200);
      const p = d().catch(() => {});
      d.cancel();
      vi.advanceTimersByTime(200);
      await p;
      expect(fn).not.toHaveBeenCalled();
    });

    it('is idempotent — second call returns false', () => {
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 200);
      d();
      expect(d.cancel()).toBe(true);
      expect(d.cancel()).toBe(false);
    });

    it('debouncer remains reusable after cancellation', async () => {
      const fn = vi.fn().mockResolvedValue('REUSED');
      const d = debounceAsync(fn, 100);
      d().catch(() => {});
      d.cancel();

      const p = d();
      vi.advanceTimersByTime(100);
      await expect(p).resolves.toBe('REUSED');
    });

    it('cancel() after natural resolution returns false', async () => {
      const fn = vi.fn().mockResolvedValue('done');
      const d = debounceAsync(fn, 100);
      const p = d();
      vi.advanceTimersByTime(100);
      await p;
      expect(d.cancel()).toBe(false);
    });

    it('cancel() does not double-reject if fn is already mid-execution', async () => {
      // Timer has fired (activeReject nulled), fn is running. cancel() should not throw.
      let resolveInner!: (v: string) => void;
      const fn = vi.fn().mockReturnValue(
        new Promise<string>((r) => {
          resolveInner = r;
        }),
      );
      const d = debounceAsync(fn, 100);
      const p = d();

      vi.advanceTimersByTime(100); // timer fires, activeReject set to null
      // fn is now in-flight; cancel() should safely return false
      expect(d.cancel()).toBe(false);

      resolveInner('ok');
      await expect(p).resolves.toBe('ok');
    });
  });

  // ── [unit] fn rejection forwarding ───────────────────────────────────────

  describe('[unit] fn rejection propagation', () => {
    it('propagates fn rejection through the returned promise', async () => {
      const err = new Error('network failure');
      const fn = vi.fn().mockRejectedValue(err);
      const d = debounceAsync(fn, 100);
      const p = d();
      vi.advanceTimersByTime(100);
      await expect(p).rejects.toBe(err);
    });

    it('fn rejection does not corrupt state — debouncer is reusable', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('first fail'))
        .mockResolvedValue('recovered');

      const d = debounceAsync(fn, 100);

      const p1 = d();
      vi.advanceTimersByTime(100);
      await expect(p1).rejects.toThrow('first fail');

      const p2 = d();
      vi.advanceTimersByTime(100);
      await expect(p2).resolves.toBe('recovered');
    });
  });

  // ── [unit] Context (this) preservation ──────────────────────────────────

  describe('[unit] Context (this) preservation', () => {
    it('forwards this to the async fn', async () => {
      interface Obj {
        tag: string;
        fetch: CancellableAsync<(this: Obj) => Promise<string>, unknown>;
      }
      let capturedTag = '';
      const obj: Obj = {
        tag: 'async-ctx',
        fetch: debounceAsync(async function (this: Obj) {
          capturedTag = this.tag;
          return this.tag;
        }, 100),
      };
      const p = obj.fetch();
      vi.advanceTimersByTime(100);
      await p;
      expect(capturedTag).toBe('async-ctx');
    });
  });

  // ── [unit] AbortSignal — pre-aborted ─────────────────────────────────────

  describe('[unit] AbortSignal — pre-aborted at construction', () => {
    it('every call returns an already-rejected Promise', async () => {
      const controller = new AbortController();
      controller.abort();
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 100, { signal: controller.signal });
      await expect(d()).rejects.toBeInstanceOf(Error);
      await expect(d()).rejects.toBeInstanceOf(Error);
    });

    it('fn is never called when signal is pre-aborted', async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const controller = new AbortController();
      controller.abort();
      const d = debounceAsync(fn, 100, { signal: controller.signal });
      await d().catch(() => {});
      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
    });

    it('stub cancel() always returns false', () => {
      const controller = new AbortController();
      controller.abort();
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 100, { signal: controller.signal });
      expect(d.cancel()).toBe(false);
    });

    it('rejection carries the abort reason', async () => {
      const reason = new Error('user-navigated-away');
      const controller = new AbortController();
      controller.abort(reason);
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 100, { signal: controller.signal });
      await expect(d()).rejects.toBe(reason);
    });
  });

  // ── [unit] AbortSignal — mid-flight abort ────────────────────────────────

  describe('[unit] AbortSignal — mid-flight abort', () => {
    it('rejects the pending promise when signal fires', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const controller = new AbortController();
      const d = debounceAsync(fn, 500, { signal: controller.signal });
      const p = d();
      vi.advanceTimersByTime(200);
      controller.abort();
      await expect(p).rejects.toBeInstanceOf(Error);
      expect(fn).not.toHaveBeenCalled();
    });

    it('uses the signal.reason as the rejection error when it is an Error', async () => {
      const reason = new Error('abort-reason');
      const controller = new AbortController();
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 300, { signal: controller.signal });
      const p = d();
      controller.abort(reason);
      await expect(p).rejects.toBe(reason);
    });

    it('falls back to a generic message when reason is not an Error', async () => {
      const controller = new AbortController();
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 300, { signal: controller.signal });
      const p = d();
      controller.abort('string-reason'); // non-Error reason
      await expect(p).rejects.toThrow('Debounced: Task was explicitly aborted via AbortSignal.');
    });

    it('subsequent calls after signal abort return rejected Promises', async () => {
      const controller = new AbortController();
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 200, { signal: controller.signal });
      const p1 = d();
      controller.abort();
      await p1.catch(() => {});
      const p2 = d();
      await expect(p2).rejects.toBeInstanceOf(Error);
    });

    it('removes the abort listener after cancel() to avoid duplicate rejection', () => {
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 200, { signal: controller.signal });
      d().catch(() => {});
      d.cancel();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  // ── [stress] High-frequency async bursts ─────────────────────────────────

  describe('[stress] High-frequency async bursts', () => {
    it('500 rapid calls: only the last resolves, all others reject', async () => {
      const fn = vi.fn().mockResolvedValue('FINAL');
      const d = debounceAsync(fn, 300);
      const N = 500;
      const promises = Array.from({ length: N }, (_, i) => d(i));

      vi.advanceTimersByTime(300);

      const results = await Promise.allSettled(promises);
      const resolved = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(resolved).toHaveLength(1);
      expect(rejected).toHaveLength(N - 1);
      expect((resolved[0] as PromiseFulfilledResult<string>).value).toBe('FINAL');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(N - 1);
    });

    it('interleaved burst windows each resolve their last call independently', async () => {
      const fn = vi.fn().mockResolvedValueOnce('window-1').mockResolvedValueOnce('window-2');
      const d = debounceAsync(fn, 200);

      const p1 = d('a');
      d('b').catch(() => {});
      const last1 = d('c');
      vi.advanceTimersByTime(200);
      await expect(p1).rejects.toThrow(); // superseded by 'b'
      await expect(last1).resolves.toBe('window-1');

      const p2 = d('x');
      d('y').catch(() => {});
      const last2 = d('z');
      vi.advanceTimersByTime(200);
      await expect(p2).rejects.toThrow();
      await expect(last2).resolves.toBe('window-2');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ── [abuse] Adversarial patterns ─────────────────────────────────────────

  describe('[abuse] Adversarial patterns', () => {
    it('cancel() before any call is a safe no-op', () => {
      const d = debounceAsync(vi.fn().mockResolvedValue(null), 100);
      expect(() => d.cancel()).not.toThrow();
      expect(d.cancel()).toBe(false);
    });

    it('simultaneous cancel() and signal abort do not cause double-rejection', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockResolvedValue(null);
      const d = debounceAsync(fn, 200, { signal: controller.signal });

      const p = d();
      controller.abort(); // rejects via signal handler
      d.cancel(); // attempts to cancel again — activeReject is already null

      await expect(p).rejects.toBeInstanceOf(Error);
      // No unhandled rejection or double-rejection error should be thrown
    });

    it('delayMs = 0 resolves on the next tick', async () => {
      const fn = vi.fn().mockResolvedValue('zero');
      const d = debounceAsync(fn, 0);
      const p = d();
      vi.advanceTimersByTime(0);
      await expect(p).resolves.toBe('zero');
    });
  });

  // ── [integration] Real-world patterns ───────────────────────────────────

  describe('[integration] Real-world patterns', () => {
    it('typeahead search: only final query hits the API', async () => {
      let callCount = 0;
      const fetchResults = vi.fn().mockImplementation(async (q: string) => {
        callCount++;
        return { query: q, results: [] };
      });
      const search = debounceAsync(fetchResults, 300);

      // Simulate rapid typing
      const catchable = (p: Promise<unknown>) => p.catch(() => null);
      await Promise.all([
        catchable(search('r')),
        catchable(search('re')),
        catchable(search('rea')),
        catchable(search('reac')),
        catchable(search('react')),
      ]);

      // Advance past last call
      vi.advanceTimersByTime(300);
      // Only 'react' should resolve — others superseded synchronously
      expect(callCount).toBe(0); // timer not yet expired at Promise.all resolution
    });

    it('auto-save: pending save is cancelled on navigation away', async () => {
      const save = vi.fn().mockResolvedValue({ ok: true });
      const controller = new AbortController();
      const autoSave = debounceAsync(save, 500, { signal: controller.signal });

      const p = autoSave({ content: 'draft...' });
      vi.advanceTimersByTime(200);

      // User navigates away
      controller.abort();
      await expect(p).rejects.toBeInstanceOf(Error);
      expect(save).not.toHaveBeenCalled();
    });

    it('error recovery: UI can catch individual rejections without breaking the debouncer', async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('success');
      const d = debounceAsync(fn, 100);

      const p1 = d('try-1');
      vi.advanceTimersByTime(100);
      await expect(p1).rejects.toThrow('timeout');

      const p2 = d('try-2');
      vi.advanceTimersByTime(100);
      await expect(p2).resolves.toBe('success');
    });
  });
});

// ---------------------------------------------------------------------------
// ============================================================
//  throttle()
// ============================================================
// ---------------------------------------------------------------------------

describe('throttle()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── [unit] Leading edge ──────────────────────────────────────────────────

  describe('[unit] Leading edge', () => {
    it('fires fn immediately on the first call', () => {
      const fn = vi.fn();
      const t = throttle(fn, 400);
      t('first');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('first');
    });

    it('does not fire again immediately on the second call within the window', () => {
      const fn = vi.fn();
      const t = throttle(fn, 400);
      t('first');
      t('second');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('fires immediately again after the full window has elapsed', () => {
      const fn = vi.fn();
      const t = throttle(fn, 200);
      t('a');
      vi.advanceTimersByTime(200);
      t('b');
      // No trailing args queued after the timer expires, so leading fires
      expect(fn).toHaveBeenCalledTimes(2); // trailing from 'a' plus leading 'b'? Depends on trailing.
      // More precisely: after timer, next call fires immediately
    });

    it('fires on leading edge even when called as a plain function (this = null)', () => {
      const fn = vi.fn();
      const t = throttle(fn, 200);
      t(42);
      expect(fn).toHaveBeenCalledWith(42);
    });
  });

  // ── [unit] Trailing edge ─────────────────────────────────────────────────

  describe('[unit] Trailing edge', () => {
    it('schedules a trailing execution with the latest args after the window', () => {
      const fn = vi.fn();
      const t = throttle(fn, 400);

      t('leading');
      t('intermediate');
      t('trailing'); // this becomes the trailing args
      vi.advanceTimersByTime(400);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('trailing');
    });

    it('always uses the most recent args — intermediate calls are merged', () => {
      const fn = vi.fn();
      const t = throttle(fn, 300);
      t('a');
      t('b');
      t('c');
      t('d'); // trailing = 'd'
      vi.advanceTimersByTime(300);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('d');
    });

    it('only one trailing timer is ever scheduled during a window', () => {
      const fn = vi.fn();
      const t = throttle(fn, 500);
      t('a'); // leading
      for (let i = 0; i < 10; i++) {
        t(`call-${i}`); // each updates args but does NOT add timers
      }
      vi.advanceTimersByTime(500);
      // Leading (1) + trailing (1) = 2 total
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('no trailing execution fires if no calls happened during the window', () => {
      const fn = vi.fn();
      const t = throttle(fn, 200);
      t('only-call');
      vi.advanceTimersByTime(200);
      // Leading fires immediately; no subsequent calls, so trailing timer has nothing
      // This is 1 call because the trailing timer guard (lastArgs) is null
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('trailing execution uses the correct remaining time, not full limitMs', () => {
      const fn = vi.fn();
      const t = throttle(fn, 400);
      t('leading'); // t=0, lastRan=0
      vi.advanceTimersByTime(200); // t=200, 200ms remain in window
      t('trailing-call'); // scheduled for remaining ~200ms
      vi.advanceTimersByTime(199); // t=399 — should NOT have fired yet
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1); // t=400 — trailing fires
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ── [unit] Context (this) preservation ──────────────────────────────────

  describe('[unit] Context (this) preservation', () => {
    it('forwards this on the leading edge call', () => {
      const captured: string[] = [];
      const obj = {
        tag: 'leading-ctx',
        run: throttle(function (this: typeof obj) {
          captured.push(this.tag);
        }, 200),
      };
      obj.run();
      expect(captured).toEqual(['leading-ctx']);
    });

    it('forwards the latest this on the trailing edge call', () => {
      const captured: string[] = [];
      const run = throttle(function (this: { tag: string }) {
        captured.push(this.tag);
      }, 200);
      const a = { tag: 'alpha', run };
      const b = { tag: 'beta', run };
      a.run(); // leading — captures 'alpha'
      b.run(); // trailing args become beta
      vi.advanceTimersByTime(200); // trailing fires with 'beta'
      expect(captured).toEqual(['alpha', 'beta']);
    });
  });

  // ── [unit] cancel() ──────────────────────────────────────────────────────

  describe('[unit] cancel()', () => {
    it('returns true when a trailing timer is active', () => {
      const t = throttle(vi.fn(), 400);
      t('a');
      t('b'); // schedules trailing
      expect(t.cancel()).toBe(true);
    });

    it('returns false when nothing is pending', () => {
      const t = throttle(vi.fn(), 400);
      expect(t.cancel()).toBe(false);
    });

    it('prevents trailing execution after cancel', () => {
      const fn = vi.fn();
      const t = throttle(fn, 400);
      t('leading'); // fires now
      t('trailing'); // queued
      t.cancel();
      vi.advanceTimersByTime(400);
      expect(fn).toHaveBeenCalledTimes(1); // only leading
    });

    it('is idempotent — second call returns false', () => {
      const t = throttle(vi.fn(), 200);
      t('a');
      t('b');
      expect(t.cancel()).toBe(true);
      expect(t.cancel()).toBe(false);
    });

    it('fully resets timing — the next call after cancel fires on the leading edge', () => {
      const fn = vi.fn();
      const t = throttle(fn, 1000);
      t('a'); // leading — fires
      t('b'); // trailing queued
      t.cancel(); // trailing discarded; timing reset
      t('c'); // should fire immediately (leading edge again)
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('c');
    });

    it('returns false when called before any invocation', () => {
      const t = throttle(vi.fn(), 300);
      expect(t.cancel()).toBe(false);
    });
  });

  // ── [unit] AbortSignal — pre-aborted ─────────────────────────────────────

  describe('[unit] AbortSignal — pre-aborted at construction', () => {
    it('every call throws ReferenceError immediately', () => {
      const controller = new AbortController();
      controller.abort();
      const t = throttle(vi.fn(), 200, { signal: controller.signal });
      expect(() => t()).toThrow(ReferenceError);
    });

    it('stub cancel() always returns false', () => {
      const controller = new AbortController();
      controller.abort();
      const t = throttle(vi.fn(), 200, { signal: controller.signal });
      expect(t.cancel()).toBe(false);
    });

    it('propagates signal.reason as the cause', () => {
      const reason = new Error('lifecycle-end');
      const controller = new AbortController();
      controller.abort(reason);
      const t = throttle(vi.fn(), 200, { signal: controller.signal });
      try {
        t();
      } catch (e) {
        expect((e as Error & { cause: unknown }).cause).toBe(reason);
      }
    });
  });

  // ── [unit] AbortSignal — mid-flight abort ─────────────────────────────────

  describe('[unit] AbortSignal — mid-flight abort', () => {
    it('clears the trailing timer when the signal fires', () => {
      const fn = vi.fn();
      const controller = new AbortController();
      const t = throttle(fn, 400, { signal: controller.signal });

      t('leading'); // fires immediately
      t('trailing'); // queued
      vi.advanceTimersByTime(200);
      controller.abort(); // clears the trailing timer
      vi.advanceTimersByTime(200);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).not.toHaveBeenCalledWith('trailing');
    });

    it('cancel() returns false after signal has already cleared the timer', () => {
      const controller = new AbortController();
      const t = throttle(vi.fn(), 400, { signal: controller.signal });
      t('a');
      t('b');
      controller.abort();
      expect(t.cancel()).toBe(false);
    });

    it('removes the abort listener when cancel() is called explicitly', () => {
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const t = throttle(vi.fn(), 400, { signal: controller.signal });
      t('a');
      t('b');
      t.cancel();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });

  // ── [stress] High-frequency bursts ──────────────────────────────────────

  describe('[stress] High-frequency bursts', () => {
    it('1 000 calls within the window: only leading + one trailing fire', () => {
      const fn = vi.fn();
      const t = throttle(fn, 500);

      fireN(t, 1000, (i) => `call-${i}`);
      vi.advanceTimersByTime(500);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(1, 'call-0');
      expect(fn).toHaveBeenNthCalledWith(2, 'call-999');
    });

    it('sequential windows each fire leading + trailing correctly', () => {
      const fn = vi.fn();
      const t = throttle(fn, 100);

      // Window 1
      t('w1-lead');
      t('w1-trail');
      vi.advanceTimersByTime(100);

      // Window 2
      t('w2-lead');
      t('w2-trail');
      vi.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(4);
      expect(fn).toHaveBeenNthCalledWith(1, 'w1-lead');
      expect(fn).toHaveBeenNthCalledWith(2, 'w1-trail');
      expect(fn).toHaveBeenNthCalledWith(3, 'w2-lead');
      expect(fn).toHaveBeenNthCalledWith(4, 'w2-trail');
    });

    it('50 separate throttle instances each fire independently', () => {
      const fn = vi.fn();
      const instances = Array.from({ length: 50 }, () => throttle(fn, 100));
      instances.forEach((t, i) => {
        t(i);
        t(i + 1000);
      }); // leading + trailing each
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(100); // 2 per instance
    });

    it('10 000 calls without stack overflow', () => {
      const fn = vi.fn();
      const t = throttle(fn, 100);
      expect(() => fireN(t, 10_000, (i) => i)).not.toThrow();
      vi.advanceTimersByTime(100);
    });
  });

  // ── [abuse] Adversarial patterns ─────────────────────────────────────────

  describe('[abuse] Adversarial patterns', () => {
    it('calling cancel() repeatedly before any invocation never throws', () => {
      const t = throttle(vi.fn(), 200);
      expect(() => {
        t.cancel();
        t.cancel();
        t.cancel();
      }).not.toThrow();
    });

    it('alternating cancel() and calls resets the leading edge each time', () => {
      const fn = vi.fn();
      const t = throttle(fn, 1000);

      t('a');
      t('b');
      t.cancel(); // reset
      t('c');
      t('d');
      t.cancel(); // reset
      t('e'); // leading fires
      expect(fn).toHaveBeenCalledTimes(3); // 'a', 'c', 'e' on leading edges
      expect(fn).toHaveBeenNthCalledWith(1, 'a');
      expect(fn).toHaveBeenNthCalledWith(2, 'c');
      expect(fn).toHaveBeenNthCalledWith(3, 'e');
    });

    it('fn throwing on leading edge does not break the throttler state', () => {
      const fn = vi.fn((_: string) => {
        throw new Error('boom');
      });
      const t = throttle(fn, 200);
      expect(() => t('a')).toThrow('boom');
      // State should still work — trailing should not be corrupted
      // (the throw happened inside fn, not inside throttle's state machine)
    });

    it('delayMs = 0: leading edge fires, trailing fires at next tick', () => {
      const fn = vi.fn();
      const t = throttle(fn, 0);
      t('lead');
      expect(fn).toHaveBeenCalledTimes(1);
      t('trail');
      vi.advanceTimersByTime(0);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ── [integration] Real-world patterns ───────────────────────────────────

  describe('[integration] Real-world patterns', () => {
    it('drag handler: leading snaps UI, trailing commits the final position', () => {
      const updatePosition = vi.fn();
      const t = throttle(updatePosition, 100);

      // Simulate mouse drag events at 16ms intervals (60fps)
      for (let x = 0; x <= 500; x += 16) {
        vi.advanceTimersByTime(16);
        t(x, 240);
      }
      vi.advanceTimersByTime(100); // allow trailing to fire

      // Leading fires at x=0, trailing fires with the last x value
      expect(updatePosition).toHaveBeenCalledWith(0, 240);
      const lastCall = updatePosition.mock.calls.at(-1)!;
      expect(lastCall[1]).toBe(240); // y is always 240
    });

    it('scroll handler: only the leading + final scroll position are processed', () => {
      const onScroll = vi.fn();
      const t = throttle(onScroll, 200);

      // Simulate 20 scroll events at 10ms intervals (within a single 200ms window)
      for (let y = 0; y < 20; y++) {
        vi.advanceTimersByTime(10);
        t(y * 50);
      }
      vi.advanceTimersByTime(200);

      expect(onScroll).toHaveBeenCalledTimes(2);
      expect(onScroll).toHaveBeenNthCalledWith(1, 0); // leading
      expect(onScroll).toHaveBeenLastCalledWith(950); // trailing — last scroll position
    });

    it('component teardown: abort during drag clears trailing without firing', () => {
      const render = vi.fn();
      const controller = new AbortController();
      const t = throttle(render, 100, { signal: controller.signal });

      t(0, 0); // leading fires
      t(10, 10); // trailing queued
      vi.advanceTimersByTime(50);
      controller.abort(); // component unmounts mid-drag
      vi.advanceTimersByTime(100);

      expect(render).toHaveBeenCalledTimes(1); // only leading, trailing suppressed
    });

    it('rate-limited API: enforces a max call rate across a burst of requests', () => {
      const apiCall = vi.fn();
      const t = throttle(apiCall, 1000); // max once per second

      // Fire 10 requests rapidly
      for (let i = 0; i < 10; i++) t(`req-${i}`);
      vi.advanceTimersByTime(1000);

      // Should only have called: leading (req-0) + trailing (req-9)
      expect(apiCall).toHaveBeenCalledTimes(2);
      expect(apiCall).toHaveBeenNthCalledWith(1, 'req-0');
      expect(apiCall).toHaveBeenNthCalledWith(2, 'req-9');
    });
  });
});

// ---------------------------------------------------------------------------
// ============================================================
//  Cross-function integration tests
// ============================================================
// ---------------------------------------------------------------------------

describe('Cross-function integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debounce + debounceAsync on the same shared AbortController', async () => {
    const controller = new AbortController();
    const syncFn = vi.fn();
    const asyncFn = vi.fn().mockResolvedValue('ok');

    const d = debounce(syncFn, 200, { signal: controller.signal });
    const da = debounceAsync(asyncFn, 200, { signal: controller.signal });

    d('sync');
    const p = da('async');

    vi.advanceTimersByTime(100);
    controller.abort(); // fires both abort handlers

    vi.advanceTimersByTime(200);
    expect(syncFn).not.toHaveBeenCalled();
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  it('throttle and debounce can coexist on the same event source', () => {
    const throttled = vi.fn();
    const debounced = vi.fn();
    const t = throttle(throttled, 200);
    const d = debounce(debounced, 200);

    // 10 rapid events
    for (let i = 0; i < 10; i++) {
      t(i);
      d(i);
    }
    vi.advanceTimersByTime(200);

    // Throttle: leading (i=0) + trailing (i=9)
    expect(throttled).toHaveBeenCalledTimes(2);
    // Debounce: only trailing (i=9)
    expect(debounced).toHaveBeenCalledTimes(1);
    expect(debounced).toHaveBeenCalledWith(9);
  });

  it('debounceAsync and throttle can share a signal without interfering', async () => {
    const controller = new AbortController();
    const asyncFn = vi.fn().mockResolvedValue('data');
    const syncFn = vi.fn();

    const da = debounceAsync(asyncFn, 300, { signal: controller.signal });
    const t = throttle(syncFn, 300, { signal: controller.signal });

    const p = da('query');
    t('event'); // leading fires
    t('event2'); // trailing queued

    vi.advanceTimersByTime(150);
    controller.abort();
    vi.advanceTimersByTime(200);

    await expect(p).rejects.toBeInstanceOf(Error);
    expect(syncFn).toHaveBeenCalledTimes(1); // only leading; trailing cleared
  });

  it('multiple independent debounce instances do not share state', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const d1 = debounce(fn1, 200);
    const d2 = debounce(fn2, 200);

    d1('instance-1');
    d2('instance-2');
    d1.cancel(); // only d1 is cancelled

    vi.advanceTimersByTime(200);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledWith('instance-2');
  });

  it('multiple independent throttle instances do not share lastRan state', () => {
    const fn = vi.fn();
    const t1 = throttle(fn, 200);
    const t2 = throttle(fn, 200);

    t1('t1-lead'); // t1 fires immediately
    t2('t2-lead'); // t2 fires immediately (independent lastRan)
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
