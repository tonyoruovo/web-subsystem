# @webkrnl/translation

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/translation) and [JSR](https://jsr.io/@webkrnl/translation).

The **Translation** subsystem (id `translation`, featurized, Tab scope, no required dependency). It gives the UI localized messages and locale-aware formatting, and works offline.

- **`t()` is synchronous**, because templates call it while they render. Catalogs load before, in the background. `views.state` changes when they arrive, so the UI renders again.
- **ICU MessageFormat**, parsed by the package (no dependency): arguments, `plural` and `selectordinal` (with `#`, `=N` and `offset`), `select`, `number`, `date` and `time` styles, nested messages, apostrophe quoting.
- **A locale chain**: the setting `locale` (Settings), then the device languages, then `defaultLocale`, matched against `supportedLocales`. A key that `fr-CA` does not have comes from `fr`, then from the default.
- **Catalogs from anywhere**: in the options, from a loader of the app (a dynamic `import()`), or from a URL through Network. Only `common` loads at start; other namespaces load on demand, and the least recently used ones leave memory.
- **A worker compiles**: the processor `compile` parses catalogs in a dedicated worker, then on the main thread.
- **Offline**: with Storage, fetched catalogs are kept (`translation.catalogs`) and checked again with their `ETag` when the platform is online.
- **Never crashes on a gap**: a missing key returns the key, is counted, and is broadcast once as `translation:missing-key`. A message that does not parse is reported and falls back.
- **Safe parameters**: parameter values are HTML-escaped by default.
- **Formatting**: numbers, money, dates, relative times, lists and sorting, for the active locale.

Design: [ARCHITECTURE §21.2](../../docs/ARCHITECTURE.md#212-translation) and the [Translation proposal](../../docs/proposals/translation_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/translation": "workspace:*"
  }
}
```

The package starts its worker with `new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' })`. Vite, webpack 5 and Rollup find the worker file from this expression.

## Entry points

| Import                        | Contents                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@webkrnl/translation`        | `createTranslation`, `parseMessage`, `formatMessage`, `createFormatContext`, `escapeHtml`, `resolveLocaleChain`, `canonicalLocale`, `textDirection`, `compileCatalog`, constants, errors, types |
| `@webkrnl/translation/worker` | The worker entry. It serves the processor `compile`. You do not import it yourself.                                                                                                             |

## Usage

```ts
import { createTranslation, type TranslationControl } from '@webkrnl/translation';

const kernel = new Kernel(
  [
    ...centralized,
    createConsent(),
    createSettings(),
    createStorage({ keys }),
    createNetwork(),
    createTranslation({
      supportedLocales: ['en', 'fr', 'fr-CA', 'ar'],
      url: '/i18n/{locale}/{namespace}.json', // { "messages": { ... } }
    }),
  ],
  { router: queue.router },
);
await kernel.start();

const i18n = kernel.unit<TranslationControl>('translation').control!;
i18n.views.state.subscribe(() => {
  const { locale, direction } = i18n.views.state.getSnapshot();
  document.documentElement.lang = locale!;
  document.documentElement.dir = direction!;
  render();
});

i18n.commands.t('cart.items', { count: 3 }); // '3 items'
await i18n.commands.loadNamespace('checkout');
await i18n.commands.setLocale('fr'); // with Settings: every tab follows
```

A catalog file:

```json
{
  "version": 12,
  "messages": {
    "cart.items": "{count, plural, =0 {Your cart is empty} one {# item} other {# items}}",
    "greeting": "{gender, select, female {Welcome back, {name}} other {Welcome back, {name}}}",
    "due": "Due {date, date, long}"
  }
}
```

## The message format

| Form          | Example                                                                    | Result (`en`)                 |
| ------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Argument      | `Hello, {name}!`                                                           | `Hello, Ada!`                 |
| Number        | `{n, number}`, `{n, number, integer}`, `{r, number, percent}`              | `1,234.5`, `3`, `25%`         |
| Money         | `{p, number, currency}` (option `currency`), `{p, number, ::currency/EUR}` | `$5.00`, `€5.00`              |
| Skeletons     | `::compact-short`, `::compact-long`, `::.00`, `::.0#`, `::percent`         | `12K`, `2.00`                 |
| Date and time | `{d, date, long}`, `{d, time, short}`                                      | `October 5, 2026`, `12:00 PM` |
| Plural        | `{n, plural, =0 {none} one {# file} other {# files}}`                      | `none`, `1 file`, `5 files`   |
| Offset        | `{n, plural, offset:1 =1 {you} other {you and # others}}`                  | `you and 2 others`            |
| Ordinal       | `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`            | `22nd`                        |
| Select        | `{g, select, female {She} male {He} other {They}}`                         | `They`                        |
| Quoting       | `It''s`, `Type '{name}' here.`                                             | `It's`, `Type {name} here.`   |

A missing parameter shows as `{name}`. A plural, ordinal or select without `other` does not parse.

## Behaviour

| Situation                                               | Result                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start                                                   | Resolves the chain, loads `common` (and `namespaces`) for each locale of the chain, and waits for them up to `startWaitMs` (2 s). After that it is ready, and `t()` returns keys until the catalogs arrive |
| A key in the first locale of the chain                  | Its message, formatted with the plural rules of that locale                                                                                                                                                |
| A key only in a later locale                            | The message of that locale                                                                                                                                                                                 |
| A key in no catalog                                     | The key. Counted in `missing`, and broadcast once for each key and locale as `translation:missing-key` (LOW). `strict: true` throws `MissingTranslationError`                                              |
| A message that does not parse                           | Reported to `onError`. The chain continues past it                                                                                                                                                         |
| The setting `locale` changes (Settings), or `setLocale` | A new chain; its catalogs load; `translation:locale-changed` (Tab scope) with the direction                                                                                                                |
| A catalog source                                        | The first that has it: `catalogs` in the options, Storage, `load()`, then `url`                                                                                                                            |
| A catalog from `url`                                    | Kept in Storage (`translation.catalogs`, not encrypted: catalogs are public)                                                                                                                               |
| A catalog from Storage                                  | Used at once, then checked with `If-None-Match`; a new version replaces it                                                                                                                                 |
| Offline, catalog in Storage                             | Used. The check fails quietly                                                                                                                                                                              |
| Offline, no catalog anywhere                            | `lastError` is set; `t()` returns keys                                                                                                                                                                     |
| More than `maxCatalogs` in memory                       | The least recently used catalogs that the chain does not need leave                                                                                                                                        |
| Parameter values with HTML                              | Escaped (`&lt;`), unless `escapeParams: false`                                                                                                                                                             |
| Sign-out (ARCHITECTURE §5.1)                            | Nothing to wipe: Translation keeps no user data                                                                                                                                                            |

## Options

| Option                    | Default                    | Purpose                                                                                           |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `defaultLocale`           | `'en'`                     | The last locale of every chain.                                                                   |
| `supportedLocales`        | the default locale         | The locales the app has catalogs for.                                                             |
| `catalogs`                | none                       | Catalogs in the options.                                                                          |
| `load(locale, namespace)` | none                       | A loader of the app. Returns `{ messages, version? }` or `null`.                                  |
| `url`                     | none                       | A catalog URL with `{locale}` and `{namespace}`. Through Network when it runs, otherwise `fetch`. |
| `namespaces`              | `['common']`               | The namespaces that load at start.                                                                |
| `maxCatalogs`             | `50`                       | Catalogs kept in memory.                                                                          |
| `strict`                  | `false`                    | Throw for a missing key.                                                                          |
| `escapeParams`            | `true`                     | HTML-escape parameter values. Turn it off where the framework escapes text.                       |
| `currency`                | `'USD'`                    | The currency of the `currency` style and of `formatCurrency`.                                     |
| `startWaitMs`             | `2000`                     | How long the start waits for the first catalogs.                                                  |
| `hosts`                   | `['dedicated', 'virtual']` | The hosts of the processor `compile`.                                                             |
| `languages()`             | `navigator.languages`      | The device locales (tests).                                                                       |

## Testing

```bash
pnpm exec vitest run --project node packages/translation
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/translation
```

The browser test compiles a catalog in a real dedicated worker.
