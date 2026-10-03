# packages

One folder per published package (`@platform/<name>`). See
[`docs/ARCHITECTURE.md` §14](../docs/ARCHITECTURE.md) for the layout and
[`docs/PLAN.md`](../docs/PLAN.md) for the milestone that creates each one.

Each package has a `README.md`. Each source directory (`src/` and its subdirectories) has an `EXAMPLES.md` with runnable examples for the doc pages. [`docs/EXAMPLES-FORMAT.md`](../docs/EXAMPLES-FORMAT.md) defines the format, and `pnpm check:examples` runs every example in Node and in Chrome.
