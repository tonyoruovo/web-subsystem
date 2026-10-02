/// <reference types="node" />
/**
 * @fileoverview
 * @summary Every browser installation the test matrix can run on.
 * @description
 * Each entry points at an explicit executable, so a failing launch can be
 * debugged (or allowed through the firewall) per installation:
 *
 * ```text
 *   node scripts/check-browsers.ts      launch each installation and report
 *   BROWSERS=edge,firefox pnpm test:browser   run only the named installations
 *   ```
 *
 * Installations whose executable does not exist on this machine are skipped,
 * so the same file works on CI and on other developers' machines.
 *
 * - `source: 'system'`: installed by the developer, outside this repo.
 * - `source: 'playwright'`: downloaded by `pnpm exec playwright install`.
 *   Their paths are resolved through Playwright, so they follow upgrades.
 *
 * Supported platforms: docs/ARCHITECTURE.md §1.1.
 */
import { existsSync } from 'node:fs';

import { chromium, devices, firefox, webkit } from 'playwright';

/** @summary A browser engine Playwright can drive. */
export type Engine = 'chromium' | 'firefox' | 'webkit';

/** @summary One browser executable the tests can launch. */
export interface BrowserInstallation {
  /** Unique id. Used as the Vitest project name and in `BROWSERS=`. */
  readonly id: string;
  /** The engine Playwright drives it with. */
  readonly engine: Engine;
  /** Absolute path to the executable. */
  readonly executablePath: string;
  /** Who installed it. */
  readonly source: 'system' | 'playwright';
  /** Playwright device to emulate, for the mobile profiles. */
  readonly device?: keyof typeof devices;
}

const playwrightPath = (engine: Engine): string =>
  ({ chromium, firefox, webkit })[engine].executablePath();

/** @summary All known installations, including ones missing on this machine. */
export const installations: readonly BrowserInstallation[] = [
  // Installed by the developer.
  {
    id: 'chrome',
    engine: 'chromium',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    source: 'system',
  },
  {
    id: 'system-chromium',
    engine: 'chromium',
    executablePath: 'C:\\chromium\\chrome.exe',
    source: 'system',
  },
  {
    id: 'edge',
    engine: 'chromium',
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    source: 'system',
  },

  // Downloaded by Playwright.
  {
    id: 'chromium',
    engine: 'chromium',
    executablePath: playwrightPath('chromium'),
    source: 'playwright',
  },
  {
    id: 'firefox',
    engine: 'firefox',
    executablePath: playwrightPath('firefox'),
    source: 'playwright',
  },
  {
    id: 'webkit',
    engine: 'webkit',
    executablePath: playwrightPath('webkit'),
    source: 'playwright',
  },
  {
    id: 'mobile-chromium',
    engine: 'chromium',
    executablePath: playwrightPath('chromium'),
    source: 'playwright',
    device: 'Pixel 7',
  },
  {
    id: 'mobile-webkit',
    engine: 'webkit',
    executablePath: playwrightPath('webkit'),
    source: 'playwright',
    device: 'iPhone 15',
  },
];

/**
 * @summary The installations to run: present on disk, and selected by `BROWSERS` when set.
 * @param {string | undefined} [filter] Comma-separated ids. Defaults to `process.env.BROWSERS`.
 * @returns {BrowserInstallation[]} The installations to run.
 */
export function selectInstallations(filter = process.env.BROWSERS): BrowserInstallation[] {
  const wanted = filter
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return installations.filter(
    (i) => existsSync(i.executablePath) && (!wanted?.length || wanted.includes(i.id)),
  );
}

/**
 * Playwright 1.63 disables these Chromium features by default
 * (playwright-core chromiumSwitches.ts). ThirdPartyStoragePartitioning is
 * among them, but users' Chrome ships with it on, and multi-origin tests
 * depend on it.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];

/**
 * @summary Launch options for an installation, with storage partitioning as users have it.
 * @description For Chromium, removes Playwright's default that turns
 * third-party storage partitioning off, and keeps its other defaults.
 * @param {BrowserInstallation} installation The installation.
 * @returns {object} Options for `browserType.launch`.
 */
export function launchOptionsFor(installation: BrowserInstallation) {
  if (installation.engine !== 'chromium') return { executablePath: installation.executablePath };
  return {
    executablePath: installation.executablePath,
    ignoreDefaultArgs: [`--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(',')}`],
    args: [
      `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.filter((f) => f !== 'ThirdPartyStoragePartitioning').join(',')}`,
    ],
  };
}

/**
 * @summary Browser-context options for an installation (the emulated device, if any).
 * @param {BrowserInstallation} installation The installation.
 * @returns {object} Context options without the device's default engine.
 */
export function contextOptionsFor(installation: BrowserInstallation) {
  if (!installation.device) return {};
  const { defaultBrowserType: _engine, ...options } = devices[installation.device];
  return options;
}
