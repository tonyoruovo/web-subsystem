/**
 * @fileoverview
 * @summary Route sources: how Page scope learns that the path changed.
 * @description
 * Implements docs/ARCHITECTURE.md §11.2.1. Page scope ends when the path
 * changes. The core stays framework-agnostic by reading the path through a
 * {@linkcode RouteSource}; a router adapter (for example `vue-router`'s
 * `afterEach`) can supply its own.
 *
 * Only the **path** counts: query and hash changes do not end a page.
 *
 * ```text
 *   createBrowserRouteSource()
 *   +-- Navigation API present  --> listen to 'navigatesuccess'
 *   +-- otherwise               --> listen to 'popstate', wrap history.pushState / replaceState
 *                                   (wrappers removed when the last subscriber leaves)
 *   ```
 *
 * @example
 * Following the browser's path
 * ```ts
 * import { createBrowserRouteSource } from '@platform/core';
 *
 * const route = createBrowserRouteSource();
 * const stop = route.subscribe((path) => console.log('page changed to', path));
 * ```
 *
 * @example
 * Feeding a router's navigations instead (vue-router)
 * ```ts
 * import type { RouteSource } from '@platform/core';
 *
 * function vueRouterSource(router: Router): RouteSource {
 *   return {
 *     current: () => router.currentRoute.value.path,
 *     subscribe: (listener) => router.afterEach((to, from) => {
 *       if (to.path !== from.path) listener(to.path);
 *     }),
 *   };
 * }
 * ```
 *
 * @author MathAid
 */

/**
 * @summary A source of the current path and its changes.
 *
 * @description
 * `current()` returns the path now; `subscribe(listener)` calls the listener
 * with the new path after each path change and returns an unsubscribe
 * function. Query-only and hash-only changes are not reported.
 *
 * The platform uses it to end Page-scope units when the user navigates.
 * Router adapters implement it from their router's navigation hooks.
 *
 * @example
 * Example 1: Reacting to navigations
 * ```ts
 * route.subscribe((path) => analytics.page(path));
 * ```
 *
 * @example
 * Example 2: Reading the path once
 * ```ts
 * if (route.current().startsWith('/admin')) loadAdminTools();
 * ```
 *
 * @public
 * @see {@linkcode createBrowserRouteSource}
 * @see {@linkcode createMemoryRouteSource}
 */
export interface RouteSource {
  /**
   * @summary Returns the current path, for example `/settings/profile`.
   * @returns {string} The path.
   */
  current(): string;
  /**
   * @summary Calls `listener` with the new path after each path change.
   * @param {(path: string) => void} listener Receives the new path.
   * @returns {() => void} Removes the listener.
   */
  subscribe(listener: (path: string) => void): () => void;
}

/**
 * @summary A {@linkcode RouteSource} driven by hand, for tests and non-browser hosts.
 *
 * @example
 * Example 1: Simulating navigation in a test
 * ```ts
 * const route = createMemoryRouteSource('/');
 * route.navigate('/settings');
 * ```
 *
 * @example
 * Example 2: Driving it from a custom router
 * ```ts
 * myRouter.on('change', (path) => route.navigate(path));
 * ```
 *
 * @public
 */
export interface MemoryRouteSource extends RouteSource {
  /**
   * @summary Moves to `path`, notifying subscribers when it differs from the current one.
   * @param {string} path The new path.
   */
  navigate(path: string): void;
}

/**
 * @summary Creates a {@linkcode MemoryRouteSource}.
 *
 * @example
 * Example 1: Starting at the root
 * ```ts
 * const route = createMemoryRouteSource();
 * route.current(); // '/'
 * ```
 *
 * @example
 * Example 2: Starting on a deep link
 * ```ts
 * const route = createMemoryRouteSource('/orders/42');
 * ```
 *
 * @param {string} [initial='/'] The starting path.
 * @returns {MemoryRouteSource} The route source.
 *
 * @public
 */
export function createMemoryRouteSource(initial = '/'): MemoryRouteSource {
  let path = initial;
  const listeners = new Set<(path: string) => void>();
  return {
    current: () => path,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate(next) {
      if (next === path) return;
      path = next;
      for (const listener of [...listeners]) listener(path);
    },
  };
}

/**
 * @summary The parts of `window` a browser route source uses.
 *
 * @description
 * `location.pathname`, `history.pushState` and `replaceState`, the `popstate`
 * event, and the optional Navigation API (`navigation`). Declared as an
 * interface so tests can pass a fake window.
 *
 * @example
 * Example 1: The real window satisfies it
 * ```ts
 * createBrowserRouteSource(window);
 * ```
 *
 * @example
 * Example 2: A fake window in a test
 * ```ts
 * const win: RouteWindow = { location, history, addEventListener, removeEventListener };
 * ```
 *
 * @public
 */
export interface RouteWindow {
  /**
   * @summary The current location of the page.
   */
  readonly location: {
    /**
     * @summary The path of the current URL, for example `/settings`.
     */
    readonly pathname: string;
  };
  /**
   * @summary The history methods that change the path.
   * @description The route source wraps them when the Navigation API is not available.
   */
  readonly history: Pick<History, 'pushState' | 'replaceState'>;
  /**
   * @summary Adds the `popstate` listener.
   * @param {'popstate'} type The event type.
   * @param {() => void} listener Called after the user goes back or forward.
   */
  addEventListener(type: 'popstate', listener: () => void): void;
  /**
   * @summary Removes the `popstate` listener.
   * @param {'popstate'} type The event type.
   * @param {() => void} listener The listener to remove.
   */
  removeEventListener(type: 'popstate', listener: () => void): void;
  /**
   * @summary The Navigation API, where the browser has it.
   * @description When it is present, the route source uses it instead of the History API.
   */
  readonly navigation?: {
    /**
     * @summary Adds the `navigatesuccess` listener.
     * @param {'navigatesuccess'} type The event type.
     * @param {() => void} listener Called after each navigation completes.
     */
    addEventListener(type: 'navigatesuccess', listener: () => void): void;
    /**
     * @summary Removes the `navigatesuccess` listener.
     * @param {'navigatesuccess'} type The event type.
     * @param {() => void} listener The listener to remove.
     */
    removeEventListener(type: 'navigatesuccess', listener: () => void): void;
  };
}

/**
 * @summary Creates a {@linkcode RouteSource} for the browser.
 *
 * @description
 * Uses the Navigation API (`navigatesuccess`) when present. Otherwise it
 * listens to `popstate` and wraps `history.pushState` and `replaceState`,
 * which do not fire events. Listening starts with the first subscriber and
 * stops (restoring `history`) when the last one leaves.
 *
 * @example
 * Example 1: In an app
 * ```ts
 * const route = createBrowserRouteSource();
 * route.subscribe((path) => console.log(path));
 * history.pushState(null, '', '/settings'); // logs '/settings'
 * ```
 *
 * @example
 * Example 2: In a test, with a fake window
 * ```ts
 * const route = createBrowserRouteSource(fakeWindow);
 * ```
 *
 * @param {RouteWindow} [win=globalThis] The window to read.
 * @returns {RouteSource} The route source.
 *
 * @public
 */
export function createBrowserRouteSource(
  win: RouteWindow = globalThis as unknown as RouteWindow,
): RouteSource {
  const listeners = new Set<(path: string) => void>();
  let last = win.location.pathname;
  let detach: (() => void) | null = null;

  const check = () => {
    const path = win.location.pathname;
    if (path === last) return;
    last = path;
    for (const listener of [...listeners]) listener(path);
  };

  const attach = (): (() => void) => {
    if (win.navigation) {
      const navigation = win.navigation;
      navigation.addEventListener('navigatesuccess', check);
      return () => navigation.removeEventListener('navigatesuccess', check);
    }
    const history = win.history;
    const { pushState, replaceState } = history;
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      pushState.apply(this, args);
      check();
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      replaceState.apply(this, args);
      check();
    };
    win.addEventListener('popstate', check);
    return () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      win.removeEventListener('popstate', check);
    };
  };

  return {
    current: () => win.location.pathname,
    subscribe(listener) {
      if (listeners.size === 0) {
        last = win.location.pathname;
        detach = attach();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
  };
}
