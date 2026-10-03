# Examples: `@platform/global-state`

Global State finds the status of the platform from the lifecycle of each unit and from the work in progress. It answers admission questions, follows the online and visible states, and gives each tab an id.

## Show a busy indicator and hold optional work

<!-- example id="global-state/busy-and-admission" runtime="any" -->

An app shows a spinner while the platform is `BUSY`, and holds `LOW` work, such as analytics, until the platform is `IDLE` again.

```ts file=main.ts
import { Kernel } from '@platform/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';

const kernel = new Kernel([
  createGlobalState({
    busyThreshold: 2, // more than 2 pending works makes the platform BUSY
    environment: createStaticEnvironment(),
    tabIdentity: false,
  }),
]);
await kernel.start();
const { commands, views } = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
const show = (label: string) => console.log(label, views.state.getSnapshot().status);

show('after boot:');
for (const id of ['upload-1', 'upload-2', 'upload-3']) {
  commands.beginWork({ id, subsystemId: 'files', importance: 'MEDIUM', label: 'Upload' });
}
show('three uploads:');
console.log('accept analytics now?', commands.canAccept('LOW'));
console.log('accept a payment now?', commands.canAccept('CRITICAL'));

for (const id of ['upload-1', 'upload-2', 'upload-3']) commands.endWork(id);
show('uploads done:');
await kernel.stop();
```

```text output
after boot: IDLE
three uploads: BUSY
accept analytics now? false
accept a payment now? true
uploads done: IDLE
```

## Show an offline banner

<!-- example id="global-state/offline-banner" runtime="any" -->

The `online` and `visible` states are part of the state view. This example uses a static environment, so it can go offline on demand. In an app, `createBrowserEnvironment` follows the real browser events.

```ts file=main.ts
import { Kernel } from '@platform/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';

const environment = createStaticEnvironment({ online: true });
const kernel = new Kernel([createGlobalState({ environment, tabIdentity: false })]);
await kernel.start();

const { views } = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
let bannerShown = false;
views.state.subscribe(() => {
  const offline = views.state.getSnapshot().online === false;
  if (offline !== bannerShown) console.log(offline ? 'show banner: You are offline' : 'hide banner');
  bannerShown = offline;
});

environment.set({ online: false }); // the network drops
await new Promise((resolve) => setTimeout(resolve, 0));
environment.set({ online: true }); // the network is back
await new Promise((resolve) => setTimeout(resolve, 0));
await kernel.stop();
```

```text output
show banner: You are offline
hide banner
```

## Give each tab a stable id

<!-- example id="global-state/tab-identity" runtime="any" -->

A draft editor keys each draft by tab, so two tabs do not overwrite each other. The id survives a reload. A duplicated tab copies the stored id, so it asks the open tabs and gets a new id when the old one is taken.

```ts file=main.ts
import { resolveTabIdentity, type TabIdStorage } from '@platform/global-state';

// sessionStorage of the first tab. A duplicated tab starts with a copy of it.
const values = new Map<string, string>();
const storage: TabIdStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => void values.set(key, value),
};
let n = 0;
const ids = () => `tab_${++n}`;

const first = await resolveTabIdentity({ storage, ids });
console.log('first tab:', first.id);

const reloaded = await resolveTabIdentity({ storage, ids, channel: () => null });
console.log('after a reload:', reloaded.id);

const copy = new Map(values); // the user duplicates the tab
const duplicate = await resolveTabIdentity({
  storage: { getItem: (k) => copy.get(k) ?? null, setItem: (k, v) => void copy.set(k, v) },
  ids,
});
console.log('duplicated tab:', duplicate.id);

first.close();
duplicate.close();
```

```text output
first tab: tab_1
after a reload: tab_1
duplicated tab: tab_2
```
