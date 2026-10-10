# @webkrnl/create

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/create) and [JSR](https://jsr.io/@webkrnl/create).

The **scaffolder** of WebKrnl. `npm init @webkrnl <folder>` writes a Vite app that boots WebKrnl, with generated tests. It has no dependencies.

```bash
npm init @webkrnl shop                          # Vue 3, vue-router, @webkrnl/vue
npm init @webkrnl notes -- --template vanilla   # TypeScript only
```

Design: [ARCHITECTURE §22.4](../../docs/ARCHITECTURE.md#224-the-scaffolder-webkrnlcreate).

## Templates

| Template        | What it has                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `vue` (default) | Vue 3 with `<script setup>`, vue-router, `createWebKrnl` (Page scope follows the router), `useT`, `useUnit`, `useView`; `vue-tsc`        |
| `vanilla`       | TypeScript and the DOM only: the page reads WebKrnl views and renders again when they change. It proves that the core needs no framework |

Each app has:

| File                                                                         | Purpose                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform.ts`                                                            | One `createPlatform` call with comments, and the `notes` entity of Sync                                                                                         |
| `src/main.ts`                                                                | Boots the platform and renders a page: the platform status, online state, open tabs, waiting changes, notes on the server, a theme switch and a language switch |
| `src/style.css`                                                              | Styles that use only the design tokens (`--ds-*`)                                                                                                               |
| `public/i18n/{en,fr}/common.json`                                            | Translation catalogs in ICU MessageFormat                                                                                                                       |
| `mock-api.ts`                                                                | A small API for development and preview (`/api/notes`); replace it with your server                                                                             |
| `tests/offline.test.ts`                                                      | The generated test: go offline, save a note, go online, and the note reaches the server once                                                                    |
| `vite.config.ts`, `tsconfig.json`, `package.json`, `README.md`, `.gitignore` | The tooling: `dev`, `build`, `preview`, `test`, `typecheck`                                                                                                     |

## Options

| Option           | Default         | Purpose                                                                                                              |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<folder>`       | (required)      | The folder of the app. It must not exist, or be empty.                                                               |
| `--template`     | `vue`           | `vue` or `vanilla`.                                                                                                  |
| `--name`         | the folder name | The package name of the app.                                                                                         |
| `--local <path>` | none            | Link the packages of a local checkout of this monorepo (`link:`), before the first release. Use `pnpm install` then. |

## In this monorepo

```bash
node packages/create/src/cli.ts ../try-webkrnl --template vanilla --local .
cd ../try-webkrnl && pnpm install && pnpm dev
```

Node 24 runs the TypeScript source. The published package runs the build in `dist/` (ARCHITECTURE §22.5).

## Testing

```bash
pnpm exec vitest run --project node packages/create
BROWSERS=chrome,webkit pnpm exec vitest run --project e2e packages/create   # the M10 gate
```

The gate scaffolds both templates with `--local`, installs them, runs their tests, builds them, and drives them offline and online in real browsers.
