/// <reference types="node" />
/**
 * @fileoverview
 * @summary Checks every `EXAMPLES.md`: the format, the types, and the real output of each example.
 * @description
 * Implements the checks of docs/EXAMPLES-FORMAT.md. The doc compiler turns
 * these examples into code sandboxes, so each one must be correct, complete
 * and deterministic.
 *
 * ```text
 *   packages/<name>/src/**\/EXAMPLES.md
 *     --> parse: headings, markers, code blocks, output blocks   (format errors)
 *     --> write each example to .examples/<id>/
 *     --> tsc on all examples, with @platform/* mapped to the sources
 *     --> rolldown bundle of each main.ts
 *     --> run: runtime "any" in Node and in Chrome, "browser" in Chrome, "none" not run
 *     --> compare the console output with the output block
 *   ```
 *
 * Run it with `pnpm check:examples`. Add `--only=<id prefix>` to check some
 * examples, for example `--only=core/`. It exits with code 1 on any problem.
 *
 * @example
 * Check the examples of one package
 * ```ts
 * // pnpm check:examples --only=queue/
 * // ok   queue/retry-and-dead-letters (any)
 * // 1 example(s) checked, 0 problem(s).
 * ```
 *
 * @author MathAid
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

import { launchOptionsFor, selectInstallations } from '../playwright.config.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(root, '.examples');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '';

/** @summary One example, as parsed from a file. */
interface Example {
  readonly id: string;
  readonly title: string;
  readonly runtime: 'any' | 'browser' | 'none';
  readonly source: string;
  readonly line: number;
  readonly files: Map<string, string>;
  readonly output: string | null;
}

const problems: string[] = [];
const problem = (where: string, message: string) => problems.push(`${where}: ${message}`);

/** @summary Every `EXAMPLES.md` under the `src` directory of a package. */
function exampleFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'EXAMPLES.md') found.push(path);
    }
  };
  for (const name of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', name, 'src');
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
      walk(src);
      if (!only && !statSync(join(src, 'EXAMPLES.md'), { throwIfNoEntry: false })) {
        problem(relative(root, src), 'no EXAMPLES.md');
      }
    }
  }
  return found;
}

/** @summary Parses one `EXAMPLES.md` (docs/EXAMPLES-FORMAT.md). */
function parse(file: string): Example[] {
  const source = relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (!lines[0]?.startsWith('# ')) problem(source, 'the file must start with a "# " heading');
  const examples: Example[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) {
      i++;
      continue;
    }
    const title = lines[i].slice(3).trim();
    const headingLine = i + 1;
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const marker = /^<!-- example (.*) -->$/.exec(lines[i] ?? '');
    if (!marker) {
      problem(`${source}:${headingLine}`, `"${title}" has no example marker after its heading`);
      continue;
    }
    const attributes = Object.fromEntries(
      [...marker[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    const files = new Map<string, string>();
    let output: string | null = null;
    i++;
    while (i < lines.length && !lines[i].startsWith('## ')) {
      const fence = /^```(\S*)\s*(.*)$/.exec(lines[i]);
      if (!fence || fence[1] === '') {
        i++;
        continue;
      }
      const [, language, info] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== '```') body.push(lines[i++]);
      i++;
      const name = /file=(\S+)/.exec(info)?.[1];
      if (language === 'text' && info.trim() === 'output') output = body.join('\n');
      else if (name) files.set(name, body.join('\n') + '\n');
    }
    const id = attributes.id ?? '';
    const runtime = attributes.runtime as Example['runtime'];
    const where = `${source}:${headingLine} (${id || title})`;
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) problem(where, 'id must be "<package>/<kebab-name>"');
    if (!['any', 'browser', 'none'].includes(runtime))
      problem(where, 'runtime must be any, browser or none');
    if (!files.has('main.ts')) problem(where, 'no "ts file=main.ts" block');
    if (runtime !== 'none' && output === null) problem(where, 'no "text output" block');
    examples.push({ id, title, runtime, source, line: headingLine, files, output });
  }
  return examples;
}

/** @summary The `@platform/*` import paths, mapped to the package sources. */
function aliases(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of readdirSync(join(root, 'packages'))) {
    const pkg = join(root, 'packages', name, 'package.json');
    if (!statSync(pkg, { throwIfNoEntry: false })) continue;
    const json = JSON.parse(readFileSync(pkg, 'utf8')) as {
      name: string;
      exports?: Record<string, string>;
    };
    for (const [key, target] of Object.entries(json.exports ?? {})) {
      map[key === '.' ? json.name : `${json.name}/${key.slice(2)}`] = join(
        root,
        'packages',
        name,
        target,
      );
    }
  }
  return map;
}

const examples = exampleFiles()
  .flatMap(parse)
  .filter((e) => e.id.startsWith(only));
const seen = new Set<string>();
for (const example of examples) {
  if (seen.has(example.id))
    problem(`${example.source}:${example.line}`, `duplicate id ${example.id}`);
  seen.add(example.id);
}

// Write the examples, then type-check them all in one run.
rmSync(work, { recursive: true, force: true });
const map = aliases();
for (const example of examples) {
  for (const [name, code] of example.files) {
    const path = join(work, example.id, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);
  }
}
writeFileSync(
  join(work, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: '../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        rootDir: '..',
        paths: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [v]])),
      },
      include: ['./**/*.ts'],
    },
    null,
    2,
  ),
);
if (examples.length > 0) {
  const tsc = spawnSync(`pnpm exec tsc -p "${join(work, 'tsconfig.json')}"`, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  });
  for (const line of `${tsc.stdout}${tsc.stderr}`.split('\n').filter((l) => /error TS/.test(l))) {
    problems.push(`type error: ${line.trim().replace(/^\.examples[\\/]/, '')}`);
  }
}

/** @summary Bundles one example's `main.ts` into one ES module. */
async function bundle(example: Example): Promise<string> {
  const build = await rolldown({
    input: join(work, example.id, 'main.ts'),
    platform: example.runtime === 'browser' ? 'browser' : 'neutral',
    resolve: { alias: map },
    logLevel: 'silent',
  });
  const { output } = await build.generate({ format: 'esm' });
  return output[0].code;
}

const normalize = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

const compare = (example: Example, actual: string, runtime: string) => {
  const where = `${example.source}:${example.line} (${example.id}, ${runtime})`;
  if (normalize(actual) !== normalize(example.output ?? '')) {
    problem(where, `output differs.\n--- expected\n${example.output}\n--- actual\n${actual}`);
    return false;
  }
  return true;
};

/** @summary Runs a bundle in Node and returns its standard output, or `null` after a failure. */
function runInNode(example: Example, code: string): string | null {
  const file = join(work, example.id, 'bundle.mjs');
  writeFileSync(file, code);
  try {
    return execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    problem(
      `${example.source}:${example.line} (${example.id}, node)`,
      `run failed:\n${failure.stdout ?? ''}${failure.stderr ?? String(error)}`,
    );
    return null;
  }
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

/** @summary Runs a bundle in a Chrome page and returns its `console.log` lines, or `null` after a failure. */
async function runInBrowser(example: Example, code: string): Promise<string | null> {
  if (!browser) {
    const installation = selectInstallations().find((i) => i.engine === 'chromium');
    if (!installation) throw new Error('No Chromium-based browser is installed.');
    browser = await chromium.launch(launchOptionsFor(installation));
  }
  const page = await browser.newPage();
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'log') logs.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://examples.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><body><script type="module">${code.replace(/<\/script/gi, '<\\/script')}\nwindow.__done = true;</script></body>`,
    }),
  );
  await page.goto('https://examples.test/');
  try {
    await page.waitForFunction(
      () => (window as unknown as { __done?: boolean }).__done === true,
      null,
      {
        timeout: 30_000,
      },
    );
  } catch {
    errors.push('did not finish in 30 seconds');
  }
  await page.close();
  if (errors.length > 0) {
    problem(
      `${example.source}:${example.line} (${example.id}, browser)`,
      `run failed: ${errors.join('; ')}`,
    );
    return null;
  }
  return logs.join('\n');
}

for (const example of examples) {
  if (example.runtime === 'none') {
    console.log(`ok   ${example.id} (not run)`);
    continue;
  }
  let code: string;
  try {
    code = await bundle(example);
  } catch (error) {
    problem(`${example.source}:${example.line} (${example.id})`, `bundle failed: ${String(error)}`);
    continue;
  }
  // An "any" example must print the same lines in Node and in a browser.
  let ok = true;
  if (example.runtime === 'any') {
    const node = runInNode(example, code);
    ok = node !== null && compare(example, node, 'node');
  }
  const page = await runInBrowser(example, code);
  ok = page !== null && compare(example, page, 'browser') && ok;
  if (ok)
    console.log(`ok   ${example.id} (${example.runtime === 'any' ? 'node + browser' : 'browser'})`);
}
await browser?.close();

for (const line of problems) console.log(`FAIL ${line}`);
console.log(`${examples.length} example(s) checked, ${problems.length} problem(s).`);
process.exit(problems.length > 0 ? 1 : 0);
