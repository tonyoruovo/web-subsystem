# @webkrnl/vue

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/vue) and [JSR](https://jsr.io/@webkrnl/vue).

The **Vue adapter** of WebKrnl. Every WebKrnl view is an external store, so Vue can use it without an adapter; this package makes it short, and connects vue-router to Page scope. It adds no behaviour that the core lacks (ARCHITECTURE §14.1).

- `useView(view)`: a read-only `shallowRef` that follows a view, and stops when the component unmounts.
- `createWebKrnl(platform, { router })`: the plugin. It provides the platform, starts it, and with a router, each navigation ends Page scope (`kernel.changePage`).
- `usePlatform()`, `useUnit(id)`: the platform, and a ref of the control interface of a unit (`undefined` while it does not run). `useUnit` is typed for the ids of the catalogue.
- `useT()`: `t` of Translation, bound to its state, so a template renders again when catalogs arrive or the locale changes.
- `createVueRouterRouteSource(router)`: the route source, for a kernel without the platform.

Design: [ARCHITECTURE §22.3](../../docs/ARCHITECTURE.md#223-the-vue-adapter-webkrnlvue).

## Installation

```json
{
  "dependencies": {
    "@webkrnl/platform": "workspace:*",
    "@webkrnl/vue": "workspace:*",
    "vue": "^3.5.0",
    "vue-router": "^5.4.0"
  }
}
```

`vue` and `vue-router` are peer dependencies; `vue-router` is optional.

## Usage

`src/main.ts`:

```ts
import { createPlatform } from '@webkrnl/platform';
import { createWebKrnl } from '@webkrnl/vue';

const platform = createPlatform({
  appName: 'shop',
  routes: null, // Page scope follows vue-router through the plugin
  translation: {
    supportedLocales: ['en', 'fr'],
    url: '/i18n/{locale}/{namespace}.json',
    escapeParams: false,
  },
});
createApp(App).use(router).use(createWebKrnl(platform, { router })).mount('#app');
```

A component:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { usePlatform, useT, useUnit, useView } from '@webkrnl/vue';

const platform = usePlatform();
const state = useView(platform.unit('global-state')!.views.state);
const settings = useUnit('settings');
const t = useT();
const offline = computed(() => !state.value.online);
</script>

<template>
  <p v-if="offline">{{ t('offline.banner') }}</p>
  <p>{{ t('cart.items', { count: 3 }) }}</p>
  <button @click="settings?.commands.set('dataSaver', true)">{{ t('settings.dataSaver') }}</button>
</template>
```

## Behaviour

| Situation                                             | Result                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `app.use(createWebKrnl(platform))`                    | `provide`s the platform and starts it (`start: false` to start it yourself). `platform.ready` resolves when it runs |
| A navigation of vue-router (with `router`)            | `kernel.changePage(path)`: Page-scope subsystems restart as a new page, or handle the path in `pageChange`          |
| `useView(view)` in `setup`                            | The ref changes with each notification of the view; it stops following when the component unmounts                  |
| `useUnit(id)` before the unit runs, or after it stops | `undefined`; the ref changes when the unit starts or restarts                                                       |
| `useT()` before Translation runs                      | `t` returns the key; it renders again when Translation starts and when catalogs or the locale change                |
| `usePlatform()` outside an app with the plugin        | `Error`                                                                                                             |
| Escaping                                              | Vue escapes text: give Translation `escapeParams: false`, so text is not escaped twice                              |

## Testing

```bash
pnpm exec vitest run --project node packages/vue
```
