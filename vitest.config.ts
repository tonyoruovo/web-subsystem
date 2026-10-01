import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { devices } from 'playwright';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

/** Tests named `*.browser.spec.ts` need real browser APIs (workers, channels, iframes). */
const BROWSER_TESTS = ['tests/**/*.browser.spec.ts', 'packages/*/test/**/*.browser.spec.ts'];

/**
 * Supported platforms (docs/ARCHITECTURE.md §1.1): desktop engines, plus
 * emulated mobile WebKit (every iOS browser) and Chromium on Android.
 * Emulation uses the desktop engine with a mobile viewport, user agent and
 * touch; real-device runs are added before 1.0.
 */
const mobile = (device: keyof typeof devices) => {
  const { defaultBrowserType: _engine, ...contextOptions } = devices[device];
  return playwright({ contextOptions });
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['tests/**/*.{spec,test}.ts', 'packages/*/test/**/*.{spec,test}.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...BROWSER_TESTS],
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
            instances: [
              { browser: 'chromium' },
              { browser: 'firefox' },
              { browser: 'webkit' },
              { browser: 'webkit', name: 'mobile-webkit', provider: mobile('iPhone 15') },
              { browser: 'chromium', name: 'mobile-chromium', provider: mobile('Pixel 7') },
            ],
          },
        },
      },
    ],
  },
});
