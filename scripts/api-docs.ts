/**
 * @fileoverview
 * @summary Builds the TSDoc-model documentation site: Microsoft API Extractor, then API Documenter, into `docs-site/tsdoc`.
 * @description
 * `pnpm docs:site` runs TypeDoc (the community tool) into `docs-site/typedoc`.
 * This script runs the other TSDoc-native toolchain — the one built by the
 * TSDoc spec's own authors — into `docs-site/tsdoc`: API Extractor reads each
 * package's built declarations (`pnpm build` first) and writes one `.api.json`
 * doc model per package into `.api-extractor-temp/`; API Documenter then
 * turns every model into linked markdown pages.
 *
 * ```text
 *   pnpm build                                     dist/<name>.d.ts, one per package
 *   for each package:
 *     Extractor.prepare + Extractor.invoke          dist/index.d.ts --> .api-extractor-temp/<name>.api.json
 *   api-documenter markdown                        .api-extractor-temp/*.api.json --> docs-site/tsdoc/*.md
 *   ```
 *
 * The project's TSDoc comments use a few tags (`@summary`, `@fileoverview`,
 * `@description`) that are not in the official TSDoc spec, and the project's
 * `@param` convention keeps the JSDoc `{Type}` and no hyphen, which the
 * strict TSDoc grammar does not accept. The shared root `tsdoc.json` declares
 * the custom tags (for this script and for TypeDoc alike); the `@param`
 * grammar mismatch is a known, accepted style difference, not a defect, so
 * its specific message codes are suppressed below rather than silenced
 * wholesale.
 *
 * @example
 * Build everything, or some packages
 * ```ts
 * // pnpm docs:tsdoc
 * // node scripts/api-docs.ts core settings
 * ```
 *
 * @author MathAid
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Extractor, ExtractorConfig, type IConfigFile } from '@microsoft/api-extractor';
import { TSDocConfigFile } from '@microsoft/tsdoc-config';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packagesDir = join(root, 'packages');
const modelDir = join(root, '.api-extractor-temp');
const outDir = join(root, 'docs-site', 'tsdoc');

// The virtual `configObjectFullPath` below has no file on disk, so the usual
// "walk up from the config file" discovery of tsdoc.json cannot find it.
// Load the shared root tsdoc.json once, explicitly, instead.
const tsdocConfigFile = TSDocConfigFile.loadForFolder(root);
if (tsdocConfigFile.hasErrors) {
  console.error(tsdocConfigFile.getErrorSummary());
  process.exitCode = 1;
}

/** @summary TSDoc-parser message codes that are a known style choice of this project, not a defect. */
const QUIET_TSDOC_CODES = [
  'tsdoc-param-tag-missing-hyphen', // @param {Type} name Description, not @param name - Description
  'tsdoc-param-tag-with-invalid-type', // the {Type} in @param and @returns
  'tsdoc-param-tag-with-invalid-optional-name', // @param {Type} [name]
  'tsdoc-malformed-inline-tag', // a literal '{' in prose, not an inline tag
  'tsdoc-escape-right-brace', // a literal '}' in prose, e.g. in a code sample's JSON
  'tsdoc-escape-greater-than', // a literal '>' in prose, e.g. '<Type>'
  'tsdoc-html-tag-missing-greater-than', // the same '<Type>' read as a stray HTML tag
];
/** @summary API Extractor's own (`ae-*`) message codes that are expected, not a defect. */
const QUIET_AE_CODES = [
  'ae-missing-release-tag', // every public member already has its own @public (check:docs); some container types do not need one
];
const quietTsdoc = Object.fromEntries(
  QUIET_TSDOC_CODES.map((code) => [code, { logLevel: 'none' as const }]),
);
const quietAe = Object.fromEntries(
  QUIET_AE_CODES.map((code) => [code, { logLevel: 'none' as const }]),
);

interface Manifest {
  readonly name: string;
  readonly exports?: Record<string, string>;
  readonly publishConfig?: { readonly exports?: Record<string, unknown> };
}

/** @summary Reads the `exports["."]` entry point (declaration) of a package, built or not. */
function entryPoint(manifest: Manifest): string {
  return (manifest.exports?.['.'] ?? './src/index.ts')
    .replace(/^\.\/src\//, './dist/')
    .replace(/\.ts$/, '.d.ts');
}

/**
 * @summary A `paths` map that redirects every `@webkrnl/*` import to its own built declarations.
 * @description Inside the workspace, `@webkrnl/<name>` resolves to that
 * package's `src/index.ts` (its own `package.json` fields point there, for
 * live development). API Extractor needs the opposite: every cross-package
 * import of a public type must resolve to a `.d.ts`, the same contract a
 * published package would present, or it reports `ae-wrong-input-file-type`
 * the moment it follows an import back into another package's TypeScript
 * source. `publishConfig.exports` (`scripts/release.ts sync`) already has
 * the dist-mapped paths for every entry point of every package.
 */
function distPaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const name of readdirSync(packagesDir)) {
    const packageJsonPath = join(packagesDir, name, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Manifest;
    for (const [key, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
      const types = typeof target === 'string' ? target : (target as { types?: string }).types;
      if (!types) continue;
      const specifier = key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`;
      paths[specifier] = [join(packagesDir, name, types)];
    }
  }
  return paths;
}
const paths = distPaths();

function buildOne(name: string): boolean {
  const packageDir = join(packagesDir, name);
  const packageJsonFullPath = join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(packageJsonFullPath, 'utf8')) as Manifest;
  const mainEntryPointFilePath = join(packageDir, entryPoint(manifest));
  if (!existsSync(mainEntryPointFilePath)) {
    console.error(`skip ${name}: ${mainEntryPointFilePath} is missing. Run "pnpm build" first.`);
    return false;
  }
  const configObject: IConfigFile = {
    mainEntryPointFilePath,
    projectFolder: packageDir,
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          moduleResolution: 'bundler',
          baseUrl: root,
          paths,
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'ESNext.Intl', 'ESNext.Error'],
        },
      },
    },
    apiReport: { enabled: false, reportFileName: `${name}.api.md` },
    docModel: { enabled: true, apiJsonFilePath: join(modelDir, `${name}.api.json`) },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      compilerMessageReporting: { default: { logLevel: 'warning' } },
      extractorMessageReporting: { default: { logLevel: 'warning' }, ...quietAe },
      tsdocMessageReporting: { default: { logLevel: 'warning' }, ...quietTsdoc },
    },
  };
  const extractorConfig = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: join(packageDir, 'api-extractor.json'), // a virtual path: only used to resolve <projectFolder>
    packageJsonFullPath,
    tsdocConfigFile,
  });
  const result = Extractor.invoke(extractorConfig, { localBuild: true });
  if (!result.succeeded) {
    console.error(
      `FAIL ${name}: ${result.errorCount} error(s), ${result.warningCount} warning(s).`,
    );
  }
  return result.succeeded;
}

const only = process.argv.slice(2);
const names = readdirSync(packagesDir).filter(
  (name) =>
    existsSync(join(packagesDir, name, 'package.json')) &&
    (only.length === 0 || only.includes(name)),
);

rmSync(modelDir, { recursive: true, force: true });
mkdirSync(modelDir, { recursive: true });
let failed = false;
for (const name of names) {
  if (buildOne(name)) console.log(`built ${name}`);
  else failed = true;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// On Windows, api-documenter is a .cmd shim, which spawnSync can only run via a shell.
const documenter = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'api-documenter.cmd' : 'api-documenter',
);
const run = spawnSync(
  documenter,
  ['markdown', '--input-folder', modelDir, '--output-folder', outDir],
  {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  },
);
if (run.stdout) console.log(run.stdout);
if (run.status !== 0) {
  console.error(run.stderr || `api-documenter exited with code ${run.status}.`);
  failed = true;
}

process.exitCode = failed ? 1 : 0;
