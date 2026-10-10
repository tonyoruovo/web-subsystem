# @webkrnl/settings

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/settings) and [JSR](https://jsr.io/@webkrnl/settings).

The **Settings** subsystem (id `settings`, featurized, Window scope, requires Consent). It keeps the preferences of the user and of the device, and is the state behind a settings page.

- **Definitions**: each setting has a default, an optional check, and a kind: `device` (the default) or `user`. Built in: `syncInterval`, `bandwidthMode`, `dataSaver` and `locale`. The app adds its own.
- **Live**: a change applies at once. No reload.
- **Persisted**: the values are kept through the kernel's persistence, and saved after each change.
- **Shared by every tab of the site** (Window scope, with the Window transport of `@webkrnl/hub`): a change reaches the other tabs, and a new tab asks the open ones (`settings:sync`). For each key, the newer change wins.
- **On the server (optional)**: with `handlers.save`, user settings go to the server, and a failed save rolls the change back in every tab. With `handlers.load`, the user settings of the server apply when a user signs in.
- **Analytics opt-out**: `enableAnalytics` and `disableAnalytics` change the `analytics` grant of Consent. Opting out never stops essential work.
- **`optimisticUpdate(apply, commit, rollback)`**: the primitive that Settings uses for saves, exported for the app.

Design: [ARCHITECTURE §21.1](../../docs/ARCHITECTURE.md#211-settings) and the [Settings proposal](../../docs/proposals/settings_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/consent": "workspace:*",
    "@webkrnl/settings": "workspace:*"
  }
}
```

## Entry points

| Import              | Contents                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@webkrnl/settings` | `createSettings`, `BUILT_IN_SETTINGS`, `optimisticUpdate`, `mergeSettingRecords`, `SETTINGS_ID`, `SETTINGS_CHANGED`, `SETTINGS_SYNC`, `SETTINGS_STATE`, types |

## Usage

```ts
import { createConsent } from '@webkrnl/consent';
import { createSettings } from '@webkrnl/settings';

const kernel = new Kernel(
  [
    ...centralized,
    createWindowTransport({ hubUrl }),
    createAuth({ handlers }),
    createConsent(),
    createSettings({
      definitions: {
        'editor.fontSize': { default: 14, validate: (v) => v === 12 || v === 14 || v === 16 },
        'mail.digest': { default: true, kind: 'user' },
      },
      handlers: {
        load: async () => (await network.commands.get('/api/me/settings')).data,
        save: async (changes) => void (await network.commands.patch('/api/me/settings', changes)),
      },
    }),
  ],
  { router: queue.router, persistence },
);
```

A settings page:

```ts
import type { SettingsControl } from '@webkrnl/settings';

const { commands, views } = kernel.unit<SettingsControl>('settings').control!;

views.values.subscribe(() => render(views.values.getSnapshot()));
dataSaver.onchange = () => void commands.set('dataSaver', dataSaver.checked);
save.onclick = async () => {
  const saved = await commands.update({ 'mail.digest': digest.checked, locale: language.value });
  if (!saved) toast('Not saved. Try again.');
};
analytics.onchange = () =>
  analytics.checked ? commands.enableAnalytics() : commands.disableAnalytics();
```

From another subsystem, declare `{ target: 'settings', kind: 'optional' }` and follow a value:

```ts
init: (ctx) =>
  ctx.watch<SettingsControl>('settings', (settings) => {
    if (settings) applyMode(settings.commands.get('bandwidthMode'));
  }),
```

## Behaviour

| Situation                                                                    | Result                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set` / `update` with a valid value                                          | The value applies at once, `views.values` changes, the other tabs get it                                                                              |
| An unknown key, or a value that fails the check                              | `RangeError`; nothing changes                                                                                                                         |
| The same value again                                                         | No change, no broadcast, no save                                                                                                                      |
| A change of `user` settings, with `handlers.save`, while a user is signed in | Saved on the server. The promise resolves with `true`                                                                                                 |
| The save fails                                                               | The change rolls back in every tab, `lastError` is set, the error goes to `onError`, the promise resolves with `false`                                |
| A change of `device` settings, or nobody signed in (with Auth)               | Not saved on the server                                                                                                                               |
| A user signs in (with Auth and `handlers.load`)                              | The `user` settings of the server apply. Other keys, and values that fail the check, are ignored                                                      |
| Sign-out, or another user signs in (ARCHITECTURE §5.1)                       | The `user` settings return to their defaults, and that is persisted at once. The `device` settings stay. A load that the sign-out overtook is dropped |
| A change in another tab                                                      | Merged: for each key, the newer change wins                                                                                                           |
| This tab starts                                                              | Asks the open tabs (`settings:sync`), and merges their answers                                                                                        |
| A reload, or a crash                                                         | The values come back from the kernel's persistence                                                                                                    |

## Options

| Option        | Default    | Purpose                                                         |
| ------------- | ---------- | --------------------------------------------------------------- |
| `definitions` | none       | More settings, and changes to the built-in ones (same key).     |
| `handlers`    | none       | `load()` and `save(changes)` for the user settings on a server. |
| `now`         | `Date.now` | The clock.                                                      |

The built-in settings:

| Key             | Kind   | Default  | Values                                       |
| --------------- | ------ | -------- | -------------------------------------------- |
| `syncInterval`  | device | `300000` | An integer of at least 1000 (ms)             |
| `bandwidthMode` | device | `'FULL'` | `'FULL'`, `'CONSERVATIVE'`, `'MINIMAL'`      |
| `dataSaver`     | device | `false`  | A boolean                                    |
| `locale`        | user   | `null`   | A BCP 47 tag, or `null` (the device decides) |

## Testing

```bash
pnpm exec vitest run --project node packages/settings
```
