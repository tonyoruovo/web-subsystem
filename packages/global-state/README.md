# @platform/global-state

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Global State** subsystem: the platform's view of itself. It is a centralized subsystem (id `global-state`, Tab scope) that:

- **derives the platform status** from every unit's lifecycle and from pending work: `INITIALIZING`, `IDLE`, `BUSY`, `DEGRADED`, then `STOPPED` after shutdown;
- **decides admission**: `CRITICAL` work is always accepted, nothing else while `BUSY`, no `LOW` work while `DEGRADED`;
- **tracks pending work**, so the user can always see what is in progress (the Queue registers every packet in flight);
- **observes the environment**: online and page visibility;
- **identifies the tab**, with an id that survives reloads and is unique for duplicated tabs.

Design: [ARCHITECTURE §10.1](../../docs/ARCHITECTURE.md#101-how-the-three-centralized-subsystems-fit-together-m3) and the amended [Global State proposal](../../proposals/global_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/global-state": "workspace:*"
  }
}
```

| Peer dependency  | Why                                |
| ---------------- | ---------------------------------- |
| `@platform/core` | The kernel this subsystem runs on. |

## Usage

Register it with the kernel, usually first:

```ts
import { Kernel } from '@platform/core';
import { createGlobalState } from '@platform/global-state';

const kernel = new Kernel([createGlobalState(), ...subsystems]);
await kernel.start();
```

Read the status, pending work and environment from its view:

```ts
import type { GlobalStateControl } from '@platform/global-state';

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

## Options

| Option          | Default                      | Purpose                                                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `busyThreshold` | `50`                         | Pending work above which the platform is `BUSY`.                                        |
| `environment`   | `createBrowserEnvironment()` | Where `online` and `visible` come from.                                                 |
| `tabIdentity`   | browser defaults             | Storage, channel and probe timeout; `false` turns tab identity off (the id is `'tab'`). |
| `now`           | `Date.now`                   | Clock for `startedAt`.                                                                  |

## Testing

```ts
import { createTestPlatform } from '@platform/core/testing';
import { createGlobalState, createStaticEnvironment } from '@platform/global-state';

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
