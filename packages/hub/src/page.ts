/**
 * @fileoverview
 * @summary The hub page: a static HTML file the app deploys on its apex, and the script inside it.
 * @description
 * Implements the hub of docs/ARCHITECTURE.md §11.3. Every tab on a subdomain
 * frames this page; the page joins one `BroadcastChannel` on the apex origin
 * and passes envelopes between it and its parent tab.
 *
 * ```text
 *   parent tab (allowed origin) --hello-->   hub  --welcome { partitionId }--> parent
 *   parent tab --publish(envelope)--> hub --> BroadcastChannel --> every other hub --envelope--> its parent
 *   parent tab --ping--> hub --pong--> parent         (heartbeat)
 *   ```
 *
 * The page checks every message's origin against the allowlist, answers only
 * the origin that said `hello`, and carries Window-scope broadcasts only.
 *
 * {@linkcode renderHubPage} produces the HTML at build time, with the
 * `Content-Security-Policy` to serve it with (the script's hash, and
 * `frame-ancestors` from the allowlist).
 *
 * @example
 * Writing the hub page during a build
 * ```ts
 * import { writeFile } from 'node:fs/promises';
 * import { renderHubPage } from '@platform/hub';
 *
 * const page = await renderHubPage({ allowedOrigins: ['https://example.com', 'https://*.example.com'] });
 * await writeFile('public/__platform/hub.html', page.html);
 * // Serve it with the header: Content-Security-Policy: page.csp (and no X-Frame-Options)
 * ```
 *
 * @example
 * Serving it from a Node server
 * ```ts
 * app.get('/__platform/hub.html', (req, res) => res.set('Content-Security-Policy', page.csp).type('html').send(page.html));
 * ```
 *
 * @author MathAid
 */

import { DEFAULT_CHANNEL, isWindowBroadcast, originAllowed, readPartitionId } from './shared';

/**
 * @summary Options for {@linkcode renderHubPage}.
 *
 * @description
 * `allowedOrigins` lists the origins that may frame and talk to the hub
 * (exact origins, or `https://*.example.com`); it must not be empty.
 * `channel` names the `BroadcastChannel` (default `__platform_window`); every
 * client must use the same name.
 *
 * @example
 * Example 1: A site and its subdomains
 * ```ts
 * renderHubPage({ allowedOrigins: ['https://example.com', 'https://*.example.com'] });
 * ```
 *
 * @example
 * Example 2: Two apps sharing one apex, kept apart
 * ```ts
 * renderHubPage({ allowedOrigins: ['https://*.example.com'], channel: 'shop' });
 * ```
 *
 * @public
 */
export interface HubPageOptions {
  /**
   * @summary The origins that can frame the hub and talk to it.
   * @description Use exact origins or `https://*.example.com` patterns. The list must not be empty.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * @summary The name of the `BroadcastChannel`.
   * @description The default is `__platform_window`. All clients must use the same name.
   */
  readonly channel?: string;
}

/**
 * @summary The rendered hub page: its HTML, and the header values to serve it with.
 *
 * @description
 * `html` is the complete file. `csp` is the `Content-Security-Policy` header
 * value: nothing but the inline script (by hash), and `frame-ancestors` from
 * the allowlist. Do not send `X-Frame-Options` for this path.
 *
 * @example
 * Example 1: An nginx location
 * ```ts
 * console.log(`add_header Content-Security-Policy "${page.csp}";`);
 * ```
 *
 * @example
 * Example 2: Checking the hash in a test
 * ```ts
 * expect(page.csp).toContain(page.scriptHash);
 * ```
 *
 * @public
 */
export interface HubPage {
  /**
   * @summary The full HTML file of the hub page.
   */
  readonly html: string;
  /**
   * @summary The value of the `Content-Security-Policy` header for the page.
   * @description It allows only the inline script, by hash, and sets
   * `frame-ancestors` from the allowlist.
   */
  readonly csp: string;
  /**
   * @summary The hash of the inline script, in CSP form: `'sha256-...'`.
   * @description The `csp` value contains it. A browser runs the script only when the hash matches.
   */
  readonly scriptHash: string;
}

/**
 * @summary The configuration the hub script receives.
 * @internal
 */
interface HubConfig {
  readonly allowedOrigins: readonly string[];
  readonly channel: string;
}

/**
 * @summary The hub page's script. Self-contained: rendered into the page with its helpers as arguments.
 *
 * @description
 * Not for direct use: {@linkcode renderHubPage} inlines it. It is exported
 * for the browser tests that run it in a real hub frame.
 *
 * @example
 * Example 1: What the page runs
 * ```ts
 * // <script>(hubMain)({ allowedOrigins: [...], channel: '__platform_window' }, originAllowed, readPartitionId, isWindowBroadcast)</script>
 * ```
 *
 * @example
 * Example 2: Running it in a test page
 * ```ts
 * hubMain({ allowedOrigins: ['https://*.site.test'], channel: 'test' }, originAllowed, readPartitionId, isWindowBroadcast);
 * ```
 *
 * @param {HubConfig} config The allowlist and channel name.
 * @param {typeof originAllowed} allowed The origin matcher.
 * @param {typeof readPartitionId} partition The partition id reader.
 * @param {typeof isWindowBroadcast} carried The envelope check.
 *
 * @public
 */
export function hubMain(
  config: HubConfig,
  allowed: typeof originAllowed,
  partition: typeof readPartitionId,
  carried: typeof isWindowBroadcast,
): void {
  const TAG = '__platform_hub';
  if (window.parent === window) return; // opened directly: tabs on the apex use the channel themselves
  const channel = new BroadcastChannel(config.channel);
  const partitionId = partition(indexedDB);
  let parentOrigin: string | null = null;

  const send = (message: Record<string, unknown>) => {
    if (parentOrigin !== null) window.parent.postMessage({ [TAG]: 1, ...message }, parentOrigin);
  };

  channel.onmessage = (event: MessageEvent) => {
    if (carried(event.data)) send({ type: 'envelope', envelope: event.data });
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || !allowed(event.origin, config.allowedOrigins)) return;
    const message = event.data as { [TAG]?: unknown; type?: unknown; envelope?: unknown } | null;
    if (!message || message[TAG] !== 1) return;
    if (message.type === 'hello') {
      parentOrigin = event.origin;
      void partitionId.then(
        (id) => send({ type: 'welcome', partitionId: id }),
        () => send({ type: 'welcome', partitionId: 'unavailable' }),
      );
    } else if (event.origin !== parentOrigin) {
      return; // only the origin that said hello
    } else if (message.type === 'publish' && carried(message.envelope)) {
      channel.postMessage(message.envelope);
    } else if (message.type === 'ping') {
      send({ type: 'pong' });
    }
  });
}

/**
 * @summary Renders the hub page: HTML with one inline script, and the CSP to serve it with.
 *
 * @example
 * Example 1: At build time
 * ```ts
 * const page = await renderHubPage({ allowedOrigins: ['https://example.com', 'https://*.example.com'] });
 * ```
 *
 * @example
 * Example 2: The header
 * ```ts
 * page.csp; // "default-src 'none'; script-src 'sha256-…'; frame-ancestors https://example.com https://*.example.com"
 * ```
 *
 * @param {HubPageOptions} options The allowlist and channel name.
 * @returns {Promise<HubPage>} The page and its header values.
 * @throws {RangeError} When `allowedOrigins` is empty or has an entry that is not an origin pattern.
 *
 * @public
 */
export async function renderHubPage(options: HubPageOptions): Promise<HubPage> {
  const { allowedOrigins } = options;
  if (allowedOrigins.length === 0)
    throw new RangeError('The hub needs at least one allowed origin.');
  for (const pattern of allowedOrigins) {
    if (!/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(pattern)) {
      throw new RangeError(`"${pattern}" is not an origin or an https://*.domain pattern.`);
    }
  }
  const config: HubConfig = { allowedOrigins, channel: options.channel ?? DEFAULT_CHANNEL };
  // JSON in a script: escape '<' so the config can never close the tag.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const script = `(${hubMain.toString()})(${json}, ${originAllowed.toString()}, ${readPartitionId.toString()}, ${isWindowBroadcast.toString()});`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
  const scriptHash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Platform hub</title></head><body><script>${script}</script></body></html>\n`;
  const csp = `default-src 'none'; script-src ${scriptHash}; frame-ancestors ${allowedOrigins.join(' ')}`;
  return { html, csp, scriptHash };
}
