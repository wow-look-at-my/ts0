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
| `ts0 run [file]` | Build, then run the entry point (or a specific file)   |
| `ts0 test [pat]` | Run tests via Node's built-in test runner              |

### Flags

- `--watch`, `-w` &mdash; watch mode (`build`, `test`)
- `--no-build` &mdash; skip the build step and run sources directly via `--experimental-strip-types` (`run`)
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
| `entry`     | `string`              | auto-detected      | Entry point relative to the config file. A `.ts` file (single bundle), a `.html` file (inlined HTML), or a **directory** (the [js library target](#js-library-target)) |
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

### js (library) target

If `entry` is a **directory**, `ts0 build` switches to the "js" library target:
every `*.ts`/`*.tsx` file under that directory is compiled to a parallel `*.js`
file under `outdir`, preserving the directory structure
(`src/webgpu/sky.ts` → `dist/webgpu/sky.js`). This is the shape a library
deployed to static hosting (GitHub Pages, a CDN) wants — consumers import an
individual module by URL.

```json
{
    "entry": "src",
    "target": "browser",
    "format": "esm",
    "sourcemap": false,
    "esbuild": { "loader": { ".wgsl": "text" } }
}
```

- Each file is its own esbuild entry point. Code shared across entries is
    **deduplicated into a chunk** (for `esm` output) and imported — never copied
    into each output. A consumer still writes a single import; the browser
    fetches any shared chunk transitively. Loader-backed imports (e.g. `import
    src from "./shader.wgsl"` with the `loader` escape hatch above) and
    non-shared local imports stay inlined in the importing module. Pass
    `"esbuild": { "splitting": false }` to force fully self-contained outputs
    (with duplication) instead.
- Declaration files (`*.d.ts`) and tests (`*.test.*`, `*.spec.*`) are skipped.
- Type-checking uses **bundler** module resolution (matching esbuild), so
    extensionless relative imports and loader-backed imports type-check without
    forcing `.ts` extensions on library source. Add an ambient declaration
    (e.g. `declare module "*.wgsl" { const s: string; export default s; }`) so
    loader imports type-check.
- `ts0 run` does not apply to this target (there is no single entry to run);
    use `ts0 build`. The single-file `outfile` option is likewise ignored —
    output always goes to `outdir`.

See `samples/js` for a complete example.

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

- **Build:** `ts0 build` runs `tsc --noEmit` against a tsconfig generated from your
    `ts0.json`, then bundles with esbuild.
- **Run:** with `--no-build`, `ts0 run` shells out to `node --experimental-strip-types`
    to execute TypeScript directly &mdash; no build step in the dev loop.
- **Test:** test files are discovered via the configured glob and handed to
    `node --test --experimental-strip-types`.

## License

MIT
