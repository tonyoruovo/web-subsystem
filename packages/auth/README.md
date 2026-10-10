# @webkrnl/auth

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/auth) and [JSR](https://jsr.io/@webkrnl/auth).

The **Auth** subsystem (id `auth`, featurized, **Window** scope). It keeps the session of the user:

- **Handlers, not endpoints**: the app gives `login`, `refresh`, and optionally `logout` and `elevate`. Auth does not know the shape of the credentials, so passwords, MFA, OAuth and passkeys all work.
- **Tokens stay secret**: the access and refresh tokens are never in the unit state. When Storage runs, the session is kept in the **encrypted** collection `auth.session`, so a reload stays signed in.
- **Refresh**: before the access token expires, and once on a `401`. One refresh runs at a time, also across tabs (a Web Lock), which rotating refresh tokens need.
- **Every tab of the site**: `auth:changed` carries the status and the user id (never a token). A sign-out in one tab signs out every tab.
- **Other subdomains**: the optional `restore` handler gets a session for this origin from the server, with an `HttpOnly` cookie on the apex domain. Tokens never travel between tabs.
- **Network**: the token goes only to `protectedOrigins` (default: the page origin), never to a third party.
- **Permissions**: roles, permissions, levels, and elevations that expire.
- **Lockout**: after repeated failed logins, `login` fails at once for a while.

Network is optional; Storage and Crypto are late-bound. Design: [ARCHITECTURE §19.2](../../docs/ARCHITECTURE.md#192-auth) and the amended [Auth proposal](../../docs/proposals/auth_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/auth": "workspace:*"
  }
}
```

## Entry points

| Import          | Contents                                                           |
| --------------- | ------------------------------------------------------------------ |
| `@webkrnl/auth` | `createAuth`, `meetsRequirement`, `AuthLockedError`, and the types |

## Usage

```ts
import { createAuth, type AuthControl, type AuthHandlers, type AuthSession } from '@webkrnl/auth';

const handlers: AuthHandlers<{ email: string; password: string }> = {
  login: async (credentials, { network }) =>
    (await network!.commands.post<AuthSession>('/auth/login', credentials)).data,
  refresh: async (session, { network }) =>
    (await network!.commands.post<AuthSession>('/auth/refresh', { token: session.refreshToken }))
      .data,
  // A session for this origin, from the session cookie on the apex domain (other subdomains, a new tab).
  restore: async ({ network }) => {
    const response = await network!.commands.request<AuthSession>({
      url: '/auth/restore',
      method: 'POST',
      allowErrorStatus: true,
    });
    return response.status === 200 ? response.data : null;
  },
};

const kernel = new Kernel(
  [
    ...centralized,
    createCrypto(),
    createStorage(),
    createNetwork(),
    createAuth({ handlers, protectedOrigins: ['https://api.shop.example'] }),
  ],
  { router: queue.router },
);
await kernel.start();

const { commands, views } =
  kernel.unit<AuthControl<{ email: string; password: string }>>('auth').control!;
await commands.login({ email, password });
commands.hasPermission('orders:refund');
commands.check({ roles: ['ADMIN'], level: 50 });
views.state.subscribe(() => render(views.state.getSnapshot().status));
```

Requests that handlers make through `tools.network` skip the 401 refresh, so a refresh handler cannot loop.

## Recommended flow

This is the flow that the platform is designed for. Your server does its part of it.

**Tokens**

1. Give a short-lived **access token** (5 to 15 minutes) and a **refresh token** that the server rotates on each use. When an old refresh token comes back, revoke the whole family: someone copied it.
2. Keep the defaults: `persist: 'encrypted'` stores the session in an encrypted Storage collection, and give `createStorage` the same key source as `createCrypto` (Storage checks it, `keyCheck`). Do not put tokens in `localStorage`, in unit state, in logs, or in URLs.
3. Send the access token only as `Authorization: Bearer`, only to `protectedOrigins`. List your API origins there. Auth never sends the token anywhere else.

**Cookies**

4. At login, the server also sets a **session cookie on the apex domain**: `HttpOnly; Secure; SameSite=Lax; Domain=example.com; Path=/auth`. No script can read it, and every subdomain sends it to `/auth/*` only.
5. Use the cookie **only** for `/auth/restore` and `/auth/refresh`, never for your API. The API takes the Bearer token, so it needs no CSRF protection. On the cookie endpoints, accept only `POST` and check that the `Origin` header is one of your subdomains.
6. The `logout` handler calls the server, which revokes the refresh token family and clears the cookie. Auth then signs out every tab of the site.

**Across tabs and subdomains**

7. Tabs of one origin share one session through Storage. A tab on another subdomain gets only the status (`auth:changed`), then calls `restore`, and the cookie gets it its own session. Tokens never travel through the hub or the Window channel.

**Caching and other subsystems**

8. On sign-out, **each subsystem wipes the data of the user that it keeps** (ARCHITECTURE §5.1): its state, its persisted state, its Storage collections, its memory and its workers. Auth only ends the session and announces it. Your own units do the same: watch Auth (`ctx.watch('auth')`) and wipe when the status becomes `UNAUTHENTICATED` or `user.id` changes. For an account deletion, `crypto.commands.forget()` also makes encrypted copies unreadable.
9. Do not use a cache strategy on responses that must not outlive the session, even encrypted.
10. Realtime: use `auth: 'message'` (the token in the first frame) rather than `'query'`, because URLs end up in server and proxy logs. Sync: push through Network, so the token and the 401 refresh apply.

## Behaviour

| Situation                                               | Result                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `login` succeeds                                        | `AUTHENTICATED`; the session is stored (encrypted); `auth:changed` to every tab                                                                 |
| `login` fails `lockout.maxAttempts` times in a row      | `AuthLockedError` until `lockedUntil`                                                                                                           |
| The access token is near its expiry                     | Refresh `refreshBeforeMs` before it                                                                                                             |
| The API answers `401`                                   | One refresh, then the request is sent again                                                                                                     |
| The refresh is refused (4xx) or keeps failing           | `EXPIRED`; `auth:changed` with `reason: 'expired'`                                                                                              |
| Two tabs refresh at the same time                       | One refresh; the other tab takes the stored session                                                                                             |
| Another tab signs in or refreshes (same origin)         | This tab loads the session from Storage                                                                                                         |
| Another tab signs out                                   | This tab signs out too, also when a restore or a Storage read was under way                                                                     |
| Another subdomain signs in (no session in Storage here) | `restore`: the server gives this origin its own session (the apex cookie)                                                                       |
| A tab starts without a stored session                   | `restore` (unless `restoreOnStart: false`); `null` keeps it signed out, with no lockout count                                                   |
| No Web Locks API (outside the supported browsers, §1.1) | Two tabs can refresh at the same time; with rotating refresh tokens, one of them can become `EXPIRED`                                           |
| Auth stops                                              | Tokens and elevations leave memory                                                                                                              |
| Sign-out (the user data that Auth keeps)                | The session, the tokens and the elevations are wiped, in memory and in `auth.session`. Other subsystems wipe their own data (ARCHITECTURE §5.1) |

## Options

| Option             | Default                                   | Purpose                                                |
| ------------------ | ----------------------------------------- | ------------------------------------------------------ |
| `handlers`         | (required)                                | `login`, `refresh`, `logout?`, `elevate?`, `restore?`. |
| `restoreOnStart`   | `true`                                    | Call `restore` at start when no session is stored.     |
| `protectedOrigins` | the page origin                           | The origins that get the token.                        |
| `refreshBeforeMs`  | `60_000`                                  | How early to refresh.                                  |
| `refreshRetries`   | `3`                                       | Retries of a failed refresh.                           |
| `lockout`          | `{ maxAttempts: 5, durationMs: 300_000 }` | The login lockout, or `false`.                         |
| `persist`          | `'encrypted'`                             | How the session is kept in Storage, or `false`.        |
| `fetch`            | the global `fetch`                        | Given to handlers when Network does not run.           |

## Testing

```bash
pnpm exec vitest run --project node packages/auth
```
