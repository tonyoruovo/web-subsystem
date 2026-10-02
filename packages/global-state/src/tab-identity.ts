/**
 * @fileoverview
 * @summary Tab identity: an id that survives reloads and is unique for duplicated tabs.
 * @description
 * The id is kept in `sessionStorage`, so a reload keeps it. Duplicating a tab
 * copies `sessionStorage` too, so a stored id alone could be shared by two
 * tabs. {@linkcode resolveTabIdentity} therefore asks the other tabs over a
 * `BroadcastChannel` whether the id is taken, and mints a new one if a live
 * tab answers.
 *
 * ```text
 *   new tab:        no stored id ----------------------------> mint, store
 *   reload:         stored id --> probe --> no answer -------> keep
 *   duplicated tab: stored id --> probe --> 'taken' reply ---> mint, store
 *   every tab:      answers probes for its own id with 'taken'
 *   ```
 *
 * @example
 * Resolving this tab's id
 * ```ts
 * import { resolveTabIdentity } from '@platform/global-state';
 *
 * const identity = await resolveTabIdentity();
 * console.log(identity.id); // 'tab_...'
 * // on shutdown:
 * identity.close();
 * ```
 *
 * @example
 * Two "tabs" in a test, sharing copied storage
 * ```ts
 * const storage = new Map<string, string>();
 * const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) };
 * const first = await resolveTabIdentity({ storage: store });
 * const duplicate = await resolveTabIdentity({ storage: store }); // gets a different id
 * ```
 *
 * @author MathAid
 */

/** @summary The storage key of the tab id. @internal */
const STORAGE_KEY = 'platform:tab-id';

/** @summary The channel tabs probe each other on. @internal */
const CHANNEL_NAME = 'platform:tab-identity';

/**
 * @summary The parts of `Storage` tab identity needs.
 * @public
 */
export type TabIdStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * @summary The parts of `BroadcastChannel` tab identity needs.
 * @public
 */
export interface TabChannel {
  /**
   * @summary Sends a message to the other tabs.
   * @param {unknown} message A probe message.
   */
  postMessage(message: unknown): void;
  /**
   * @summary Listens to the messages of the other tabs.
   * @param {'message'} type The event type.
   * @param {(event: MessageEvent) => void} listener Called with each message.
   */
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /**
   * @summary Stops a listener.
   * @param {'message'} type The event type.
   * @param {(event: MessageEvent) => void} listener The listener to remove.
   */
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /**
   * @summary Closes the channel.
   */
  close(): void;
}

/**
 * @summary Options for {@linkcode resolveTabIdentity}.
 *
 * @description
 * Every option has a browser default: `storage` is `sessionStorage` (or an
 * in-memory store where it does not exist), `channel` opens a
 * `BroadcastChannel` (or none, which skips the duplicate check),
 * `probeTimeoutMs` is how long to wait for a `taken` reply (default 100), and
 * `ids` mints new ids (default `tab_` plus a random UUID).
 *
 * @example
 * Example 1: A shorter probe
 * ```ts
 * resolveTabIdentity({ probeTimeoutMs: 50 });
 * ```
 *
 * @example
 * Example 2: No duplicate detection
 * ```ts
 * resolveTabIdentity({ channel: () => null });
 * ```
 *
 * @public
 */
export interface TabIdentityOptions {
  /**
   * @summary Where the id stays across reloads.
   * @description The default is `sessionStorage`, which a duplicated tab
   * copies. Where it does not exist, the default is an in-memory store.
   */
  readonly storage?: TabIdStorage;
  /**
   * @summary Opens the probe channel.
   * @description Return `null` to skip the check for duplicated tabs. The
   * default opens a `BroadcastChannel`.
   */
  readonly channel?: () => TabChannel | null;
  /**
   * @summary The time to wait for a `taken` reply, in milliseconds.
   * @description The default is 100.
   */
  readonly probeTimeoutMs?: number;
  /**
   * @summary Makes a new id.
   * @description The default is `tab_` followed by a random UUID.
   */
  readonly ids?: () => string;
}

/**
 * @summary This tab's resolved identity.
 *
 * @description
 * `id` is the tab's id. While open, the identity answers other tabs' probes
 * for that id; `close` stops answering and closes the channel.
 *
 * @example
 * Example 1: Tagging data with the tab
 * ```ts
 * const draftKey = `draft:${identity.id}`;
 * ```
 *
 * @example
 * Example 2: Closing on shutdown
 * ```ts
 * addEventListener('pagehide', () => identity.close());
 * ```
 *
 * @public
 */
export interface TabIdentity {
  /**
   * @summary The id of this tab.
   */
  readonly id: string;
  /**
   * @summary Stops the answers to probes and closes the channel.
   * @example
   * Closing on shutdown
   * ```ts
   * addEventListener('pagehide', () => identity.close());
   * ```
   */
  close(): void;
}

/** @summary The probe protocol's messages. @internal */
type ProbeMessage =
  | { readonly type: 'probe'; readonly id: string; readonly nonce: string }
  | { readonly type: 'taken'; readonly id: string; readonly nonce: string };

/**
 * @summary An in-memory {@linkcode TabIdStorage}, where `sessionStorage` does not exist.
 * @internal
 */
function memoryStorage(): TabIdStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

/**
 * @summary Resolves this tab's identity, minting a new id for a new or duplicated tab.
 *
 * @description
 * Reads the stored id (minting one if there is none), probes the other tabs
 * for it, waits `probeTimeoutMs`, and mints a new id if a live tab answers
 * that the id is taken. The returned identity then answers probes for its
 * own id until `close` is called.
 *
 * @example
 * Example 1: In Global State
 * ```ts
 * const identity = await resolveTabIdentity();
 * ctx.state.update((s) => void (s.tabId = identity.id));
 * ```
 *
 * @example
 * Example 2: With fixed ids in a test
 * ```ts
 * let n = 0;
 * const identity = await resolveTabIdentity({ ids: () => `tab_${++n}` });
 * ```
 *
 * @param {TabIdentityOptions} [options] Storage, channel, probe timeout and id source.
 * @returns {Promise<TabIdentity>} The identity.
 *
 * @public
 */
export async function resolveTabIdentity(options: TabIdentityOptions = {}): Promise<TabIdentity> {
  const storage =
    options.storage ??
    (globalThis as { sessionStorage?: Storage }).sessionStorage ??
    memoryStorage();
  const ids = options.ids ?? (() => `tab_${crypto.randomUUID()}`);
  const channel =
    options.channel?.() ??
    (options.channel === undefined && typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(CHANNEL_NAME)
      : null);

  let id = storage.getItem(STORAGE_KEY) ?? '';
  const minted = id === '';
  if (minted) {
    id = ids();
    storage.setItem(STORAGE_KEY, id);
  }
  if (!channel) return { id, close: () => {} };

  const nonce = crypto.randomUUID();
  let taken = false;
  const onMessage = (event: MessageEvent) => {
    const message = event.data as ProbeMessage | undefined;
    if (!message || message.id !== id) return;
    // Answer other tabs' probes (not our own); accept replies addressed to our probe.
    if (message.type === 'probe' && message.nonce !== nonce) {
      channel.postMessage({ type: 'taken', id, nonce: message.nonce } satisfies ProbeMessage);
    } else if (message.type === 'taken' && message.nonce === nonce) {
      taken = true;
    }
  };
  channel.addEventListener('message', onMessage);

  // A stored id may belong to the tab this one was duplicated from.
  if (!minted) {
    channel.postMessage({ type: 'probe', id, nonce } satisfies ProbeMessage);
    await new Promise((resolve) => setTimeout(resolve, options.probeTimeoutMs ?? 100));
    if (taken) {
      id = ids();
      storage.setItem(STORAGE_KEY, id);
    }
  }

  return {
    get id() {
      return id;
    },
    close() {
      channel.removeEventListener('message', onMessage);
      channel.close();
    },
  };
}
