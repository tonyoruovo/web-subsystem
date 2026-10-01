/**
 * @fileoverview
 * @summary The Auth manager: tokens, permissions, and temporary elevation.
 * @description
 * Implements the authentication core of M2. It holds the auth state, tokens,
 * user, permissions, and temporary elevations. Login and refresh are injected
 * so the manager is testable without a network. Tokens persist through the
 * Storage facade in a later wiring step; here they live in memory.
 *
 * ```text
 *   login(credentials) -> user + tokens -> AUTHENTICATED
 *   isAuthenticated()  -> checks expiry, flips to EXPIRED
 *   requestElevation() -> temporary permission grant with a TTL
 *   logout()           -> clear user, tokens, elevations
 *   ```
 *
 * A revoked or expired session degrades to a defined unauthenticated state. It
 * never crashes.
 *
 * @author MathAid
 */

/**
 * @summary The auth level, from the user's roles.
 */
export type AuthLevel = 'GUEST' | 'USER' | 'ADMIN' | 'CORPORATE' | 'MODERATOR' | 'SUSPENDED';

/**
 * @summary The auth status.
 */
export type AuthStatus = 'UNAUTHENTICATED' | 'AUTHENTICATED' | 'EXPIRED' | 'ERROR';

/**
 * @summary Login credentials.
 */
export interface AuthCredentials {
  username?: string;
  email?: string;
  password: string;
}

/**
 * @summary The tokens returned by login or refresh.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiry: number;
  refreshTokenExpiry: number;
}

/**
 * @summary The authenticated user.
 */
export interface AuthUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
}

/**
 * @summary Options for constructing an {@linkcode AuthManager}.
 */
export interface AuthManagerOptions {
  /** The login function. */
  loginFn?: (credentials: AuthCredentials) => Promise<{ user: AuthUser; tokens: AuthTokens }>;
  /** The refresh function. */
  refreshFn?: (refreshToken: string) => Promise<AuthTokens>;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id factory. Defaults to a local counter. */
  makeId?: () => string;
}

/**
 * @summary The Auth manager.
 * @description
 * One instance per realm. It is the security manager that hands temporary
 * elevation to subsystems.
 *
 * @example
 * Example 1: Log in and check a permission
 * ```ts
 * const auth = new AuthManager({ loginFn });
 * await auth.login({ username: 'a', password: 'b' });
 * if (auth.hasPermission('delete')) { /* ... *\/ }
 * ```
 */
export class AuthManager {
  /** @internal The auth status. */
  private status: AuthStatus = 'UNAUTHENTICATED';

  /** @internal The user. */
  private user: AuthUser | null = null;

  /** @internal The tokens. */
  private tokens: AuthTokens | null = null;

  /** @internal Elevation id to grant. */
  private readonly elevations = new Map<string, { expiresAt: number; permissions: string[] }>();

  /** @internal The login function. */
  private readonly loginFn: (
    credentials: AuthCredentials,
  ) => Promise<{ user: AuthUser; tokens: AuthTokens }>;

  /** @internal The refresh function. */
  private readonly refreshFn: (refreshToken: string) => Promise<AuthTokens>;

  /** @internal The clock. */
  private readonly now: () => number;

  /** @internal The id factory. */
  private readonly makeId: () => string;

  /**
   * @summary Creates an AuthManager.
   * @param {AuthManagerOptions} options The login/refresh functions and injectables.
   * @throws {Error} When `loginFn` or `refreshFn` is missing and used.
   */
  constructor(options: AuthManagerOptions) {
    this.loginFn = options.loginFn ?? (() => Promise.reject(new Error('[AuthManager] no loginFn')));
    this.refreshFn =
      options.refreshFn ?? (() => Promise.reject(new Error('[AuthManager] no refreshFn')));
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? makeCounter();
  }

  /**
   * @summary Logs in with credentials.
   * @param {AuthCredentials} credentials The credentials.
   * @returns {Promise<void>}
   */
  async login(credentials: AuthCredentials): Promise<void> {
    const { user, tokens } = await this.loginFn(credentials);
    this.user = user;
    this.tokens = tokens;
    this.status = 'AUTHENTICATED';
  }

  /**
   * @summary Logs out and clears sensitive state.
   * @returns {void}
   */
  logout(): void {
    this.user = null;
    this.tokens = null;
    this.elevations.clear();
    this.status = 'UNAUTHENTICATED';
  }

  /**
   * @summary Refreshes the access token.
   * @returns {Promise<void>}
   * @throws {Error} When there is no refresh token.
   */
  async refreshToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('[AuthManager] no refresh token');
    }
    this.tokens = await this.refreshFn(this.tokens.refreshToken);
  }

  /**
   * @summary Whether the user is authenticated and the token is not expired.
   * @returns {boolean} `true` when authenticated.
   */
  isAuthenticated(): boolean {
    if (this.status !== 'AUTHENTICATED') return false;
    if (this.tokens && this.tokens.accessTokenExpiry <= this.now()) {
      this.status = 'EXPIRED';
      return false;
    }
    return true;
  }

  /**
   * @summary The current auth status.
   * @returns {AuthStatus} The status.
   */
  getStatus(): AuthStatus {
    return this.status;
  }

  /**
   * @summary The user id, or `null`.
   * @returns {string | null} The id.
   */
  getUserId(): string | null {
    return this.user?.id ?? null;
  }

  /**
   * @summary The current access token, or `null`.
   * @returns {string | null} The token.
   */
  getAccessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  /**
   * @summary The auth level derived from roles.
   * @returns {AuthLevel} The level.
   */
  getAuthLevel(): AuthLevel {
    if (!this.isAuthenticated() || !this.user) return 'GUEST';
    if (this.user.roles.includes('ADMIN')) return 'ADMIN';
    if (this.user.roles.includes('USER')) return 'USER';
    return 'GUEST';
  }

  /**
   * @summary Whether the user has a permission.
   * @param {string} permission The permission.
   * @returns {boolean} `true` when granted.
   */
  hasPermission(permission: string): boolean {
    if (!this.isAuthenticated() || !this.user) return false;
    return this.user.permissions.includes(permission);
  }

  /**
   * @summary Requests a temporary elevation.
   * @param {string[]} permissions The permissions to grant.
   * @param {number} durationMs The duration in milliseconds.
   * @returns {Promise<string>} The elevation token.
   * @throws {Error} When not authenticated.
   */
  async requestElevation(permissions: string[], durationMs: number): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new Error('[AuthManager] not authenticated');
    }
    const id = this.makeId();
    this.elevations.set(id, { expiresAt: this.now() + durationMs, permissions });
    return id;
  }

  /**
   * @summary Whether an active elevation grants a permission.
   * @param {string} permission The permission.
   * @returns {boolean} `true` when an unexpired elevation grants it.
   */
  hasElevation(permission: string): boolean {
    for (const [id, grant] of this.elevations) {
      if (grant.expiresAt <= this.now()) {
        this.elevations.delete(id);
        continue;
      }
      if (grant.permissions.includes(permission)) return true;
    }
    return false;
  }
}

/**
 * @summary Builds a monotonically increasing id factory.
 * @returns {() => string} A function that returns a new id on each call.
 * @internal
 */
function makeCounter(): () => string {
  let counter = 0;
  return () => `elev-${++counter}`;
}
