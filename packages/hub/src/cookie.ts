/**
 * @fileoverview
 * @summary The window cookie: the browser session's window id, and whether the hub shares one partition.
 * @description
 * Implements partition detection of docs/ARCHITECTURE.md §11.3. Top-level
 * pages on every subdomain share a cookie set for the apex domain, in every
 * browser, even where the hub iframe is partitioned. The cookie records:
 *
 * ```text
 *   __platform_window = w.p.o.h
 *     w  window id       random, for this browser session; the relay groups connections by it
 *     p  reference id    the partition id of the first hub that connected
 *     o  reference origin the origin of the tab that connected it
 *     h  hub state       u (unknown) | s (shared) | p (partitioned)
 *
 *   a tab connects with partition id P from origin O:
 *     no cookie                      --> write w=new, p=P, o=O, h=u
 *     h = p                          --> partitioned (final)
 *     P = p and O != o               --> shared       (two origins, one partition)
 *     P != p                         --> partitioned  (two partitions)
 *     P = p and O = o                --> unchanged    (same origin proves nothing)
 *   ```
 *
 * @example
 * Recording a connection
 * ```ts
 * const state = recordConnection(cookieJar, { partitionId, origin: location.origin, domain: 'example.com' });
 * state.hub; // 'unknown' | 'shared' | 'partitioned'
 * ```
 *
 * @example
 * Reading the latest state before a send
 * ```ts
 * readWindowCookie(cookieJar)?.hub;
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Whether every framed copy of the hub shares one partition.
 * @public
 */
export type HubPartition = 'unknown' | 'shared' | 'partitioned';

/**
 * @summary Reads and writes `document.cookie`, or a stand-in for tests.
 *
 * @example
 * Example 1: The default
 * ```ts
 * const jar: CookieJar = { read: () => document.cookie, write: (c) => (document.cookie = c) };
 * ```
 *
 * @example
 * Example 2: A jar for tests
 * ```ts
 * let cookie = '';
 * const jar: CookieJar = { read: () => cookie, write: (c) => (cookie = c.split(';')[0]) };
 * ```
 *
 * @public
 */
export interface CookieJar {
  /** Every cookie, as `document.cookie` returns them. */
  read(): string;
  /** Sets one cookie, as assigning `document.cookie` does. */
  write(cookie: string): void;
}

/**
 * @summary The window cookie's content.
 *
 * @example
 * Example 1: After the first tab
 * ```ts
 * // { windowId: 'w1', partitionId: 'p1', origin: 'https://a.example.com', hub: 'unknown' }
 * ```
 *
 * @example
 * Example 2: Using the window id
 * ```ts
 * relay.subscribe(state.windowId, onEnvelope);
 * ```
 *
 * @public
 */
export interface WindowCookie {
  readonly windowId: string;
  readonly partitionId: string;
  readonly origin: string;
  readonly hub: HubPartition;
}

/**
 * @summary The cookie's name.
 * @constant {'__platform_window'}
 * @public
 */
export const WINDOW_COOKIE = '__platform_window';

const HUB_CODES: Readonly<Record<HubPartition, string>> = {
  unknown: 'u',
  shared: 's',
  partitioned: 'p',
};

/**
 * @summary The browser's cookie jar (`document.cookie`).
 *
 * @example
 * Example 1: The client's default
 * ```ts
 * createWindowClient({ hubUrl, cookies: documentCookies() });
 * ```
 *
 * @example
 * Example 2: Reading it
 * ```ts
 * documentCookies().read();
 * ```
 *
 * @returns {CookieJar} A jar over `document.cookie`.
 *
 * @public
 */
export function documentCookies(): CookieJar {
  return {
    read: () => document.cookie,
    write: (cookie) => void (document.cookie = cookie),
  };
}

/**
 * @summary Reads the window cookie, or `null` when it is absent or malformed.
 *
 * @example
 * Example 1: Before any tab connected
 * ```ts
 * readWindowCookie(jar); // null
 * ```
 *
 * @example
 * Example 2: The hub state
 * ```ts
 * readWindowCookie(jar)?.hub === 'shared';
 * ```
 *
 * @param {CookieJar} jar The cookies.
 * @returns {WindowCookie | null} Its content.
 *
 * @public
 */
export function readWindowCookie(jar: CookieJar): WindowCookie | null {
  const entry = jar
    .read()
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WINDOW_COOKIE}=`));
  if (!entry) return null;
  const [windowId, partitionId, origin, code] = entry.slice(WINDOW_COOKIE.length + 1).split('.');
  const hub = (Object.keys(HUB_CODES) as HubPartition[]).find((h) => HUB_CODES[h] === code);
  if (!windowId || !partitionId || !origin || !hub) return null;
  return { windowId, partitionId, origin: decodeURIComponent(origin), hub };
}

/**
 * @summary Writes the window cookie: a session cookie for the apex domain.
 *
 * @example
 * Example 1: On https
 * ```ts
 * writeWindowCookie(jar, state, 'example.com');
 * // __platform_window=w1.p1.https%3A%2F%2Fa.example.com.u; Domain=example.com; Path=/; SameSite=Lax; Secure
 * ```
 *
 * @example
 * Example 2: On a local http host, without Secure
 * ```ts
 * writeWindowCookie(jar, state, 'localhost', false);
 * ```
 *
 * @param {CookieJar} jar The cookies.
 * @param {WindowCookie} value The content.
 * @param {string} domain The apex domain.
 * @param {boolean} [secure=true] Add `Secure` (https only).
 *
 * @public
 */
export function writeWindowCookie(
  jar: CookieJar,
  value: WindowCookie,
  domain: string,
  secure = true,
): void {
  // '.' separates the fields, so the origin's dots are percent-encoded too.
  const origin = encodeURIComponent(value.origin).replace(/\./g, '%2E');
  const content = [value.windowId, value.partitionId, origin, HUB_CODES[value.hub]].join('.');
  jar.write(
    `${WINDOW_COOKIE}=${content}; Domain=${domain}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`,
  );
}

/**
 * @summary Records one tab's connection to a hub and returns the updated cookie (see the table above).
 *
 * @example
 * Example 1: Chrome, a second subdomain
 * ```ts
 * recordConnection(jar, { partitionId: 'p1', origin: 'https://b.example.com', domain: 'example.com' }).hub; // 'shared'
 * ```
 *
 * @example
 * Example 2: Safari, a second subdomain
 * ```ts
 * recordConnection(jar, { partitionId: 'p2', origin: 'https://b.example.com', domain: 'example.com' }).hub; // 'partitioned'
 * ```
 *
 * @param {CookieJar} jar The cookies.
 * @param {object} connection This tab's hub `partitionId`, its `origin`, the apex `domain`, and `secure` (default `true`).
 * @returns {WindowCookie} The cookie after this connection.
 *
 * @public
 */
export function recordConnection(
  jar: CookieJar,
  connection: {
    readonly partitionId: string;
    readonly origin: string;
    readonly domain: string;
    readonly secure?: boolean;
    readonly newId?: () => string;
  },
): WindowCookie {
  const current = readWindowCookie(jar);
  let next: WindowCookie;
  if (!current) {
    next = {
      windowId: (connection.newId ?? (() => crypto.randomUUID()))(),
      partitionId: connection.partitionId,
      origin: connection.origin,
      hub: 'unknown',
    };
  } else if (current.hub === 'partitioned') {
    return current;
  } else if (current.partitionId !== connection.partitionId) {
    next = { ...current, hub: 'partitioned' };
  } else if (current.origin !== connection.origin) {
    next = { ...current, hub: 'shared' };
  } else {
    return current;
  }
  writeWindowCookie(jar, next, connection.domain, connection.secure ?? true);
  return next;
}
