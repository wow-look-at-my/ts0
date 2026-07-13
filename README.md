# ts0

A simple TypeScript framework with good defaults. One CLI, one config file, no boilerplate.

`ts0` wraps [esbuild](https://esbuild.github.io/), the TypeScript compiler, and Node's
built-in test runner so you can `init`, `build`, `run`, and `test` a TypeScript project
without writing a `tsconfig.json`, picking a bundler, or wiring up a test framework.

## Requirements

- Node.js **22 or newer** (uses `--experimental-strip-types` and the built-in test runner)
- &hellip;or **no Node at all** when using a [prebuilt binary](#prebuilt-binaries-buildhost),
    which embeds the runtime.

## Install

```sh
npm install -g ts0
```

### Prebuilt binaries (buildhost)

For machines with **nothing installed** &mdash; no Node, no npm &mdash; ts0 ships as a
fully self-contained single executable on the org buildhost. The binary embeds the
Node 22 runtime, the bundled CLI, the TypeScript compiler, and esbuild (including its
platform-native binary):

```sh
curl -fL "https://dl.pazer.build/ts0?branch=master&os=linux&arch=amd64" -o ts0
chmod +x ts0
./ts0 build
```

| Platform | URL parameters |
| -------- | -------------- |
| Linux x86-64 | `os=linux&arch=amd64` |
| Linux ARM64 | `os=linux&arch=arm64` |
| macOS Apple Silicon | `os=darwin&arch=arm64` |
| macOS Intel | `os=darwin&arch=amd64` |
| Windows x86-64 | `os=windows&arch=amd64` (an `.exe`; save it as `ts0.exe`) |

**Version pinning.** `?branch=master` resolves to the latest build of master and moves
on every merge; `?v=N` (e.g. `?v=1`) is an immutable release and never changes.
**Pin `?v=N` in anything that needs reproducible output** (a `//go:generate` step, a
Dockerfile); use `?branch=master` only where tracking latest is the point. To find the
current N, read the `Location` header of a branch download (it redirects to
`...&v=N&...`) or `GET https://pazer.build/api/v1/projects/ts0/releases`. Downloads
are anonymous (the project is public); add `&fmt=tar.gz` (or `zip`, ...) to download
repackaged instead of raw.

**First-run extraction.** On first use the binary extracts its embedded toolchain
(tsc, esbuild, the runtime template) to `~/.cache/ts0/<build-id>/` &mdash; override the
location with `TS0_CACHE_DIR`. Later runs reuse the extraction; the build id changes
with every release, so upgrades never collide and no cleanup is needed beyond deleting
the directory.

**Scope.** The binary bundles the *toolchain*, not your project's dependencies: a
project that imports npm packages &mdash; including `@types/node` for Node-target
globals &mdash; still needs its own `node_modules` (installed however you like).
Browser-target and dependency-free projects build with the binary alone. The macOS
binaries are ad-hoc code-signed; Gatekeeper treats a `curl`-downloaded binary like any
other terminal tool.

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
| `loaders`   | `object`              | &mdash;            | Map file extensions to loader names (`text`, `dataurl`, `base64`, `binary`, `file`, `json`, …), e.g. `{ ".wgsl": "text" }`. The friendly way to import non-JS/TS files; applies to the default and js targets. |
| `declarations` | `boolean`          | `true`             | js (library) target only: emit a parallel `*.d.ts` tree into `outdir` alongside the compiled `*.js` (see [Type declarations](#type-declarations)). Set `false` to skip. Ignored by the single-entry and HTML targets. |
| `esbuild`   | `object`              | &mdash;            | Raw escape hatch &mdash; merged into the esbuild options last (overrides `loaders`) |

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

### js (library) target

If `entry` is a **directory**, `ts0 build` switches to the "js" library target:
every `*.ts`/`*.tsx` file under that directory is compiled to a parallel `*.js`
file under `outdir`, preserving the directory structure
(`src/webgpu/sky.ts` → `dist/webgpu/sky.js`). This is the shape a library
deployed to static hosting (GitHub Pages, a CDN) wants — consumers import an
individual module by URL. Each module also gets a matching `*.d.ts` by default
(see [Type declarations](#type-declarations) below), so those consumers can
fetch type declarations from the same URLs as the code.

```json
{
    "entry": "src",
    "target": "browser",
    "sourcemap": false,
    "loaders": { ".wgsl": "text" }
}
```

- Each file is its own esbuild entry point. Code shared across entries is
    **deduplicated into a chunk** (for `esm` output) and imported — never copied
    into each output. A consumer still writes a single import; the browser
    fetches any shared chunk transitively. Loader-backed imports (e.g. `import
    src from "./shader.wgsl"`, enabled by the `loaders` field above) and
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

#### Type declarations

By default the js target also emits TypeScript declarations: every compiled
module gets a parallel `*.d.ts` under `outdir`, mirroring the source tree
exactly like the `*.js` outputs (`src/ui/timeline-view.ts` →
`dist/ui/timeline-view.js` **and** `dist/ui/timeline-view.d.ts`). A library
deployed to static hosting thus ships its types at the same URLs as its code —
a consumer fetches `x.js` for the runtime and `x.d.ts` next to it for the
types, and TypeScript pairs them up automatically.

- **Default on.** A library target exists to be consumed; set
    `"declarations": false` in `ts0.json` to opt out.
- Emission is a separate `tsc` pass (`declaration` + `emitDeclarationOnly`)
    over exactly the modules the build compiled, so tests, `*.d.ts` sources,
    and esbuild's shared `chunk-*.js` files never get declarations. It runs
    only on `ts0 build` (and each watch rebuild) — `ts0 run`/`ts0 test` never
    write output.
- The pass is **all-or-nothing**: any error (a type error never gets this far;
    think declaration-only diagnostics like TS4023 "cannot be named") fails
    the build and writes no `.d.ts` at all — there is no partial tree. Output
    is deterministic: the same input produces byte-identical `.d.ts`, so
    committed copies of fetched declarations diff cleanly.
- Relative import specifiers are kept as written, including explicit `.ts` /
    `.tsx` extensions. That is the standard declaration shape for
    `allowImportingTsExtensions` projects: TypeScript resolves `./x.ts` inside
    a `.d.ts` by extension substitution (`.ts` → `.tsx` → `.d.ts`) to the
    deployed sibling `x.d.ts`, under both `bundler` and `NodeNext` consumer
    resolution. No rewriting is needed (and TypeScript's
    `rewriteRelativeImportExtensions` wouldn't help — it only affects
    JavaScript emit).
- One structural constraint: declaration output mirrors the entry directory,
    so a module importing a **source outside the entry directory** fails the
    build with `TS6059` (esbuild can inline such an import into the `.js`, but
    a mirrored `.d.ts` tree cannot represent it). Move the file under the
    entry directory or set `"declarations": false`.

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

- **Type-checking is mandatory &mdash; there is no way to build, run, or test
    un-checked code.** `ts0` type-checks before it emits *or executes* anything.
    `build`, `run`, and `test` all check first &mdash; for every entry kind
    (`.ts`, `.html`, and the directory/js library target) &mdash; and produce/run
    nothing if the check fails. Even
    `ts0 run --no-build`, which skips the bundle and writes no artifact,
    type-checks first: Node's `--experimental-strip-types` only strips annotations
    (it does not type-check), so ts0 runs `tsc` itself before handing sources to
    Node. There is no escape hatch. In every `--watch` mode (`build` *and* `test`)
    each cycle re-checks, so introducing a type error stops the run/rebuild and
    leaves the previous good output in place instead of running something broken.
- **Build:** `ts0 build` runs `tsc --noEmit` against a tsconfig generated from your
    `ts0.json` (the DOM libs for browser/HTML entries, ESNext for Node), then
    bundles with esbuild. A pure-JS project with no TypeScript sources has nothing
    to check and builds straight through.
- **Run:** `ts0 run` builds (type-check + bundle) then runs the output with Node.
    With `--no-build` it type-checks, then skips the bundle and executes the
    sources directly via `node --experimental-strip-types` &mdash; the fast dev
    loop, minus the artifact, but never minus the type-check.
- **Test:** `ts0 test` type-checks the whole project, then (only if it passes)
    runs the discovered test files via `node --test --experimental-strip-types`. A
    type error anywhere fails the command and no tests run. `ts0 test --watch`
    re-type-checks and re-runs on every change (ts0 drives the watch loop itself
    rather than `node --test --watch`, so the check is never skipped).

## License

MIT
