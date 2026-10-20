# CLAUDE.md

Notes for Claude working in this repository.

## What this project is

`ts0` -- a small TypeScript framework CLI that wraps esbuild, the TypeScript compiler, and Node's built-in test runner. The repository directory is named `bundler`. The published package and binary are both named `ts0`.

The CLI exposes commands: `init`, `build`, `run`, `test`. See `README.md` for user-facing documentation.

## Layout

```
src/
    cli.ts              # entry point - arg parsing and command dispatch
    config.ts           # ts0.json loader, defaults, entry auto-detection
    reporter.ts         # GitHub Actions ::error::/::warning:: annotations + ANSI coloring
    commands/
        init.ts         # scaffolds ts0.json + src/ + package.json
        build.ts        # type-check gate (runTypecheck) + declaration emit (emitDeclarations) + esbuild bundle (dispatches HTML/js)
        build-html.ts   # bundles an .html entry into a single inlined .html
        build-js.ts     # compiles a directory entry into a parallel .js (+ .d.ts) tree (type-checked)
        esbuild-base.ts # baseEsbuildOptions() shared by build.ts + build-js.ts
        explicit-any.ts # explicit-`any` ban (parse-based), run inside runTypecheck
        run.ts          # type-check, then build+node (or strip-types+node for --no-build)
        test.ts         # type-check, then node --test on discovered test files
    prebuilt/           # prebuilt ts0.cjs support; see "Prebuilt ts0.cjs"
        main.ts         # bundle entry: prepare cache + esbuild native, then load the CLI
        runtime.ts      # cache extraction + esbuild-native fetch (no self-path dependence)
        prebuilt-assets.d.ts # ambient decl for the generated "ts0-prebuilt-assets" virtual module
scripts/
    build-prebuilt.ts   # packages ts0.cjs + the five esbuild natives for buildhost
    prebuilt-smoke.sh   # bare-node (no npm) end-to-end verification of ts0.cjs
samples/
    basic/              # Node-entry smoke-test sample exercised by CI
    html/               # HTML-entry smoke-test sample exercised by CI
    html-jsx/           # HTML+JSX (Preact, automatic runtime) regression sample
    html-referenced/    # HTML entry with inlineAssets:false -> multi-file site (CI)
    js/                 # directory-entry "js" library target sample (CI)
    userscript/         # iife + globalName + preserveHeader sample (CI)
    bookmarklet/        # HTML entry with a javascript: bookmarklet href (CI)
    external-css/       # `external` keeps a CSS-module import a reference (CI)
tests/                  # dats behavioural suites (all of CI's assertions)
    cli.dats            # init/build/run/test, --config
    gate.dats           # type-check gate + explicit-`any` ban, every path
    samples.dats        # every sample under samples/
    html-referenced.dats # the multi-file HTML target
    node-target.dats    # bundleDependencies, and running a test in its own module format
    action.dats         # action.yml: always test then build, no command input; the PATH launcher
bin/ts0                 # launcher action.yml copies onto PATH beside ts0.cjs
.github/workflows/ci.yml
ts0.json                # ts0 builds itself with these settings
```

`ts0` is self-hosting: `package.json`'s `build` script invokes the CLI from source via `node --experimental-strip-types src/cli.ts build`, which reads the repo's own `ts0.json` and produces `dist/ts0`. Every `samples/*` directory is a nested ts0 project, so that command builds them too -- see "Nested projects" under Type-checking.

## Runtime requirements

- Node.js **22 or newer**. The CLI relies on `--experimental-strip-types` and the built-in `node --test` runner, both Node 22+ features. Do not lower the `engines.node` field.
- This is a Node/TypeScript project. **Do not** apply the `go-toolchain` rules here -- they do not apply.

## Working on the code

[docs/working-on-the-code.md](docs/working-on-the-code.md) holds this section.

## Conventions

- **Indentation:** tabs (4-wide), per `.editorconfig`. Match this in every file.
- **Modules:** ESM only (`"type": "module"`). Use `.ts` extensions in relative imports (e.g. `import { build } from "./commands/build.ts"`) so `--experimental-strip-types` resolves them.
- **Dependencies:** keep them minimal. The production deps are `esbuild`, `typescript` and `@types/node`. The last one is embedded and re-exposed through `typeRoots`, so a Node-target project needs no install of its own. See docs/prebuilt-ts0-cjs.md. The dev dep is `preact`, only so the `samples/html-jsx` regression sample resolves `preact/jsx-runtime` when CI builds it. Do not add a CLI parser, a test framework, or a bundler abstraction. The whole point is that ts0 stays small.
- **Argument parsing:** `src/cli.ts` parses `process.argv` by hand. A new command must follow the same pattern, with no new dependency.

## Output: colors + GitHub Actions annotations

`reporter.ts` is the one place that formats a diagnostic for display. It owns ANSI color, forced on under `GITHUB_ACTIONS=true` because that log viewer renders color although stdout is a pipe. It also owns the `::error::` and `::warning::` annotations, which do nothing outside Actions. `docs/reporter.md` carries the depth, including why esbuild's own logging is off.

## Configuration model

`config.ts` defines `Ts0Config` and a single `DEFAULT_CONFIG` object. When adding a new option:

1. Add the field to the `Ts0Config` interface and `DEFAULT_CONFIG`.
2. If it changes build behavior shared by the default and js targets, thread it through `baseEsbuildOptions()` in `commands/esbuild-base.ts`. Both targets call that. A target-specific option lives in `build.ts` or `build-js.ts` instead. The user-supplied `esbuild` field is spread last so it stays an escape hatch. Keep it that way.
3. Document it in `README.md`'s configuration table.

`loadConfig()` walks up from the cwd to look for `ts0.json`. It falls back to the defaults plus an auto-detected entry. Do not break the no-config-file path.

## Type-checking

[docs/type-checking.md](docs/type-checking.md) holds this section.

## JSX

`jsx` and `jsxImportSource` are threaded into esbuild from **both** paths. Those are the Node and TS path in `build.ts`, and the HTML path in `build-html.ts`'s `<script>` bundling. Keep them in sync. If only one path sets them, an HTML and JSX project silently falls back to esbuild's classic `React.createElement` transform, and Preact breaks at runtime.

## HTML entries

When `entry` ends with `.html`, `build.ts` delegates to `commands/build-html.ts`. That module reads the HTML and inlines classes of dependency:

1. `<script src="local">` -- bundled with esbuild, inlined as `<script>…</script>`.
2. `<script type="module">…inline body…</script>` -- bundled via esbuild's `stdin` API with `resolveDir` set to the HTML's directory, so relative imports in the inline body work.
3. `<link rel="stylesheet" href="local">` -- bundled with esbuild, inlined as `<style>…</style>`. The CSS bundling uses a `dataurl` loader for fonts and images, so a `url(...)` reference inside the CSS becomes a `data:` URL.
4. Runtime-fetched assets. A file under the entry directory, or under a directory named in `assetDirs`, is embedded into a `window.fetch` interceptor at the top of `<head>`. It qualifies when its extension is in `TEXT_ASSET_EXTS` or `BINARY_ASSET_EXTS`, both defined at the top of `src/commands/build-html.ts`. The interceptor template lives at `src/runtime/fetch-interceptor.js`, and carries a `__ASSETS_JSON__` placeholder that the build replaces. Substitute with `replaceAll`, not `replace`. The file's own header comment necessarily mentions the placeholder name.

5. Bookmarklet links. An `href="javascript:<local source file>"`, with a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` extension, is bundled as a browser IIFE, **always minified**. A bookmarklet is a URL, and length is the constraint. It is then percent-encoded with `encodeURIComponent` and substituted back as `javascript:<encoded>`. A real inline-JS href, such as `javascript:void(0)`, does not match the extension test and is left untouched. A file-looking reference that does not exist is a build error. encodeURIComponent escapes quotes, `&`, `#` and whitespace, so the encoded bundle is attribute-safe raw.

`.json` is deliberately not in the asset extension list, so `ts0.json` and `package.json` are not picked up. Disable embedding fully with `"embedAssets": false` in `ts0.json`.

When `assetDirs` is set in `ts0.json`, `build-html.ts` scans only those directories, relative to rootDir, instead of the HTML entry's directory. An asset key in the interceptor map is relative to rootDir, so `"assetDirs": ["people"]` produces a key such as `people/foo.xml`. The interceptor also exposes `window.__ts0_embedded_paths__`, an array of all embedded asset keys, so client code discovers the available assets at runtime.

An external URL, such as `https://`, `//` or `data:`, is left alone. Every tag attribute on the script or link is preserved, except `src`, `href`, `rel` and `type`.

Keep the HTML parser regex-based and dependency-free -- do not add an HTML parser package.

### Referenced assets (`inlineAssets: false`)

`"inlineAssets": false` (HTML entries only) bundles each referenced local script/stylesheet to its own file under `assetPath` and rewrites the tag's `src`/`href` instead of inlining. Load-bearing invariants:

- **The default is unchanged inline mode.** `inlineAssets` absent or `true` emits exactly the same bytes as before. `assets` comes back empty from `processHtml`, and no other code path differs.
- **Output name = source basename + bundled extension**, with no content hash (`src/main.ts` -> `main.js`). Sources that want the same name are a **build error naming both**. Never an overwrite, and never an invented suffix.
- **Nothing is written when the pass has errors.** `buildOnce` returns before it writes the HTML or any asset. A new shell therefore never points at a bundle that was not emitted, and in watch mode the previous good output stays.
- **esbuild is given the `outfile`**, and *every* `outputFiles` entry is written. An entry that imports CSS makes esbuild emit a companion `.css`, which lands beside the JS only if esbuild knows the real path.
- `assetPath` is the URL prefix verbatim. Minus a leading `/` or `./`, it is the subdirectory under the HTML's out dir. A `..` in it is a config error, caught by `loadConfig`, not something to sanitize.

Covered by `tests/html-referenced.dats`, not a CI shell step.

### Interceptor template lookup

`build-html.ts` resolves the interceptor template via multiple candidate paths so both running modes work:

- `<__dirname>/../runtime/fetch-interceptor.js` -- running from source (e.g. `node --experimental-strip-types src/cli.ts build`).
- `<__dirname>/../src/runtime/fetch-interceptor.js` -- running from the bundled `dist/ts0`.

`package.json`'s `"files"` ships both `dist/ts0` and `src/runtime/fetch-interceptor.js` so installs from a published tarball or git URL find the template.

## Userscript bundling (iife + globalName + preserveHeader)

`format: "iife"`, plus the optional `globalName`, is threaded through `baseEsbuildOptions()` like the other formats. It therefore applies to the default and js targets alike. `preserveHeader: true`, on the single-entry target only, re-prepends the entry's leading comment block to the written bundle. esbuild strips comments. But a userscript's `==UserScript==` block, or a mandated license banner, is load-bearing metadata of the OUTPUT file. It must survive byte-exactly at the top. The mechanics are `leadingCommentBlock` plus `preserveHeaderPlugin` in build.ts.

An esbuild `onEnd` hook reads the entry and extracts the maximal leading run of `//` lines, or one `/* … */` block, byte-exactly. It then prepends that to the output file. The hook covers the one-shot build and every watch rebuild. Each of those rewrites the file, so headers never stack. The header sits above the bundle's own first line. A leading `"use strict";` stays an effective directive.

Comments never break the directive prologue. esbuild emits that directive when the consumer project's tsconfig sets `alwaysStrict` or `strict`. A Node-target outfile keeps its `#!/usr/bin/env node` shebang. A browser-target outfile gets none, because a shebang is a Node convenience and corrupts a userscript header.

## js (library) target

When `entry` resolves to a **directory**, and not to a `.ts` or `.html` file, `build.ts` delegates to `commands/build-js.ts`. `isJsTarget` does that directory check, after `isHtmlEntry`. This target compiles every `*.ts`, `*.tsx`, `*.mts` and `*.cts` file under the directory as a separate esbuild entry point. `outbase` is the entry dir and `outdir` is `dist`. The source tree is therefore mirrored (`src/webgpu/sky.ts` -> `dist/webgpu/sky.js`). `*.d.ts`, `*.test.*` and `*.spec.*` are skipped.

Code shared across entries is **deduplicated**, not duplicated. `splitting: true` (enabled for `esm` output) makes esbuild emit a module imported by 2+ entries once into a chunk and import it, rather than inlining a copy into every output. A consumer still imports a single entry file — the browser fetches any shared chunk transitively. Non-shared local imports and loader-backed imports (`.wgsl` text, etc.) stay inlined. `"bundleShared": false` turns splitting off to force self-contained (duplicating) outputs — a first-class option, NOT the `esbuild` escape hatch. This is slated for removal along with esbuild itself.

Splitting is only expressible for `esm`, so other formats duplicate regardless. Code shared across entries is **deduplicated**, not duplicated. `splitting: true` is enabled for `esm` output. A module imported by two or more entries is then emitted once into a chunk and imported, rather than inlined into every output. A consumer still imports a single entry file, and the browser fetches any shared chunk transitively. A non-shared local import stays inlined, as does a loader-backed import such as `.wgsl` text.

`"bundleShared": false` turns splitting off, to force self-contained outputs that duplicate. It is a first-class option, NOT the `esbuild` escape hatch, which is slated for removal along with esbuild itself. Splitting is only expressible for `esm`, so every other format duplicates regardless.

It is mutually exclusive with the HTML target and the default single-entry target. `outfile` is ignored, because output always goes to `outdir`. `ts0 run` rejects it, because there is no single entry to run. The non-output esbuild options, such as platform, format and jsx, come from `baseEsbuildOptions()` in `commands/esbuild-base.ts`. The default target shares that function. The two therefore cannot drift.

## External imports (`external`)

`external` lists import specifiers that stay **references** in the output: the import statement is emitted verbatim and the target's contents are never pulled in. It is threaded through `baseEsbuildOptions()`, so the single-entry and js targets both honor it. "this import is resolved at runtime" is a property of the code, not of which target compiles it.

The motivating case is a CSS module script (`import s from "./x.css" with { type: "css" }`), which the browser resolves and constructs itself. Also peer dependencies a library must not embed, and import-map entries.

- **It is ts0 vocabulary, not an esbuild passthrough.** The `esbuild` escape hatch and esbuild itself are slated for removal. `external` is defined in terms of import specifiers and must survive a bundler swap. Do not reintroduce it as a raw passthrough or document it in esbuild's terms.
- **It must never become a way to silence an unsupported import.** An import the bundler cannot handle and that is NOT listed in `external` has to keep failing the build, with nothing written. That hard failure is the whole guardrail: silent inlining will put stylesheet text into the JS and defeat the feature. `tests/samples.dats` carries "an unsupported CSS-type import errors instead of silently inlining" specifically to keep this honest — if that test ever starts passing, the guardrail is gone.
- Matching is by specifier as written (`"./styles.css"`, `"lit"`, `"*.css"` with `*` matching any run of characters), not by resolved file path.
- External imports are still type-checked. The sample pairs one with an ambient `declare module "*.css"`.

Type-checking for this target uses `moduleResolution: "Bundler"` (see "Type-checking" above). For loader-backed imports (e.g. `.wgsl` as text), set the loader with the `loaders` config field (`{ ".wgsl": "text" }`, threaded into esbuild by `baseEsbuildOptions`) and give an ambient `declare module "*.wgsl"` so the import also type-checks. Esbuild does the actual inlining. ts0 applies no loaders by default. (The `esbuild.loader` escape hatch still works and overrides `loaders`.)
## Dependency bundling (`bundleDependencies`)

A node-target build leaves an imported package as a `require("pkg")` call, through esbuild's `packages: "external"`. That is right for a CLI installed alongside its node_modules. `"bundleDependencies": true` compiles those packages in instead, for an artifact that must run where its node_modules does not exist. One example is a GitHub Action, whose release tag ships `dist/` and nothing else. It is threaded through `baseEsbuildOptions`, so `external` still wins per specifier. A native addon or a peer dependency opts back out that way.

The default stays external. ts0 builds ITSELF with the node target and resolves `typescript` at run time through `createRequire`. Bundling its dependencies breaks that, and tries to compile esbuild's native module in.

## External imports (`external`)

`external` lists import specifiers that stay **references** in the output. The import statement is emitted verbatim, and the target's contents are never pulled in. It is threaded through `baseEsbuildOptions()`, so the single-entry and js targets both honor it. "This import is resolved at runtime" is a property of the code, not of which target compiles it.

The motivating case is a CSS module script, `import s from "./x.css" with { type: "css" }`, which the browser resolves and constructs itself. Two more are a peer dependency a library must not embed, and an import-map entry.

- **It is ts0 vocabulary, not an esbuild passthrough.** The `esbuild` escape hatch and esbuild itself are slated for removal. `external` is defined in terms of import specifiers, and must survive a bundler swap. Do not reintroduce it as a raw passthrough, and do not document it in esbuild's terms.
- **It must never become a way to silence an unsupported import.** An import the bundler cannot handle must keep failing the build with nothing written, unless `external` lists it. That hard failure is the whole guardrail. Silent inlining puts stylesheet text into the JS and defeats the feature. `tests/samples.dats` carries "an unsupported CSS-type import errors instead of silently inlining" to keep this honest. If that test ever starts passing, the guardrail is gone.
- Matching is by specifier as written, not by resolved file path: `"./styles.css"`, `"lit"`, or `"*.css"` with `*` matching any run of characters.
- An external import is still type-checked. The sample pairs one with an ambient `declare module "*.css"`.

Type-checking for this target uses `moduleResolution: "Bundler"`. See "Type-checking" above. For a loader-backed import, such as `.wgsl` as text, set the loader with the `loaders` config field, `{ ".wgsl": "text" }`, which `baseEsbuildOptions` threads into esbuild. Give an ambient `declare module "*.wgsl"` so the import also type-checks. esbuild does the actual inlining. ts0 applies no loaders by default. The `esbuild.loader` escape hatch still works, and overrides `loaders`.

### Declaration emit (js target only)

Unless `"declarations": false`, the js target emits a parallel `*.d.ts` tree into outdir, beside the `*.js` outputs (`src/ui/x.ts` -> `dist/ui/x.js` plus `dist/ui/x.d.ts`). A deployed library therefore ships types at the same URLs as its code. For the mechanics, see `emitDeclarations` in build.ts and `declarationsPlugin` in build-js.ts:

- It is a second tsc pass, with `declaration`, `emitDeclarationOnly` and `noEmitOnError`, `outDir` set to the build outdir and `rootDir` set to the entry dir. It covers **exactly the entry-point set esbuild compiled**, plus the project's ambient `*.d.ts` files. `collectAmbientDeclarations` gathers those, so a loader-backed import resolves. An ambient input emits nothing and is exempt from `rootDir`. Consequences follow. A test file and esbuild's `chunk-*.js` never get a `.d.ts`. A `*.d.ts` source is not copied.
- It runs in an esbuild `onEnd` hook, one-shot AND watch, only after a successful build. An emit failure fails the build. `noEmitOnError` makes it all-or-nothing, so no partial `.d.ts` tree can land. `ts0 run` and `ts0 test` never invoke it, because they must not write output.
- Emitted declarations **keep source specifiers**, explicit `.ts` and `.tsx` extensions included. That is the standard shape for an `allowImportingTsExtensions` project. A consumer resolves `./x.ts` inside a `.d.ts` by extension substitution (`.ts` -> `.tsx` -> `.d.ts`) to the deployed sibling `x.d.ts`. This was verified under both bundler and NodeNext consumer resolution. Do NOT add `rewriteRelativeImportExtensions`. It rewrites JavaScript emit only, not declarations, and is unnecessary.
- Output is deterministic: one input gives byte-identical `.d.ts`. CI asserts this, because a consumer commits a fetched copy and diffs it.
- One known constraint. An entry that imports a source file **outside the entry directory** fails the pass with TS6059, loudly and with nothing written. A mirrored tree cannot represent such an import. The opt-out is `"declarations": false`.

## Distributing

Three consumption paths:

- **`action.yml` (repo root) for GitHub Actions consumers.** `uses: wow-look-at-my/ts0@master`, with no inputs, downloads the prebuilt `ts0.cjs` below and runs `test` then `build`. See the README's "GitHub Actions" section. It takes **no command input**. A caller that chooses the command can choose `--help`, a green check for zero work. `tests/action.dats` asserts multiple things. Both commands still run, in that order. No `node` line in the action interpolates an expression. The input set is exactly working-directory. Keep it that way.
- **Prebuilt ts0.cjs on buildhost, the primary path for non-npm consumers.** Some machines carry stock Node but no npm, no node_modules and no git: webhook-runner's `//go:generate` step, a CI image, a container. Each downloads one platform-neutral JavaScript file from `https://dl.pazer.build/ts0?...` and runs it with `node`, or pipes it as `curl ... | node - build`. See the README's "Prebuilt ts0.cjs" section for the URLs, and "Prebuilt ts0.cjs" below for how it is built. Never recommend a `?v=N` pin: the release it names is deleted in time and the URL then answers 404.
- **npm and git installs, for node projects.** `npm install github:wow-look-at-my/bundler` works because `package.json` has a `prepare` script that runs `npm run build`. An install from a git URL runs `prepare` automatically. `dist/ts0` is therefore built on the consumer's machine, and `npx ts0 …` works with no separate build step. The `"files"` field is irrelevant to a git install, but it matters for `npm publish`. Keep `dist/ts0` and `src/runtime/fetch-interceptor.js` in it. js-snippets consumes ts0 this way. The prebuilt machinery must never change this path's behavior. See the npm-path invariant in docs/prebuilt-ts0-cjs.md.

## Prebuilt ts0.cjs (buildhost packaging)

`scripts/build-prebuilt.ts` packages ts0 for buildhost as ONE platform-neutral CommonJS file plus five small platform-native esbuild binaries. CI publishes them on every branch push. A consumer runs `node ts0.cjs <cmd>` on stock Node >= 22 with no npm. CommonJS, `.cjs` and stdin-runnable are all load-bearing. The compiler is embedded exactly once. Nothing in shared code may depend on the bundle's own path.

- docs/prebuilt-ts0-cjs.md -- the whole contract. It covers the bundle contents, the generated `bin/tsc` driver, cache extraction and the esbuild native fetch. It also covers the npm-path invariant, what must stay in sync on a dependency bump, and CI and publish.

## Documentation

Per global instructions: when you change project structure, commands, config fields, or tooling, update `README.md` and this file in the same commit. Do not let the docs drift.

## Git workflow

- Develop on the branch the task specifies.
- Commit and push frequently. The VM can reset.
- PRs in this org are squash-merged. Do not rebase or force-push.
