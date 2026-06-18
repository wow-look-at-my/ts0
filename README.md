# ts0

A simple TypeScript framework with good defaults. One CLI, one config file, no boilerplate.

`ts0` wraps [esbuild](https://esbuild.github.io/), the TypeScript compiler, and Node's
built-in test runner so you can `init`, `build`, `run`, and `test` a TypeScript project
without writing a `tsconfig.json`, picking a bundler, or wiring up a test framework.

## Requirements

- Node.js **22 or newer** (uses `--experimental-strip-types` and the built-in test runner)

## Install

```sh
npm install -g ts0
```

## Quick start

```sh
mkdir my-app && cd my-app
ts0 init      # creates ts0.json, src/main.ts, src/main.test.ts, package.json
ts0 run       # build + run your app
ts0 test      # run tests
ts0 build     # produce a bundled output
```

## Commands

| Command          | What it does                                           |
| ---------------- | ------------------------------------------------------ |
| `ts0 init`       | Create `ts0.json` and starter files in the cwd         |
| `ts0 build`      | Type-check with `tsc --noEmit`, then bundle via esbuild|
| `ts0 run [file]` | Type-check, build, then run the entry point (or a specific file) |
| `ts0 test [pat]` | Run tests via Node's built-in test runner              |

### Flags

- `--watch`, `-w` &mdash; watch mode (`build`, `test`)
- `--no-build` &mdash; skip the bundle step and run sources directly via `--experimental-strip-types`; still type-checked first (`run`)
- `--entry <path>` &mdash; override the configured entry for this `build` invocation
- `--outfile <path>` &mdash; override `outfile`; produces a single file at this path (`build`)
- `--outdir <path>` &mdash; override `outdir` (`build`)
- `--force` &mdash; overwrite existing files (`init`)
- `--help`, `-h` &mdash; show help

### Examples

```sh
ts0 run                    # build and run the entry point
ts0 run src/app.ts         # run a specific file
ts0 run --no-build         # skip the bundle, run TS directly (fast dev loop)
ts0 test --watch           # watch mode tests
ts0 build --watch          # rebuild on change
```

## Configuration

`ts0` reads `ts0.json` from the current directory (or any ancestor). Every field is
optional &mdash; if there is no config file, `ts0` falls back to sensible defaults and
auto-detects an entry point from `src/main.ts`, `src/index.ts`, `main.ts`, `index.ts`,
`index.html`, or `src/index.html`.

```json
{
    "entry": "src/main.ts",
    "outfile": "dist/my-app",
    "target": "node",
    "format": "esm",
    "strict": true,
    "minify": false,
    "sourcemap": true,
    "test": {
        "pattern": "**/*.test.ts"
    }
}
```

| Field       | Type                  | Default            | Notes                                                         |
| ----------- | --------------------- | ------------------ | ------------------------------------------------------------- |
| `entry`     | `string`              | auto-detected      | Entry point relative to the config file. May be `.ts` or `.html` |
| `outfile`   | `string`              | &mdash;            | Single-file output. Adds a `#!/usr/bin/env node` shebang for JS |
| `outdir`    | `string`              | `"dist"`           | Used when `outfile` is not set                                |
| `target`    | `"node" \| "browser"` | `"node"`           | esbuild platform (ignored for HTML entries &mdash; always browser) |
| `format`    | `"esm" \| "cjs"`      | `"esm"`            | Output module format                                          |
| `strict`    | `boolean`             | `true`             | Toggles TypeScript `strict` mode for the type-check step      |
| `minify`    | `boolean`             | `false`            | Minify the bundle                                             |
| `sourcemap` | `boolean`             | `true`             | Emit a sourcemap (inlined for HTML entries)                   |
| `test.pattern` | `string`           | `"**/*.test.ts"`   | Glob for test files                                           |
| `embedAssets` | `boolean`           | `true`             | HTML entries: embed runtime-fetched assets (see below). Set `false` to skip. |
| `assetDirs` | `string[]`            | &mdash;            | HTML entries: directories to scan for embeddable assets (relative to config file). When set, only these dirs are scanned instead of the entry's directory. |
| `jsx`       | `"automatic" \| "transform" \| "preserve"` | &mdash; | Enable JSX/TSX. `"automatic"` uses the modern runtime (no factory import; pair with `jsxImportSource`); `"transform"` is the classic `React.createElement`; `"preserve"` leaves JSX as-is. |
| `jsxImportSource` | `string`        | &mdash;            | Module the automatic runtime imports from, e.g. `"preact"` or `"react"`. Only used when `jsx` is `"automatic"`. |
| `esbuild`   | `object`              | &mdash;            | Escape hatch &mdash; merged into the esbuild options last     |

When `outfile` is set, `ts0` produces a single executable file with a Node shebang &mdash;
useful for shipping a CLI as one file. When only `outdir` is set, output goes there
preserving the entry's basename.

For Node targets, `packages: "external"` is set automatically so `node_modules` are not
bundled into the output.

### HTML entries

If `entry` ends with `.html`, `ts0 build` produces a single self-contained HTML file
that runs from disk (`file://`) with no asset tree alongside it. Specifically:

- Every `<script src="local">` is bundled with esbuild and inlined as `<script>…</script>`.
- Every `<script type="module">…inline code…</script>` block is bundled with esbuild
    (relative imports resolve against the HTML's directory).
- Every `<link rel="stylesheet" href="local">` is bundled and inlined as `<style>…</style>`.
    `url(./fonts/x.woff2)` and `url(./img/y.png)` references inside the bundled CSS are
    rewritten to `data:` URLs.
- Every fetchable asset (shaders, `.hdr`, `.glb`, images, …) under the entry's
    directory is collected into a `window.fetch` interceptor inserted at the top of
    `<head>`, so code like `fetch(new URL("shaders/scene.wgsl", import.meta.url))`
    keeps resolving in the standalone bundle. Set `"embedAssets": false` to disable.
- External URLs (`https://`, `//`, `data:`) are left untouched.

The project's `.ts`/`.tsx` files are type-checked (with the DOM lib) before any
HTML is written, so a type error in an HTML project's scripts fails the build just
like it would for a Node entry.

```html
<!-- index.html -->
<link rel="stylesheet" href="./src/styles.css" />
<script type="module" src="./src/main.ts"></script>
<script type="module">
    import { ready } from "./src/init.ts"; // bundled via inline-module support
    ready();
</script>
```

```sh
ts0 build                                  # uses ts0.json
ts0 build --entry pages/foo/index.html \
        --outfile out/foo.html                       # one-off override, no config edit
```

`ts0 run` is for Node entries only; it errors out when the entry is HTML. Open the
produced HTML in a browser instead.

The text/binary asset extension lists are defined by `TEXT_ASSET_EXTS` and
`BINARY_ASSET_EXTS` at the top of `src/commands/build-html.ts`. `.json` is intentionally
excluded so `ts0.json`/`package.json` aren't picked up; runtime JSON should be loaded
via JS imports instead.

The fetch interceptor exposes `window.__ts0_embedded_paths__` &mdash; an array of all
embedded asset keys. Client code can use this to enumerate available assets at runtime
(e.g. to discover all `.xml` files in a data directory without a hardcoded manifest).

### JSX / TSX

Set `jsx` to compile `.tsx`/`.jsx`. The setting is threaded into both the type-checker
and esbuild &mdash; for **every** entry kind, including HTML entries whose `<script>`
tags pull in `.tsx`. A Preact app uses the automatic runtime:

```json
{
    "entry": "index.html",
    "jsx": "automatic",
    "jsxImportSource": "preact"
}
```

With `"automatic"`, JSX compiles to `preact/jsx-runtime` calls and needs no factory
import. Omitting `jsxImportSource` (or using `"transform"`) makes esbuild emit the
classic `React.createElement`, which throws `React is not defined` in a Preact bundle
&mdash; so always pair `"automatic"` with `jsxImportSource` for Preact/React. See
`samples/html-jsx` for a complete Preact-via-HTML example.

## How it works

- **Type-checking is mandatory &mdash; there is no way to build or run un-checked
    code.** `ts0` type-checks before it emits *or executes* anything. `ts0 build`
    and `ts0 run` both check first &mdash; for `.ts` *and* `.html` entries &mdash;
    and produce/run nothing if the check fails. Even `ts0 run --no-build`, which
    skips the bundle and writes no artifact, type-checks first: Node's
    `--experimental-strip-types` only strips annotations (it does not type-check),
    so ts0 runs `tsc` itself before handing the sources to Node. In `--watch` mode
    every rebuild re-checks, so introducing a type error leaves the previous good
    output in place instead of overwriting it with something broken.
- **Build:** `ts0 build` runs `tsc --noEmit` against a tsconfig generated from your
    `ts0.json` (the DOM libs for browser/HTML entries, ESNext for Node), then
    bundles with esbuild. A pure-JS project with no TypeScript sources has nothing
    to check and builds straight through.
- **Run:** `ts0 run` builds (type-check + bundle) then runs the output with Node.
    With `--no-build` it type-checks, then skips the bundle and executes the
    sources directly via `node --experimental-strip-types` &mdash; the fast dev
    loop, minus the artifact, but never minus the type-check.
- **Test:** test files are discovered via the configured glob and handed to
    `node --test --experimental-strip-types`. (Tests run your code rather than
    producing a shipped artifact, so `ts0 test` does not impose the type-check
    gate &mdash; run `ts0 build` for that.)

## License

MIT
