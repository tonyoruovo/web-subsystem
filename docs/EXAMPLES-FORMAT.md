# The `EXAMPLES.md` format

Each source directory of a package has an `EXAMPLES.md` file. The file holds runnable, real-world examples for the doc pages of that directory. A doc compiler reads the files and makes one code sandbox for each example.

This document is the contract between the authors of the examples and the doc compiler. `pnpm check:examples` checks every file against it.

## Where the files are

| Directory | Doc page | Import path in the examples |
|---|---|---|
| `packages/core/src` | `@platform/core` | `@platform/core`, `@platform/core/worker` |
| `packages/core/src/testing` | `@platform/core/testing` | `@platform/core/testing` |
| `packages/<name>/src` | `@platform/<name>` | `@platform/<name>` |

Test directories (`test/`) have no `EXAMPLES.md`. They are not published and have no doc page.

## Structure of a file

````markdown
# Examples: `@platform/core`

One paragraph about the module.

## Boot two subsystems

<!-- example id="core/boot-two-subsystems" runtime="any" -->

One to three sentences: the real-world problem, and what the example shows.

```ts file=main.ts
import { Kernel, defineSubsystem } from '@platform/core';
// ...
console.log(count);
```

```text output
1
```
````

1. The file starts with one `#` heading.
2. Each example starts with a `##` heading, its title.
3. The line after the heading (after one blank line) is the example marker: an HTML comment that starts with `example`.
4. Then come the description, the code blocks and the output block, in this order.
5. An example ends at the next `##` heading or at the end of the file.

## The marker

```html
<!-- example id="core/boot-two-subsystems" runtime="any" -->
```

| Attribute | Required | Values |
|---|---|---|
| `id` | yes | Unique in the repository. Use `<package>/<name>` in kebab case. The compiler uses it for the sandbox URL. |
| `runtime` | yes | `any`: runs in Node and in a browser. `browser`: needs the DOM or other browser APIs. `none`: the compiler shows the code but does not run it (for example, it needs several origins or a server). |

## Code blocks

- The info string is `ts file=<name>`. The name is a path relative to the root of the sandbox.
- Each example has exactly one `main.ts`. It is the entry point.
- An example can have more files, for example `processor.ts`. `main.ts` imports them with relative paths.
- Code imports only `@platform/*` packages, files of the same example, and the standard globals of the runtime. It has no other dependencies.
- Code shows results with `console.log`. It does not use test frameworks.
- `console.log` gets only strings, numbers and booleans. Use `JSON.stringify` for an object or an array. Node and the browser console format objects differently, so the output of an object is not the same in every sandbox.
- Code is complete: it type-checks with the settings of the repository and ends by itself.

## The output block

- The info string is `text output`.
- It holds the expected console output of `main.ts`, one `console.log` call for each line.
- It is required for `runtime="any"` and `runtime="browser"`. The checker compares it with the real output.
- The output must be deterministic. Do not print random ids or the current time. Use the `ids` and `now` options to fix them.

## What the doc compiler must do

1. Read each `EXAMPLES.md` under `packages/*/src`.
2. For each example, make a sandbox with its files and with the `@platform/*` packages that it imports.
3. Run `main.ts`. Use a Node sandbox or a browser sandbox for `runtime="any"`, and a browser sandbox for `runtime="browser"`. Do not run `runtime="none"`.
4. Show the title, the description, the code and the output block on the doc page of the directory.

## What the authors must do

1. Write the description in ASD-STE100 Simplified Technical English.
2. Keep the detail low to medium: one real-world task for each example, in 15 to 60 lines of code.
3. Run `pnpm check:examples` before you commit. It type-checks every example, runs the `any` examples in Node and in Chrome, runs the `browser` examples in Chrome, and compares each output with the output block.
