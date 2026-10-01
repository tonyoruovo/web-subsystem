import type { Cancellable, CancellableAsync, FunctionLike, RateLimitOptions } from '@/modules';
import type { ComputeClampParams } from '@/types';

/**
 * Generates a cryptographically secure random floating-point number
 * between 0 (inclusive) and 1 (exclusive), similar to Math.random().
 */
export function generateSecureRandom(): number {
  // Use Uint32Array for better precision than Uint8Array when scaling to a large range.
  const randomUint32Values = new Uint32Array(1);

  // Fills the array with cryptographically secure random values.
  // The 'crypto' object is available globally in browsers and Node.js (via require('crypto') in older versions, global in newer).
  crypto.getRandomValues(randomUint32Values);

  const u32Max = 0xffffffff; // Maximum value for a 32-bit unsigned integer (4294967295)
  // To ensure the result is strictly less than 1, divide by max + 1 (4294967296).
  const result = randomUint32Values[0] / (u32Max + 1);

  return result;
}
/**
 * Clamps a number between a minimum and maximum value. If
 * the value is less than the minimum, the minimum is
 * returned. If the value is greater than the maximum,
 * the maximum is returned. Otherwise, the value itself
 * is returned.
 * @param param0 the arguments as named parameters
 * @returns returns the clamped value (i.e., the value constrained to be within
 * the min and max bounds)
 */
export function computeClamp({
  max = Number.MAX_SAFE_INTEGER,
  min = Number.MIN_SAFE_INTEGER,
  value = 0,
}: ComputeClampParams) {
  return Math.min(max, Math.max(min, value));
}
export function clientIsSameOriginWithWorker(origin: string) {
  if (origin.length === 0) return true;
  return new URL((import.meta as any).env.VITE_BASE_URL).origin === new URL(origin).origin;
}
/**
 * Generates a consistent 32-bit integer hash from a string.
 * @param {string} str - The input string to hash.
 * @returns {number} A numeric hash value.
 */
export function stringToHash(str?: string | null): number {
  let hash = 0;

  if (isNil(str) || str.length === 0) return hash;

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    // (hash << 5) - hash is effectively: hash * 31
    // Bitwise OR 0 converts the result to a signed 32-bit integer
    hash = ((hash << 5) - hash + char) | 0;
  }

  return hash;
}
/**
 * Estimates the memory footprint of a given value in bytes.
 * Handles Blobs, Files, Buffers, Strings, Numbers, Booleans, Dates, Arrays, Objects, and Null/Undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sizeOf(value: any): number {
  // 1. Primitive handling for null and undefined
  if (value === null || value === undefined) {
    return 0;
  }

  // 2. Handle structural and specialized object types
  if (typeof value === 'object') {
    // Handle specialized Node.js Buffer
    // if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    //   return value.length;
    // }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      return value.byteLength;
    }

    // Handle browser Blob and File objects
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return value.size;
    }

    // Handle Date objects (stored as an 8-byte 64-bit integer timestamp)
    if (value instanceof Date) {
      return 8;
    }

    // Handle Arrays (calculates the sum of all elements)
    if (Array.isArray(value)) {
      return value.reduce((acc, item) => acc + sizeOf(item), 0);
    }

    // Handle standard Objects (keys + values)
    let size = 0;
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        size += sizeOf(key); // Key name takes up memory string space
        size += sizeOf(value[key]); // Value memory size
      }
    }
    return size;
  }

  // 3. Handle primitives
  switch (typeof value) {
    case 'string':
      // Encoded in UTF-16 in JavaScript/TypeScript engines (2 bytes per character)
      return value.length * 2;

    case 'number':
      // IEEE 754 double-precision floats take 8 bytes
      return 8;

    case 'boolean':
      // Booleans are stored using 4 bytes (standard engine word size assignment)
      return 4;

    default:
      return 0;
  }
}

/**
 * Checks if the argument is null or undefined.
 *
 * @param x - The value to be checked.
 * @returns A type predicate asserting that the argument is null or undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isNil(x: any): x is null | undefined {
  return x === null || x === undefined;
}
/**
 * Checks if every element in an array/tuple is null or undefined.
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that all elements in the input array are null or undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function allNil(...args: any[]) /*: args is { [K in keyof T]: null | undefined }*/ {
  return args.every(isNil);
}
/**
 * Checks if any element in an array/tuple is null or undefined.
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that at least 1 element in the input array is null or undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function anyNil(...args: any[]) {
  return args.some(isNil);
}
/**
 * Checks if the argument is null.
 *
 * @param x - The value to be checked.
 * @returns A type predicate asserting that the argument is null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isNull(x: any): x is null {
  return x === null;
}
/**
 * Checks if every element in an array/tuple is null
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that all elements in the input array are null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function allNull(...args: any[]) {
  return args.every(isNull);
}
/**
 * Checks if any element in an array/tuple is null
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that at least 1 element in the input array is null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function anyNull(...args: any[]) {
  return args.some(isNull);
}
/**
 * Checks if the argument is undefined.
 *
 * @param x - The value to be checked.
 * @returns A type predicate asserting that the argument is undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isUndefined(x: any): x is undefined {
  return x === undefined;
}
/**
 * Checks if every element in an array/tuple is undefined.
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that all elements in the input array are undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function allUndefined(...args: any[]) {
  return args.every(isUndefined);
}
/**
 * Checks if any element in an array/tuple is undefined.
 *
 * @param args - The items to be checked.
 * @returns A type predicate asserting that at least 1 element in the input array is undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function anyUndefined(...args: any[]) {
  return args.some(isUndefined);
}

/**
 * @summary Debounces executions with context retention and cancellation support
 *
 * @description
 * Debounces executions with strict context retention, trailing edge execution and standard
 * `AbortSignal` or manual cancellation control
 *
 * It is generic higher-order context-preserving factory pattern function, returning an enhanced
 * execution proxy. It:
 * - Preserves parameters, execution context, and structural typing.
 * - Enforces parameter array parity.
 * - Accepts a target callback function `fn: T` and a mandatory time threshold `delayMs: number`.
 * - Returns a stateful proxy function matching the signature of `fn` but resolving to `void` that
 * is also a {@linkcode Cancellable Cancellable<T>} exposing the function pipeline along with a `.cancel()` hook.
 *
 * Standard debouncing breaks class methods or DOM node handlers that rely on `this`.
 * This implementation uses explicit `this` forward binding via `.apply()` alongside
 * a trailing-edge strategy. This ensures that when an interactive pipeline goes
 * quiet, the very last event signature executes correctly with its appropriate
 * structural instance context. It also integrates directly with modern Web APIs. If
 * an external `AbortController` fires during an active delay loop, the scheduled
 * callback is aborted and wiped automatically.
 *
 * @example
 * // Example 1: Debouncing a search input element listener
 * const searchAPI = (query: string) => fetch(`/search?q=${query}`);
 * const debouncedSearch = debounce(searchAPI, 300);
 *
 * // Simulating user typing "TS" rapidly
 * debouncedSearch("T");  // Timer starts
 * debouncedSearch("TS"); // Timer resets, "T" execution cancelled
 * // 300ms passes -> searchAPI("TS") is executed exactly once.
 *
 * @example
 * // Example 2: Tracking window resizing with typed parameters
 * const handleResize = (width: number, height: number) => {
 *   console.log(`Dimensions updated: ${width}x${height}`);
 * };
 * const debouncedResize = debounce(handleResize, 150);
 *
 * window.addEventListener('resize', () => {
 *   debouncedResize(window.innerWidth, window.innerHeight);
 * });
 *
 * @example
 * // Example 3: Handling a class instance method while preserving 'this'
 * class FormValidator {
 *   private apiEndpoint = '/validate';
 *
 *   // Bind the debounced variant within the instance context
 *   public validateField = debounce(function(this: FormValidator, text: string) {
 *     fetch(`${this.apiEndpoint}?val=${text}`); // 'this' properly points to the class instance
 *   }, 250);
 * }
 *
 * @example
 * // Example 4: Attaching to DOM instances directly
 * const uiButton = document.querySelector('#submit-btn');
 * const clickHandler = debounce(function(this: HTMLButtonElement, event: Event) {
 *   this.disabled = true; // Correctly refers to the bound DOM element
 * }, 300);
 * uiButton?.addEventListener('click', clickHandler);
 *
 * @example
 * // Example 5: Cancelling on component unmount
 * const logData = debounce(() => console.log("Sent"), 1000);
 * logData();
 * logData.cancel(); // Cleared instantly; nothing prints to the console.
 *
 * @example
 * // Example 6: Wiring a debouncer directly into a native AbortController
 * const controller = new AbortController();
 * const logData = debounce(() => console.log("Sent"), 1000, { signal: controller.signal });
 *
 * logData();
 * controller.abort(); // Cleared automatically via the signal binding!
 *
 * @template T - The operational function type signature matching the target callback.
 *
 * @param fn - The operational callback target to be throttled/delayed.
 * @param {number} delayMs - The cooldown threshold in milliseconds.
 * Must be a non-negative integer. Negative values default immediately to `0` inside native
 * execution loops.
 * @param {RateLimitOptions} [options] - Optional operational runtime configuration map.
 * @returns A closure-mapped executor as a stateful proxy, with an exposed `.cancel()`
 * method attached, mapping inputs and context explicitly.
 * @throws Any error thrown by the input function
 *
 * @note The returned runtime proxy discards the original return value of `fn` because execution
 * occurs asynchronously after the execution stack has cleared. When passing a long-lived
 * `AbortSignal` (e.g., one tied to the application lifetime), call `.cancel()` explicitly when
 * the debounced function is no longer needed. This removes the internal `abort` listener from
 * the signal and prevents a memory leak. Per-request or component-scoped signals are naturally
 * short-lived and do not require this.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/setTimeout MDN `setTimeout` documentation}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/apply MDN `Function.prototype.apply()`}
 * @author MathAid
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends FunctionLike<any>>(
  fn: T,
  delayMs: number,
  options: RateLimitOptions = {},
): Cancellable<T> {
  let asyncHandle: ReturnType<typeof setTimeout> | undefined;

  // Define the cancellation utility for the cancel mechanism
  const cancel = () => {
    const cancelled = !isUndefined(asyncHandle);
    if (asyncHandle) {
      clearTimeout(asyncHandle);
      asyncHandle = undefined;
    }
    return cancelled;
  };

  // Wire up the standard AbortSignal if present
  if (options.signal) {
    if (options.signal.aborted) {
      const stub = function (
        this: ThisParameterType<T>,

        ..._: Parameters<T>
      ): never {
        throw new ReferenceError(
          `The input signal was already aborted prior: ${options.signal?.reason}`,
        );
      };

      return Object.assign(stub, { cancel: () => false }) as Cancellable<T>;
    }
    options.signal.addEventListener('abort', cancel, { once: true });
  }

  // Define the actual closure's intrinsic body
  const debouncedFn = function (this: ThisParameterType<T>, ...args: Parameters<T>): void {
    if (options.signal?.aborted) {
      throw new ReferenceError(
        `The input signal was already aborted prior: ${options.signal?.reason}`,
      );
    }

    clearTimeout(asyncHandle);
    asyncHandle = setTimeout(() => {
      if (options.signal) {
        options.signal.removeEventListener('abort', cancel);
      }
      fn.apply(this, args);
    }, delayMs);
  };

  // Attach the cancel mechanism with cleanup for possible abort listener
  debouncedFn.cancel = () => {
    const cancelled = cancel();
    if (options.signal) {
      options.signal.removeEventListener('abort', cancel);
    }
    return cancelled;
  };

  return debouncedFn;
}

/**
 * @summary Debounces async routines with cancellation support.
 *
 * @description
 * Debounces async routines, settling pending promises upon abort events or manual cancellation.
 *
 * It is an asynchronous higher-order context-preserving (debouncer) wrapper, responding
 * dynamically to `AbortSignal` tokens, returning cancellation tokens. It:
 * - Handles underlying argument and return mapping.
 * - Accepts a target function `fn: T` and a mandatory time threshold `delayMs: number`.
 * - Returns a proxy function, {@linkcode CancellableAsync CancellableAsync<T, R>} that converts
 * the output of `fn` into a Promise: `(...args: Parameters<T>) => Promise<ReturnType<T>>`,
 * offering a runtime control surface.
 *
 * Standard debouncers instantly return `void`. This is problematic when a debounced operation
 * (like an auto-saving input or an API calculation) needs to signal back to the UI when it has
 * completed or what it resolved to. By wrapping the pipeline in a Promise lifecycle, any pending
 * callers are rejected when a new event triggers, while the absolute final event resolves
 * gracefully with the real data payload. Additionally, when a user actively routes away from a
 * viewport or cancels a task, intermediate Promises must be structured to throw errors immediately
 * to unlock operational UI workflows.
 *
 * Ideal for search-as-you-type drop-downs wrapped in standard UI frameworks, allowing native abort
 * chains to instantly break pending promise resolutions.
 *
 * @example
 * // Example 1: Awaiting the results of a debounced API search query
 * const fetchUserCount = async (role: string) => {
 *   const res = await fetch(`/api/users/count?role=${role}`);
 *   return res.json() as Promise<{ count: number }>;
 * };
 *
 * const debouncedCount = debounceAsync(fetchUserCount, 500);
 *
 * async function handleTyping(inputRole: string) {
 *   try {
 *     // If typed rapidly, earlier loops will throw an Abort Error
 *     const data = await debouncedCount(inputRole);
 *     console.log(`Final Result: ${data.count}`); // Accesses real return value!
 *   } catch (err) {
 *     // Catches skipped/debounced intermediate calls safely
 *   }
 * }
 *
 * @example
 * // Example 2: Triggering and forcing a cancellation reject
 * const fetchQuery = debounceAsync(async (q: string) => "Result", 500);
 * const p = fetchQuery("search");
 * fetchQuery.cancel(); // p instantly rejects with a cancellation error
 *
 * @example
 * // Example 3: Integrating with an active AbortSignal
 * const controller = new AbortController();
 * const search = debounceAsync(async (val) => "Data", 500, { signal: controller.signal });
 *
 * const p = search("query");
 * controller.abort(); // p rejects instantly with a DOMException/Error
 *
 * @template T - The operational async signature structure matching the target callback.
 * @template R - Underlying value resolution payload type.
 * @param fn - The operational callback target whose resolved value is forwarded through the returned Promise.
 * @param delayMs - The cooldown threshold in milliseconds.
 * @param {RateLimitOptions} [options] - Optional configuration carrying the target AbortSignal.
 * @returns A stateful proxy returning a Promise that resolves when the final cooldown
 * window passes.
 *
 * @throws {Error} Throws an error for the following scenarios:
 * - Active abortion token error if a subsequent execution overrides a pending execution.
 * - Overridden by newer calls or if explicitly aborted via `.cancel()` or using the
 * `AbortController.abort()` for the corresponding `AbortSignal` passed to this method.
 * - The input `fn` throws
 * @author MathAid
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounceAsync<T extends FunctionLike<any, Promise<R>>, R = any>(
  fn: T,
  delayMs: number,
  options: RateLimitOptions = {},
): CancellableAsync<T, R> {
  let asyncHandle: ReturnType<typeof setTimeout> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeReject: ((reason?: any) => void) | null = null;

  // Define the cancellation utility for the cancel mechanism
  const cancelAndReject = (reason: Error) => {
    const cancelled = !isUndefined(asyncHandle) || !isNull(activeReject);
    if (asyncHandle) {
      clearTimeout(asyncHandle);
      asyncHandle = undefined;
    }
    if (!isNull(activeReject)) {
      activeReject(reason);
      activeReject = null;
    }
    return cancelled;
  };

  // Integrate cancellation utility into the AbortSignal
  const handleAbortSignal = () => {
    const abortError =
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('Debounced: Task was explicitly aborted via AbortSignal.');
    return cancelAndReject(abortError);
  };

  // Wire up the standard AbortSignal if present
  if (options.signal) {
    if (options.signal.aborted) {
      const abortError =
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new ReferenceError(`Aborted: ${options.signal.reason}`);
      const stub = function (
        this: ThisParameterType<T>,

        ..._args: Parameters<T>
      ): Promise<R> {
        return Promise.reject(abortError);
      };

      return Object.assign(stub, { cancel: () => false }) as CancellableAsync<T, R>;
    }
    options.signal.addEventListener('abort', handleAbortSignal, { once: true });
  }

  // Define the actual closure's intrinsic body
  const debouncedAsyncFn = function (
    this: ThisParameterType<T>,
    ...args: Parameters<T>
  ): Promise<R> {
    if (options.signal?.aborted) {
      const abortError =
        options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted');
      return Promise.reject(abortError);
    }

    clearTimeout(asyncHandle);
    if (!isNull(activeReject)) {
      activeReject(new Error('Debounced: A newer invocation canceled this task.'));
    }

    return new Promise<R>((resolve, reject) => {
      activeReject = reject;

      asyncHandle = setTimeout(() => {
        // Timer fired: this is now the committed invocation. Clear the reject handle
        // before fn runs so that a concurrent cancel() during async execution does
        // not double-reject a promise that is already resolving.
        activeReject = null;
        asyncHandle = undefined;

        fn.apply(this, args)
          .then((result) => {
            resolve(result);
            activeReject = null;
          })
          .catch((error) => reject(error));
        // .finally(() => activeReject = null)
        /*try {
          const result = await fn.apply(this, args);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          activeReject = null;
        }*/
      }, delayMs);
    });
  };

  // Attach the cancel mechanism with cleanup for possible abort listener
  debouncedAsyncFn.cancel = () => {
    const cancelled = cancelAndReject(
      new Error('Debounced: Task was explicitly canceled by the user.'),
    );
    if (options.signal) {
      options.signal.removeEventListener('abort', handleAbortSignal);
    }
    return cancelled;
  };

  return debouncedAsyncFn;
}

/**
 * @summary Throttles high-frequency loops with dual-edge invocation and signal cancellations.
 *
 * @description
 * A stateful (tracking parameters across `AbortSignal`s), higher-order throttle utility with
 * context retention, guaranteed trailing edge processing, manual and signal cancellations. it:
 * - Locks parameters and instance types.
 * - Accepts a target function `fn: T` and an operational window length `limitMs: number`.
 * - Returns a stateful parameter wrapper proxy tracking scheduling matrices.
 *
 * Basic throttling drops calls that arrive while a lock is active, which can result in missing
 * the final user action. This dual-edge variant invokes the callback immediately on the leading
 * edge, but also schedules a trailing-edge backup. If the user invokes the throttled function
 * again during the cooldown, those trailing parameters are cached and executed automatically
 * when the timer expires.
 *
 * Intermediate calls within the active cooldown window do not schedule additional
 * timers; they only update the cached arguments, so the single trailing execution
 * always reflects the most recent invocation.
 *
 * @example
 * // Capturing the final drag coordinate via trailing edge
 * const dragCanvas = {
 *   scale: 1.2,
 *   updatePosition: throttle(function(this: typeof dragCanvas, x: number, y: number) {
 *     console.log(`Moving canvas at scale ${this.scale} to: ${x}, ${y}`);
 *   }, 100)
 * };
 * // If dragging stops inside the 100ms window, the absolute final coordinate is still guaranteed to execute.
 *
 * @example
 * // Example 2: Leading-edge-only behavior — the first call in each window fires immediately
 * const logResize = throttle((width: number) => {
 *   console.log("Viewport width:", width);
 * }, 200);
 *
 * logResize(800); // fires immediately (leading edge)
 * logResize(810); // dropped — within the 200ms window, args cached
 * logResize(820); // dropped — args updated to 820
 * // ~200ms later: fires with width=820 (trailing edge)
 *
 * @example
 * // Example 3: Manual cancellation and timing reset
 * const save = throttle((payload: object) => api.save(payload), 1000);
 *
 * save({ draft: true });  // fires immediately
 * save({ draft: false }); // cached as trailing args
 * save.cancel();          // pending trailing call discarded; timing fully reset
 * save({ final: true });  // fires immediately on leading edge (as if freshly created)
 *
 * @example
 * // Example 4: AbortSignal integration for component lifecycle teardown
 * const controller = new AbortController();
 *
 * const trackScroll = throttle(
 *   (y: number) => analytics.record("scroll", y),
 *   150,
 *   { signal: controller.signal }
 * );
 *
 * window.addEventListener("scroll", () => trackScroll(window.scrollY));
 *
 * // On component unmount:
 * controller.abort(); // trackScroll is silently disabled; no further executions
 *
 * @template T - The operational function type signature matching the target callback.
 * @param fn - The operational callback target to be frequency-restricted.
 * @param limitMs - The evaluation cooldown frame threshold window expressed in milliseconds.
 * @param options - Optional administrative control map configurations.
 * @returns A closure-mapped executor tracking active frames and trailing parameter states.
 *
 * @note Calling `.cancel()` fully resets the throttle's internal timing state.
 * The next invocation after a cancel will fire immediately on the leading edge,
 * as if the throttle had just been created.
 *
 * @author MathAid
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends FunctionLike<any>>(
  fn: T,
  limitMs: number,
  options: RateLimitOptions = {},
): Cancellable<T> {
  // Private fields
  // -Infinity ensures `remaining` is always deeply negative on the very first call,
  // so the leading-edge branch fires unconditionally — regardless of whether the
  // runtime clock (or a fake timer) starts at 0.
  // Private fields
  let lastRan = 0;
  let asyncHandle: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Parameters<T> | null = null;
  let lastContext: ThisParameterType<T> | null = null;

  // Define the cancellation utility for the cancel mechanism
  const cancel = () => {
    const handleRemoved = !isUndefined(asyncHandle);
    clearTimeout(asyncHandle);
    asyncHandle = undefined;
    lastRan = 0; // Reset timing: the next call fires immediately on the leading edge
    lastArgs = null;
    lastContext = null;
    return handleRemoved;
  };

  // Wire up the standard AbortSignal if present
  if (options.signal) {
    if (options.signal.aborted) {
      const stub = function (
        this: ThisParameterType<T>,

        ..._: Parameters<T>
      ): never {
        throw new ReferenceError(
          `The input signal was already aborted prior: ${options.signal?.reason}`,
        );
      };

      return Object.assign(stub, { cancel: () => false }) as Cancellable<T>;
    }
    options.signal.addEventListener('abort', cancel, { once: true });
  }

  // Define the actual closure's intrinsic body
  const throttledFn = function (this: ThisParameterType<T>, ...args: Parameters<T>): void {
    if (options.signal?.aborted) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const context = this;
    const now = Date.now();
    const remaining = limitMs - (now - lastRan);

    if (remaining <= 0 || remaining > limitMs) {
      if (asyncHandle) {
        clearTimeout(asyncHandle);
        asyncHandle = undefined;
      }
      fn.apply(context, args);
      lastRan = now;
      lastArgs = null;
      lastContext = null;
    } else {
      // Cache the latest args and context so the trailing-edge timer
      // always fires with the most recent invocation's parameters,
      // even if this is the 10th call during the cooldown window.
      // Only one timer is ever pending at a time; intermediate calls
      // are intentionally "merged" into the final trailing execution.
      lastArgs = args;
      lastContext = context;

      if (!asyncHandle) {
        asyncHandle = setTimeout(() => {
          // Guard only on lastArgs — lastContext is legitimately null when throttle
          // is invoked as a plain function rather than a method, and fn.apply(null, args)
          // is equivalent to a plain call. Guarding on lastContext would silently swallow
          // the trailing execution in the common non-method case.
          if (lastArgs) {
            fn.apply(lastContext, lastArgs);
            lastRan = Date.now();
            lastArgs = null;
            lastContext = null;
            asyncHandle = undefined;
          }
        }, remaining);
      }
    }
  };

  // Attach the cancel mechanism with cleanup for possible abort listener
  throttledFn.cancel = () => {
    const wasCancelled = cancel();
    if (options.signal) {
      options.signal.removeEventListener('abort', cancel);
    }
    return wasCancelled;
  };

  return throttledFn;
}
