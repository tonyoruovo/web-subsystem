/**
 * @fileoverview
 * @summary Publishing to JSR (`jsr.io`): one `jsr.json` per package, generated from its own `exports`.
 * @description
 * JSR publishes TypeScript source directly (no `dist/`): `exports` points
 * at `src/*.ts`, the same paths the workspace already uses for local
 * development (`package.json`'s own `exports`, before the `publishConfig`
 * override to `dist/` that the registry (GitHub Packages, §22.5) uses).
 *
 * ```text
 *   node scripts/jsr.ts sync             jsr.json, from each package's own package.json exports
 *   node scripts/jsr.ts check [names]    `jsr publish --dry-run`, every package or the ones named
 *   node scripts/jsr.ts publish [names]  `jsr publish`, every package or the ones named (needs a login or --token)
 *   ```
 *
 * On Windows, the `jsr` npm wrapper has a bug: it shells out to its
 * downloaded `deno.exe` without quoting the path, which breaks the moment
 * a username has a space in it (`node --trace-deprecation` shows the
 * DEP0190 warning, then "is not recognized as an internal or external
 * command"). This script finds that same downloaded binary and calls it
 * directly instead.
 *
 * @example
 * Before publishing an RC
 * ```ts
 * // node scripts/jsr.ts sync
 * // node scripts/jsr.ts check
 * ```
 *
 * @author MathAid
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packagesDir = join(root, 'packages');

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly exports?: Record<string, string>;
}

const names = readdirSync(packagesDir).filter((name) =>
  existsSync(join(packagesDir, name, 'package.json')),
);

function jsrConfigOf(manifest: Manifest): Record<string, unknown> {
  const exports = Object.fromEntries(
    Object.entries(manifest.exports ?? {}).filter(([, target]) => target.endsWith('.ts')),
  );
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? 'ISC',
    exports,
    publish: { exclude: ['test', '**/*.spec.ts', '**/*.test.ts', 'FIXES.md'] },
  };
}

/** @summary Finds the real `deno.exe` the `jsr` npm wrapper downloaded into pnpm's content-addressed store. */
function denoBinary(): string {
  if (process.platform !== 'win32') return 'deno'; // the jsr wrapper's own shell-out works fine elsewhere
  const store = execFileSync('pnpm.cmd', ['store', 'path'], {
    encoding: 'utf8',
    shell: true,
  }).trim();
  const linksDir = join(store, 'links', '@', 'jsr');
  if (!existsSync(linksDir)) {
    // Warms the download cache; its own invocation then fails on the quoting bug, which is fine here.
    spawnSync('pnpm.cmd', ['dlx', 'jsr', '--version'], { cwd: root, shell: true });
  }
  for (const jsrVersion of existsSync(linksDir) ? readdirSync(linksDir) : []) {
    for (const hash of readdirSync(join(linksDir, jsrVersion))) {
      const download = join(linksDir, jsrVersion, hash, 'node_modules', 'jsr', '.download');
      if (!existsSync(download)) continue;
      const denoVersion = readdirSync(download)[0];
      if (denoVersion) return join(download, denoVersion, 'win32', 'deno.exe');
    }
  }
  throw new Error('Could not find the downloaded jsr/deno binary. Run: pnpm dlx jsr --version');
}

/**
 * @summary Runs `fn` with every `"@webkrnl/*": "workspace:*"` in `dir`'s package.json replaced by its real version.
 * @description JSR's npm-compat layer reads a bare import like `@webkrnl/core`
 * as `npm:@webkrnl/core`, then looks in package.json for the version to pin
 * it to - `workspace:*` isn't a version, so it reports the specifier as
 * missing one ("specifier 'npm:@webkrnl/core' is missing a version
 * constraint"). pnpm rewrites `workspace:*` on its own publish; `jsr publish`
 * does not, so this does the same rewrite here, only for the duration of
 * the call, on the file on disk (not a copy - `jsr publish` reads it from
 * `dir` directly).
 */
function withPinnedWorkspaceDeps<T>(dir: string, fn: () => T): T {
  const packageJsonPath = join(dir, 'package.json');
  const original = readFileSync(packageJsonPath, 'utf8');
  const manifest = JSON.parse(original) as Manifest & Record<string, unknown>;
  const version = manifest.version;
  let changed = false;
  for (const field of [
    'dependencies',
    'peerDependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (dep.startsWith('@webkrnl/') && range === 'workspace:*') {
        deps[dep] = version;
        changed = true;
      }
    }
  }
  if (!changed) return fn();
  writeFileSync(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n');
  try {
    return fn();
  } finally {
    writeFileSync(packageJsonPath, original);
  }
}

function runOne(name: string, args: string[]): boolean {
  const dir = join(packagesDir, name);
  const result = withPinnedWorkspaceDeps(dir, () =>
    spawnSync(denoBinary(), args, { cwd: dir, encoding: 'utf8', stdio: 'inherit' }),
  );
  return result.status === 0;
}

const [command, ...rest] = process.argv.slice(2);
const only = rest.filter((arg) => !arg.startsWith('--'));
const targets = names.filter((name) => only.length === 0 || only.includes(name));

if (command === 'sync') {
  for (const name of targets) {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, name, 'package.json'), 'utf8'),
    ) as Manifest;
    const config = jsrConfigOf(manifest);
    writeFileSync(join(packagesDir, name, 'jsr.json'), `${JSON.stringify(config, null, 2)}\n`);
  }
  console.log(`jsr.json written in ${targets.length} package(s).`);
} else if (command === 'check' || command === 'publish') {
  const denoArgs = [
    'publish',
    '--unstable-bare-node-builtins',
    '--unstable-sloppy-imports',
    '--unstable-byonm',
    '--no-check',
    ...(command === 'check' ? ['--dry-run'] : []),
    '--allow-dirty', // withPinnedWorkspaceDeps always touches package.json for the duration of the call
    ...(rest.includes('--allow-slow-types') ? ['--allow-slow-types'] : []),
    ...(rest.includes('--token') ? ['--token', rest[rest.indexOf('--token') + 1]!] : []),
  ];
  let failed = false;
  for (const name of targets) {
    console.log(`\n--- ${name} ---`);
    if (!runOne(name, denoArgs)) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} else {
  console.error(
    'Usage: node scripts/jsr.ts sync | check [names...] | publish [names...] [--allow-slow-types] [--token <t>]',
  );
  process.exitCode = 1;
}
