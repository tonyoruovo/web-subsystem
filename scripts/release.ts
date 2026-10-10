/**
 * @fileoverview
 * @summary The release checks of the fixed-version monorepo: one version, publish fields that point at `dist/`, clean packages.
 * @description
 * Implements docs/ARCHITECTURE.md §22.5. Nothing is published: the version
 * stays `0.0.2` until the alpha (docs/PLAN.md §4.1).
 *
 * ```text
 *   node scripts/release.ts sync           publishConfig, files, repository/author/homepage/bugs, from the workspace, in each package.json
 *   node scripts/release.ts check          one version; the above in sync; dist/ built; npm pack has dist/ and no tests
 *   node scripts/release.ts version 0.1.0  sets the version of every package
 *   ```
 *
 * `sync` also points `publishConfig.registry` at GitHub Packages
 * (`npm.pkg.github.com`), since every package is scoped to this repo's
 * owner. Nothing publishes there until a release is actually run
 * (`pnpm -r publish`): this only prepares the config.
 *
 * @example
 * Before a release
 * ```ts
 * // pnpm build && pnpm release:check
 * ```
 *
 * @author MathAid
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packagesDir = join(root, 'packages');
const repoUrl = 'https://github.com/tonyoruovo/WebKrnl.git';

type Manifest = Record<string, unknown> & {
  name: string;
  version: string;
  author?: string;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: Record<string, unknown>;
};

const packages = readdirSync(packagesDir)
  .map((name) => join(packagesDir, name, 'package.json'))
  .filter((path) => existsSync(path))
  .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }));

const toDist = (target: string, extension: '.js' | '.d.ts') =>
  target.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, extension);

/** @summary The publish fields of a package, derived from its workspace exports and bin. */
function publishConfigOf(manifest: Manifest): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    exports[key] = target.endsWith('.ts')
      ? { types: toDist(target, '.d.ts'), import: toDist(target, '.js') }
      : target; // data files, such as the wire fixtures of core
  }
  const config: Record<string, unknown> = {
    main: toDist('./src/index.ts', '.js'),
    types: toDist('./src/index.ts', '.d.ts'),
    exports,
    access: 'public',
    registry: 'https://npm.pkg.github.com',
  };
  if (manifest.bin) {
    config.bin = Object.fromEntries(
      Object.entries(manifest.bin).map(([k, v]) => [k, toDist(v, '.js')]),
    );
  }
  return config;
}

const filesOf = (manifest: Manifest) =>
  (manifest.files ?? ['src']).map((entry) => (entry === 'src' ? 'dist' : entry));

/** @summary The `repository`/`homepage`/`bugs` fields of a package, pointing at its own folder of this repo. */
function metaOf(dir: string): {
  repository: Record<string, string>;
  homepage: string;
  bugs: Record<string, string>;
} {
  const directory = `packages/${basename(dir)}`;
  return {
    repository: { type: 'git', url: repoUrl, directory },
    homepage: `https://github.com/tonyoruovo/WebKrnl/tree/master/${directory}#readme`,
    bugs: { url: 'https://github.com/tonyoruovo/WebKrnl/issues' },
  };
}

const write = (path: string, manifest: Manifest) =>
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

const [command, argument] = process.argv.slice(2);
const problems: string[] = [];

if (command === 'sync') {
  for (const { path, manifest } of packages) {
    manifest.files = filesOf(manifest);
    manifest.publishConfig = publishConfigOf(manifest);
    manifest.author ||= 'MathAid';
    Object.assign(manifest, metaOf(join(path, '..')));
    write(path, manifest);
  }
  console.log(
    `publishConfig, files and repository metadata written in ${packages.length} packages.`,
  );
} else if (command === 'version') {
  if (!argument || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(argument)) {
    throw new Error('Give a version, for example: node scripts/release.ts version 0.1.0');
  }
  for (const { path, manifest } of packages) {
    manifest.version = argument;
    write(path, manifest);
  }
  console.log(`Every package is now ${argument}.`);
} else if (command === 'check') {
  const versions = new Set(packages.map((p) => p.manifest.version));
  if (versions.size !== 1)
    problems.push(`The packages have different versions: ${[...versions].join(', ')}.`);
  for (const { path, manifest } of packages) {
    const dir = join(path, '..');
    const where = relative(root, dir);
    if (JSON.stringify(manifest.publishConfig) !== JSON.stringify(publishConfigOf(manifest))) {
      problems.push(
        `${where}: publishConfig is not in sync with exports (run: node scripts/release.ts sync).`,
      );
    }
    if (JSON.stringify(manifest.repository) !== JSON.stringify(metaOf(dir).repository)) {
      problems.push(`${where}: repository is not in sync (run: node scripts/release.ts sync).`);
    }
    if (!manifest.author) {
      problems.push(`${where}: author is missing (run: node scripts/release.ts sync).`);
    }
    if (
      JSON.stringify(manifest.files) !== JSON.stringify(filesOf(manifest)) ||
      !manifest.files?.includes('dist')
    ) {
      problems.push(`${where}: "files" must list dist instead of src.`);
    }
    for (const [name, spec] of Object.entries({
      ...(manifest.dependencies as Record<string, string> | undefined),
      ...(manifest.peerDependencies as Record<string, string> | undefined),
    })) {
      if (name.startsWith('@webkrnl/') && spec !== 'workspace:*') {
        problems.push(
          `${where}: ${name} must be "workspace:*" (pnpm writes the fixed version on publish).`,
        );
      }
    }
    const targets = Object.values(manifest.publishConfig ?? {}).flatMap((value) =>
      typeof value === 'string'
        ? [value]
        : Object.values(value as Record<string, unknown>).flatMap((v) =>
            typeof v === 'string' ? [v] : Object.values(v as Record<string, string>),
          ),
    );
    for (const target of targets) {
      if (target.startsWith('./dist/') && !existsSync(join(dir, target))) {
        problems.push(`${where}: ${target} is missing (run: pnpm build).`);
      }
    }
    const packed = JSON.parse(
      execFileSync(
        process.platform === 'win32' ? 'cmd.exe' : 'npm',
        process.platform === 'win32'
          ? ['/d', '/s', '/c', 'npm pack --dry-run --json']
          : ['pack', '--dry-run', '--json'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    ) as Array<{ files: Array<{ path: string }> }>;
    const files = packed[0]!.files.map((f) => f.path);
    if (!files.some((f) => f.startsWith('dist/')))
      problems.push(`${where}: npm pack has no dist/.`);
    const tests = files.filter(
      (f) => /(^|\/)test\/|\.spec\.|\.test\./.test(f) && !f.startsWith('templates/'),
    );
    if (tests.length > 0) problems.push(`${where}: npm pack has test files: ${tests.join(', ')}.`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`${problems.length} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log(`${packages.length} packages at ${[...versions][0]}: ready to publish.`);
  }
} else {
  console.error('Usage: node scripts/release.ts sync | check | version <x.y.z>');
  process.exitCode = 1;
}
