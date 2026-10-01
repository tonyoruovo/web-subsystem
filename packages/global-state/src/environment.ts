/**
 * @fileoverview
 * @summary The environment Global State observes: connectivity and page visibility.
 * @description
 * An {@linkcode EnvironmentSource} reports whether the device is online and
 * the page visible, and notifies on change. The browser source reads
 * `navigator.onLine` and `document.visibilityState`; outside a browser it
 * reports online and visible and never changes. Tests use
 * {@linkcode createStaticEnvironment}.
 *
 * @example
 * The browser environment
 * ```ts
 * import { createBrowserEnvironment } from '@platform/global-state';
 *
 * const environment = createBrowserEnvironment();
 * environment.subscribe(() => console.log(environment.online(), environment.visible()));
 * ```
 *
 * @example
 * Simulating going offline in a test
 * ```ts
 * import { createStaticEnvironment } from '@platform/global-state';
 *
 * const environment = createStaticEnvironment();
 * environment.set({ online: false });
 * ```
 *
 * @author MathAid
 */

/**
 * @summary A source of connectivity and visibility.
 *
 * @description
 * `online()` and `visible()` read the current values; `subscribe` calls the
 * listener after either changes and returns the unsubscribe function.
 *
 * Global State reads one to fill its `online` and `visible` fields.
 *
 * @example
 * Example 1: Reading it
 * ```ts
 * if (!environment.online()) showOfflineBanner();
 * ```
 *
 * @example
 * Example 2: A source fed by a native shell
 * ```ts
 * const environment: EnvironmentSource = {
 *   online: () => shell.isOnline,
 *   visible: () => shell.isForeground,
 *   subscribe: (listener) => shell.onChange(listener),
 * };
 * ```
 *
 * @public
 */
export interface EnvironmentSource {
  /** @summary Whether the device has a network connection. */
  online(): boolean;
  /** @summary Whether the page is visible. */
  visible(): boolean;
  /**
   * @summary Calls `listener` after connectivity or visibility changes.
   * @param {() => void} listener Called with no arguments.
   * @returns {() => void} Removes the listener.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * @summary Creates the browser {@linkcode EnvironmentSource}.
 *
 * @description
 * Listens to `online` and `offline` on `window`, and `visibilitychange` on
 * `document`. Where those do not exist (Node, workers), it reports online and
 * visible and never notifies.
 *
 * @example
 * Example 1: The default
 * ```ts
 * const environment = createBrowserEnvironment();
 * ```
 *
 * @example
 * Example 2: Passing it to Global State
 * ```ts
 * createGlobalState({ environment: createBrowserEnvironment() });
 * ```
 *
 * @param {typeof globalThis} [scope=globalThis] The global scope to read.
 * @returns {EnvironmentSource} The source.
 *
 * @public
 */
export function createBrowserEnvironment(scope: typeof globalThis = globalThis): EnvironmentSource {
  const navigatorRef = scope.navigator as Navigator | undefined;
  const documentRef = (scope as { document?: Document }).document;
  return {
    online: () => navigatorRef?.onLine ?? true,
    visible: () => (documentRef ? documentRef.visibilityState !== 'hidden' : true),
    subscribe(listener) {
      const add = (scope as { addEventListener?: typeof addEventListener }).addEventListener;
      if (typeof add !== 'function') return () => {};
      scope.addEventListener('online', listener);
      scope.addEventListener('offline', listener);
      documentRef?.addEventListener('visibilitychange', listener);
      return () => {
        scope.removeEventListener('online', listener);
        scope.removeEventListener('offline', listener);
        documentRef?.removeEventListener('visibilitychange', listener);
      };
    },
  };
}

/**
 * @summary An {@linkcode EnvironmentSource} set by hand, for tests.
 *
 * @example
 * Example 1: Going offline
 * ```ts
 * environment.set({ online: false });
 * ```
 *
 * @example
 * Example 2: Hiding the page
 * ```ts
 * environment.set({ visible: false });
 * ```
 *
 * @public
 */
export interface StaticEnvironment extends EnvironmentSource {
  /**
   * @summary Changes connectivity or visibility and notifies subscribers.
   * @param {object} next The values to change.
   */
  set(next: { readonly online?: boolean; readonly visible?: boolean }): void;
}

/**
 * @summary Creates a {@linkcode StaticEnvironment}.
 *
 * @example
 * Example 1: Online and visible
 * ```ts
 * const environment = createStaticEnvironment();
 * ```
 *
 * @example
 * Example 2: Starting offline
 * ```ts
 * const environment = createStaticEnvironment({ online: false });
 * ```
 *
 * @param {object} [initial] The starting values. Both default to `true`.
 * @returns {StaticEnvironment} The environment.
 *
 * @public
 */
export function createStaticEnvironment(
  initial: { readonly online?: boolean; readonly visible?: boolean } = {},
): StaticEnvironment {
  let online = initial.online ?? true;
  let visible = initial.visible ?? true;
  const listeners = new Set<() => void>();
  return {
    online: () => online,
    visible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      online = next.online ?? online;
      visible = next.visible ?? visible;
      for (const listener of [...listeners]) listener();
    },
  };
}
