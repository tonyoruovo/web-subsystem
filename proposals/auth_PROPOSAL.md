# Auth Manager

## Initial Proposal

### States

The state object for the Auth Manager subsystem contains:

- **importance/priority/weight**: `CRITICAL` - Authentication is fundamental to platform security and data access
- **authStatus**: Current authentication state:
  ```javascript
  {
    state: 'UNAUTHENTICATED' | 'AUTHENTICATING' | 'AUTHENTICATED' | 'EXPIRED' | 'ERROR',
    userId: string | null,
    username: string | null,
    email: string | null,
    roles: string[], // e.g., ['GUEST', 'USER', 'ADMIN', 'CORPORATE']
    permissions: Map<string, boolean>, // permissionId -> hasPermission
    authLevel: number, // 0=guest, 100=admin, configurable
    authTimestamp: number | null,
    sessionId: string | null
  }
  ```
- **tokenRegistry**: Map of active tokens:
  ```javascript
  {
    accessToken: {
      token: string,
      expiresAt: number,
      issuedAt: number,
      type: 'JWT' | 'JWK' | 'OPAQUE',
      scope: string[]
    },
    refreshToken: {
      token: string,
      expiresAt: number,
      issuedAt: number
    },
    idToken: {
      token: string,
      expiresAt: number
    } | null,
    csrfToken: string | null,
    temporaryElevations: Map<string, { // subsystemId -> elevation
      token: string,
      expiresAt: number,
      permissions: string[],
      reason: string
    }>
  }
  ```
- **credentialCache**: Securely cached credentials:
  ```javascript
  {
    username: string | null,
    email: string | null,
    hashedPassword: string | null, // Never plain text
    biometricKey: string | null,
    totpSecret: string | null,
    lastUsed: number
  }
  ```
- **protectedResources**: Registry of protected elements:
  ```javascript
  {
    routes: Array<{
      pattern: string | RegExp,
      requiredPermissions: string[],
      requiredRoles: string[],
      minimumAuthLevel: number,
      fallbackRoute: string | null
    }>,
    elements: Array<{
      selector: string,
      requiredPermissions: string[],
      requiredRoles: string[],
      visibility: 'HIDE' | 'DISABLE' | 'SHOW_UNAUTHORIZED'
    }>,
    subsystemEvents: Array<{
      subsystemId: string,
      eventId: string,
      requiredPermissions: string[],
      blockBehavior: 'REJECT' | 'SILENT' | 'ELEVATE'
    }>
  }
  ```
- **sessionData**: Current session information:
  ```javascript
  {
    startTime: number,
    lastActivity: number,
    timeout: number, // ms
    renewOnActivity: boolean,
    deviceFingerprint: string,
    ipAddress: string | null,
    userAgent: string
  }
  ```
- **authSettings**: Configuration object:
  ```javascript
  {
    // Token settings
    tokenRefreshThreshold: number, // ms before expiry to refresh
    autoRefresh: boolean,
    refreshRetryAttempts: number,
    refreshRetryDelay: number,

    // Session settings
    sessionTimeout: number,
    sessionRenewal: boolean,
    maxConcurrentSessions: number,

    // Security settings
    requireMFA: boolean,
    passwordPolicy: {
      minLength: number,
      requireUpper: boolean,
      requireLower: boolean,
      requireNumbers: boolean,
      requireSpecial: boolean
    },
    lockoutPolicy: {
      maxAttempts: number,
      lockoutDuration: number,
      resetAfter: number
    },

    // Storage settings
    storageStrategy: 'MEMORY' | 'LOCAL' | 'SESSION' | 'ENCRYPTED',
    encryptTokens: boolean,
    clearOnLogout: boolean,

    // API endpoints
    loginEndpoint: string,
    logoutEndpoint: string,
    refreshEndpoint: string,
    validateEndpoint: string,
    mfaVerifyEndpoint: string,

    // OAuth/OIDC settings (if applicable)
    oauthProviders: Array<{
      id: string,
      name: string,
      clientId: string,
      authorizationEndpoint: string,
      tokenEndpoint: string,
      scope: string[],
      enabled: boolean
    }>
  }
  ```
- **attemptTracker**: Security tracking:
  ```javascript
  {
    failedAttempts: number,
    lastAttempt: number | null,
    lockoutUntil: number | null,
    suspiciousActivities: Array<{
      timestamp: number,
      action: string,
      riskLevel: 'LOW' | 'MEDIUM' | 'HIGH',
      metadata: Record<string, any>
    }>
  }
  ```
- **elevationRequests**: Pending elevation requests:
  ```javascript
  {
    requestId: {
      subsystemId: string,
      requestedPermissions: string[],
      reason: string,
      requestedBy: string, // userId
      status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED',
      expiresAt: number,
      approvedBy: string | null,
      approvalTimestamp: number | null
    }
  }
  ```

### Message Packets

```typescript
export type AuthState = 'UNAUTHENTICATED' | 'AUTHENTICATING' | 'AUTHENTICATED' | 'EXPIRED' | 'ERROR'
export type Importance = 'HIGH' | 'MEDIUM' | 'LOW'
export type AuthProvider = 'JWT' | 'OAuth' | 'Basic'
export type Role = 'GUEST' | 'USER' | 'ADMIN' | 'CORPORATE' | string // Extendable
export type PermissionType = 'PAGE' | 'ELEMENT' | 'SUBSYSTEM' | 'EVENT'

export interface BasePacket<P, R = any> {
  eventId: symbol
  actionName: string
  payload: P
  importance: Importance
  onComplete: (result: R) => void
  onError: (error: Error) => void
  onLog: ((fingerprints: string[]) => void) | null
  fingerprints: string[]
  authToken?: string // Optional elevation token for protected operations
}

/**
 * 1. Login Request
 */
export interface LoginPayload {
  credentials: {
    username?: string
    email?: string
    password: string
    rememberMe?: boolean
  }
  mfaToken?: string
  provider?: string // For OAuth
  redirectUri?: string
}

export interface LoginResult {
  user: {
    id: string
    username: string
    email: string
    roles: string[]
    permissions: string[]
  }
  tokens: {
    accessToken: string
    refreshToken: string
    accessTokenExpiry: number
    refreshTokenExpiry: number
    tokenType: string
  }
  session: {
    id: string
    timeout: number
  }
}

export type LoginPacket = BasePacket<LoginPayload, LoginResult>

/**
 * 2. Logout Request
 */
export interface LogoutPayload {
  everywhere?: boolean
  reason?: string
}

export type LogoutPacket = BasePacket<LogoutPayload, void>

/**
 * 3. Token Refresh
 */
export interface TokenRefreshPayload {
  refreshToken: string
  force?: boolean
}

export interface TokenRefreshResult {
  accessToken: string
  refreshToken: string
  accessTokenExpiry: number
  refreshTokenExpiry: number
}

export type TokenRefreshPacket = BasePacket<TokenRefreshPayload, TokenRefreshResult>

/**
 * 4. Permission Check
 */
export interface PermissionCheckPayload {
  resourceType: PermissionType
  resourceIdentifier: string
  requiredPermissions: string[]
  requiredRoles: Role[]
}

export type PermissionCheckPacket = BasePacket<PermissionCheckPayload, { registered: boolean }>

/**
 * 5. Elevation Request
 */
export interface ElevationRequestPayload {
  subsystemId: string
  requestedPermissions: string[] // scopes?
  duration: number // ms
  reason: string
  context: Record<string, any>
}

export interface ElevationRequestResult {
  elevationToken: string
  expiresAt: number
  grantedPermissions: string[]
}

export type ElevationRequestPacket = BasePacket<ElevationRequestPayload, ElevationRequestResult>

/**
 * 6. Auth Status Request
 */
export interface AuthStatusPayload {
  includeTokens?: boolean
  includePermissions?: boolean
}

export interface AuthStatusResult {
  status: AuthState
  user: {
    id: string | null
    username: string | null
    email: string | null
    roles: string[]
  }
  session: {
    startTime: number | null
    remainingTime: number | null
  }
  hasElevation: boolean
}

export type AuthStatusPacket = BasePacket<AuthStatusPayload, AuthStatusResult>

/**
 * 7. Protected Resource Registration
 */
export interface ProtectedResourceRegistrationPayload {
  resourceType: PermissionType
  resourceIdentifier: string
  requiredPermissions: string[]
  requiredRoles?: string[]
  minimumAuthLevel?: number
  fallbackAction?: string
}

export type ProtectedResourceRegistrationPacket = BasePacket<
  ProtectedResourceRegistrationPayload,
  { registered: boolean }
>

/**
 * 8. MFA Verification
 */
export interface MFAVerificationPayload {
  method: 'TOTP' | 'SMS' | 'EMAIL' | 'BIOMETRIC'
  token: string
  rememberDevice?: boolean
}

export type MFAVerificationPacket = BasePacket<MFAVerificationPayload, { verified: boolean }>

/**
 * 9. Session Management
 */
export interface SessionManagementPayload {
  action: 'RENEW' | 'TERMINATE' | 'LIST' | 'INVALIDATE_OTHER'
  sessionId?: string
}

export interface SessionManagementResult {
  success: boolean
  sessions?: Array<{
    id: string
    device: string
    lastActivity: number
    expiresAt: number
  }>
}

export type SessionManagementPacket = BasePacket<SessionManagementPayload, SessionManagementResult>

/**
 * 10. Password Change
 */
export interface PasswordChangePayload {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

export type PasswordChangePacket = BasePacket<PasswordChangePayload, { changed: boolean }>

export type AuthPacket =
  | LoginPacket
  | LogoutPacket
  | TokenRefreshPacket
  | PermissionCheckPacket
  | ElevationRequestPacket
  | AuthStatusPacket
  | ProtectedResourceRegistrationPacket
  | MFAVerificationPacket
  | SessionManagementPacket
  | PasswordChangePacket
```

### Dependencies

Ordered by initialization priority:

1. **Global State** (CRITICAL) - For platform status, timestamps, and session persistence
2. **Storage Manager** (CRITICAL) - For secure token storage and credential caching
3. **Network Request Manager** (CRITICAL) - For authentication API calls
4. **Sync Manager** (HIGH) - For token refresh synchronization
5. **Notification Center** (HIGH) - For event coordination
6. **Message Queue** (HIGH) - For sending auth event packets
7. **Logger** (MEDIUM) - For security auditing and authentication logs
8. **Analytics Manager** (LOW) - For sending auth metrics (e.g., login rates).

### Control Interface

#### Getters (No-arg)

- `getAuthStatus()` - Returns current authentication state
- `getUser()` - Returns current user information
- `getTokens()` - Returns active tokens (excluding sensitive values)
- `getPermissions()` - Returns current user's permissions
- `getSessionInfo()` - Returns session metadata
- `getProtectedResources()` - Returns registered protected resources
- `getElevations()` - Returns active elevation tokens
- `isAuthenticated()` - Boolean indicating if user is authenticated
- `hasPermission(permission)` - Checks if user has specific permission
- `getAuthLevel()` - Returns current auth level (0-100)
- `getFailedAttempts()` - Returns number of recent failed attempts
- `isLockedOut()` - Boolean indicating if account is locked

#### Setters

- `setAutoRefresh(enabled)` - Enables/disables automatic token refresh
- `setSessionTimeout(timeout)` - Updates session timeout duration
- `setPasswordPolicy(policy)` - Updates password requirements
- `setLockoutPolicy(policy)` - Updates account lockout settings
- `setRequireMFA(required)` - Enables/disables MFA requirement

#### Actions (Fire events to message queue)

- `login(credentials, options?)` - Initiates authentication
- `logout(everywhere?)` - Terminates session
- `refreshToken(force?)` - Manually refreshes tokens
- `checkPermission(resourceType, resourceId, permission)` - Checks access
- `requestElevation(subsystemId, permissions, duration, reason)` - Requests temporary elevation
- `registerProtectedResource(resourceType, resourceId, requirements)` - Registers protection
- `verifyMFA(method, token)` - Verifies multi-factor authentication
- `changePassword(current, new)` - Changes user password
- `validateSession()` - Validates and renews session if needed
- `clearCredentials()` - Securely clears cached credentials
- `listSessions()` - Lists all active sessions
- `terminateSession(sessionId)` - Terminates specific session
- `resetFailedAttempts()` - Resets security counters
- `updateUserProfile(data)` - Updates user information

#### Subscriptions (Subscribe to notification center events)

- Subscribes to Global State online/offline changes for session management
- Subscribes to Sync Manager token refresh events
- Subscribes to browser visibility changes for session renewal
- Subscribes to Storage Manager CRUD events for token persistence

### Life Cycle Manager

#### Initialization Sequence

1. Initialize status to IDLE and load configurations from Storage Manager.
2. Load persisted auth state from Storage Manager:
   - Tokens (encrypted)
   - User profile
   - Session data
   - Protected resource registry
3. Register all event IDs with action names in notification center
4. Initialize feature components in order:
   - Token Manager (first - security critical)
   - Credential Manager (early - sensitive data)
   - Permission Manager
   - Session Manager
   - Protected Resource Manager
   - Elevation Manager
   - Security Monitor
   - Network Interceptor
5. Validate stored tokens:
   - Check expiration
   - Validate integrity
   - Refresh if needed and auto-refresh enabled
6. Initialize session:
   - Calculate session timeout
   - Start session renewal timer if needed
   - Validate device fingerprint
7. Subscribe to critical events:
   - Global State online/offline changes
   - Sync Manager token sync events
   - Network Request Manager for auth header injection
   - Browser visibility changes
8. Initialize security monitoring:
   - Start failed attempt decay timer
   - Initialize suspicious activity detection
9. Log initialization complete event (without sensitive data)

#### Destruction Sequence

1. Revoke all active elevations.
2. Unsubscribe from all notification center events
3. Stop all timers (token refresh, session renewal, security)
4. Securely clear sensitive data from memory:
   - Plain text tokens
   - Credentials
   - Encryption keys
5. Persist non-sensitive state:
   - User profile (non-sensitive fields)
   - Permission mappings
   - Protected resource registry
6. Terminate active sessions if clearOnLogout enabled
7. Stop refresh interval.
8. Flush audit log to Logger.
9. Generate security audit log of shutdown
10. Log shutdown complete event

### Features

#### Token Manager

- Manages JWT/JWK/opaque token lifecycle
- Handles token storage, retrieval, and encryption
- Validates token signatures and expiration
- Implements token refresh with exponential backoff
- Manages CSRF token generation and validation
- **Weight**: CRITICAL - Security foundation

#### Credential Manager

- Securely stores and manages user credentials
- Implements password hashing (bcrypt/scrypt/Argon2)
- Handles biometric key storage (WebAuthn)
- Manages MFA secrets (TOTP)
- Implements credential caching with expiration
- **Weight**: CRITICAL - Sensitive data handling

#### Permission Manager

- Maps roles to permissions
- Validates permission checks against current user
- Manages permission inheritance and hierarchies
- Implements permission caching for performance
- Provides permission introspection APIs
- **Weight**: HIGH - Access control core

#### Session Manager

- Manages user session lifecycle
- Implements session timeout and renewal
- Tracks session activity and device fingerprinting
- Handles concurrent session limits
- Manages session invalidation and cleanup
- **Weight**: HIGH - User experience critical

#### Protected Resource Manager

- Registers and validates protected resources
- Implements route guard logic
- Manages element visibility/disable logic
- Handles subsystem event blocking/elevation
- Provides resource protection APIs
- **Weight**: MEDIUM - Security enforcement

#### Elevation Manager

- Issues and validates temporary elevation tokens
- Manages elevation request/approval workflow
- Tracks elevation usage and expiration
- Implements elevation revocation
- Provides elevation audit trail
- **Weight**: MEDIUM - Subsystem security

#### Security Monitor

- Tracks failed authentication attempts
- Implements account lockout logic
- Detects suspicious activities
- Generates security alerts
- Manages security event logging
- **Weight**: HIGH - Threat prevention

#### Network Interceptor

- Injects auth tokens into outgoing requests
- Handles 401/403 responses with token refresh
- Implements request retry with refreshed tokens
- Manages CORS and credential modes
- Provides request authentication APIs
- **Weight**: HIGH - Network security

###### Cookie Manager

- Handles secure cookie storage for sessions/tokens.
- Manages domain, path, and secure flags.
- Integrates with Storage Manager for fallback.
- **Weight**: LOW - Session persistence.

#### OAuth/OIDC Manager

- Manages third-party authentication flows
- Handles OAuth authorization code flow
- Implements PKCE for public clients
- Manages provider configurations
- Handles token exchange and validation
- **Weight**: MEDIUM - External auth

#### Audit Logger

- Logs all authentication events
- Tracks permission checks and elevations
- Generates security audit trails
- Implements secure log sanitization
- Provides audit query APIs
- **Weight**: MEDIUM - Compliance

### Worker

The Auth Manager uses a **Hybrid Worker** approach with Virtual Worker for synchronous operations and Physical Worker for cryptographic operations.

#### Receiver

- Receives authentication requests (login, logout, token refresh)
- Accepts permission check queries
- Receives elevation requests
- Accepts protected resource registrations
- Receives security configuration updates
- Accepts session management commands

#### Processor

##### Cryptographic Processor (Physical Worker)

- Password hashing/verification (CPU-intensive)
- JWT token validation and parsing
- Encryption/decryption of sensitive data
- Key generation and management
- Digital signature verification
- **Runs in Web Worker for security**

##### Token Processor

- Validates token signatures and claims
- Manages token expiration and renewal
- Handles token storage and retrieval
- Implements token revocation lists
- Manages token refresh queues

##### Permission Processor

- Evaluates permission checks against rules
- Resolves role-permission mappings
- Caches permission evaluations
- Handles permission inheritance
- Validates elevation tokens

##### Session Processor

- Validates session continuity
- Calculates session timeouts
- Manages session renewal
- Handles device fingerprint validation
- Coordinates session cleanup

##### Security Processor

- Analyzes authentication attempts
- Implements lockout logic
- Detects anomaly patterns
- Generates security scores
- Triggers security alerts

#### Dispatcher

- Emits authentication status changes to notification center
- Sends token updates to Sync Manager
- Posts security events to Logger
- Returns permission check results
- Sends elevation tokens to requesting subsystems
- Broadcasts session state changes

#### Additional Worker Requirements

##### Security Requirements

- **Isolated Cryptography**: All cryptographic operations in Web Worker
- **Secure Memory**: Zeroization of sensitive data after use
- **Timing Attack Protection**: Constant-time comparisons
- **Side-Channel Resistance**: Mitigations for Spectre/Meltdown-type attacks

##### Performance Requirements

- **Low Latency**: Permission checks < 5ms
- **Background Processing**: Token refresh in background
- **Lazy Loading**: Permission mappings loaded on demand
- **Caching**: Frequent permission checks cached

##### Error Handling

- **Graceful Degradation**: Fallback to less secure modes if crypto unavailable
- **Fail-Secure**: Deny access on uncertainty
- **Detailed Logging**: Security events with context
- **Recovery**: Automatic token refresh on failure

##### Cleanup Protocols

- **Token Revocation**: Immediate invalidation on logout
- **Memory Sanitization**: Secure deletion of credentials
- **Session Cleanup**: Orphaned session detection
- **Cache Invalidation**: Stale permission cache cleanup

##### Visibility API Integration

- **Background Refresh**: Pause token refresh when hidden
- **Deferred Operations**: Delay non-critical auth tasks
- **Resource Conservation**: Reduce crypto operations when hidden
