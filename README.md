# ts0

A simple TypeScript framework with good defaults. One CLI, one config file, no boilerplate.

`ts0` wraps [esbuild](https://esbuild.github.io/), the TypeScript compiler, and Node's
built-in test runner so you can `init`, `build`, `run`, and `test` a TypeScript project
without writing a `tsconfig.json`, picking a bundler, or wiring up a test framework.

## Requirements

- Node.js **22 or newer** &mdash; the only requirement. With a
    [prebuilt ts0.cjs](#prebuilt-tscjs-buildhost) you need nothing else: no npm,
    no node_modules, no git.

## Install

```sh
npm install -g ts0
```

### Prebuilt ts0.cjs (buildhost)

For machines with **stock Node and nothing else** &mdash; no npm, no node_modules,
no git &mdash; ts0 ships as a single platform-neutral JavaScript file on the org
buildhost, with the TypeScript compiler inlined. Two ways to run it:

```sh
# Pinned + cached (recommended for build wiring, e.g. a go:generate step):
curl -fL "https://dl.pazer.build/ts0?v=N&os=linux&arch=amd64" -o ts0.cjs
node ts0.cjs build

# Zero-file pipe form (re-downloads each run; fine on a fast/LAN link):
curl -fsSL "https://dl.pazer.build/ts0?branch=master&os=linux&arch=amd64" | node - build
```

`ts0.cjs` is the same bytes for every platform &mdash; buildhost addresses
artifacts by os/arch, so the URL parameters are required, but any supported pair
returns the identical file. Save it with a `.cjs` extension: the bundle is
CommonJS (that is what lets the pipe form run with no flags), and a `.js` file
would be mis-parsed as ESM if it lands inside a package that declares
`"type": "module"`.

**Version pinning.** `?branch=master` resolves to the latest build of master and
moves on every merge; `?v=N` (e.g. `?v=1`) is an immutable release and never
changes. **Pin `?v=N` in anything that needs reproducible output**; use
`?branch=master` only where tracking latest is the point. To find the current N,
read the `Location` header of a branch download (it redirects to `...&v=N&...`)
or `GET https://pazer.build/api/v1/projects/ts0/releases`. Downloads are
anonymous (the project is public).

**The one native piece: esbuild.** Everything else is inlined, but esbuild's
compiler is a platform-native binary. On first run, ts0.cjs downloads the
matching binary (~11 MB, published alongside each release at
`https://dl.pazer.build/ts0/esbuild-<version>?os=...&arch=...`, byte-identical
to the npm registry's `@esbuild` package) into
`TS0_CACHE_DIR` || `~/.cache/ts0/<build-id>/`, atomically and once; the inlined
TypeScript compiler is extracted to the same cache. Later runs touch nothing.
Prebuilt natives exist for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64,
and windows/amd64.

If the download target is unreachable, ts0 fails with a message naming the URL
and the destination path &mdash; there is no silent fallback. For firewalled or
air-gapped machines, set `TS0_ESBUILD_URL` to a mirror of the exact esbuild
version, or place the binary at the named destination yourself.

**Scope.** The file bundles the *toolchain*, not your project's dependencies: a
project that imports npm packages &mdash; including `@types/node` for
Node-target globals &mdash; still needs its own `node_modules` (installed
however you like). Browser-target and dependency-free projects build with
`ts0.cjs` alone.

### GitHub Actions

`wow-look-at-my/ts0@master` is a composite action: it downloads the newest
`ts0.cjs` from buildhost's master branch (never a pinned version to drift
behind &mdash; see "Version pinning" above) and runs `ts0 test` then `ts0 build`,
so a workflow doesn't have to hand-roll the download. It takes no arguments:

```yaml
- uses: wow-look-at-my/ts0@master
```

**There is no input for which command to run**, deliberately. `test`
type-checks the whole project and bans explicit `any` before running the tests
(and type-checks even when a project has none yet); `build` type-checks again
before it emits. Letting the workflow choose the command lets it choose
`--help` &mdash; exit 0, nothing checked, nothing tested, nothing built, and a
green check for it.

A project needing several build targets (e.g. a node-target helper script,
alongside a browser-target bundle) still needs only this one step: give each
target its own `ts0.json` and the single `build` recurses into all of them (see
"Nested projects" below).

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `working-directory` | No | `.` | Directory to run `ts0` from |

That is the whole input set. The action always downloads the newest ts0 on the
default branch: ts0 is a build tool, not a pinned dependency, so CI tracks
latest and there is nothing to choose.

Outputs `path`, the full path to the downloaded `ts0.cjs`.

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
| `ts0 build`      | Type-check with `tsc --noEmit`, then bundle via esbuild. Recurses into nested ts0 projects |
| `ts0 run [file]` | Type-check, build, then run the entry point (or a specific file) |
| `ts0 test [pat]` | Run tests via Node's built-in test runner. Recurses into nested ts0 projects |

### Flags

- `--watch`, `-w` &mdash; watch mode (`build`, `test`)
- `--no-build` &mdash; skip the bundle step and run sources directly via `--experimental-strip-types`; still type-checked first (`run`)
- `--config <path>` &mdash; use an explicit config file instead of the nearest `ts0.json` (`build`, `run`, `test`). The config's directory stays the project root, so a repo can keep several differently-configured builds side by side (`ts0 build --config ts0.tool.json && ts0 build --config ts0.site.json`)
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

### Output

Errors are red, warnings yellow, and a passing test's `ok` is green (a TTY, or
`FORCE_COLOR`/`NO_COLOR` to override; color is always on under
`GITHUB_ACTIONS=true`). Under GitHub Actions, a type-check/build error or a
failing test is also reported as an `::error::` log annotation.

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
| `format`    | `"esm" \| "cjs" \| "iife"` | `"esm"`       | Output module format. `"iife"` wraps the bundle in an immediately-invoked function (browser-script style); pair with `globalName` |
| `globalName` | `string`             | &mdash;            | With `format: "iife"`: global variable that receives the entry's exports (`var MyLib = (() => {…})()`) |
| `preserveHeader` | `boolean`        | `false`            | Single-entry target: re-prepend the entry file's leading comment block to the bundle, byte-exactly (see [Userscripts and headered bundles](#userscripts-and-headered-bundles)) |
| `exclude`   | `string[]`            | &mdash;            | Directories (relative to the config file) excluded from the type-check gate, e.g. a test tree checked by its own tsconfig. Does not change what gets built |
| `strict`    | `boolean`             | `true`             | Toggles TypeScript `strict` mode for the type-check step. Explicit `any` is rejected either way &mdash; that ban is not configurable |
| `minify`    | `boolean`             | `false`            | Minify the bundle                                             |
| `sourcemap` | `boolean`             | `true`             | Emit a sourcemap (inlined for HTML entries)                   |
| `test.pattern` | `string`           | `"**/*.test.ts"`   | Glob for test files                                           |
| `embedAssets` | `boolean`           | `true`             | HTML entries: embed runtime-fetched assets (see below). Set `false` to skip. |
| `assetDirs` | `string[]`            | &mdash;            | HTML entries: directories to scan for embeddable assets (relative to config file). When set, only these dirs are scanned instead of the entry's directory. |
| `inlineAssets` | `boolean`          | `true`             | HTML entries: inline every referenced script/stylesheet into the HTML. Set `false` to emit a multi-file static site instead (see [Referenced assets](#referenced-assets-multi-file-sites)). |
| `assetPath` | `string`              | `"assets"`         | HTML entries with `inlineAssets: false`: the URL prefix written into the HTML, and &mdash; minus a leading `/` or `./` &mdash; the subdirectory under the output dir. May not contain `..`. |
| `jsx`       | `"automatic" \| "transform" \| "preserve"` | &mdash; | Enable JSX/TSX. `"automatic"` uses the modern runtime (no factory import; pair with `jsxImportSource`); `"transform"` is the classic `React.createElement`; `"preserve"` leaves JSX as-is. |
| `jsxImportSource` | `string`        | &mdash;            | Module the automatic runtime imports from, e.g. `"preact"` or `"react"`. Only used when `jsx` is `"automatic"`. |
| `loaders`   | `object`              | &mdash;            | Map file extensions to loader names (`text`, `dataurl`, `base64`, `binary`, `file`, `json`, …), e.g. `{ ".wgsl": "text" }`. The friendly way to import non-JS/TS files; applies to the default and js targets. |
| `declarations` | `boolean`          | `true`             | js (library) target only: emit a parallel `*.d.ts` tree into `outdir` alongside the compiled `*.js` (see [Type declarations](#type-declarations)). Set `false` to skip. Ignored by the single-entry and HTML targets. |
| `external`  | `string[]`            | &mdash;            | Import specifiers that stay **external references** in the output instead of being bundled, e.g. `["*.css"]` or `["lit"]`. The import statement is emitted verbatim and the file's contents appear nowhere in the output (see [External imports](#external-imports)). Applies to the default and js targets. |
| `bundleShared` | `boolean`          | `true`             | js (library) target: may code shared by two or more outputs be factored into a shared chunk they import. Set `false` to make every emitted module fully self-contained (shared code is duplicated into each). |
| `esbuild`   | `object`              | &mdash;            | Raw escape hatch &mdash; merged into the esbuild options last (overrides `loaders`) |

When `outfile` is set with a Node target, `ts0` produces a single executable file
with a `#!/usr/bin/env node` shebang &mdash; useful for shipping a CLI as one file.
Browser-target outfiles get no shebang. When only `outdir` is set, output goes
there preserving the entry's basename.

For Node targets, `packages: "external"` is set automatically so `node_modules` are not
bundled into the output.

### Userscripts and headered bundles

Some artifacts carry a comment header that is semantically load-bearing in the
*output* file &mdash; a userscript's `==UserScript==` metadata block (parsed by
Tampermonkey/Greasemonkey from the installed file), or a license banner a
distributor requires at the top. esbuild strips comments while bundling;
`preserveHeader: true` re-prepends the **entry file's leading comment block**
(a run of consecutive `//` lines, or one `/* … */` block, starting at byte 0)
to the bundled output, byte-exactly. Combined with `format: "iife"` +
`globalName`, a multi-module userscript builds to one self-contained file:

```json
{
    "entry": "src/my-script.user.ts",
    "outfile": "dist/my-script.user.js",
    "target": "browser",
    "format": "iife",
    "globalName": "__MY_SCRIPT_API",
    "preserveHeader": true,
    "sourcemap": false
}
```

The header lands above the bundle's own first line; a leading `"use strict";`
in the bundle (emitted by esbuild when the project's `tsconfig.json` sets
`alwaysStrict`/`strict`) remains an effective directive &mdash; comments never
break the directive prologue. See `samples/userscript`.

### HTML entries

If `entry` ends with `.html`, `ts0 build` produces a single self-contained HTML file
that runs from disk (`file://`) with no asset tree alongside it &mdash; the default;
`"inlineAssets": false` emits a [multi-file site](#referenced-assets-multi-file-sites)
instead. Specifically:

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

#### Referenced assets (multi-file sites)

A single self-contained file is the wrong shape for an app served over HTTP: nothing
is independently cacheable, and a one-line HTML edit busts the whole JS bundle.
`"inlineAssets": false` emits a normal static site instead &mdash; each referenced
local script and stylesheet is bundled to its own file under `assetPath`, and the tag
keeps referencing it via `src=`/`href=`. Output names are the source's basename with
the bundled extension (`src/main.ts` &rarr; `main.js`), with no content hash: the
serving side owns cache headers and ETags.

```json
{
    "entry": "index.html",
    "outdir": "dist",
    "target": "browser",
    "inlineAssets": false,
    "assetPath": "/assets"
}
```

```
dist/
    index.html          <link href="/assets/app.css">, <script src="/assets/main.js">
    assets/
        main.js
        app.css
```

`assetPath` is used verbatim as the URL prefix, so `"/assets"` (absolute) is what a
single-page app wants &mdash; the same shell is served on deep links like `/c/abc123`,
where a relative URL would resolve against the wrong directory. `"assets"` and
`"./assets"` write the same files and emit relative URLs. Two sources with the same
basename (`a/main.ts` and `b/main.ts`) fail the build rather than overwriting each
other; if any reference fails, nothing is written at all. External URLs, inline
`<script>` bodies, bookmarklet hrefs and the fetch interceptor behave exactly as
they do in inline mode. See `samples/html-referenced`.

#### Bookmarklet links

An `href` of the form `javascript:<local source file>` is a **bookmarklet
link**: `ts0 build` bundles the referenced file (browser IIFE, always
minified &mdash; a bookmarklet is a URL, and length is the constraint) and
substitutes `javascript:` + the percent-encoded bundle into the href, so the
page ships a drag-to-bookmarks-bar link with no separate build step:

```html
<a href="javascript:./src/copy-title.ts">Copy Title</a>
```

Only hrefs ending in a bundleable source extension (`.ts`, `.tsx`, `.js`,
`.jsx`, `.mjs`, `.cjs`) are treated as file references &mdash; real inline
JavaScript hrefs (`javascript:void(0)`) are left untouched. A file-looking
reference that doesn't exist fails the build. See `samples/bookmarklet`.

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
    non-shared local imports stay inlined in the importing module. Set
    `"bundleShared": false` to force fully self-contained outputs (with
    duplication) instead — the right trade only when outputs are consumed in
    isolation, where fetching a sibling chunk isn't possible.
- Declaration files (`*.d.ts`) and tests (`*.test.*`, `*.spec.*`) are skipped.
- Type-checking uses **bundler** module resolution (matching esbuild), so
    extensionless relative imports and loader-backed imports type-check without
    forcing `.ts` extensions on library source. Add an ambient declaration
    (e.g. `declare module "*.wgsl" { const s: string; export default s; }`) so
    loader imports type-check.
- Test files are the exception: `ts0 test` hands them to Node, whose resolver
    takes the specifier literally, so give their imports a real `.ts`/`.tsx`
    extension even though the sources beside them need not.
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

### External imports

By default every import is resolved and bundled at build time. Some imports must
**not** be — they are meant to be resolved at runtime, by the browser or by the
consumer. `external` lists those specifiers: the `import` statement is emitted
verbatim and the imported file's contents appear nowhere in the output.

The motivating case is a CSS module script, where the browser constructs the
stylesheet itself:

```json
{
    "entry": "src/main.ts",
    "outfile": "dist/main.js",
    "target": "browser",
    "external": ["*.css"]
}
```

```ts
import styles from "./styles.css" with { type: "css" };

document.adoptedStyleSheets = [styles];
```

The bundle keeps that line exactly as written — import attributes included — and
ships no stylesheet text. Other uses: a peer dependency a library must not embed
(`["lit"]`), or anything supplied by an import map.

- **Matching is by specifier, not by file path.** Entries are compared against
    the specifier as written: `"./styles.css"` externalizes that relative
    import, `"lit"` externalizes the bare package, and `*` matches any run of
    characters, so `"*.css"` covers every CSS import in the project.
- **It is per-specifier, not a blanket opt-out.** Ordinary imports sitting next
    to an externalized one bundle exactly as before.
- **Types still apply.** An external import is type-checked like any other, so
    give it an ambient declaration:
    `declare module "*.css" { const sheet: CSSStyleSheet; export default sheet; }`.
- **It is not a way to silence an unsupported import.** An import ts0 cannot
    handle and that is *not* listed here still fails the build, loudly, with
    nothing written. That red build is the guardrail: it is what stops a
    stylesheet from being quietly inlined into your JavaScript.
- Applies to the single-entry target and the [js library target](#js-library-target).

See `samples/external-css` for a complete example.

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
    (`.ts`, `.html`, and the directory/js library target), wherever the entry
    lives, including under a dot-directory like `.github/scripts/` &mdash; and
    produce/run nothing if the check fails. Even
    `ts0 run --no-build`, which skips the bundle and writes no artifact,
    type-checks first: Node's `--experimental-strip-types` only strips annotations
    (it does not type-check), so ts0 runs `tsc` itself before handing sources to
    Node. There is no escape hatch. In every `--watch` mode (`build` *and* `test`)
    each cycle re-checks, so introducing a type error stops the run/rebuild and
    leaves the previous good output in place instead of running something broken.
- **No `any`, explicit or implicit.** `strict` makes an *implicit* `any` an
    error; ts0 additionally rejects an *explicit* one &mdash; `x: any`,
    `x as any`, `<any>x`, `any[]`, `Promise<any>`, in sources and `.d.ts` files
    alike &mdash; because it switches type-checking off wherever it appears.
    Annotate the real type, or use `unknown` and narrow it. The check parses
    with the TypeScript compiler, so identifiers, strings, comments and JSX text
    that merely contain the word "any" are untouched. It runs inside the same
    gate, so it fails `build`, `run`, and `test` alike; a directory listed in
    `exclude` is skipped by it too.
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
- **Nested projects:** a subdirectory with its own `ts0.json` is its own
    project, and `ts0 build` / `ts0 test` recurse into every one of them, each
    under its own config &mdash; to any depth. Nothing is skipped: a broken
    nested project fails the parent. (`ts0 run` executes one entry, so it builds
    only its own project.)

## License

MIT
