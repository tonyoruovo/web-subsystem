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
 * @author MathAid
 */

/** @summary A source of the current path and its changes. */
export interface RouteSource {
  /** @summary The current path, for example `/settings/profile`. */
  current(): string;
  /**
   * @summary Calls `listener` with the new path after each path change.
   * @returns The unsubscribe function.
   */
  subscribe(listener: (path: string) => void): () => void;
}

/** @summary A route source driven by hand, for tests and non-browser hosts. */
export interface MemoryRouteSource extends RouteSource {
  /** @summary Moves to `path`, notifying subscribers when it differs. */
  navigate(path: string): void;
}

/**
 * @summary Creates a {@linkcode MemoryRouteSource}.
 * @param {string} [initial] The starting path. Defaults to `/`.
 * @returns {MemoryRouteSource} The route source.
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

/** @summary The parts of `window` a browser route source uses. */
export interface RouteWindow {
  readonly location: { readonly pathname: string };
  readonly history: Pick<History, 'pushState' | 'replaceState'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
  readonly navigation?: {
    addEventListener(type: 'navigatesuccess', listener: () => void): void;
    removeEventListener(type: 'navigatesuccess', listener: () => void): void;
  };
}

/**
 * @summary Creates a route source for the browser.
 * @description
 * Uses the Navigation API (`navigatesuccess`) when present. Otherwise it
 * listens to `popstate` and wraps `history.pushState` / `replaceState`; the
 * wrappers are removed when the last subscriber leaves.
 *
 * @param {RouteWindow} [win] The window. Defaults to `globalThis`.
 * @returns {RouteSource} The route source.
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
