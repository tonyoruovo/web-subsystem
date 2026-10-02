# @platform

> **Status: pre-alpha (`0.0.2`).** The architecture is agreed. The kernel and its worker runtime (`@platform/core`, M1 and M2), the three centralized subsystems (`@platform/global-state`, `@platform/queue`, `@platform/notification`, M3), the pilot subsystems (`@platform/logger`, `@platform/consent`, M4), and Window scope across subdomains (`@platform/hub`, M5) are built. The other subsystems are not yet ported onto the kernel. Nothing here is ready for production use, and every API shown below may change.
>
> `@platform` is a **placeholder name** until milestone M9, when the final name is chosen.

A framework-agnostic **platform runtime** for browser applications. Your app boots it once and hands it the work that must not fail: storage, network calls, authentication, sync, real-time messaging, and the messages between them.

## Why

Web apps lose their connection, run out of storage, and hit unexpected errors. The platform is designed so that none of these stops critical work:

- **Resilience:** work is queued, persisted, retried, and replayed. A failing part turns itself off without bringing down the rest.
- **Efficiency:** data is deduplicated, cached, compressed, and synced as deltas.
- **Visible, non-blocking remote work:** HTTP, WebSocket, webhook, and RPC operations run off the main thread when possible, and the user can always see what is still pending.

## Core ideas

| Concept                               | In one sentence                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subsystem** (also _manager_)        | An independent part of the platform, such as Storage or Auth, with its own state, lifecycle, and public interface.                                                |
| **Feature**                           | A part of a subsystem that can fail on its own without failing its parent.                                                                                        |
| **Packet**                            | A message between subsystems. It is traced with fingerprints, and its payload is read once per delivery.                                                          |
| **Queue** and **Notification Center** | Every packet enters through the Queue (priority, retry, dead letters). The Notification Center fans broadcasts out to subscribers.                                |
| **Scope**                             | How far a subsystem's broadcasts reach: **Page**, **Tab**, **Window** (all tabs across your site's subdomains), or **Global** (all devices, through your server). |
| **Workers**                           | Each processor runs on a shared worker, a dedicated worker, or the main thread, and falls back automatically when one is not available.                           |

The full design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Packages (planned)

Each subsystem is its own package. Packages depend on each other through peer dependencies, and optional dependencies turn individual features on or off.

| Package                   | Purpose                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `@platform/core`          | Units, lifecycle, dependency resolution, packets, scopes, worker hosts, the Global wire protocol |
| `@platform/global-state`  | Environment detection, platform status, tab identity, pending work                               |
| `@platform/queue`         | Single entry point for packets: admission, priority, retry, dead letters                         |
| `@platform/notification`  | Broadcast routing, subscriptions, access control                                                 |
| `@platform/logger`        | Logs and traces, buffered from the first moment of boot                                          |
| `@platform/crypto`        | Keys, encryption, signing                                                                        |
| `@platform/storage`       | One schema-validated interface over IndexedDB, OPFS, Cache, Web Storage, and memory              |
| `@platform/consent`       | Consent grants                                                                                   |
| `@platform/settings`      | User settings, with optimistic updates                                                           |
| `@platform/network`       | Requests with retry, deduplication, caching, and interceptors                                    |
| `@platform/auth`          | Tokens, refresh, permissions, elevation                                                          |
| `@platform/sync`          | Server sync with intervals, offline replay, and conflict resolution                              |
| `@platform/realtime`      | WebSocket and SSE connections, and the Global scope transport                                    |
| `@platform/translation`   | Translation catalogs                                                                             |
| `@platform/analytics`     | Consent-gated, sampled analytics                                                                 |
| `@platform/design-system` | To be designed                                                                                   |
| `@platform/hub`           | The page that connects tabs across subdomains (Window scope)                                     |
| `@platform/platform`      | Boots a chosen set of subsystems                                                                 |
| `@platform/vue`           | Vue adapter                                                                                      |
| `@platform/create`        | Project scaffolder: `npm init @platform`                                                         |

## Intended usage

> Illustrative only. These APIs are designed in milestones M1–M10 and may change.

```ts
import { createPlatform } from '@platform/platform';
import { storage } from '@platform/storage';
import { network } from '@platform/network';
import { auth } from '@platform/auth';

const platform = await createPlatform({
  subsystems: [storage(), network(), auth({ refreshFn })],
});

// Every view is a store: read a snapshot, subscribe to changes.
const status = platform.globalState.views.status;
status.subscribe(() => console.log(status.getSnapshot()));
```

With Vue:

```ts
import { createApp } from 'vue';
import { platformPlugin, usePlatform, useView } from '@platform/vue';

createApp(App)
  .use(platformPlugin, { subsystems: [storage(), network()] })
  .mount('#app');

// In a component's setup:
const platform = usePlatform();
const status = useView(platform.globalState.views.status); // Readonly<ShallowRef<...>>
```

The core works without any framework. Views follow the `getSnapshot` and `subscribe` contract, so they also work with React's `useSyncExternalStore` without an adapter.

## Supported platforms

| Platform                              | Minimum version         |
| ------------------------------------- | ----------------------- |
| Desktop Chrome, Edge, Firefox, Safari | Last two major versions |
| Chrome for Android                    | Last two major versions |
| iOS and iPadOS (every browser)        | 16.4                    |

In-app WebViews are not supported. Packages can be imported in server-side rendering but do not run there.

## Deployment notes

- **Window scope** (across subdomains) needs the hub page from `@platform/hub`, served from your **apex** domain. That path must allow your subdomains to frame it: send `Content-Security-Policy: frame-ancestors https://example.com https://*.example.com`, and don't send `X-Frame-Options`.
- **Global scope** needs a server that implements the platform's wire protocol. This project ships the protocol schema and conformance fixtures, not a server.

## Repository layout

```text
docs/        architecture and plan (start here)
proposals/   the original design proposals; proposals/README.md is the authoritative model
src/         existing code, to be moved into packages/ milestone by milestone
tests/       existing tests
packages/    (from M0) one folder per package
```

Precedence when documents disagree: [`proposals/README.md`](proposals/README.md) > [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) > the per-subsystem proposals.

## Development

Requires [pnpm](https://pnpm.io) 11.

```bash
pnpm install
```

Run every check (type-check, lint, formatting, Node and browser tests):

```bash
pnpm check
```

Browser tests run on every installation listed in [`playwright.config.ts`](playwright.config.ts) that exists on your machine. To see which ones launch, and their executable paths:

```bash
pnpm check:browsers
```

Run a subset with `BROWSERS=chrome,edge pnpm test:browser`.

> **CI is deferred.** A GitHub Actions workflow exists in `.github/workflows/ci.yml` but is not enabled yet. Until then, run `pnpm check` locally.

## Roadmap

| Milestone | Delivers                                                           |
| --------- | ------------------------------------------------------------------ |
| M0        | Tooling, monorepo, browser test matrix (CI deferred)               |
| M1        | Kernel (`core`)                                                    |
| M2        | Worker hosts and transports                                        |
| M3        | Global State, Queue, Notification Center                           |
| M4        | Pilot: Logger and Consent                                          |
| M5        | Window scope hub                                                   |
| M6        | Crypto and Storage                                                 |
| M7        | Network, Auth, Sync, Realtime                                      |
| M8        | Global scope                                                       |
| M9        | Translation, Settings, Analytics, Design System; final name chosen |
| M10       | Orchestrator, Vue adapter, scaffolder                              |
| Alpha     | Validation in real React, Vue, Svelte and Astro apps               |

Milestones do not change the version: it stays `0.0.2` until every milestone is complete and alpha tests pass in real React, Vue, Svelte and Astro projects. Details and exit criteria are in [`docs/PLAN.md`](docs/PLAN.md).

## License

ISC
