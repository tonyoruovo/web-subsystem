/**
 * @fileoverview
 * @summary Launches every browser installation and reports which ones start.
 * @description
 * Run with `pnpm check:browsers`. Prints each installation's executable
 * path, so a blocked one can be allowed through the firewall or antivirus.
 * Exits with code 1 when any present installation fails to launch.
 */
import { existsSync } from 'node:fs';

import { chromium, firefox, webkit } from 'playwright';

import { installations } from '../playwright.config.ts';

const engines = { chromium, firefox, webkit };
let failed = 0;

for (const installation of installations) {
  const label = `${installation.id.padEnd(16)} ${installation.source.padEnd(10)}`;
  if (!existsSync(installation.executablePath)) {
    console.log(`SKIP ${label} not found: ${installation.executablePath}`);
    continue;
  }
  try {
    const browser = await engines[installation.engine].launch({
      executablePath: installation.executablePath,
      headless: true,
      timeout: 30_000,
    });
    console.log(`OK   ${label} v${browser.version()}  ${installation.executablePath}`);
    await browser.close();
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`FAIL ${label} ${message}\n     ${installation.executablePath}`);
  }
}

process.exitCode = failed ? 1 : 0;
