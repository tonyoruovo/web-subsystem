import { describe, expect, it } from 'vitest';

import { AuthManager, type AuthTokens, type AuthUser } from '../src';

function user(roles: string[] = ['USER'], permissions: string[] = []): AuthUser {
  return { id: 'u1', username: 'alice', email: 'alice@example.com', roles, permissions };
}

function tokens(expiry: number): AuthTokens {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    accessTokenExpiry: expiry,
    refreshTokenExpiry: expiry,
  };
}

function makeAuth(now = 0): AuthManager {
  return new AuthManager({
    now: () => now,
    loginFn: async () => ({ user: user(), tokens: tokens(now + 1000) }),
    refreshFn: async () => tokens(now + 2000),
  });
}

describe('AuthManager', () => {
  it('logs in and becomes authenticated', async () => {
    const auth = makeAuth();
    expect(auth.isAuthenticated()).toBe(false);

    await auth.login({ username: 'alice', password: 'pw' });

    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getUserId()).toBe('u1');
  });

  it('logs out and clears state', async () => {
    const auth = makeAuth();
    await auth.login({ username: 'alice', password: 'pw' });

    auth.logout();

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getUserId()).toBeNull();
    expect(auth.getAuthLevel()).toBe('GUEST');
  });

  it('expires when the access token passes its expiry', async () => {
    const auth = makeAuth(0);
    await auth.login({ username: 'alice', password: 'pw' });
    expect(auth.isAuthenticated()).toBe(true);

    const later = new AuthManager({
      now: () => 2000, // past the 1000ms expiry
      loginFn: async () => ({ user: user(), tokens: tokens(1000) }),
      refreshFn: async () => tokens(3000),
    });
    await later.login({ username: 'alice', password: 'pw' });
    expect(later.isAuthenticated()).toBe(false);
    expect(later.getStatus()).toBe('EXPIRED');
  });

  it('refreshes the access token', async () => {
    const auth = makeAuth(0);
    await auth.login({ username: 'alice', password: 'pw' });

    await auth.refreshToken();

    expect(auth.isAuthenticated()).toBe(true);
  });

  it('derives the auth level from roles', async () => {
    const auth = new AuthManager({
      now: () => 0,
      loginFn: async () => ({ user: user(['ADMIN']), tokens: tokens(1000) }),
      refreshFn: async () => tokens(1000),
    });
    await auth.login({ username: 'a', password: 'b' });

    expect(auth.getAuthLevel()).toBe('ADMIN');
  });

  it('checks permissions', async () => {
    const auth = new AuthManager({
      now: () => 0,
      loginFn: async () => ({ user: user(['USER'], ['read', 'write']), tokens: tokens(1000) }),
      refreshFn: async () => tokens(1000),
    });
    await auth.login({ username: 'a', password: 'b' });

    expect(auth.hasPermission('read')).toBe(true);
    expect(auth.hasPermission('delete')).toBe(false);
  });

  it('grants a temporary elevation with expiry', async () => {
    let now = 0;
    const auth = new AuthManager({
      now: () => now,
      loginFn: async () => ({ user: user(), tokens: tokens(1000) }),
      refreshFn: async () => tokens(1000),
    });
    await auth.login({ username: 'a', password: 'b' });

    await auth.requestElevation(['delete'], 100);
    expect(auth.hasElevation('delete')).toBe(true);

    now = 200; // advance past the 100ms elevation
    expect(auth.hasElevation('delete')).toBe(false);
  });
});
