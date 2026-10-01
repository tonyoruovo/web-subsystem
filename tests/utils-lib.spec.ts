/**
 * @fileoverview This file defines a rigorous, automated unit testing pipeline using
 * fake timers to validate execution frequencies, context preservation, and cancellation lifecycles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { debounce, debounceAsync, throttle } from '../src/libs/utils';

describe('AbortSignal Execution Lifecycle Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should prevent synchronous debounce execution when AbortSignal fires mid-flight', () => {
    const mockFn = vi.fn();
    const controller = new AbortController();
    const debounced = debounce(mockFn, 200, { signal: controller.signal });

    debounced();
    vi.advanceTimersByTime(100);
    controller.abort();

    vi.advanceTimersByTime(100);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should instantly reject active asynchronous operations when AbortSignal triggers', async () => {
    const mockFn = vi.fn().mockResolvedValue('SUCCESS');
    const controller = new AbortController();
    const debounced = debounceAsync(mockFn, 300, { signal: controller.signal });

    const promise = debounced();
    vi.advanceTimersByTime(150);
    controller.abort();

    await expect(promise).rejects.toThrow(Error);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should immediately kill throttle trailing edge adjustments if AbortSignal activates', () => {
    const mockFn = vi.fn();
    const controller = new AbortController();
    const throttled = throttle(mockFn, 400, { signal: controller.signal });

    throttled('initial'); // Fires leading edge immediately
    throttled('trailing-update');

    vi.advanceTimersByTime(200);
    controller.abort();

    vi.advanceTimersByTime(200);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).not.toHaveBeenCalledWith('trailing-update');
  });
});

describe('Rate Limiting Utilities Integration Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('debounce() via Cancellable Implementation', () => {
    it('should postpone invocation until delay boundary is reached', () => {
      const mockFn = vi.fn();
      const debounced = debounce(mockFn, 200);

      debounced();
      debounced();
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(199);
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should forward context references accurately', () => {
      const mockObj = {
        value: 'test-context',
        run: debounce(function (this: { value: string }) {
          expect(this.value).toBe('test-context');
        }, 100),
      };

      mockObj.run();
      vi.advanceTimersByTime(100);
    });

    it('should completely suppress execution when .cancel() is invoked', () => {
      const mockFn = vi.fn();
      const debounced = debounce(mockFn, 200);

      debounced();
      vi.advanceTimersByTime(150);
      debounced.cancel();

      vi.advanceTimersByTime(100);
      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  describe('debounceAsync() Execution Framework', () => {
    it('should resolve asynchronously with target results', async () => {
      const mockFn = vi.fn().mockResolvedValue('API_DATA');
      const debounced = debounceAsync(mockFn, 300);

      const promise = debounced();
      vi.advanceTimersByTime(300);

      await expect(promise).resolves.toBe('API_DATA');
    });

    it('should reject earlier promises when newer invocations override them', async () => {
      const mockFn = vi.fn().mockResolvedValue('LATEST');
      const debounced = debounceAsync(mockFn, 300);

      const firstCall = debounced();
      vi.advanceTimersByTime(150);

      const secondCall = debounced();
      vi.advanceTimersByTime(300);

      await expect(firstCall).rejects.toThrow('A newer invocation canceled this task.');
      await expect(secondCall).resolves.toBe('LATEST');
    });

    it('should reject pending items upon manual .cancel() utility triggers', async () => {
      const mockFn = vi.fn().mockResolvedValue('DATA');
      const debounced = debounceAsync(mockFn, 300);

      const promise = debounced();
      vi.advanceTimersByTime(150);
      debounced.cancel();

      await expect(promise).rejects.toThrow('Task was explicitly canceled by the user.');
      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  describe('throttle() Execution Engine', () => {
    it('should execute on leading edge instantly and schedule trailing edge updates', () => {
      const mockFn = vi.fn();
      const throttled = throttle(mockFn, 400);

      throttled('first');
      expect(mockFn).toHaveBeenCalledWith('first');
      expect(mockFn).toHaveBeenCalledTimes(1);

      throttled('second');
      throttled('third'); // This should become the definitive trailing parameters frame
      expect(mockFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(400);
      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(mockFn).toHaveBeenLastCalledWith('third');
    });

    it('should isolate frames cleanly and erase trailing queues if cancelled', () => {
      const mockFn = vi.fn();
      const throttled = throttle(mockFn, 400);

      throttled('alpha');
      throttled('beta');

      vi.advanceTimersByTime(200);
      throttled.cancel();

      vi.advanceTimersByTime(200);
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).not.toHaveBeenCalledWith('beta');
    });
  });
});
