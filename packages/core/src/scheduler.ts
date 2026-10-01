/**
 * @fileoverview
 * @summary The main-thread task scheduler behind virtual hosts.
 * @description
 * Implements the fallback chain of docs/ARCHITECTURE.md §8.2:
 *
 * ```text
 *   postTask:  scheduler.postTask  ->  MessageChannel macrotask  ->  setTimeout(0)
 *   yield:     scheduler.yield     ->  a postTask round-trip
 *   idle:      requestIdleCallback ->  a background postTask
 *   ```
 *
 * `queueMicrotask` is deliberately absent: a microtask does not give the
 * thread back to the browser.
 *
 * @author MathAid
 */

/** @summary Prioritized Task Scheduling priorities. */
export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

/** @summary Runs work as separate tasks on the main thread. */
export interface Scheduler {
  /** Which primitive `postTask` uses. */
  readonly kind: 'postTask' | 'message-channel' | 'timeout';
  /** Runs `task` in a new task and resolves with its result. */
  postTask<T>(task: () => T | Promise<T>, priority?: TaskPriority): Promise<T>;
  /** Gives the thread back to the browser, then resolves. */
  yield(): Promise<void>;
  /** Runs `task` when the browser is idle. */
  idle<T>(task: () => T | Promise<T>): Promise<T>;
}

/** @summary The globals the scheduler looks for. Defaults to `globalThis`. */
export interface SchedulerEnvironment {
  readonly scheduler?: {
    postTask?<T>(task: () => T, options?: { priority?: TaskPriority }): Promise<T>;
    yield?(): Promise<void>;
  };
  readonly MessageChannel?: typeof MessageChannel;
  readonly requestIdleCallback?: (callback: () => void) => unknown;
  readonly setTimeout: (callback: () => void, ms?: number) => unknown;
}

/**
 * @summary Creates a scheduler from the best primitives the environment has.
 * @param {SchedulerEnvironment} [env] The globals. Defaults to `globalThis`.
 * @returns {Scheduler} The scheduler.
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
