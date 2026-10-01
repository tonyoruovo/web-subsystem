/**
 * @fileoverview
 * @summary Wires the Auth manager into the Network manager's request flow.
 * @description
 * Bridges M2's two managers. It registers a request interceptor that injects
 * the bearer token, and returns a request function that, on a 401, refreshes
 * the token and replays the request once. This is the "401 triggers
 * refresh-then-replay" criterion.
 *
 * ```text
 *   request(config)
 *     |-- request interceptor: add Authorization header
 *     |-- network.request
 *     |-- status 401? -> auth.refreshToken() -> replay once
 *     v
 *   NetworkResponse
 *   ```
 *
 * @see {@linkcode AuthManager}
 * @see {@linkcode NetworkManager}
 * @author MathAid
 */

import { AuthManager } from './auth.manager';
import {
  NetworkManager,
  type NetworkRequestConfig,
  type NetworkResponse,
} from '../network/network.manager';

/**
 * @summary A request function that injects the token and handles 401 refresh.
 * @description
 * Replays at most once on a 401. A second 401 after refresh is returned as-is,
 * so the caller can surface the failure.
 */
export type AuthenticatedRequest = <T = unknown>(
  config: NetworkRequestConfig,
) => Promise<NetworkResponse<T>>;

/**
 * @summary Wires auth token injection and 401 refresh into a network manager.
 * @description
 * Registers a request interceptor for the bearer token and returns a request
 * function that refreshes and replays on a 401.
 *
 * @example
 * Example 1: Use the authenticated request
 * ```ts
 * const request = createAuthenticatedRequest(auth, network);
 * const res = await request({ url: '/api/profile' });
 * ```
 *
 * @param {AuthManager} auth The auth manager.
 * @param {NetworkManager} network The network manager.
 * @returns {AuthenticatedRequest} The request function.
 */
export function createAuthenticatedRequest(
  auth: AuthManager,
  network: NetworkManager,
): AuthenticatedRequest {
  network.addRequestInterceptor((config) => {
    const token = auth.getAccessToken();
    if (!token) return config;
    return { ...config, headers: { ...config.headers, Authorization: `Bearer ${token}` } };
  });

  return async function request<T = unknown>(
    config: NetworkRequestConfig,
  ): Promise<NetworkResponse<T>> {
    const response = await network.request<T>(config);

    if (response.status === 401 && auth.isAuthenticated()) {
      await auth.refreshToken();
      return network.request<T>(config);
    }

    return response;
  };
}
