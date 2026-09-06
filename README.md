# ts0

A simple TypeScript framework with good defaults. One CLI, one config file, no boilerplate.

`ts0` wraps [esbuild](https://esbuild.github.io/), the TypeScript compiler, and Node's built-in test runner. You `init`, `build`, `run`, and `test` a TypeScript project without writing a `tsconfig.json`, picking a bundler, or wiring up a test framework.

## Requirements

- Node.js **22 or newer** -- the only requirement. With a [prebuilt ts0.cjs](#prebuilt-tscjs-buildhost) you need nothing else: no npm, no node_modules, no git.

## Install

```sh
npm install -g ts0
```

### Prebuilt ts0.cjs (buildhost)

Some machines carry **stock Node and nothing else**: no npm, no node_modules, no git. For those, ts0 ships as a single platform-neutral JavaScript file on the org buildhost, with the TypeScript compiler inlined. Two ways to run it:

```sh
# Pinned + cached (recommended for build wiring, e.g. a go:generate step):
curl -fL "https://dl.pazer.build/ts0?v=N&os=linux&arch=amd64" -o ts0.cjs
node ts0.cjs build

# Zero-file pipe form (re-downloads each run; fine on a fast/LAN link):
curl -fsSL "https://dl.pazer.build/ts0?branch=master&os=linux&arch=amd64" | node - build
```

`ts0.cjs` is the same bytes for every platform. The store addresses artifacts by os and arch, so the URL parameters are required. Any supported pair returns the identical file. Save it with a `.cjs` extension. The bundle is CommonJS, which is what lets the pipe form run with no flags. A `.js` file instead parses as ESM if it lands inside a package that declares `"type": "module"`.

**Version pinning.** `?branch=master` resolves to the latest build of master and moves on every merge. `?v=N`, for example `?v=1`, is an immutable release and never changes. **Pin `?v=N` in anything that needs reproducible output.** Use `?branch=master` only where tracking latest is the point. To find the current N, read the `Location` header of a branch download, which redirects to `...&v=N&...`. `GET https://pazer.build/api/v1/projects/ts0/releases` answers the same question. Downloads are anonymous, because the project is public.

**The one native piece: esbuild.** Everything else is inlined, but esbuild's compiler is a platform-native binary. On the first run, ts0.cjs downloads the matching binary into `TS0_CACHE_DIR`, or into `~/.cache/ts0/<build-id>/`, atomically and once. That binary is ~11 MB. It is published alongside each release at `https://dl.pazer.build/ts0/esbuild-<version>?os=...&arch=...`, byte-identical to the npm registry's `@esbuild` package. The inlined TypeScript compiler extracts to the same cache. Later runs touch nothing. Prebuilt natives exist for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, and windows/amd64.

If the download target is unreachable, ts0 fails with a message naming the URL and the destination path -- there is no silent fallback. For firewalled or air-gapped machines, set `TS0_ESBUILD_URL` to a mirror of the exact esbuild version, or place the binary at the named destination yourself.

**Scope.** The file bundles the *toolchain*, not your project's dependencies. A project that imports npm packages still needs its own `node_modules`, installed however you like. That includes `@types/node` for Node-target globals. A browser-target project and a dependency-free project each build with `ts0.cjs` alone.

### GitHub Actions

`wow-look-at-my/ts0@master` is a composite action. It downloads the newest `ts0.cjs` from buildhost's master branch, never a pinned version to drift behind -- see "Version pinning" above. It then runs `ts0 test` and `ts0 build`, so a workflow never hand-rolls the download. It takes no arguments:

```yaml
- uses: wow-look-at-my/ts0@master
```

**There is no input for which command to run**, deliberately. `test` type-checks the whole project and bans explicit `any` before it runs the tests, and it type-checks even when a project has no tests yet. `build` type-checks again before it emits. A workflow that chooses the command can choose `--help`: exit 0, nothing checked, nothing tested, nothing built, and a green check for it.

A project with several build targets still needs only this one step. An example is a node-target helper script alongside a browser-target bundle. Give each target its own `ts0.json`, and the single `build` recurses into all of them. See "Nested projects" below.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `working-directory` | No | `.` | Directory to run `ts0` from |

That is the whole input set. The action always downloads the newest ts0 on the default branch. A build tool is not a pinned dependency, so CI tracks latest and there is nothing to choose.

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

- `--watch`, `-w` -- watch mode (`build`, `test`)
- `--no-build` -- skip the bundle step and run sources directly through `--experimental-strip-types`. Still type-checked first (`run`)
- `--config <path>` -- use an explicit config file instead of the nearest `ts0.json` (`build`, `run`, `test`). The config's directory stays the project root. A repo can therefore keep several differently-configured builds side by side (`ts0 build --config ts0.tool.json && ts0 build --config ts0.site.json`)
- `--entry <path>` -- override the configured entry for this `build` invocation
- `--outfile <path>` -- override `outfile`. Produces a single file at this path (`build`)
- `--outdir <path>` -- override `outdir` (`build`)
- `--force` -- overwrite existing files (`init`)
- `--help`, `-h` -- show help

### Examples

```sh
ts0 run                    # build and run the entry point
ts0 run src/app.ts         # run a specific file
ts0 run --no-build         # skip the bundle, run TS directly (fast dev loop)
ts0 test --watch           # watch mode tests
ts0 build --watch          # rebuild on change
```

### Output

Errors are red, warnings yellow, and a passing test's `ok` is green. Color follows the TTY, and `FORCE_COLOR`/`NO_COLOR` override it. Color is always on under `GITHUB_ACTIONS=true`. Under GitHub Actions, a type-check error, a build error and a failing test each also become an `::error::` log annotation.

## Configuration

`ts0` reads `ts0.json` from the current directory, or from any ancestor. Every field is optional. With no config file, `ts0` falls back to sensible defaults and auto-detects an entry point from `src/main.ts`, `src/index.ts`, `main.ts`, `index.ts`, `index.html`, or `src/index.html`.

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
| `outfile`   | `string`              | --            | Single-file output. Adds a `#!/usr/bin/env node` shebang for JS |
| `outdir`    | `string`              | `"dist"`           | Used when `outfile` is not set                                |
| `target`    | `"node" \| "browser"` | `"node"`           | esbuild platform (ignored for HTML entries -- always browser) |
| `format`    | `"esm" \| "cjs" \| "iife"` | `"esm"`       | Output module format. `"iife"` wraps the bundle in an immediately-invoked function (browser-script style); pair with `globalName` |
| `globalName` | `string`             | --            | With `format: "iife"`: global variable that receives the entry's exports (`var MyLib = (() => {…})()`) |
| `preserveHeader` | `boolean`        | `false`            | Single-entry target: re-prepend the entry file's leading comment block to the bundle, byte-exactly (see [Userscripts and headered bundles](#userscripts-and-headered-bundles)) |
| `exclude`   | `string[]`            | --            | Directories (relative to the config file) excluded from the type-check gate, e.g. a test tree checked by its own tsconfig. Does not change what gets built |
| `strict`    | `boolean`             | `true`             | Toggles TypeScript `strict` mode for the type-check step. Explicit `any` is rejected either way -- that ban is not configurable |
| `minify`    | `boolean`             | `false`            | Minify the bundle                                             |
| `sourcemap` | `boolean`             | `true`             | Emit a sourcemap (inlined for HTML entries)                   |
| `test.pattern` | `string`           | `"**/*.test.ts"`   | Glob for test files                                           |
| `embedAssets` | `boolean`           | `true`             | HTML entries: embed runtime-fetched assets (see below). Set `false` to skip. |
| `assetDirs` | `string[]`            | --            | HTML entries: directories to scan for embeddable assets (relative to config file). When set, only these dirs are scanned instead of the entry's directory. |
| `inlineAssets` | `boolean`          | `true`             | HTML entries: inline every referenced script/stylesheet into the HTML. Set `false` to emit a multi-file static site instead (see [Referenced assets](#referenced-assets-multi-file-sites)). |
| `assetPath` | `string`              | `"assets"`         | HTML entries with `inlineAssets: false`: the URL prefix written into the HTML, and -- minus a leading `/` or `./` -- the subdirectory under the output dir. May not contain `..`. |
| `jsx`       | `"automatic" \| "transform" \| "preserve"` | -- | Enable JSX/TSX. `"automatic"` uses the modern runtime (no factory import; pair with `jsxImportSource`); `"transform"` is the classic `React.createElement`; `"preserve"` leaves JSX as-is. |
| `jsxImportSource` | `string`        | --            | Module the automatic runtime imports from, e.g. `"preact"` or `"react"`. Only used when `jsx` is `"automatic"`. |
| `loaders`   | `object`              | --            | Map file extensions to loader names (`text`, `dataurl`, `base64`, `binary`, `file`, `json`, …), e.g. `{ ".wgsl": "text" }`. The friendly way to import non-JS/TS files; applies to the default and js targets. |
| `declarations` | `boolean`          | `true`             | js (library) target only: emit a parallel `*.d.ts` tree into `outdir` alongside the compiled `*.js` (see [Type declarations](#type-declarations)). Set `false` to skip. Ignored by the single-entry and HTML targets. |
| `external`  | `string[]`            | --            | Import specifiers that stay **external references** in the output instead of being bundled, e.g. `["*.css"]` or `["lit"]`. The import statement is emitted verbatim and the file's contents appear nowhere in the output (see [External imports](#external-imports)). Applies to the default and js targets. |
| `bundleShared` | `boolean`          | `true`             | js (library) target: may code shared by two or more outputs be factored into a shared chunk they import. Set `false` to make every emitted module fully self-contained (shared code is duplicated into each). |
| `bundleDependencies` | `boolean`    | `false`            | Node target: compile imported packages INTO the output instead of leaving them `require("pkg")` calls for Node to resolve at run time. Set `true` when the output has to run where its `node_modules` does not exist -- a GitHub Action, a script copied onto a machine on its own. A specifier listed in `external` stays a reference even so. Browser code always bundles and ignores this. |
| `esbuild`   | `object`              | --            | Raw escape hatch -- merged into the esbuild options last (overrides `loaders`) |

When `outfile` is set with a Node target, `ts0` produces a single executable file with a `#!/usr/bin/env node` shebang. That is how you ship a CLI as one file. A browser-target outfile gets no shebang. When only `outdir` is set, output goes there and keeps the entry's basename.

For Node targets, `packages: "external"` is set automatically so `node_modules` are not bundled into the output.

### Userscripts and headered bundles

Some artifacts carry a comment header that is load-bearing in the *output* file. One example is a userscript's `==UserScript==` metadata block, which Tampermonkey and Greasemonkey parse from the installed file. Another is a license banner a distributor requires at the top. esbuild strips comments while it bundles. `preserveHeader: true` re-prepends the **entry file's leading comment block** to the bundled output, byte-exactly. That block is a run of consecutive `//` lines, or one `/* … */` block, starting at byte 0. Add `format: "iife"` and `globalName`, and a multi-module userscript builds to one self-contained file:

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

The header lands above the bundle's own first line. A leading `"use strict";` in the bundle stays an effective directive, because comments never break the directive prologue. That directive appears when the project's `tsconfig.json` sets `alwaysStrict` or `strict`. See `samples/userscript`.

### HTML entries

If `entry` ends with `.html`, `ts0 build` produces a single self-contained HTML file. It runs from disk (`file://`) with no asset tree beside it. That is the default. `"inlineAssets": false` emits a [multi-file site](#referenced-assets-multi-file-sites) instead. Specifically:

- Every `<script src="local">` is bundled with esbuild and inlined as `<script>…</script>`.
- Every `<script type="module">…inline code…</script>` block is bundled with esbuild (relative imports resolve against the HTML's directory).
- Every `<link rel="stylesheet" href="local">` is bundled and inlined as `<style>…</style>`. `url(./fonts/x.woff2)` and `url(./img/y.png)` references inside the bundled CSS are rewritten to `data:` URLs.
- Every fetchable asset under the entry's directory -- shaders, `.hdr`, `.glb`, images and their peers -- is collected into a `window.fetch` interceptor at the top of `<head>`. Code such as `fetch(new URL("shaders/scene.wgsl", import.meta.url))` therefore keeps resolving in the standalone bundle. Set `"embedAssets": false` to disable it.
- External URLs (`https://`, `//`, `data:`) are left untouched.

The project's `.ts`/`.tsx` files are type-checked, with the DOM lib, before any HTML is written. A type error in an HTML project's scripts therefore fails the build, exactly as it does for a Node entry.

#### Referenced assets (multi-file sites)

A single self-contained file is the wrong shape for an app served over HTTP. Nothing in it is independently cacheable, and a one-line HTML edit busts the whole JS bundle. `"inlineAssets": false` emits a normal static site instead. Each referenced local script and stylesheet bundles to its own file under `assetPath`. The tag keeps referencing it through `src=` or `href=`. An output name is the source's basename with the bundled extension (`src/main.ts` -> `main.js`), and carries no content hash. The serving side owns cache headers and ETags.

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

`assetPath` is the URL prefix verbatim. A single-page app wants the absolute form, `"/assets"`. The same shell is served on a deep link such as `/c/abc123`, where a relative URL resolves against the wrong directory. `"assets"` and `"./assets"` write the same files and emit relative URLs. Two sources with one basename, `a/main.ts` and `b/main.ts`, fail the build rather than overwrite each other. If any reference fails, nothing is written at all. External URLs, inline `<script>` bodies, bookmarklet hrefs and the fetch interceptor behave exactly as they do in inline mode. See `samples/html-referenced`.

#### Bookmarklet links

An `href` of the form `javascript:<local source file>` is a **bookmarklet link**. `ts0 build` bundles the referenced file as a browser IIFE, always minified, because a bookmarklet is a URL and length is the constraint. It then substitutes `javascript:` plus the percent-encoded bundle into the href. The page therefore ships a drag-to-bookmarks-bar link with no separate build step:

```html
<a href="javascript:./src/copy-title.ts">Copy Title</a>
```

Only an href that ends in a bundleable source extension counts as a file reference: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. A real inline JavaScript href, such as `javascript:void(0)`, is left untouched. A file-looking reference that does not exist fails the build. See `samples/bookmarklet`.

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

`ts0 run` is for Node entries only. It errors out when the entry is HTML. Open the produced HTML in a browser instead.

`TEXT_ASSET_EXTS` and `BINARY_ASSET_EXTS`, at the top of `src/commands/build-html.ts`, define the asset extension lists. `.json` is deliberately excluded, so `ts0.json` and `package.json` are not picked up. Load runtime JSON through a JS import instead.

The fetch interceptor exposes `window.__ts0_embedded_paths__`, an array of all embedded asset keys. Client code enumerates the available assets with it at runtime. One use is to discover every `.xml` file in a data directory without a hardcoded manifest.

### js (library) target

If `entry` is a **directory**, `ts0 build` switches to the "js" library target. Every `*.ts` and `*.tsx` file under that directory compiles to a parallel `*.js` file under `outdir`, and the directory structure is preserved (`src/webgpu/sky.ts` -> `dist/webgpu/sky.js`). A library deployed to static hosting wants this shape, on GitHub Pages or a CDN. A consumer imports an individual module by URL. Each module also gets a matching `*.d.ts` by default. Those consumers therefore fetch the type declarations from the same URLs as the code. See [Type declarations](#type-declarations) below.

```json
{
    "entry": "src",
    "target": "browser",
    "sourcemap": false,
    "loaders": { ".wgsl": "text" }
}
```

- Each file is its own esbuild entry point. Code shared across entries is **deduplicated into a chunk**, for `esm` output, and imported. It is never copied into each output. A consumer still writes a single import, and the browser fetches any shared chunk transitively. A loader-backed import stays inlined in the importing module, as does a non-shared local import. An example is `import src from "./shader.wgsl"`, enabled by the `loaders` field above. Set `"bundleShared": false` to force fully self-contained outputs, with duplication. That is the right trade only when outputs are consumed in isolation, where fetching a sibling chunk is not possible.
- Declaration files (`*.d.ts`) and tests (`*.test.*`, `*.spec.*`) are skipped.
- Type-checking uses **bundler** module resolution, which matches esbuild. An extensionless relative import and a loader-backed import therefore type-check, and library source needs no `.ts` extension. Add an ambient declaration so a loader import type-checks, such as `declare module "*.wgsl" { const s: string; export default s; }`.
- Test files are the exception. `ts0 test` hands them to Node, whose resolver takes the specifier literally. Give their imports a real `.ts` or `.tsx` extension, even though the sources beside them need none.
- `ts0 run` does not apply to this target, because there is no single entry to run. Use `ts0 build`. The single-file `outfile` option is ignored too. Output always goes to `outdir`.

See `samples/js` for a complete example.

#### Type declarations

By default the js target also emits TypeScript declarations. Every compiled module gets a parallel `*.d.ts` under `outdir`, mirroring the source tree exactly like the `*.js` outputs (`src/ui/timeline-view.ts` -> `dist/ui/timeline-view.js` **and** `dist/ui/timeline-view.d.ts`). A library deployed to static hosting therefore ships its types at the same URLs as its code. A consumer fetches `x.js` for the runtime and `x.d.ts` beside it for the types, and TypeScript pairs them automatically.

- **Default on.** A library target exists to be consumed. Set `"declarations": false` in `ts0.json` to opt out.
- Emission is a separate `tsc` pass (`declaration` plus `emitDeclarationOnly`) over exactly the modules the build compiled. Tests, `*.d.ts` sources and esbuild's shared `chunk-*.js` files therefore never get declarations. It runs only on `ts0 build`, and on each watch rebuild. `ts0 run` and `ts0 test` never write output.
- The pass is **all-or-nothing**. Any error fails the build and writes no `.d.ts` at all, so there is no partial tree. A type error never reaches this pass. The errors that do are declaration-only diagnostics such as TS4023, "cannot be named". Output is deterministic: one input produces byte-identical `.d.ts`, so a committed copy of fetched declarations diffs cleanly.
- Relative import specifiers are kept as written, explicit `.ts` and `.tsx` extensions included. That is the standard declaration shape for an `allowImportingTsExtensions` project. TypeScript resolves `./x.ts` inside a `.d.ts` by extension substitution (`.ts` -> `.tsx` -> `.d.ts`) to the deployed sibling `x.d.ts`, under both `bundler` and `NodeNext` consumer resolution. No rewriting is needed. TypeScript's `rewriteRelativeImportExtensions` does not help either, because it affects JavaScript emit only.
- One structural constraint. Declaration output mirrors the entry directory. A module that imports a **source outside the entry directory** therefore fails the build with `TS6059`. The bundler can inline such an import into the `.js`, but a mirrored `.d.ts` tree cannot represent it. Move the file under the entry directory, or set `"declarations": false`.

### External imports

By default every import is resolved and bundled at build time. Some imports must **not** be — they are meant to be resolved at runtime, by the browser or by the consumer. `external` lists those specifiers: the `import` statement is emitted verbatim and the imported file's contents appear nowhere in the output.

The motivating case is a CSS module script, where the browser constructs the stylesheet itself:

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

The bundle keeps that line exactly as written — import attributes included — and ships no stylesheet text. Other uses: a peer dependency a library must not embed (`["lit"]`), or anything supplied by an import map.

- **Matching is by specifier, not by file path.** Each entry is compared against the specifier as written. `"./styles.css"` externalizes that relative import, and `"lit"` externalizes the bare package. `*` matches any run of characters, so `"*.css"` covers every CSS import in the project.
- **It is per-specifier, not a blanket opt-out.** Ordinary imports sitting next to an externalized one bundle exactly as before.
- **Types still apply.** An external import is type-checked like any other, so give it an ambient declaration: `declare module "*.css" { const sheet: CSSStyleSheet; export default sheet; }`.
- **It is not a way to silence an unsupported import.** An import ts0 cannot handle and that is *not* listed here still fails the build, loudly, with nothing written. That red build is the guardrail: it is what stops a stylesheet from being quietly inlined into your JavaScript.
- Applies to the single-entry target and the [js library target](#js-library-target).

See `samples/external-css` for a complete example.

### JSX / TSX

Set `jsx` to compile `.tsx`/`.jsx`. The setting is threaded into both the type-checker and esbuild -- for **every** entry kind, including HTML entries whose `<script>` tags pull in `.tsx`. A Preact app uses the automatic runtime:

```json
{
    "entry": "index.html",
    "jsx": "automatic",
    "jsxImportSource": "preact"
}
```

With `"automatic"`, JSX compiles to `preact/jsx-runtime` calls and needs no factory import. Omitting `jsxImportSource` (or using `"transform"`) makes esbuild emit the classic `React.createElement`, which throws `React is not defined` in a Preact bundle -- so always pair `"automatic"` with `jsxImportSource` for Preact/React. See `samples/html-jsx` for a complete Preact-via-HTML example.

## How it works

- **Type-checking is mandatory. There is no way to build, run, or test un-checked code.** `ts0` type-checks before it emits *or executes* anything. `build`, `run` and `test` all check first, and produce or run nothing when the check fails. That holds for every entry kind -- `.ts`, `.html`, and the directory (js library) target -- wherever the entry lives, a dot-directory such as `.github/scripts/` included. Even `ts0 run --no-build` type-checks first, although it skips the bundle and writes no artifact. Node's `--experimental-strip-types` only strips annotations and does not type-check, so ts0 runs `tsc` itself before it hands sources to Node. There is no escape hatch. Every `--watch` mode re-checks on each cycle, `build` and `test` alike. A new type error therefore stops the rebuild or the run, and leaves the previous good output in place.
- **No `any`, explicit or implicit.** `strict` makes an *implicit* `any` an error. ts0 also rejects an *explicit* one: `x: any`, `x as any`, `<any>x`, `any[]`, `Promise<any>`, in sources and `.d.ts` files alike. An explicit `any` switches type-checking off wherever it appears. Annotate the real type, or use `unknown` and narrow it. The check parses with the TypeScript compiler, so an identifier, a string, a comment or JSX text that merely contains the word "any" is untouched. It runs inside the same gate, so it fails `build`, `run` and `test` alike. A directory listed in `exclude` is skipped by it too.
- **Build:** `ts0 build` runs `tsc --noEmit` against a tsconfig generated from your `ts0.json`, then bundles with esbuild. That tsconfig carries the DOM libs for a browser or HTML entry, and ESNext for Node. A pure-JS project with no TypeScript sources has nothing to check and builds straight through.
- **Run:** `ts0 run` type-checks, bundles, then runs the output with Node. With `--no-build` it type-checks, skips the bundle, and executes the sources directly through `node --experimental-strip-types`. That is the fast dev loop, minus the artifact, and never minus the type-check.
- **Test:** `ts0 test` type-checks the whole project first. Only if that passes, it compiles each discovered test file with the same compiler the build uses, and runs the results with `node --test`. A type error anywhere fails the command, and no tests run. `ts0 test --watch` re-type-checks and re-runs on every change. ts0 drives that watch loop itself rather than `node --test --watch`, so nothing skips the check.

    Compiling rather than stripping is what lets a test import whatever the build supports: a `loaders` extension, JSX, an `external` specifier. It is also what lets a CommonJS-format project run at all. Stripping erases type annotations without turning `import` into `require`, so such a project once passed the gate and then died inside Node on "Cannot use import statement outside a module". Each compiled file keeps its source's module format and is written beside it, then deleted after the run. `__dirname`, `require` and `import.meta.dirname` therefore all mean what they meant. One thing cannot survive: `require.main === module` in a module under test. Everything in a bundle shares one module object, so that guard fires. Export the work and leave the invocation to the entry file.
- **Nested projects:** a subdirectory with its own `ts0.json` is its own project. `ts0 build` and `ts0 test` recurse into every one of them, each under its own config, to any depth. Nothing is skipped, and a broken nested project fails the parent. `ts0 run` executes one entry, so it builds only its own project.

## License

MIT
