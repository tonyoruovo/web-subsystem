/**
 * @fileoverview
 * @summary The Window client: one tab's connection to Window scope, through the hub and, where needed, the relay.
 * @description
 * Implements the client of docs/ARCHITECTURE.md §11.3.
 *
 * ```text
 *   mode          when                                   link
 *   iframe        hubUrl on another origin (a subdomain)  iframeLink (the hub page in a hidden iframe)
 *   direct        hubUrl on this tab's origin (the apex)  channelLink (the hub's BroadcastChannel)
 *   single-origin no hubUrl                               channelLink (this origin's BroadcastChannel)
 *
 *   connect --> link.open --> partition id --> window cookie --> hub: unknown | shared | partitioned
 *           --> relay.subscribe(windowId)          (when a relay is configured)
 *
 *   publish(envelope) --> link              (buffered while connecting)
 *                     --> relay            (while the hub is not known to be shared)
 *   link or relay --> deduplicate by messageId --> listeners
 *
 *   heartbeat: ping every heartbeatMs; no pong --> reconnect with backoff
 *   reach: site (hub shared, relay connected, or single-origin) | origin (partitioned, no relay) | unknown
 *   ```
 *
 * @example
 * A tab on a subdomain
 * ```ts
 * const client = createWindowClient({ hubUrl: 'https://example.com/__platform/hub.html', relay });
 * await client.connect();
 * client.onEnvelope((envelope) => queue.commands.ingest(envelope));
 * ```
 *
 * @example
 * Showing the reach
 * ```ts
 * client.status.subscribe(() => (badge.textContent = client.status.getSnapshot().reach));
 * ```
 *
 * @author MathAid
 */

import {
  computeBackoff,
  createDeduplicator,
  createStore,
  type PacketEnvelope,
  type View,
} from '@platform/core';

import {
  documentCookies,
  readWindowCookie,
  recordConnection,
  type CookieJar,
  type HubPartition,
} from './cookie';
import { channelLink, iframeLink, type HubLink } from './link';
import { DEFAULT_CHANNEL, isWindowBroadcast, readPartitionId } from './shared';

/**
 * @summary Carries Window broadcasts between tabs that the hub cannot join (ARCHITECTURE §11.3).
 *
 * @description
 * The Global transport implements it from M8: the server forwards a Window
 * envelope to every connection that subscribed with the same window id.
 * `publish` must not throw for transport failures. `connected` says whether
 * the relay is reachable now.
 *
 * @example
 * Example 1: What the client calls
 * ```ts
 * const stop = relay.subscribe(windowId, onEnvelope);
 * relay.publish(windowId, envelope);
 * ```
 *
 * @example
 * Example 2: An in-memory relay for tests
 * ```ts
 * const listeners = new Map<string, Set<(e: PacketEnvelope) => void>>();
 * const relay: WindowRelay = {
 *   publish: (w, e) => listeners.get(w)?.forEach((l) => l(e)),
 *   subscribe: (w, l) => { ... },
 *   connected: createStore(true).view,
 * };
 * ```
 *
 * @public
 */
export interface WindowRelay {
  /**
   * @summary Sends a Window broadcast to the other connections of the same window.
   * @description It must not throw for a transport failure.
   * @example
   * What the client calls
   * ```ts
   * relay.publish(windowId, envelope);
   * ```
   * @param {string} windowId The window id of this browser session.
   * @param {PacketEnvelope} envelope The broadcast.
   */
  publish(windowId: string, envelope: PacketEnvelope): void;
  /**
   * @summary Receives the Window broadcasts that other connections of the same window send.
   * @example
   * What the client calls
   * ```ts
   * const stop = relay.subscribe(windowId, onEnvelope);
   * ```
   * @param {string} windowId The window id of this browser session.
   * @param {(envelope: PacketEnvelope) => void} listener Called with each broadcast.
   * @returns {() => void} Stops the listener.
   */
  subscribe(windowId: string, listener: (envelope: PacketEnvelope) => void): () => void;
  /**
   * @summary Tells if the relay can reach the server now, as a view.
   * @description The client counts a connected relay as `site` reach.
   */
  readonly connected: View<boolean>;
}

/**
 * @summary How the client reaches the other tabs.
 * @public
 */
export type WindowMode = 'iframe' | 'direct' | 'single-origin';

/**
 * @summary Which tabs a Window broadcast reaches: the whole site, this origin only, or not known yet.
 * @public
 */
export type WindowReach = 'site' | 'origin' | 'unknown';

/**
 * @summary The client's status.
 *
 * @description
 * `connection` is the link's state; `hub` whether the hub shares one
 * partition; `relay` the relay's state (`none` without one); `reach` what
 * that adds up to; `windowId` the browser session's window id, once known.
 *
 * @example
 * Example 1: Chrome, on a subdomain
 * ```ts
 * // { mode: 'iframe', connection: 'connected', hub: 'shared', relay: 'none', reach: 'site', windowId: 'w1' }
 * ```
 *
 * @example
 * Example 2: Safari without a relay
 * ```ts
 * // { mode: 'iframe', connection: 'connected', hub: 'partitioned', relay: 'none', reach: 'origin', windowId: 'w1' }
 * ```
 *
 * @public
 */
export interface WindowStatus {
  /**
   * @summary How the client reaches the other tabs: `iframe`, `direct` or `single-origin`.
   */
  readonly mode: WindowMode;
  /**
   * @summary The state of the link to the hub.
   * @description `idle` before `connect`, and `closed` after `close`.
   */
  readonly connection: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed';
  /**
   * @summary Tells if all framed copies of the hub share one partition.
   * @description It stays `unknown` until a tab on another origin connects.
   */
  readonly hub: HubPartition;
  /**
   * @summary The state of the relay, or `none` without a relay.
   */
  readonly relay: 'none' | 'connected' | 'disconnected';
  /**
   * @summary The tabs that a Window broadcast reaches.
   * @description `site` means all tabs of the site. `origin` means the tabs of this origin only.
   */
  readonly reach: WindowReach;
  /**
   * @summary The window id of this browser session, or `null` before the first connection.
   * @description A single-origin app has no window id.
   */
  readonly windowId: string | null;
}

/**
 * @summary Options for {@linkcode createWindowClient}.
 *
 * @description
 * - `hubUrl`: the hub page on the apex; leave it out for a single-origin app.
 * - `channel`: the `BroadcastChannel` name (default `__platform_window`; must match the hub page).
 * - `relay`: the relay for browsers that partition the hub (the Global transport, M8).
 * - `heartbeatMs` (default 10000), `timeoutMs` (default 5000), `retryBaseMs` (default 500): heartbeat and reconnection.
 * - `bufferSize` (default 100): envelopes held while connecting.
 * - `origin`, `cookies`, `link`, `random`: replace `location.origin`, `document.cookie`, the link and the jitter source (tests).
 *
 * @example
 * Example 1: A subdomain tab with a relay
 * ```ts
 * createWindowClient({ hubUrl: 'https://example.com/__platform/hub.html', relay: globalTransport.windowRelay });
 * ```
 *
 * @example
 * Example 2: A single-origin app
 * ```ts
 * createWindowClient({});
 * ```
 *
 * @public
 */
export interface WindowClientOptions {
  /**
   * @summary The URL of the hub page on the apex.
   * @description Leave it out for a single-origin app.
   */
  readonly hubUrl?: string;
  /**
   * @summary The name of the `BroadcastChannel`.
   * @description The default is `__platform_window`. It must match the name in `renderHubPage`.
   */
  readonly channel?: string;
  /**
   * @summary The relay for browsers that partition the hub.
   * @description The Global transport gives one from M8.
   */
  readonly relay?: WindowRelay;
  /**
   * @summary The time between two pings of the hub, in milliseconds.
   * @description The default is 10000.
   */
  readonly heartbeatMs?: number;
  /**
   * @summary The longest time to wait for `welcome` and for each `pong`, in milliseconds.
   * @description The default is 5000.
   */
  readonly timeoutMs?: number;
  /**
   * @summary The first wait before a reconnection, in milliseconds.
   * @description The default is 500. The wait grows with each failure, up to 30 seconds.
   */
  readonly retryBaseMs?: number;
  /**
   * @summary The number of broadcasts that the client holds while it connects.
   * @description The default is 100. When the buffer is full, the oldest broadcast is dropped.
   */
  readonly bufferSize?: number;
  /**
   * @summary The origin of this tab.
   * @description The default is `location.origin`. Tests give a value.
   */
  readonly origin?: string;
  /**
   * @summary The cookie jar.
   * @description The default uses `document.cookie`. Tests give an in-memory jar.
   */
  readonly cookies?: CookieJar;
  /**
   * @summary The link to the hub.
   * @description The default follows the mode. Tests give a fake link.
   */
  readonly link?: HubLink;
  /**
   * @summary The source of random numbers for the backoff jitter.
   */
  readonly random?: () => number;
}

/**
 * @summary One tab's connection to Window scope.
 *
 * @description
 * `connect` resolves once the link is open (and keeps reconnecting after a
 * failure, which it also rejects with). `publish` sends a Window broadcast
 * from this tab. `onEnvelope` receives broadcasts from other tabs, once each.
 * `status` is observable. `close` disconnects for good.
 *
 * @example
 * Example 1: Wiring it by hand
 * ```ts
 * const client = createWindowClient({ hubUrl });
 * client.onEnvelope((envelope) => console.log('from another tab', envelope.eventId));
 * await client.connect();
 * client.publish(envelope);
 * ```
 *
 * @example
 * Example 2: In a subsystem
 * ```ts
 * createWindowTransport({ hubUrl }); // builds its own client (transport.ts)
 * ```
 *
 * @public
 */
export interface WindowClient {
  /**
   * @summary The status of the client, as a view.
   */
  readonly status: View<WindowStatus>;
  /**
   * @summary Opens the link to the hub.
   * @description After a failure, the client also reconnects with backoff.
   * Broadcasts in the buffer go out after the connection.
   * @example
   * Connecting at startup
   * ```ts
   * await client.connect();
   * ```
   * @returns {Promise<void>} Resolves when the link is open.
   * @throws {HubUnavailableError} When the hub does not answer in time.
   * @throws {Error} When the client is closed.
   */
  connect(): Promise<void>;
  /**
   * @summary Sends a Window broadcast from this tab to the other tabs.
   * @description The client sends through the hub, and also through the relay
   * while the hub is not known to be shared. While it connects, it buffers the broadcast.
   * @example
   * Sending a broadcast by hand
   * ```ts
   * client.publish(envelope);
   * ```
   * @param {PacketEnvelope} envelope A Window-scope broadcast.
   * @throws {TypeError} When the envelope is not a Window-scope broadcast.
   */
  publish(envelope: PacketEnvelope): void;
  /**
   * @summary Receives the broadcasts of the other tabs, one time each.
   * @example
   * Handing them to the Queue
   * ```ts
   * client.onEnvelope((envelope) => void queue.commands.ingest(envelope));
   * ```
   * @param {(envelope: PacketEnvelope) => void} listener Called with each broadcast.
   * @returns {() => void} Stops the listener.
   */
  onEnvelope(listener: (envelope: PacketEnvelope) => void): () => void;
  /**
   * @summary Disconnects for good.
   * @description The client stops its timers, removes the link and drops the buffer. `connect` then throws.
   * @example
   * Closing at teardown
   * ```ts
   * return () => client.close();
   * ```
   */
  close(): void;
}

/**
 * @summary Creates a {@linkcode WindowClient}.
 *
 * @example
 * Example 1: On a subdomain
 * ```ts
 * const client = createWindowClient({ hubUrl: 'https://example.com/__platform/hub.html' });
 * ```
 *
 * @example
 * Example 2: In a test, with a fake link
 * ```ts
 * createWindowClient({ hubUrl, origin: 'https://a.site.test', link: fakeLink, cookies: jar });
 * ```
 *
 * @param {WindowClientOptions} [options] Hub URL, relay, timings and test stand-ins.
 * @returns {WindowClient} The client.
 *
 * @public
 */
export function createWindowClient(options: WindowClientOptions = {}): WindowClient {
  const origin = options.origin ?? location.origin;
  const hubUrl = options.hubUrl ? new URL(options.hubUrl) : null;
  const mode: WindowMode = !hubUrl
    ? 'single-origin'
    : hubUrl.origin === origin
      ? 'direct'
      : 'iframe';
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const bufferSize = options.bufferSize ?? 100;
  const relay = options.relay;
  const cookies = mode === 'single-origin' ? null : (options.cookies ?? documentCookies());
  const link: HubLink =
    options.link ??
    (mode === 'iframe'
      ? iframeLink({ hubUrl: hubUrl!.href, timeoutMs: options.timeoutMs })
      : channelLink({
          channel,
          partition: mode === 'direct' ? () => readPartitionId(indexedDB) : undefined,
        }));

  const dedupe = createDeduplicator(1000);
  const listeners = new Set<(envelope: PacketEnvelope) => void>();
  const buffer: PacketEnvelope[] = [];
  const store = createStore<WindowStatus>({
    mode,
    connection: 'idle',
    hub: mode === 'single-origin' ? 'shared' : 'unknown',
    relay: relay ? 'disconnected' : 'none',
    reach: mode === 'single-origin' ? 'site' : 'unknown',
    windowId: null,
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopRelay: (() => void) | undefined;
  let stopRelayStatus: (() => void) | undefined;
  let closed = false;

  const update = (patch: Partial<WindowStatus>) => {
    const next = { ...store.view.getSnapshot(), ...patch };
    const reach: WindowReach =
      next.mode === 'single-origin' || next.hub === 'shared' || next.relay === 'connected'
        ? 'site'
        : next.hub === 'partitioned'
          ? 'origin'
          : 'unknown';
    store.set({ ...next, reach });
  };

  const receive = (envelope: unknown) => {
    if (!isWindowBroadcast(envelope) || dedupe.seen(envelope.metadata.messageId)) return;
    for (const listener of [...listeners]) listener(envelope);
  };

  /** The hub state, refreshed from the cookie (another tab may have learned more). */
  const hubState = (): HubPartition => {
    const current = store.view.getSnapshot();
    if (!cookies || current.hub === 'partitioned' || current.hub === 'shared') return current.hub;
    const fresh = readWindowCookie(cookies)?.hub ?? current.hub;
    if (fresh !== current.hub) update({ hub: fresh });
    return fresh;
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearTimeout(retry);
    attempts += 1;
    const wait = computeBackoff({
      base: retryBaseMs,
      attempts,
      strategy: 'exponential-jitter',
      maxCapMs: 30_000,
      random: options.random,
    });
    retry = setTimeout(() => void connect().catch(() => undefined), wait);
  };

  const startHeartbeat = () => {
    clearInterval(heartbeat);
    if (!link.ping) return;
    heartbeat = setInterval(() => {
      link.ping!().catch(() => {
        clearInterval(heartbeat);
        link.close();
        update({ connection: 'disconnected' });
        scheduleReconnect();
      });
    }, heartbeatMs);
  };

  const attachRelay = (windowId: string) => {
    if (!relay || stopRelay) return;
    stopRelay = relay.subscribe(windowId, receive);
    const sync = () =>
      update({ relay: relay.connected.getSnapshot() ? 'connected' : 'disconnected' });
    stopRelayStatus = relay.connected.subscribe(sync);
    sync();
  };

  async function connect(): Promise<void> {
    if (closed) throw new Error('The Window client is closed.');
    update({ connection: 'connecting' });
    try {
      const { partitionId } = await link.open(receive);
      if (closed) return link.close();
      attempts = 0;
      if (cookies && partitionId !== null) {
        const cookie = recordConnection(cookies, {
          partitionId,
          origin,
          domain: hubUrl!.hostname,
          secure: hubUrl!.protocol === 'https:',
        });
        update({ hub: cookie.hub, windowId: cookie.windowId });
        attachRelay(cookie.windowId);
      }
      update({ connection: 'connected' });
      startHeartbeat();
      for (const envelope of buffer.splice(0)) link.publish(envelope);
    } catch (error) {
      update({ connection: 'disconnected' });
      scheduleReconnect();
      throw error;
    }
  }

  return {
    status: store.view,
    connect,
    publish(envelope) {
      if (!isWindowBroadcast(envelope)) {
        throw new TypeError('Only Window-scope broadcasts cross the hub.');
      }
      dedupe.seen(envelope.metadata.messageId); // our own, if it comes back through the relay
      if (store.view.getSnapshot().connection === 'connected') {
        link.publish(envelope);
      } else if (!closed) {
        buffer.push(envelope);
        if (buffer.length > bufferSize) buffer.shift();
      }
      const { windowId } = store.view.getSnapshot();
      if (relay && windowId && hubState() !== 'shared') relay.publish(windowId, envelope);
    },
    onEnvelope(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retry);
      stopRelay?.();
      stopRelayStatus?.();
      link.close();
      buffer.length = 0;
      update({ connection: 'closed' });
    },
  };
}
