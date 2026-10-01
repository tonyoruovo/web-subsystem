import { describe, expect, it } from 'vitest';

import {
  AuthManager,
  createAuthenticatedRequest,
  NetworkManager,
  type AuthTokens,
  type AuthUser,
  type FetchResult,
} from '../src';

function user(): AuthUser {
  return { id: 'u1', username: 'alice', email: 'a@example.com', roles: ['USER'], permissions: [] };
}

function tokens(access: string, expiry = 10_000): AuthTokens {
  return {
    accessToken: access,
    refreshToken: 'rt',
    accessTokenExpiry: expiry,
    refreshTokenExpiry: expiry,
  };
}

function makeAuth(): AuthManager {
  let refreshCount = 0;
  return new AuthManager({
    now: () => 0,
    loginFn: async () => ({ user: user(), tokens: tokens('access-1') }),
    refreshFn: async () => {
      refreshCount += 1;
      return tokens(`access-${refreshCount + 1}`);
    },
  });
}

function status(code: number, data: unknown): FetchResult {
  return { status: code, statusText: String(code), headers: {}, json: async () => data };
}

describe('createAuthenticatedRequest', () => {
  it('injects the bearer token', async () => {
    const auth = makeAuth();
    await auth.login({ username: 'a', password: 'b' });

    let seenAuth: string | undefined;
    const network = new NetworkManager({
      fetchFn: async (_url, init) => {
        seenAuth = (init?.headers as Record<string, string>)?.Authorization;
        return status(200, { ok: true });
      },
    });

    const request = createAuthenticatedRequest(auth, network);
    await request({ url: '/api' });

    expect(seenAuth).toBe('Bearer access-1');
  });

  it('refreshes and replays on a 401', async () => {
    const auth = makeAuth();
    await auth.login({ username: 'a', password: 'b' });

    let calls = 0;
    const seenTokens: string[] = [];
    const network = new NetworkManager({
      fetchFn: async (_url, init) => {
        calls += 1;
        seenTokens.push((init?.headers as Record<string, string>)?.Authorization ?? '');
        if (calls === 1) return status(401, { error: 'expired' });
        return status(200, { ok: true });
      },
    });

    const request = createAuthenticatedRequest(auth, network);
    const res = await request({ url: '/api' });

    expect(res.status).toBe(200);
    expect(calls).toBe(2); // original + replay
    expect(seenTokens[0]).toBe('Bearer access-1');
    expect(seenTokens[1]).toBe('Bearer access-2'); // refreshed token
  });

  it('does not replay a non-401 response', async () => {
    const auth = makeAuth();
    await auth.login({ username: 'a', password: 'b' });

    let calls = 0;
    const network = new NetworkManager({
      fetchFn: async () => {
        calls += 1;
        return status(200, { ok: true });
      },
    });

    const request = createAuthenticatedRequest(auth, network);
    await request({ url: '/api' });

    expect(calls).toBe(1);
  });
});
