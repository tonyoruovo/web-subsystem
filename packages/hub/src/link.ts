/**
 * @fileoverview
 * @summary Links: how a client reaches the hub's channel, through an iframe or directly.
 * @description
 * A {@linkcode HubLink} connects one tab to the Window channel. The client
 * picks one by where the tab is (docs/ARCHITECTURE.md §11.3):
 *
 * ```text
 *   tab on a subdomain        iframeLink   frames the hub page on the apex, talks over postMessage
 *   tab on the apex           channelLink  joins the hub's BroadcastChannel directly
 *   single-origin app         channelLink  a BroadcastChannel on the app's own origin
 *   ```
 *
 * @example
 * A link for a subdomain tab
 * ```ts
 * const link = iframeLink({ hubUrl: 'https://example.com/__platform/hub.html' });
 * const { partitionId } = await link.open(onEnvelope);
 * ```
 *
 * @example
 * A link for a tab on the apex
 * ```ts
 * const link = channelLink({ partition: () => readPartitionId(indexedDB) });
 * ```
 *
 * @author MathAid
 */

import type { PacketEnvelope } from '@platform/core';

import { DEFAULT_CHANNEL, HUB_TAG, isHubMessage, isWindowBroadcast } from './shared';

/**
 * @summary Thrown when the hub does not answer in time.
 *
 * @example
 * Example 1: The hub page is missing or blocked by frame-ancestors
 * ```ts
 * await link.open(onEnvelope); // rejects with HubUnavailableError after timeoutMs
 * ```
 *
 * @example
 * Example 2: Telling it apart
 * ```ts
 * catch (error) { if (error instanceof HubUnavailableError) showDeploymentHint(); }
 * ```
 *
 * @public
 */
export class HubUnavailableError extends Error {
  /**
   * @summary The name of the error class: `'HubUnavailableError'`.
   */
  override readonly name = 'HubUnavailableError';
}

/**
 * @summary One tab's connection to the Window channel.
 *
 * @description
 * `open` connects (replacing an earlier connection) and resolves with the hub
 * partition's id, or `null` where it does not matter (a single-origin app).
 * `publish` sends an envelope to the other tabs.
 * `ping`, when present, checks that the hub still answers. `close`
 * disconnects.
 *
 * @example
 * Example 1: A link for tests
 * ```ts
 * const link: HubLink = {
 *   open: async () => ({ partitionId: 'p1' }),
 *   publish: (envelope) => sent.push(envelope),
 *   close: () => {},
 * };
 * ```
 *
 * @example
 * Example 2: Heartbeat
 * ```ts
 * await link.ping?.(); // rejects when the hub stopped answering
 * ```
 *
 * @public
 */
export interface HubLink {
  /**
   * @summary Connects, and replaces an earlier connection.
   * @example
   * Opening a link
   * ```ts
   * const { partitionId } = await link.open((envelope) => deliver(envelope));
   * ```
   * @param {(envelope: unknown) => void} onEnvelope Called with each message from the other tabs.
   * @returns {Promise<{ readonly partitionId: string | null }>} The partition id of the hub, or `null` where it does not matter.
   * @throws {HubUnavailableError} When the hub does not answer in time.
   */
  open(onEnvelope: (envelope: unknown) => void): Promise<{ readonly partitionId: string | null }>;
  /**
   * @summary Sends a broadcast to the other tabs.
   * @param {PacketEnvelope} envelope The broadcast.
   */
  publish(envelope: PacketEnvelope): void;
  /**
   * @summary Checks that the hub still answers.
   * @description Only the iframe link has it. A channel link needs no heartbeat.
   * @returns {Promise<void>} Resolves when the hub answers.
   * @throws {HubUnavailableError} When the hub does not answer in time.
   */
  ping?(): Promise<void>;
  /**
   * @summary Disconnects.
   * @description The iframe link removes its iframe. The channel link closes its channel.
   */
  close(): void;
}

/**
 * @summary Options for {@linkcode iframeLink}.
 *
 * @description
 * `hubUrl` is the hub page on the apex. `timeoutMs` (default 5000) bounds
 * the wait for `welcome` and for each `pong`. `document` and `window`
 * replace the globals.
 *
 * @example
 * Example 1: The usual
 * ```ts
 * iframeLink({ hubUrl: 'https://example.com/__platform/hub.html' });
 * ```
 *
 * @example
 * Example 2: A slow network
 * ```ts
 * iframeLink({ hubUrl, timeoutMs: 15_000 });
 * ```
 *
 * @public
 */
export interface IframeLinkOptions {
  /**
   * @summary The URL of the hub page on the apex.
   */
  readonly hubUrl: string;
  /**
   * @summary The longest time to wait for `welcome` and for each `pong`, in milliseconds.
   * @description The default is 5000.
   */
  readonly timeoutMs?: number;
  /**
   * @summary The document to add the iframe to.
   * @description The default is the global `document`.
   */
  readonly document?: Document;
  /**
   * @summary The window to listen to messages on.
   * @description The default is the global `window`.
   */
  readonly window?: Window;
}

/**
 * @summary A link that frames the hub page and talks to it over `postMessage`.
 *
 * @description
 * Adds a hidden iframe, says `hello` until the hub answers `welcome` (or
 * `timeoutMs` passes), and accepts messages only from that iframe and the
 * hub's origin.
 *
 * @example
 * Example 1: Opening it
 * ```ts
 * const link = iframeLink({ hubUrl });
 * await link.open((envelope) => deliver(envelope));
 * ```
 *
 * @example
 * Example 2: Removing the iframe
 * ```ts
 * link.close();
 * ```
 *
 * @param {IframeLinkOptions} options The hub URL, timeout and globals.
 * @returns {HubLink} The link.
 *
 * @public
 */
export function iframeLink(options: IframeLinkOptions): HubLink {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const timeoutMs = options.timeoutMs ?? 5000;
  const hubOrigin = new URL(options.hubUrl).origin;
  let iframe: HTMLIFrameElement | null = null;
  let listener: ((event: MessageEvent) => void) | null = null;
  const pongs: (() => void)[] = [];

  const post = (message: Record<string, unknown>) =>
    iframe?.contentWindow?.postMessage({ [HUB_TAG]: 1, ...message }, hubOrigin);

  const close = () => {
    if (listener) win.removeEventListener('message', listener);
    listener = null;
    iframe?.remove();
    iframe = null;
  };

  return {
    open(onEnvelope) {
      close();
      return new Promise((resolve, reject) => {
        const frame = doc.createElement('iframe');
        iframe = frame;
        let hello: ReturnType<typeof setInterval> | undefined;
        const timer = setTimeout(() => {
          clearInterval(hello);
          close();
          reject(new HubUnavailableError(`The hub at ${options.hubUrl} did not answer.`));
        }, timeoutMs);

        listener = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.origin !== hubOrigin) return;
          const message = event.data as unknown;
          if (!isHubMessage(message)) return;
          if (message.type === 'welcome') {
            clearTimeout(timer);
            clearInterval(hello);
            resolve({ partitionId: message.partitionId });
          } else if (message.type === 'envelope') {
            onEnvelope(message.envelope);
          } else if (message.type === 'pong') {
            pongs.splice(0).forEach((pong) => pong());
          }
        };
        win.addEventListener('message', listener);

        frame.src = options.hubUrl;
        frame.title = 'Platform hub';
        frame.hidden = true;
        frame.setAttribute('aria-hidden', 'true');
        frame.style.display = 'none';
        // Say hello on load, and again until the hub answers (its script may start late).
        frame.addEventListener('load', () => {
          post({ type: 'hello' });
          hello = setInterval(() => post({ type: 'hello' }), 500);
        });
        (doc.body ?? doc.documentElement).append(frame);
      });
    },
    publish(envelope) {
      post({ type: 'publish', envelope });
    },
    ping() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new HubUnavailableError('The hub stopped answering.')),
          timeoutMs,
        );
        pongs.push(() => {
          clearTimeout(timer);
          resolve();
        });
        post({ type: 'ping' });
      });
    },
    close,
  };
}

/**
 * @summary Options for {@linkcode channelLink}.
 *
 * @description
 * `channel` names the `BroadcastChannel` (default `__platform_window`; it
 * must match the hub page's). `partition` reads the partition id (a tab on
 * the apex passes `() => readPartitionId(indexedDB)`); without it the id is
 * `null`.
 *
 * @example
 * Example 1: A tab on the apex
 * ```ts
 * channelLink({ partition: () => readPartitionId(indexedDB) });
 * ```
 *
 * @example
 * Example 2: A single-origin app
 * ```ts
 * channelLink();
 * ```
 *
 * @public
 */
export interface ChannelLinkOptions {
  /**
   * @summary The name of the `BroadcastChannel`.
   * @description The default is `__platform_window`. It must match the hub page.
   */
  readonly channel?: string;
  /**
   * @summary Reads the partition id.
   * @description A tab on the apex gives `() => readPartitionId(indexedDB)`. Without it, the partition id is `null`.
   */
  readonly partition?: () => Promise<string>;
}

/**
 * @summary A link that joins the Window `BroadcastChannel` on this tab's own origin.
 *
 * @example
 * Example 1: Opening it
 * ```ts
 * await channelLink().open(deliver);
 * ```
 *
 * @example
 * Example 2: Publishing
 * ```ts
 * link.publish(envelope);
 * ```
 *
 * @param {ChannelLinkOptions} [options] Channel name and partition id reader.
 * @returns {HubLink} The link.
 *
 * @public
 */
export function channelLink(options: ChannelLinkOptions = {}): HubLink {
  let channel: BroadcastChannel | null = null;
  return {
    async open(onEnvelope) {
      channel?.close();
      channel = new BroadcastChannel(options.channel ?? DEFAULT_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        if (isWindowBroadcast(event.data)) onEnvelope(event.data);
      };
      return { partitionId: options.partition ? await options.partition() : null };
    },
    publish(envelope) {
      channel?.postMessage(envelope);
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}
