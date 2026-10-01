import type { IBrowserInfo } from '@/types';

/**
 * Configuration options for dynamically loading a polyfill script.
 *
 * @remarks
 * This type extends a specific subset of native {@link HTMLScriptElement} attributes,
 * making them optional while enforcing a required script source.
 *
 * @public
 */
export type IPolyfillOptions = Partial<
  Pick<
    HTMLScriptElement,
    | 'async'
    | 'crossOrigin'
    | 'defer'
    | 'fetchPriority'
    | 'integrity'
    | 'noModule'
    | 'referrerPolicy'
  >
> & {
  /**
   * URL of the external script file to load.
   *
   * @see {@link https://developer.mozilla.org/docs/Web/API/HTMLScriptElement/src | MDN Reference}
   */
  src: string;

  /**
   * The cryptographic MIME type of the script.
   *
   * @defaultValue `'text/javascript'`
   * @see {@link https://developer.mozilla.org/docs/Web/API/HTMLScriptElement/type | MDN Reference}
   */
  type?: 'text/javascript' | 'module';
};

/**
 * Feature detection and polyfill configuration metadata for a single runtime environment.
 *
 * @public
 */
export interface ISupportConfig {
  /**
   * Indicates whether the current environment natively supports the feature.
   *
   * @defaultValue `false`
   */
  native?: boolean;

  /**
   * The configuration required to fetch and inject a fallback script
   * if native support is missing.
   */
  polyfill?: IPolyfillOptions;
}

/**
 * A matrix mapping feature compatibility across different Web Worker contexts.
 *
 * @remarks
 * Use this to evaluate whether a browser feature is safe to use inside
 * regular background threads, service workers, or shared worker scopes.
 *
 * @public
 */
export type IWorkerSupport = {
  /**
   * Feature support details inside standard Web Workers (`new Worker()`).
   */
  web?: ISupportConfig;

  /**
   * Feature support details inside Service Workers (`navigator.serviceWorker`).
   */
  service?: ISupportConfig;

  /**
   * Feature support details inside Shared Workers (`new SharedWorker()`).
   */
  shared?: ISupportConfig;
};
export type INotificationSupport = {
  broadcastChannel?: ISupportConfig;
};
export type IMessageQueueSupport = {
  messageChannel?: ISupportConfig;
};

export type ISupport = {
  workers?: IWorkerSupport;
  userAgent?: IBrowserInfo;
  notification?: INotificationSupport;
  messageQueue?: IMessageQueueSupport;
};
