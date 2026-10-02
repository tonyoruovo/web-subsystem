/**
 * @fileoverview
 * @summary The platform: assembles and wires all managers into one drop-in object.
 * @description
 * This is the M6 entry point. It constructs every manager in boot order,
 * wires the load-bearing integrations (the queue's admission gate to Global
 * State, storage encryption to Crypto, analytics to a consent gate), and returns a
 * single object with a lifecycle. A fresh app calls `createPlatform`, then
 * `markReady`.
 *
 * ```text
 *   Global State -> Queue -> Notification -> Crypto
 *     -> Storage -> Network -> Auth -> Realtime
 *     -> Sync -> Translation -> Analytics
 *   ```
 *
 * The Logger and Consent managers moved to `@platform/logger` and
 * `@platform/consent` (M4): warnings go to `options.warn`, and analytics asks
 * `options.analyticsConsent`, which denies by default.
 *
 * Optional injectables (storage backend, fetch, socket factory, crypto) let
 * tests and alternate environments substitute their own implementations.
 *
 * @see {@linkcode createPlatform}
 * @author MathAid
 */

import { AnalyticsManager, type AnalyticsSnapshot } from './analytics/analytics.manager';
import {
  AuthManager,
  type AuthCredentials,
  type AuthTokens,
  type AuthUser,
} from './auth/auth.manager';
import { defaultQueueConfig } from './bus';
import { cryptoCodec } from './crypto/crypto.codec';
import { CryptoManager } from './crypto/crypto.manager';
import { GlobalState } from './global/global-state.manager';
import { NetworkManager } from './network/network.manager';
import { NotificationCenter } from './notification/notification.manager';
import { MessageQueue } from './queue/queue.manager';
import { RealtimeManager, type RealtimeSocket } from './realtime/realtime.manager';
import { StorageFacade } from './storage/storage.facade';
import type { IStorageBackend, StorageFacadeConfig } from './storage/storage.types';
import { SyncManager } from './sync/sync.manager';
import { TranslationManager } from './translation/translation.manager';

/**
 * @summary Options for {@linkcode createPlatform}.
 */
export interface PlatformOptions {
  /** The busy threshold for Global State. Defaults to 50. */
  busyThreshold?: number;
  /** The storage backend. When provided, storage is wired. */
  storageBackend?: IStorageBackend<string>;
  /** The storage facade config. Required when `storageBackend` is provided. */
  storageConfig?: StorageFacadeConfig;
  /** Encrypt and compress storage when `true`. */
  secure?: boolean;
  /** A pre-created Crypto manager. Defaults to a new one. */
  cryptoManager?: CryptoManager;
  /** The fetch function for Network. */
  fetchFn?: NetworkManager['fetchFn'];
  /** The socket factory for Realtime. */
  socketFactory?: () => RealtimeSocket;
  /** The login function for Auth. */
  loginFn?: (credentials: AuthCredentials) => Promise<{ user: AuthUser; tokens: AuthTokens }>;
  /** The refresh function for Auth. */
  refreshFn?: (refreshToken: string) => Promise<AuthTokens>;
  /** The analytics transport. */
  analyticsTransport?: (snapshot: AnalyticsSnapshot) => Promise<void>;
  /** Whether analytics may collect. Defaults to `() => false`: no consent, no analytics. */
  analyticsConsent?: () => boolean;
  /** Receives warnings from Storage and Network. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * @summary The assembled platform.
 */
export interface Platform {
  readonly globalState: GlobalState;
  readonly queue: MessageQueue;
  readonly notifications: NotificationCenter;
  readonly crypto: CryptoManager;
  readonly storage: StorageFacade | null;
  readonly network: NetworkManager;
  readonly auth: AuthManager;
  readonly realtime: RealtimeManager | null;
  readonly sync: SyncManager;
  readonly translation: TranslationManager;
  readonly analytics: AnalyticsManager;
  /** Transitions Global State from INITIALIZING to IDLE. */
  markReady(): void;
  /** Stops the platform and blocks new work. */
  stop(): void;
  /** Tears down resources. */
  dispose(): void;
}

/**
 * @summary Creates and wires the full platform.
 * @description
 * Constructs every manager in boot order and wires the integrations. Optional
 * injectables let callers substitute storage, fetch, the socket, or crypto.
 *
 * @example
 * Example 1: Boot the platform
 * ```ts
 * const platform = await createPlatform({ storageBackend, storageConfig });
 * platform.markReady();
 * await platform.storage?.set('count', { n: 1 }, schema);
 * ```
 *
 * @param {PlatformOptions} [options] The injectables.
 * @returns {Promise<Platform>} The assembled platform.
 */
export async function createPlatform(options: PlatformOptions = {}): Promise<Platform> {
  // 1. Global State
  const globalState = new GlobalState({ busyThreshold: options.busyThreshold });

  // 2. Message Queue, wired to Global State admission.
  const queue = new MessageQueue({
    config: defaultQueueConfig(),
    admission: (importance) => globalState.canAcceptWork(importance),
  });

  // 3. Notification Center
  const notifications = new NotificationCenter();

  // 4. Warnings, until the platform runs on the kernel (M10).
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // 5. Crypto
  const crypto = options.cryptoManager ?? new CryptoManager();
  await crypto.initialize();

  // 6. Storage (optional)
  let storage: StorageFacade | null = null;
  if (options.storageBackend && options.storageConfig) {
    storage = new StorageFacade({
      backend: options.storageBackend,
      config: options.storageConfig,
      secure: options.secure ?? false,
      codec: options.secure ? cryptoCodec(crypto) : undefined,
      warn: { warn },
    });
  }

  // 8. Network
  const network = new NetworkManager({
    fetchFn: options.fetchFn,
    warn: { warn },
  });

  // 9. Auth
  const auth = new AuthManager({ loginFn: options.loginFn, refreshFn: options.refreshFn });

  // 10. Realtime (optional)
  const realtime = options.socketFactory
    ? new RealtimeManager({ socketFactory: options.socketFactory })
    : null;

  // 11. Sync
  const sync = new SyncManager();

  // 12. Translation
  const translation = new TranslationManager();

  // 13. Analytics, gated by consent; fails closed.
  const analytics = new AnalyticsManager({
    transport: options.analyticsTransport,
    consent: options.analyticsConsent ?? (() => false),
  });

  return {
    globalState,
    queue,
    notifications,
    crypto,
    storage,
    network,
    auth,
    realtime,
    sync,
    translation,
    analytics,
    markReady: () => globalState.markReady(),
    stop: () => globalState.stop(),
    dispose: () => {
      realtime?.disconnect();
      crypto.zeroize();
    },
  };
}
