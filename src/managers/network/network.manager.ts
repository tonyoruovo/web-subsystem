/**
 * @fileoverview
 * @summary The Network manager: fetch with retry, cache, interceptors, and abort.
 * @description
 * Implements dependable remote I/O for M2. It wraps `fetch` with retry and
 * backoff, cache strategies, request/response/error interceptors, timeouts, and
 * an abort registry. Identical in-flight requests are deduplicated. A failed
 * request degrades to the cache under `network-first` instead of surfacing.
 *
 * ```text
 *   request(config)
 *     |-- request interceptors
 *     |-- cache-first / cache-only? -> cache hit -> return
 *     |-- fetch with retry + timeout (dedup by url)
 *     |     |-- success -> response interceptors -> cache -> return
 *     |     |-- failure -> network-first? -> cache fallback
 *     v
 *   NetworkResponse
 *   ```
 *
 * @author MathAid
 */

/**
 * @summary An HTTP method.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * @summary A cache strategy.
 */
export type CacheStrategy = 'network-first' | 'cache-first' | 'cache-only' | 'network-only';

/**
 * @summary Options for one request.
 */
export interface NetworkRequestConfig {
  /** The URL. */
  url: string;
  /** The method. Defaults to `GET`. */
  method?: HttpMethod;
  /** Headers. */
  headers?: Record<string, string>;
  /** Body, serialized as JSON. */
  body?: unknown;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Retry count after the first attempt. */
  retries?: number;
  /** Cache strategy. Defaults to `network-first`. */
  cacheStrategy?: CacheStrategy;
  /** External abort signal. */
  signal?: AbortSignal;
}

/**
 * @summary A parsed response.
 */
export interface NetworkResponse<T = unknown> {
  /** HTTP status. */
  status: number;
  /** Status text. */
  statusText: string;
  /** Headers. */
  headers: Record<string, string>;
  /** Parsed body. */
  data: T;
  /** Whether it came from the cache. */
  fromCache: boolean;
  /** Round-trip milliseconds. */
  latency: number;
  /** Unix milliseconds. */
  timestamp: number;
}

/**
 * @summary A cached entry.
 */
interface CacheEntry<T = unknown> {
  data: T;
  headers: Record<string, string>;
  status: number;
  statusText: string;
  expiresAt: number;
}

/**
 * @summary A minimal fetch result shape the manager reads.
 */
export interface FetchResult {
  status: number;
  statusText: string;
  headers: { entries?: () => IterableIterator<[string, string]> } | Record<string, string>;
  json(): Promise<unknown>;
}

/**
 * @summary Options for constructing a {@linkcode NetworkManager}.
 */
export interface NetworkManagerOptions {
  /** The fetch function. Defaults to `globalThis.fetch`. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<FetchResult>;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable retry delay. Defaults to exponential backoff. */
  retryDelay?: (attempt: number) => number;
  /** Default timeout. Defaults to 30000 ms. */
  defaultTimeout?: number;
  /** Default retry count. Defaults to 3. */
  defaultRetries?: number;
  /** Statuses that trigger a retry. */
  retryableStatusCodes?: number[];
  /** Injectable cache TTL in milliseconds. Defaults to 300000. */
  cacheTtl?: number;
  /** Warn sink. Defaults to `console`. */
  warn?: { warn(message: string): void };
}

/**
 * @summary A request interceptor.
 */
export type RequestInterceptor = (
  config: NetworkRequestConfig,
) => NetworkRequestConfig | Promise<NetworkRequestConfig>;

/**
 * @summary A response interceptor.
 */
export type ResponseInterceptor = <T>(
  response: NetworkResponse<T>,
) => NetworkResponse<T> | Promise<NetworkResponse<T>>;

/**
 * @summary An error interceptor.
 */
export type ErrorInterceptor = (error: unknown) => unknown;

/**
 * @summary Default retryable statuses.
 */
const DEFAULT_RETRYABLE = [408, 429, 500, 502, 503, 504];

/**
 * @summary The Network manager.
 * @description
 * One instance per realm. Use `request` for full control, or the shorthand
 * helpers. Abort by request id or all at once.
 *
 * @example
 * Example 1: Fetch with retry and cache fallback
 * ```ts
 * const network = new NetworkManager();
 * const res = await network.request({ url: '/api/data', cacheStrategy: 'network-first' });
 * console.log(res.data);
 * ```
 */
export class NetworkManager {
  /** @internal The fetch function. */
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<FetchResult>;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The retry delay function. */
  private readonly retryDelay: (attempt: number) => number;

  /** @internal The default timeout. */
  private readonly defaultTimeout: number;

  /** @internal The default retry count. */
  private readonly defaultRetries: number;

  /** @internal The retryable statuses. */
  private readonly retryableStatusCodes: number[];

  /** @internal The cache TTL. */
  private readonly cacheTtl: number;

  /** @internal The warn sink. */
  private readonly warn: { warn(message: string): void };

  /** @internal Active request id to AbortController. */
  private readonly active = new Map<string, AbortController>();

  /** @internal In-flight url to promise, for dedup. */
  private readonly inflight = new Map<string, Promise<NetworkResponse>>();

  /** @internal The cache, keyed by url. */
  private readonly cache = new Map<string, CacheEntry>();

  /** @internal Request interceptors. */
  private readonly requestInterceptors: RequestInterceptor[] = [];

  /** @internal Response interceptors. */
  private readonly responseInterceptors: ResponseInterceptor[] = [];

  /** @internal Error interceptors. */
  private readonly errorInterceptors: ErrorInterceptor[] = [];

  /** @internal Monotonic request id counter. */
  private counter = 0;

  /**
   * @summary Creates a NetworkManager.
   * @param {NetworkManagerOptions} [options] The configuration and injectables.
   */
  constructor(options: NetworkManagerOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.defaultTimeout = options.defaultTimeout ?? 30_000;
    this.defaultRetries = options.defaultRetries ?? 3;
    this.retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE;
    this.cacheTtl = options.cacheTtl ?? 300_000;
    this.warn = options.warn ?? { warn: (m) => console.warn(m) };
  }

  /**
   * @summary Makes a request with the configured strategy.
   * @param {NetworkRequestConfig} config The request.
   * @returns {Promise<NetworkResponse<T>>} The response.
   * @throws {Error} On terminal failure with no cache fallback.
   */
  async request<T = unknown>(config: NetworkRequestConfig): Promise<NetworkResponse<T>> {
    const cfg = await this.applyRequestInterceptors(config);
    const strategy = cfg.cacheStrategy ?? 'network-first';
    const cacheKey = cfg.url;

    if (strategy === 'cache-first' || strategy === 'cache-only') {
      const cached = this.readCache(cacheKey);
      if (cached) {
        return {
          status: cached.status,
          statusText: cached.statusText,
          headers: cached.headers,
          data: cached.data as T,
          fromCache: true,
          latency: 0,
          timestamp: this.now(),
        };
      }
      if (strategy === 'cache-only') {
        throw new Error(`[NetworkManager] cache miss for "${cfg.url}"`);
      }
    }

    const existing = this.inflight.get(cacheKey);
    if (existing) {
      return existing as Promise<NetworkResponse<T>>;
    }

    const promise = this.fetchWithRetry<T>(cfg);
    this.inflight.set(cacheKey, promise);
    try {
      const response = await promise;
      if (strategy !== 'network-only') {
        this.writeCache(cacheKey, response);
      }
      return response;
    } catch (error) {
      if (strategy === 'network-first') {
        const cached = this.readCache(cacheKey);
        if (cached) {
          return {
            status: cached.status,
            statusText: cached.statusText,
            headers: cached.headers,
            data: cached.data as T,
            fromCache: true,
            latency: 0,
            timestamp: this.now(),
          };
        }
      }
      throw this.applyErrorInterceptors(error);
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /**
   * @summary GET shorthand.
   * @param {string} url The URL.
   * @param {Omit<NetworkRequestConfig, 'url' | 'method'>} [options] Options.
   * @returns {Promise<NetworkResponse<T>>} The response.
   */
  get<T = unknown>(
    url: string,
    options: Omit<NetworkRequestConfig, 'url' | 'method'> = {},
  ): Promise<NetworkResponse<T>> {
    return this.request<T>({ ...options, url, method: 'GET' });
  }

  /**
   * @summary POST shorthand.
   * @param {string} url The URL.
   * @param {unknown} body The body.
   * @param {Omit<NetworkRequestConfig, 'url' | 'method' | 'body'>} [options] Options.
   * @returns {Promise<NetworkResponse<T>>} The response.
   */
  post<T = unknown>(
    url: string,
    body: unknown,
    options: Omit<NetworkRequestConfig, 'url' | 'method' | 'body'> = {},
  ): Promise<NetworkResponse<T>> {
    return this.request<T>({ ...options, url, method: 'POST', body });
  }

  /**
   * @summary Aborts a request by id.
   * @param {string} requestId The request id.
   * @returns {boolean} `true` when the request was aborted.
   */
  abort(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * @summary Aborts every active request.
   * @returns {void}
   */
  abortAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  /**
   * @summary Invalidates cache entries matching a prefix.
   * @param {string} [prefix] The url prefix. Defaults to all.
   * @returns {void}
   */
  invalidateCache(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * @summary Adds a request interceptor.
   * @param {RequestInterceptor} fn The interceptor.
   * @returns {void}
   */
  addRequestInterceptor(fn: RequestInterceptor): void {
    this.requestInterceptors.push(fn);
  }

  /**
   * @summary Adds a response interceptor.
   * @param {ResponseInterceptor} fn The interceptor.
   * @returns {void}
   */
  addResponseInterceptor(fn: ResponseInterceptor): void {
    this.responseInterceptors.push(fn);
  }

  /**
   * @summary Adds an error interceptor.
   * @param {ErrorInterceptor} fn The interceptor.
   * @returns {void}
   */
  addErrorInterceptor(fn: ErrorInterceptor): void {
    this.errorInterceptors.push(fn);
  }

  /**
   * @summary Fetches with retry and timeout.
   * @param {NetworkRequestConfig} cfg The config.
   * @returns {Promise<NetworkResponse<T>>} The response.
   * @internal
   */
  private async fetchWithRetry<T>(cfg: NetworkRequestConfig): Promise<NetworkResponse<T>> {
    const attempts = cfg.retries ?? this.defaultRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        return await this.fetchOnce<T>(cfg);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleep(this.retryDelay(attempt + 1), cfg.signal);
        }
      }
    }
    throw lastError;
  }

  /**
   * @summary Fetches once, with timeout and abort tracking.
   * @param {NetworkRequestConfig} cfg The config.
   * @returns {Promise<NetworkResponse<T>>} The response.
   * @internal
   */
  private async fetchOnce<T>(cfg: NetworkRequestConfig): Promise<NetworkResponse<T>> {
    const controller = new AbortController();
    const requestId = `req-${++this.counter}`;
    this.active.set(requestId, controller);

    const onExternalAbort = () => controller.abort();
    cfg.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), cfg.timeout ?? this.defaultTimeout);

    try {
      const startedAt = this.now();
      const res = await this.fetchFn(cfg.url, {
        method: cfg.method ?? 'GET',
        headers: cfg.headers,
        body: cfg.body === undefined ? undefined : JSON.stringify(cfg.body),
        signal: controller.signal,
      });

      if (this.retryableStatusCodes.includes(res.status)) {
        throw new Error(`[NetworkManager] retryable status ${res.status}`);
      }

      const data = await res.json();
      const headers = this.normalizeHeaders(res.headers);
      let response: NetworkResponse<T> = {
        status: res.status,
        statusText: res.statusText,
        headers,
        data: data as T,
        fromCache: false,
        latency: this.now() - startedAt,
        timestamp: this.now(),
      };

      for (const fn of this.responseInterceptors) {
        response = (await fn(response)) as NetworkResponse<T>;
      }

      return response;
    } finally {
      clearTimeout(timer);
      cfg.signal?.removeEventListener('abort', onExternalAbort);
      this.active.delete(requestId);
    }
  }

  /**
   * @summary Applies request interceptors in order.
   * @param {NetworkRequestConfig} config The config.
   * @returns {Promise<NetworkRequestConfig>} The transformed config.
   * @internal
   */
  private async applyRequestInterceptors(
    config: NetworkRequestConfig,
  ): Promise<NetworkRequestConfig> {
    let cfg = config;
    for (const fn of this.requestInterceptors) cfg = await fn(cfg);
    return cfg;
  }

  /**
   * @summary Applies error interceptors in order.
   * @param {unknown} error The error.
   * @returns {unknown} The transformed error.
   * @internal
   */
  private applyErrorInterceptors(error: unknown): unknown {
    let e = error;
    for (const fn of this.errorInterceptors) e = fn(e);
    return e;
  }

  /**
   * @summary Reads a non-expired cache entry.
   * @param {string} key The url.
   * @returns {CacheEntry | undefined} The entry, or `undefined`.
   * @internal
   */
  private readCache(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * @summary Writes a response to the cache.
   * @param {string} key The url.
   * @param {NetworkResponse} response The response.
   * @returns {void}
   * @internal
   */
  private writeCache(key: string, response: NetworkResponse): void {
    this.cache.set(key, {
      data: response.data,
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
      expiresAt: this.now() + this.cacheTtl,
    });
  }

  /**
   * @summary Normalizes a Headers object or plain object into a record.
   * @param {FetchResult['headers']} headers The headers.
   * @returns {Record<string, string>} The record.
   * @internal
   */
  private normalizeHeaders(headers: FetchResult['headers']): Record<string, string> {
    if (headers && typeof (headers as { entries?: unknown }).entries === 'function') {
      return Object.fromEntries(
        (headers as { entries(): IterableIterator<[string, string]> }).entries(),
      );
    }
    return (headers as Record<string, string>) ?? {};
  }
}

/**
 * @summary Default retry delay: exponential backoff, capped at 10 seconds.
 * @param {number} attempt The failed attempt count.
 * @returns {number} The delay in milliseconds.
 * @internal
 */
function defaultRetryDelay(attempt: number): number {
  return Math.min(10_000, 100 * Math.pow(2, attempt));
}

/**
 * @summary Sleeps, respecting an optional abort signal.
 * @param {number} ms The delay.
 * @param {AbortSignal} [signal] The signal.
 * @returns {Promise<void>}
 * @internal
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
