/**
 * @fileoverview
 * @module @platform/hub
 * @summary The public API of `@platform/hub`: Window scope across a site's subdomains.
 * @description
 * Re-exports the hub page renderer, the Window client, its links, the window
 * cookie that detects partitioning, and the Window transport subsystem
 * (docs/ARCHITECTURE.md §11.3).
 *
 * ```text
 *   @platform/hub
 *   +-- renderHubPage           the static hub page for the apex, and its CSP
 *   +-- createWindowClient      one tab's connection: iframe | direct | single-origin
 *   |   +-- WindowRelay         the relay where the browser partitions the hub (Global transport, M8)
 *   +-- createWindowTransport   the subsystem: id 'window', wires the client to the kernel
 *   +-- iframeLink, channelLink how a client reaches the channel
 *   +-- window cookie           window id and partition detection
 *   +-- originAllowed, readPartitionId, isWindowBroadcast, protocol types
 *   ```
 *
 * @example
 * A subdomain app
 * ```ts
 * import { createWindowTransport } from '@platform/hub';
 *
 * const kernel = new Kernel(
 *   [...centralized, createWindowTransport({ hubUrl: 'https://example.com/__platform/hub.html' }), ...subsystems],
 *   { router: queue.router },
 * );
 * ```
 *
 * @example
 * Rendering the hub page at build time
 * ```ts
 * import { renderHubPage } from '@platform/hub';
 *
 * const { html, csp } = await renderHubPage({ allowedOrigins: ['https://example.com', 'https://*.example.com'] });
 * ```
 *
 * @author MathAid
 */

export * from './client';
export * from './cookie';
export * from './link';
export * from './page';
export * from './shared';
export * from './transport';
