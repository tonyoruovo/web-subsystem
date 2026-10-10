# @webkrnl/platform

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/platform) and [JSR](https://jsr.io/@webkrnl/platform).

The **orchestrator** of WebKrnl. `createPlatform(options)` boots a chosen set of subsystems with one call, wired together the way the design says, so an app does not repeat the wiring that each package leaves to it.

- **Always**: Global State, the Queue and the Notification Center (router and fan-out wired), and the Logger.
- **On by default**: the Window transport (in a browser), Crypto, Storage, Consent, Settings, Network, Sync, Translation and the Design System. `false` turns one off; options configure it.
- **On demand**: Auth (with its handlers), Realtime (with a URL), Analytics (with an endpoint or `send`).
- **Wiring**: the kernel persistence (`<appName>-state`), Storage on the key store of Crypto (`<appName>-keys`), the appearance settings of the Design System in Settings, errors to the Logger, the route source of Page scope.
- **Your units**: `units` adds the subsystems of the app.

This is the only package with hard `dependencies` on the subsystems (ARCHITECTURE §14). Design: [ARCHITECTURE §22.2](../../docs/ARCHITECTURE.md#222-the-orchestrator-webkrnlplatform).

## Installation

```json
{
  "dependencies": {
    "@webkrnl/platform": "workspace:*"
  }
}
```

## Usage

```ts
import { createPlatform } from '@webkrnl/platform';

export const platform = createPlatform({
  appName: 'shop',
  hub: { hubUrl: 'https://shop.example/__platform/hub.html' }, // a site on subdomains
  translation: { supportedLocales: ['en', 'fr'], url: '/i18n/{locale}/{namespace}.json' },
  auth: { handlers, protectedOrigins: ['https://api.shop.example'] },
  analytics: { endpoint: '/t/batch', sampleRate: 0.25 },
  units: [cart],
});

await platform.start();
platform.unit('settings')?.commands.set('dataSaver', true); // typed: SettingsControl
platform.unit('translation')?.commands.t('cart.items', { count: 3 });
platform.unit<CartControl>('cart')?.commands.add(item);
```

With Vue, give it to the adapter: `app.use(createWebKrnl(platform, { router }))` (`@webkrnl/vue`).

## Behaviour

| Situation                                    | Result                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPlatform`                             | Builds the kernel; nothing starts                                                                                                                  |
| `start()`                                    | Starts every subsystem (centralized first, then the others in dependency order). A second call returns the same promise. `ready` resolves after it |
| `stop()`                                     | Featurized subsystems first, then (after the Queue delivered what it was delivering) the centralized ones                                          |
| `unit(id)`                                   | The control interface while the unit runs; `undefined` before, after, or for an id that is not registered                                          |
| A unit of the app with the id of a subsystem | `RangeError`                                                                                                                                       |
| An error without a caller                    | `console.error`, and an `ERROR` entry in the Logger, unless `onError` is given                                                                     |
| No `location` (Node)                         | No Window transport unless `hub` gives an `origin`                                                                                                 |
| No IndexedDB (Node)                          | Storage does not encrypt: Crypto keeps its keys in memory, and Storage cannot share them                                                           |

## Options

| Option                                                                                              | Default                  | Purpose                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `appName`                                                                                           | `'app'`                  | Names the databases: `<appName>-state`, `<appName>-data`, `<appName>-keys`. |
| `globalState`, `queue`, `notification`, `logger`                                                    | `{}`                     | The options of the subsystems that are always on.                           |
| `hub`, `crypto`, `storage`, `consent`, `settings`, `network`, `sync`, `translation`, `designSystem` | on                       | `false`, `true`, or the options of the subsystem.                           |
| `auth`, `realtime`, `analytics`                                                                     | off                      | The options of the subsystem turn it on.                                    |
| `units`                                                                                             | none                     | The subsystems of the app.                                                  |
| `persistence`                                                                                       | `createStatePersistence` | The kernel persistence, or `false`.                                         |
| `routes`                                                                                            | the browser route source | The route source of Page scope, or `null`.                                  |
| `onError(error, unitId)`                                                                            | console and Logger       | Errors without a caller.                                                    |
| `kernel`                                                                                            | none                     | `ids`, `now`, `schedule`, `processors`, for tests.                          |

## Testing

```bash
pnpm exec vitest run --project node packages/platform
```
