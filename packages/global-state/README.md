# @webkrnl/global-state

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/global-state) and [JSR](https://jsr.io/@webkrnl/global-state).

The **Global State** subsystem: the platform's view of itself. It is a centralized subsystem (id `global-state`, Tab scope) that:

- **derives the platform status** from every unit's lifecycle and from pending work: `INITIALIZING`, `IDLE`, `BUSY`, `DEGRADED`, then `STOPPED` after shutdown;
- **decides admission**: `CRITICAL` work is always accepted, nothing else while `BUSY`, no `LOW` work while `DEGRADED`;
- **tracks pending work**, so the user can always see what is in progress (the Queue registers every packet in flight);
- **observes the environment**: online and page visibility;
- **identifies the tab**, with an id that survives reloads and is unique for duplicated tabs;
- **counts the tabs** of this origin that have the platform open and shown (`tabs`).

Design: [ARCHITECTURE §10.1](../../docs/ARCHITECTURE.md#101-how-the-three-centralized-subsystems-fit-together-m3), the tab count in [§21.5](../../docs/ARCHITECTURE.md#215-the-tab-count-global-state), and the amended [Global State proposal](../../docs/proposals/global_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/global-state": "workspace:*"
  }
}
```

| Peer dependency | Why                                |
| --------------- | ---------------------------------- |
| `@webkrnl/core` | The kernel this subsystem runs on. |

## Usage

Register it with the kernel, usually first:

```ts
import { Kernel } from '@webkrnl/core';
import { createGlobalState } from '@webkrnl/global-state';

const kernel = new Kernel([createGlobalState(), ...subsystems]);
await kernel.start();
```

Read the status, pending work and environment from its view:

```ts
import type { GlobalStateControl } from '@webkrnl/global-state';

const state = kernel.unit<GlobalStateControl>('global-state').control!.views.state;
state.subscribe(() => {
  const { status, pending, online } = state.getSnapshot();
  statusBar.textContent = `${status}, ${pending?.length ?? 0} pending${online ? '' : ', offline'}`;
});
```

Ask for admission, or track work the Queue does not see:

```ts
const { commands } = kernel.unit<GlobalStateControl>('global-state').control!;

if (
  commands.beginWork({ id: 'import', subsystemId: 'sync', importance: 'MEDIUM', label: 'Import' })
) {
  try {
    await importEverything();
  } finally {
    commands.endWork('import');
  }
}
```

From another subsystem, declare it as an optional dependency:

```ts
requires: [{ target: 'global-state', kind: 'optional' }],
init: (ctx) => {
  const globalState = ctx.dependency<GlobalStateControl>('global-state');
  if (globalState && !globalState.commands.canAccept('LOW')) deferBackgroundWork();
},
```

## How the status is derived

| Condition (first match wins)                                           | Status         |
| ---------------------------------------------------------------------- | -------------- |
| a unit is initializing, or not started yet                             | `INITIALIZING` |
| a unit is `FAILED` or `DEGRADED`, or waits for a missing dependency    | `DEGRADED`     |
| a unit is `BUSY`, or pending work exceeds `busyThreshold` (default 50) | `BUSY`         |
| otherwise                                                              | `IDLE`         |

Global State leaves itself out of the count. On shutdown its status becomes `STOPPED`, and nothing is admitted.

## Tab identity

The tab id is kept in `sessionStorage`, so a reload keeps it. A duplicated tab copies `sessionStorage`, so on start Global State asks the other tabs over a `BroadcastChannel` whether its stored id is taken, and mints a new id if a live tab answers. `resolveTabIdentity()` is exported for use on its own.

## Tab count

`tabs` is the number of tabs of this origin with the platform open and shown, this tab included. Each tab holds the Web Lock `platform:tab:<tabId>` while its page is shown, and the count is the number of these locks (`navigator.locks.query()`). The browser releases the lock of a tab that closes or crashes, so a dead tab is never counted for long.

| Situation                                            | Result                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A tab opens or closes                                | It tells the others on a `BroadcastChannel`; they count again at once                                              |
| A page goes into the back-forward cache (`pagehide`) | It releases its lock: it does not count. `pageshow` takes it again                                                 |
| A tab crashes                                        | Its lock goes; the other tabs see it at the next count (every `intervalMs`, 30 s, and when a page becomes visible) |
| No Web Locks                                         | The tabs count each other with `hello`, `here` and `bye` messages. A crashed tab stays counted until a reload      |
| No Web Locks and no `BroadcastChannel`               | `1`                                                                                                                |
| Tabs on other subdomains                             | Not counted: locks and channels belong to one origin                                                               |

`createTabCounter(tabId)` is exported for use on its own.

## Options

| Option          | Default                      | Purpose                                                                                               |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `busyThreshold` | `50`                         | Pending work above which the platform is `BUSY`.                                                      |
| `environment`   | `createBrowserEnvironment()` | Where `online` and `visible` come from.                                                               |
| `tabIdentity`   | browser defaults             | Storage, channel and probe timeout; `false` turns tab identity off (the id is `'tab'`).               |
| `now`           | `Date.now`                   | Clock for `startedAt`.                                                                                |
| `tabCount`      | browser defaults             | Locks, channel, page events and `intervalMs` of the tab count; `false` turns it off (`tabs` stays 1). |

## Testing

```ts
import { createTestPlatform } from '@webkrnl/core/testing';
import { createGlobalState, createStaticEnvironment } from '@webkrnl/global-state';

const environment = createStaticEnvironment();
const platform = createTestPlatform([
  createGlobalState({ environment, tabIdentity: false }),
  mySubsystem,
]);
await platform.start();
environment.set({ online: false }); // simulate going offline
```

From the repository root:

```bash
pnpm exec vitest run --project node packages/global-state
```
