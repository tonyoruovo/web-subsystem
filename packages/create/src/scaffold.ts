/// <reference types="node" />
/**
 * @fileoverview
 * @summary The scaffolder: writes a new WebKrnl app from a template.
 * @description
 * Implements docs/ARCHITECTURE.md §22.4. It has no dependencies: it copies
 * the files of a template, and replaces a few placeholders.
 *
 * ```text
 *   templates/shared/**  +  templates/<vue|vanilla>/**  -->  <directory>/**
 *     {{name}} {{template}} {{version}}       the app name, the template, the WebKrnl version
 *     {{dep:<package>}}                       '^<version>', or 'link:<local>/packages/<package>' with --local
 *     /* {{localAllow}} *\/                   the local checkout, for Vite's server.fs.allow
 *     _gitignore                              .gitignore (npm drops .gitignore files from packages)
 *   ```
 *
 * @example
 * From a script
 * ```ts
 * await scaffold({ directory: 'my-app', template: 'vue' });
 * ```
 *
 * @author MathAid
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @summary The templates: a Vue app, or a plain TypeScript app.
 * @public
 */
export type Template = 'vue' | 'vanilla';

/**
 * @summary The templates that exist.
 * @public
 */
export const TEMPLATES: readonly Template[] = ['vue', 'vanilla'];

/**
 * @summary Options of {@linkcode scaffold}.
 *
 * @example
 * Example 1: A Vue app
 * ```ts
 * const options: ScaffoldOptions = { directory: 'shop', template: 'vue' };
 * ```
 *
 * @example
 * Example 2: Against a local checkout of WebKrnl
 * ```ts
 * const options: ScaffoldOptions = { directory: 'try', template: 'vanilla', local: '../webkrnl' };
 * ```
 *
 * @public
 */
export interface ScaffoldOptions {
  /**
   * @summary The folder of the new app. It must not exist, or be empty.
   */
  readonly directory: string;
  /**
   * @summary The template. The default is `vue`.
   */
  readonly template?: Template;
  /**
   * @summary The package name of the app. The default is the name of the folder.
   */
  readonly name?: string;
  /**
   * @summary A local checkout of the WebKrnl monorepo: the app links its packages (`link:`) instead of the registry.
   */
  readonly local?: string;
  /**
   * @summary The version of the `@webkrnl/*` packages. The default is the version of the scaffolder.
   */
  readonly version?: string;
}

/**
 * @summary What {@linkcode scaffold} wrote.
 * @public
 */
export interface ScaffoldResult {
  /**
   * @summary The absolute folder of the app.
   */
  readonly directory: string;
  /**
   * @summary The package name of the app.
   */
  readonly name: string;
  /**
   * @summary The template.
   */
  readonly template: Template;
  /**
   * @summary The files written, relative to the folder, sorted.
   */
  readonly files: readonly string[];
}

/** The folder of the templates, next to `src/` (or `dist/` when published). */
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/**
 * @summary The version of this package, which is the version of every WebKrnl package (fixed versions).
 * @returns {string} The version.
 * @internal
 */
function ownVersion(): string {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
    : '0.0.0';
}

/**
 * @summary Lists the files under a folder, recursively, as paths relative to it.
 * @param {string} root The folder.
 * @param {string} [prefix] The path so far.
 * @returns {Promise<string[]>} The files.
 * @internal
 */
async function list(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await list(root, path)));
    else out.push(path);
  }
  return out;
}

/**
 * @summary Writes a new WebKrnl app from a template.
 *
 * @description
 * The folder must not exist, or must be empty. The name must be a valid npm
 * package name (lower case). After it, run `npm install` (or `pnpm install`
 * with `local`, which uses `link:`) in the folder.
 *
 * @example
 * Example 1: A Vue app
 * ```ts
 * const result = await scaffold({ directory: 'shop', template: 'vue' });
 * console.log(result.files.length);
 * ```
 *
 * @example
 * Example 2: Against this monorepo (the M10 gate)
 * ```ts
 * await scaffold({ directory: tmp, template: 'vanilla', local: process.cwd() });
 * ```
 *
 * @param {ScaffoldOptions} options The folder, the template, the name, and the source of the packages.
 * @returns {Promise<ScaffoldResult>} What was written.
 * @throws {Error} When the folder is not empty, the template is unknown, or the name is not valid.
 *
 * @public
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const template = options.template ?? 'vue';
  if (!TEMPLATES.includes(template)) {
    throw new Error(`Unknown template "${template}". Use one of: ${TEMPLATES.join(', ')}.`);
  }
  const directory = resolve(options.directory);
  const name = options.name ?? basename(directory);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(
      `"${name}" is not a valid package name: use lower case, digits, ".", "_" and "-".`,
    );
  }
  if (existsSync(directory) && (await readdir(directory)).length > 0) {
    throw new Error(`The folder ${directory} is not empty.`);
  }
  const version = options.version ?? ownVersion();
  const local = options.local ? resolve(options.local).replaceAll('\\', '/') : null;
  if (local && !existsSync(join(local, 'packages', 'platform', 'package.json'))) {
    throw new Error(`${local} is not a checkout of the WebKrnl monorepo (no packages/platform).`);
  }
  const replace = (text: string) =>
    text
      .replaceAll('{{name}}', name)
      .replaceAll('{{template}}', template)
      .replaceAll('{{version}}', version)
      .replace(/\{\{dep:([a-z-]+)\}\}/g, (_match, pkg: string) =>
        local ? `link:${local}/packages/${pkg}` : `^${version}`,
      )
      .replaceAll(' /* {{localAllow}} */', local ? `, ${JSON.stringify(local)}` : '');

  const written: string[] = [];
  for (const source of ['shared', template]) {
    const root = join(TEMPLATES_DIR, source);
    for (const file of await list(root)) {
      const target = file.replace(/(^|\/)_gitignore$/, '$1.gitignore');
      const destination = join(directory, target);
      await mkdir(join(destination, '..'), { recursive: true });
      const content = await readFile(join(root, file));
      const binary = content.includes(0);
      await writeFile(destination, binary ? content : replace(content.toString('utf8')));
      if (!written.includes(target)) written.push(target);
    }
  }
  return { directory, name, template, files: written.sort() };
}

/**
 * @summary The help of the command.
 * @public
 */
export const HELP: string = `Create a WebKrnl app.

Usage: npm init @webkrnl <folder> [--template vue|vanilla] [--name <name>] [--local <path>]

  --template  vue (Vue 3, vue-router, @webkrnl/vue) or vanilla (TypeScript only). Default: vue.
  --name      the package name of the app. Default: the name of the folder.
  --local     a local checkout of the WebKrnl monorepo: link its packages instead of the registry.
  --help      this text.`;

/**
 * @summary Reads the arguments of the command.
 *
 * @example
 * Example 1: A folder and a template
 * ```ts
 * parseArguments(['shop', '--template', 'vanilla']); // { directory: 'shop', template: 'vanilla' }
 * ```
 *
 * @example
 * Example 2: Help
 * ```ts
 * parseArguments(['--help']); // { help: true }
 * ```
 *
 * @param {readonly string[]} argv The arguments, without `node` and the script.
 * @returns {ScaffoldOptions | { help: true }} The options, or a request for help.
 * @throws {Error} For an unknown option, an option without its value, or no folder.
 *
 * @public
 */
export function parseArguments(argv: readonly string[]): ScaffoldOptions | { help: true } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === '--help' || argument === '-h') return { help: true };
    const match = /^--(template|name|local)(?:=(.*))?$/.exec(argument);
    if (match) {
      const value = match[2] ?? argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`--${match[1]} needs a value.`);
      values[match[1]!] = value;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option ${argument}.`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) throw new Error('Give one folder for the new app.');
  return {
    directory: positional[0]!,
    ...(values.template ? { template: values.template as Template } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values.local ? { local: values.local } : {}),
  };
}

/**
 * @summary Says what to do after a scaffold.
 *
 * @example
 * Printing it
 * ```ts
 * console.log(nextSteps(await scaffold(options), process.cwd(), false));
 * ```
 *
 * @param {ScaffoldResult} result What was written.
 * @param {string} cwd The folder of the command.
 * @param {boolean} local `true` when the app links a local checkout (then use pnpm).
 * @returns {string} The text.
 *
 * @public
 */
export function nextSteps(result: ScaffoldResult, cwd: string, local: boolean): string {
  const folder = relative(cwd, result.directory) || '.';
  const install = local ? 'pnpm install' : 'npm install';
  const run = local ? 'pnpm' : 'npm run';
  return `Created ${result.name} (${result.template}, ${result.files.length} files) in ${folder}.

  cd ${folder}
  ${install}
  ${run} dev`;
}
