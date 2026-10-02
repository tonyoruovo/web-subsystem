import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

import { contextOptionsFor, selectInstallations } from './playwright.config.ts';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

/** Tests named `*.browser.spec.ts` need real browser APIs (workers, channels, iframes). */
const BROWSER_TESTS = ['tests/**/*.browser.spec.ts', 'packages/*/test/**/*.browser.spec.ts'];

/**
 * Tests named `*.e2e.spec.ts` drive several pages on several origins with
 * Playwright directly (one browser per installation), from Node.
 */
const E2E_TESTS = ['packages/*/test/**/*.e2e.spec.ts'];

/**
 * One browser instance per installation in playwright.config.ts that exists
 * on this machine. Select a subset with `BROWSERS=chrome,edge`.
 */
const instances = selectInstallations().map((installation) => ({
  browser: installation.engine,
  name: installation.id,
  provider: playwright({
    launchOptions: { executablePath: installation.executablePath },
    contextOptions: contextOptionsFor(installation),
  }),
}));

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      // M1 gate (docs/PLAN.md): every lifecycle transition and resolver case is covered.
      thresholds: {
        'packages/core/src/{lifecycle,dependency}.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['tests/**/*.{spec,test}.ts', 'packages/*/test/**/*.{spec,test}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...BROWSER_TESTS, ...E2E_TESTS],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: E2E_TESTS,
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'browser',
          include: BROWSER_TESTS,
          exclude: ['**/node_modules/**', '**/dist/**'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances,
          },
        },
      },
    ],
  },
});
