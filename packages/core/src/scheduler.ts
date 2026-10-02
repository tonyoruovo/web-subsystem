/**
 * @fileoverview
 * @summary The main-thread task scheduler behind virtual hosts.
 * @description
 * Implements the fallback chain of docs/ARCHITECTURE.md §8.2:
 *
 * ```text
 *   postTask:  scheduler.postTask  -->  MessageChannel macrotask  -->  setTimeout(0)
 *   yield:     scheduler.yield     -->  a postTask round-trip
 *   idle:      requestIdleCallback -->  a background postTask
 *   ```
 *
 * `queueMicrotask` is deliberately absent: a microtask does not give the
 * thread back to the browser, so it cannot keep input responsive.
 *
 * @example
 * Running work as a separate task
 * ```ts
 * import { createScheduler } from '@platform/core';
 *
 * const scheduler = createScheduler();
 * const result = await scheduler.postTask(() => expensive(), 'background');
 * ```
 *
 * @example
 * Yielding inside a long loop on the main thread
 * ```ts
 * for (const chunk of chunks) {
 *   process(chunk);
 *   await scheduler.yield();
 * }
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Prioritized_Task_Scheduling_API Prioritized Task Scheduling API}
 * @author MathAid
 */

/**
 * @summary Prioritized Task Scheduling priorities.
 * @description Only honoured by the native `scheduler.postTask`; the fallbacks ignore it.
 * @public
 */
export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

/**
 * @summary Runs work as separate tasks on the main thread.
 *
 * @description
 * `postTask` runs a function in a new task and resolves with its result (or
 * rejects with what it throws). `yield` gives the thread back to the browser,
 * then resolves. `idle` runs a function when the browser is idle. `kind`
 * reports which primitive backs `postTask`.
 *
 * Virtual hosts use it to run processor messages and to yield between
 * slices. Units can use it for their own main-thread work.
 *
 * @example
 * Example 1: Low-priority work
 * ```ts
 * await scheduler.postTask(() => prefetchThumbnails(), 'background');
 * ```
 *
 * @example
 * Example 2: Deferring to idle time
 * ```ts
 * await scheduler.idle(() => compactCache());
 * ```
 *
 * @public
 * @see {@linkcode createScheduler}
 */
export interface Scheduler {
  /**
   * @summary The browser feature that `postTask` uses.
   * @description `postTask` is the Prioritized Task Scheduling API.
   * `message-channel` and `timeout` are fallbacks for browsers without it.
   */
  readonly kind: 'postTask' | 'message-channel' | 'timeout';
  /**
   * @summary Runs `task` in a new task and resolves with its result.
   * @description Only the `postTask` kind uses `priority`. The fallbacks run tasks in order.
   * @example
   * Running work after the current task
   * ```ts
   * const result = await scheduler.postTask(() => compute(), 'background');
   * ```
   * @template T The result type.
   * @param {() => T | Promise<T>} task The work.
   * @param {TaskPriority} [priority] The priority of the task.
   * @returns {Promise<T>} The result of `task`.
   */
  postTask<T>(task: () => T | Promise<T>, priority?: TaskPriority): Promise<T>;
  /**
   * @summary Gives the thread back to the browser, then resolves.
   * @example
   * Yielding during long work
   * ```ts
   * await scheduler.yield();
   * ```
   * @returns {Promise<void>} Resolves in a later task.
   */
  yield(): Promise<void>;
  /**
   * @summary Runs `task` when the browser is idle.
   * @description Without `requestIdleCallback`, the task runs in a later task.
   * @example
   * Cleaning a cache at idle time
   * ```ts
   * void scheduler.idle(() => cache.prune());
   * ```
   * @template T The result type.
   * @param {() => T | Promise<T>} task The work.
   * @returns {Promise<T>} The result of `task`.
   */
  idle<T>(task: () => T | Promise<T>): Promise<T>;
}

/**
 * @summary The globals the scheduler looks for.
 *
 * @description
 * The native `scheduler` (Prioritized Task Scheduling API), `MessageChannel`,
 * `requestIdleCallback` and `setTimeout`. Defaults to `globalThis`; tests
 * pass a narrower object to force a fallback.
 *
 * @example
 * Example 1: Forcing the MessageChannel fallback
 * ```ts
 * const scheduler = createScheduler({ MessageChannel, setTimeout });
 * scheduler.kind; // 'message-channel'
 * ```
 *
 * @example
 * Example 2: Forcing the setTimeout fallback
 * ```ts
 * createScheduler({ setTimeout }).kind; // 'timeout'
 * ```
 *
 * @public
 */
export interface SchedulerEnvironment {
  /**
   * @summary The Prioritized Task Scheduling API, where the browser has it.
   */
  readonly scheduler?: {
    /**
     * @summary Runs a task with a priority.
     * @template T The result type.
     * @param {() => T} task The work.
     * @param {object} [options] The `priority` of the task.
     * @returns {Promise<T>} The result of `task`.
     */
    postTask?<T>(task: () => T, options?: { priority?: TaskPriority }): Promise<T>;
    /**
     * @summary Gives the thread back to the browser.
     * @returns {Promise<void>} Resolves in a later task.
     */
    yield?(): Promise<void>;
  };
  /**
   * @summary The `MessageChannel` constructor, for the first fallback.
   */
  readonly MessageChannel?: typeof MessageChannel;
  /**
   * @summary Runs a callback when the browser is idle, where the browser has it.
   */
  readonly requestIdleCallback?: (callback: () => void) => unknown;
  /**
   * @summary Runs a callback after a delay. The last fallback.
   */
  readonly setTimeout: (callback: () => void, ms?: number) => unknown;
}

/**
 * @summary Creates a {@linkcode Scheduler} from the best primitives the environment has.
 *
 * @description
 * Picks `scheduler.postTask` when present, then a `MessageChannel` macrotask
 * queue, then `setTimeout(0)`. `yield` uses `scheduler.yield` when present,
 * otherwise a `postTask` round-trip. `idle` uses `requestIdleCallback` when
 * present, otherwise a background `postTask`.
 *
 * @example
 * Example 1: The default, from `globalThis`
 * ```ts
 * const scheduler = createScheduler();
 * ```
 *
 * @example
 * Example 2: Sharing one scheduler with every processor
 * ```ts
 * new Kernel(subsystems, { processors: { scheduler: createScheduler() } });
 * ```
 *
 * @param {SchedulerEnvironment} [env=globalThis] The globals to use.
 * @returns {Scheduler} The scheduler.
 *
 * @public
 */
export function createScheduler(
  env: SchedulerEnvironment = globalThis as unknown as SchedulerEnvironment,
): Scheduler {
  const run = <T>(task: () => T | Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      try {
        Promise.resolve(task()).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });

  let kind: Scheduler['kind'];
  let enqueue: (callback: () => void, priority?: TaskPriority) => void;

  const native = env.scheduler;
  if (typeof native?.postTask === 'function') {
    kind = 'postTask';
    enqueue = (callback, priority) => void native.postTask!(callback, { priority });
  } else if (typeof env.MessageChannel === 'function') {
    kind = 'message-channel';
    const channel = new env.MessageChannel();
    const queue: (() => void)[] = [];
    channel.port1.onmessage = () => queue.shift()?.();
    // Node keeps the process alive while a port listens; browsers ignore this.
    (channel.port1 as { unref?: () => void }).unref?.();
    enqueue = (callback) => {
      queue.push(callback);
      channel.port2.postMessage(null);
    };
  } else {
    kind = 'timeout';
    enqueue = (callback) => void env.setTimeout(callback, 0);
  }

  const postTask = <T>(task: () => T | Promise<T>, priority?: TaskPriority) =>
    new Promise<T>((resolve, reject) => enqueue(() => run(task).then(resolve, reject), priority));

  return {
    kind,
    postTask,
    yield: () =>
      typeof native?.yield === 'function'
        ? native.yield()
        : postTask(() => undefined, 'user-visible'),
    idle: (task) =>
      typeof env.requestIdleCallback === 'function'
        ? new Promise((resolve, reject) => {
            env.requestIdleCallback!(() => run(task).then(resolve, reject));
          })
        : postTask(task, 'background'),
  };
}
