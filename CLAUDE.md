# CLAUDE.md

Notes for Claude working in this repository.

## What this project is

`ts0` -- a small TypeScript framework CLI that wraps esbuild, the TypeScript compiler, and Node's built-in test runner. The repository directory is named `bundler`. The published package and binary are both named `ts0`.

The CLI exposes four commands: `init`, `build`, `run`, `test`. See `README.md` for user-facing documentation.

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
    action.dats         # action.yml: always test then build, no command input
.github/workflows/ci.yml
ts0.json                # ts0 builds itself with these settings
```

`ts0` is self-hosting: `package.json`'s `build` script invokes the CLI from source via `node --experimental-strip-types src/cli.ts build`, which reads the repo's own `ts0.json` and produces `dist/ts0`. Every `samples/*` directory is a nested ts0 project, so that one command builds them too -- see "Nested projects" under Type-checking.

## Runtime requirements

- Node.js **22 or newer**. The CLI relies on `--experimental-strip-types` and the built-in `node --test` runner, both Node 22+ features. Do not lower the `engines.node` field.
- This is a Node/TypeScript project. **Do not** apply the `go-toolchain` rules here -- they do not apply.

## Working on the code

```sh
npm install
npm run build                                       # build dist/ts0
node --experimental-strip-types src/cli.ts <cmd>    # run from source without building
npm link && dats test tests/                        # behavioural suites (needs bwrap)
```

The suites need the linked `ts0` on PATH, hence `npm link`, and bubblewrap for the sandbox. A `.dats` file is tab-indented YAML.

Unit tests are every `src/**/*.test.ts`, run by `node --experimental-strip-types --test`. Every `tests/*.dats` file is a behavioural suite run by [dats](https://github.com/wow-look-at-my/dats). CI builds `dist/ts0` and `npm link`s it, then each suite stages a project and asserts what the build WROTE. A staged project gets the repo's `node_modules` symlinked in. That is the position it resolves `@types/node` and `preact` from when it is built in place. `network: false` on every file proves a build never needs a network. The dats action installs bubblewrap and clears the AppArmor restriction that denies it a user namespace, and exposes no way to turn the sandbox off, so CI runs sandboxed too. ts0 is public, so its jobs run on GitHub-hosted runners; the org's own pool is for private repos, which pay for minutes. No job uses GitHub artifact storage -- a hand-off rides `wow-look-at-my/actions@cache-upload#latest`. `docs/testing.md` says what each suite and each CI step covers.

If you change CLI behavior, update the relevant `samples/*` and the matching `tests/*.dats` suite so the new behavior is covered.

## Conventions

- **Indentation:** tabs (4-wide), per `.editorconfig`. Match this in every file.
- **Modules:** ESM only (`"type": "module"`). Use `.ts` extensions in relative imports (e.g. `import { build } from "./commands/build.ts"`) so `--experimental-strip-types` resolves them.
- **Dependencies:** keep them minimal. The production deps are `esbuild`, `typescript` and `@types/node`. The last one is embedded and re-exposed through `typeRoots`, so a Node-target project needs no install of its own. See docs/prebuilt-ts0-cjs.md. The one dev dep is `preact`, only so the `samples/html-jsx` regression sample resolves `preact/jsx-runtime` when CI builds it. Do not add a CLI parser, a test framework, or a bundler abstraction. The whole point is that ts0 stays small.
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

**Type-checking is an unskippable gate. There is NO way to build or run code that has not passed `tsc`.** The exported `runTypecheck(config, rootDir)` is the single chokepoint. Every command that emits or executes code calls it:

- `build()` runs it before it emits anything, and returns a failed `BuildResult` with no output written. Every path that produces output goes through `build()`: `ts0 build`, `ts0 run` without `--no-build`, and any programmatic caller. None of them can emit an un-checked artifact. Do **not** move the check back up into the command layer. That reintroduces the hole where `ts0 run` bundled and executed un-type-checked code.
- `run()` runs it for the `--no-build` path, before it hands sources to `node --experimental-strip-types`. Strip-types only *erases* annotations. It does **not** type-check, so without this gate `ts0 run --no-build` executes broken code. `--no-build` therefore skips only the bundle and the artifact, never the check.
- `test()` runs it before it compiles or spawns anything. The compile erases type annotations without checking them, so an un-checked test run executes an invalid program. A type error anywhere in the project fails `ts0 test`, and no test process is spawned.

The gate is more than `tsc`. It also bans explicit `any`, as "Explicit `any` is banned" below describes. Everything said here about unskippability covers that ban too.

There is intentionally **no escape hatch**. Every command that runs or emits code type-checks first. A new command, or a new branch in an existing one, that runs or emits code MUST call `runTypecheck()` first and bail on failure. The only thing `--no-build` and its peers may skip is the bundle and the artifact, never the check.

`runTypecheck()` writes a temporary `.ts0-tsconfig.json`, which is gitignored, runs `tsc --noEmit` against it, and deletes it in a `finally`. It resolves the TypeScript binary from `ts0`'s own `node_modules` through `createRequire`, so the user's project needs no `typescript` install. Preserve both behaviors. `build()`, `run()` and `test()` each already hold a loaded config, so each calls `runTypecheck(config, rootDir)` directly rather than re-loading.

The tsconfig generation is shared. `generatedCompilerOptions(config, rootDir)` builds the compiler options used by BOTH the gate and the js target's declaration emit. That emit is `emitDeclarations`, whose temp file `.ts0-tsconfig-emit.json` is also gitignored. `runTsc()` owns the write-temp-tsconfig, exec and cleanup plumbing for both. Keep them shared. If the two passes drift, declaration emit can succeed on code the gate rejects, or the reverse. The declaration pass is **additional** to the gate, never a replacement. It compiles only the js target's entry modules plus the ambient `*.d.ts` files. It therefore does not see test files, or sources outside the entry set, the way the project-wide gate does. Do not "optimize" the gate away on the build path.

Key details of the generated tsconfig:

- **`lib` depends on target.** Browser code gets `["ESNext", "DOM", "DOM.Iterable"]`, so `document`, `fetch` and `addEventListener` resolve. That covers an explicit `"browser"` target and *any* HTML entry, which is always browser. Node code gets `["ESNext"]` only, and its globals come from `@types/node`. Without the DOM lib, every HTML and browser project fails with "Cannot find name 'document'".
- **HTML entries ARE type-checked.** They used to be skipped. An HTML project's `.ts` and `.tsx` files are checked before bundling, so a type error in HTML scripts fails the build like any other project. Do not reintroduce an entry-shaped skip. The `tests/gate.dats` case "a type error in an HTML entry fails the build" exists to keep this honest. Its project is staged inline, not kept under `samples/`. Build and test recurse into every nested ts0 project, so a permanently-broken one in the tree fails the repo's own build forever.
- **The configured entry is named in `include`, not just globbed** (`entryTypeCheckPaths`). The compiler skips a dot-directory while it expands a leading wildcard, but never a path segment it was handed. Without this, an entry under `.github/` or `.config/` is bundled against an EMPTY program and the build reports success. A directory entry yields one glob per TS extension, but only when it actually holds TypeScript. A glob that matches nothing aborts with TS18003, instead of letting build-js report "No TypeScript modules found". An HTML entry yields none, because its scripts come from the markup.
- **Empty source sets are skipped, not failed.** `hasTypeScriptSources()` walks the project. With no `.ts`, `.tsx`, `.mts` or `.cts` file, as in a plain-JS HTML entry, the check is a vacuous pass. Without this, `tsc` aborts with `TS18003`, "No inputs were found", and wrongly blocks a valid JS-only build.
- **Nested ts0 projects are excluded**, meaning any subdirectory with its own `ts0.json`, through `findNestedProjectDirs`. Without this, building ts0 itself type-checks `samples/html-jsx/*.tsx` under the root config, which has no JSX, and fails with `TS17004`. A nested project is type-checked on its own when it is built directly.

**Watch mode re-checks on every cycle** for all three commands. A one-shot up-front check lets a later rebuild or re-run slip past:

- `ts0 build --watch` on the JS path adds `typecheckPlugin`. That is an esbuild `onStart` hook. It runs `runTypecheck()` and returns errors on failure, so the bundler skips writing output for a rebuild that does not type-check. The HTML path threads a `typecheck` callback into `buildHtml`. `buildOnce` runs that before each rebuild and bails on failure, writing nothing. Either way the previous good output stays in place, rather than being overwritten with something broken.
- `ts0 test --watch` does **not** use `node --test --watch`. That re-runs tests on change without re-type-checking, which runs an invalid program. `test()` owns the loop instead. An `fsWatch` debounces changes into a `cycle()` that type-checks, then runs the tests one-shot only if the check passes. Do not switch it back to `node --test --watch`. The watcher ignores the compiled test copies a cycle writes, or each run schedules the next one.

### `ts0 test` compiles each test file; it does not strip it

`compileTests` in `commands/test.ts` bundles every discovered test file with `baseEsbuildOptions`, the same settings the build uses. `node --test` then runs the results. Three properties are load-bearing:

- **The format is the source's own.** It comes from the nearest package.json, with `.mts` and `.cts` outranking it, in an extension that states it: `.ts0.cjs` or `.ts0.mjs`. `--experimental-strip-types` only erases annotations. It cannot turn `import` into `require`, so a `"type": "commonjs"` project passed the gate and died inside node on "Cannot use import statement outside a module". Compiling one format into the other is just as wrong. It drops `__dirname`, `require` and `require.main`, or it drops `import.meta`. The test then fails on a global that was there a moment ago. esbuild takes one format per call. The files are therefore grouped by format.
- **The copy is written BESIDE its source**, never under a build directory. A test that reads a fixture through `import.meta.dirname` or `__dirname` has to see the directory it was written in. The copy is deleted in a `finally`. `node --test` output is rewritten to name the source, by `sourceNameRewriter`, from the mapping the compile produced.
- **`require.main === module` in a module under test always fires**, because every module in one bundle shares one module object. Nothing can fix that here. A module under test exports its work and leaves the invocation to the entry file. `tests/node-target.dats` pins this, so it is learned from a test rather than from a mystifying CI failure.

Module resolution in the generated tsconfig follows who consumes the code. A **Node-target single-entry** app uses `NodeNext`, which requires `.ts` extensions. That is the one case where Node's own module system resolves the output. Everything esbuild compiles uses `Bundler` resolution to match esbuild: the **js library target**, any **browser-target** entry, and every **HTML** entry. An extensionless relative import and a loader-backed import, such as `import x from "./y.wgsl"`, therefore type-check exactly as the bundler resolves them.

The gate excludes three things: the output dir, nested ts0 projects, and any directory listed in the config's `exclude` field. That field is for a tree that type-checks under its own separate tsconfig, such as a test harness with different types or an experiment dir. `exclude` never changes what gets built. It changes only what the gate checks.

`typecheckExcludeDirs(config, rootDir)` owns that list. `ts0 test` leaves the same directories out of its own discovery, so it never spawns a test this gate did not check. Nothing on that list goes unchecked, though. See "Nested projects" below for the recursion that covers them.

### Nested projects: recurse, never skip

A subdirectory with its own `ts0.json` is a separate project. **`ts0 build` and `ts0 test` recurse into every one of them.** `findNestedProjectDirs` finds them, then `build` or `testTree` re-enters with that project's config. Depth is unlimited, because each nested run recurses in turn. Every project runs even after one fails, and any failure fails the parent.

This is the whole reason the parent's gate may leave those directories out. A nested project's settings, such as JSX, target and loaders, make it uncheckable under the parent's tsconfig. The parent therefore **delegates** rather than ignores. Never convert that delegation back into a skip. A nested project dropped from both the gate and the recursion is code nothing checks, reported green. Equally, never fold nested files into the parent's own run. They then execute under a config they were not written for, un-type-checked.

`ts0 run` is the one exception, and only because it executes a single entry. It builds its own project (`selfOnly`) and nothing else.

The consequence for this repo: `ts0 build` at the root builds every `samples/*` project, and `ts0 test` runs their tests. A deliberately-broken fixture therefore cannot live in the tree. Stage it inline from a `.dats` test instead.

### Explicit `any` is banned (unconditionally)

`strict` gives `noImplicitAny`. The compiler has **no flag at all** for an *explicit* `any`. ts0 enforces that itself in `commands/explicit-any.ts`, as a second pass inside `runTypecheck()`. The pass runs after tsc. A syntax error is therefore reported as one. Every `any` type annotation is an error: `x: any`, `x as any`, `<any>x`, `any[]`, `Promise<any>`, `type A = any`. There is **no config option and no escape hatch**. The ban applies even with `"strict": false`, exactly like the gate itself. A directory in `exclude` is skipped by this pass too, from the same exclusion list as the gate.

- **It parses. It does not text-search.** `checkNoExplicitAny` loads the TypeScript compiler API through `createRequire(import.meta.url)("typescript")`, the same resolution as the tsc binary, memoized. It then walks for `SyntaxKind.AnyKeyword`, which only ever occurs as a type. A text search fails a valid build on an identifier such as `anyOf`, and on object keys, strings, comments, regexes and JSX prose ("any questions?"). `samples/html-jsx` carries such a tagline on purpose, as the regression guard. Keep it a parse. A cheap `/\bany\b/` pre-filter skips a file that cannot match. A project with none therefore never loads the compiler.
- **Declaration files are scanned.** The gate does not scan them, because its `skipLibCheck` stops tsc from looking inside a `.d.ts`. A hand-written ambient declaration is project source. It is also the easiest place for an `any` to hide.
- The `.d.ts` files ts0 *emits* live in the output dir, which is excluded. They cannot contain an explicit `any` anyway, because the sources they come from cannot.

## JSX

`jsx` and `jsxImportSource` are threaded into esbuild from **both** paths. Those are the Node and TS path in `build.ts`, and the HTML path in `build-html.ts`'s `<script>` bundling. Keep them in sync. If only one path sets them, an HTML and JSX project silently falls back to esbuild's classic `React.createElement` transform, and Preact breaks at runtime.

## HTML entries

When `entry` ends with `.html`, `build.ts` delegates to `commands/build-html.ts`. That module reads the HTML and inlines five classes of dependency:

1. `<script src="local">` -- bundled with esbuild, inlined as `<script>…</script>`.
2. `<script type="module">…inline body…</script>` -- bundled via esbuild's `stdin` API with `resolveDir` set to the HTML's directory, so relative imports in the inline body work.
3. `<link rel="stylesheet" href="local">` -- bundled with esbuild, inlined as `<style>…</style>`. The CSS bundling uses a `dataurl` loader for fonts and images, so a `url(...)` reference inside the CSS becomes a `data:` URL.
4. Runtime-fetched assets. A file under the entry directory, or under a directory named in `assetDirs`, is embedded into a `window.fetch` interceptor at the top of `<head>`. It qualifies when its extension is in `TEXT_ASSET_EXTS` or `BINARY_ASSET_EXTS`, both defined at the top of `src/commands/build-html.ts`. The interceptor template lives at `src/runtime/fetch-interceptor.js`, and carries a `__ASSETS_JSON__` placeholder that the build replaces. Substitute with `replaceAll`, never `replace`. The file's own header comment necessarily mentions the placeholder name.

5. Bookmarklet links. An `href="javascript:<local source file>"`, with a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` extension, is bundled as a browser IIFE, **always minified**. A bookmarklet is a URL, and length is the constraint. It is then percent-encoded with `encodeURIComponent` and substituted back as `javascript:<encoded>`. A real inline-JS href, such as `javascript:void(0)`, does not match the extension test and is left untouched. A file-looking reference that does not exist is a build error. encodeURIComponent escapes quotes, `&`, `#` and whitespace, so the encoded bundle is attribute-safe raw.

`.json` is deliberately not in the asset extension list, so `ts0.json` and `package.json` are not picked up. Disable embedding entirely with `"embedAssets": false` in `ts0.json`.

When `assetDirs` is set in `ts0.json`, `build-html.ts` scans only those directories, relative to rootDir, instead of the HTML entry's directory. An asset key in the interceptor map is relative to rootDir, so `"assetDirs": ["people"]` produces a key such as `people/foo.xml`. The interceptor also exposes `window.__ts0_embedded_paths__`, an array of all embedded asset keys, so client code discovers the available assets at runtime.

An external URL, such as `https://`, `//` or `data:`, is left alone. Every tag attribute on the script or link is preserved, except `src`, `href`, `rel` and `type`.

Keep the HTML parser regex-based and dependency-free -- do not add an HTML parser package.

### Referenced assets (`inlineAssets: false`)

`"inlineAssets": false` (HTML entries only) bundles each referenced local script/stylesheet to its own file under `assetPath` and rewrites the tag's `src`/`href` instead of inlining. Load-bearing invariants:

- **The default is unchanged inline mode.** `inlineAssets` absent or `true` emits exactly the same bytes as before. `assets` comes back empty from `processHtml`, and no other code path differs.
- **Output name = source basename + bundled extension**, with no content hash (`src/main.ts` -> `main.js`). Two sources that want the same name are a **build error naming both**. Never an overwrite, and never an invented suffix.
- **Nothing is written when the pass has errors.** `buildOnce` returns before it writes the HTML or any asset. A new shell therefore never points at a bundle that was not emitted, and in watch mode the previous good output stays.
- **esbuild is given the `outfile`**, and *every* `outputFiles` entry is written. An entry that imports CSS makes esbuild emit a companion `.css`, which lands beside the JS only if esbuild knows the real path.
- `assetPath` is the URL prefix verbatim. Minus a leading `/` or `./`, it is the subdirectory under the HTML's out dir. A `..` in it is a config error, caught by `loadConfig`, not something to sanitize.

Covered by `tests/html-referenced.dats`, not a CI shell step.

### Interceptor template lookup

`build-html.ts` resolves the interceptor template via two candidate paths so both running modes work:

- `<__dirname>/../runtime/fetch-interceptor.js` -- running from source (e.g. `node --experimental-strip-types src/cli.ts build`).
- `<__dirname>/../src/runtime/fetch-interceptor.js` -- running from the bundled `dist/ts0`.

`package.json`'s `"files"` ships both `dist/ts0` and `src/runtime/fetch-interceptor.js` so installs from a published tarball or git URL find the template.

## Userscript bundling (iife + globalName + preserveHeader)

`format: "iife"`, plus the optional `globalName`, is threaded through `baseEsbuildOptions()` like the other formats. It therefore applies to the default and js targets alike. `preserveHeader: true`, on the single-entry target only, re-prepends the entry's leading comment block to the written bundle. esbuild strips comments. But a userscript's `==UserScript==` block, or a mandated license banner, is load-bearing metadata of the OUTPUT file. It must survive byte-exactly at the top. The mechanics are `leadingCommentBlock` plus `preserveHeaderPlugin` in build.ts. An esbuild `onEnd` hook reads the entry and extracts the maximal leading run of `//` lines, or one `/* … */` block, byte-exactly. It then prepends that to the output file. The hook covers the one-shot build and every watch rebuild. Each of those rewrites the file, so headers never stack. The header sits above the bundle's own first line. A leading `"use strict";` stays an effective directive. Comments never break the directive prologue. esbuild emits that directive when the consumer project's tsconfig sets `alwaysStrict` or `strict`. A Node-target outfile keeps its `#!/usr/bin/env node` shebang. A browser-target outfile gets none, because a shebang is a Node convenience and corrupts a userscript header.

## js (library) target

When `entry` resolves to a **directory**, and not to a `.ts` or `.html` file, `build.ts` delegates to `commands/build-js.ts`. `isJsTarget` does that directory check, after `isHtmlEntry`. This target compiles every `*.ts`, `*.tsx`, `*.mts` and `*.cts` file under the directory as a separate esbuild entry point. `outbase` is the entry dir and `outdir` is `dist`. The source tree is therefore mirrored (`src/webgpu/sky.ts` -> `dist/webgpu/sky.js`). `*.d.ts`, `*.test.*` and `*.spec.*` are skipped.

Code shared across entries is **deduplicated**, not duplicated. `splitting: true` is enabled for `esm` output. A module imported by two or more entries is then emitted once into a chunk and imported, rather than inlined into every output. A consumer still imports a single entry file, and the browser fetches any shared chunk transitively. A non-shared local import stays inlined, as does a loader-backed import such as `.wgsl` text. `"bundleShared": false` turns splitting off, to force self-contained outputs that duplicate. It is a first-class option, NOT the `esbuild` escape hatch, which is slated for removal along with esbuild itself. Splitting is only expressible for `esm`, so every other format duplicates regardless.

It is mutually exclusive with the HTML target and the default single-entry target. `outfile` is ignored, because output always goes to `outdir`. `ts0 run` rejects it, because there is no single entry to run. The non-output esbuild options, such as platform, format and jsx, come from `baseEsbuildOptions()` in `commands/esbuild-base.ts`. The default target shares that function. The two therefore cannot drift.

## Dependency bundling (`bundleDependencies`)

A node-target build leaves an imported package as a `require("pkg")` call, through esbuild's `packages: "external"`. That is right for a CLI installed alongside its node_modules. `"bundleDependencies": true` compiles those packages in instead, for an artifact that must run where its node_modules does not exist. One example is a GitHub Action, whose release tag ships `dist/` and nothing else. It is threaded through `baseEsbuildOptions`, so `external` still wins per specifier. A native addon or a peer dependency opts back out that way.

The default stays external. ts0 builds ITSELF with the node target and resolves `typescript` at run time through `createRequire`. Bundling its dependencies breaks that, and tries to compile esbuild's native module in.

## External imports (`external`)

`external` lists import specifiers that stay **references** in the output. The import statement is emitted verbatim, and the target's contents are never pulled in. It is threaded through `baseEsbuildOptions()`, so the single-entry and js targets both honor it. "This import is resolved at runtime" is a property of the code, not of which target compiles it.

The motivating case is a CSS module script, `import s from "./x.css" with { type: "css" }`, which the browser resolves and constructs itself. Two more are a peer dependency a library must not embed, and an import-map entry.

- **It is ts0 vocabulary, not an esbuild passthrough.** The `esbuild` escape hatch and esbuild itself are slated for removal. `external` is defined in terms of import specifiers, and must survive a bundler swap. Do not reintroduce it as a raw passthrough, and do not document it in esbuild's terms.
- **It must never become a way to silence an unsupported import.** An import the bundler cannot handle must keep failing the build with nothing written, unless `external` lists it. That hard failure is the whole guardrail. Silent inlining puts stylesheet text into the JS and defeats the feature. `tests/samples.dats` carries "an unsupported CSS-type import errors instead of silently inlining" to keep this honest. If that test ever starts passing, the guardrail is gone.
- Matching is by specifier as written, never by resolved file path: `"./styles.css"`, `"lit"`, or `"*.css"` with `*` matching any run of characters.
- An external import is still type-checked. The sample pairs one with an ambient `declare module "*.css"`.

Type-checking for this target uses `moduleResolution: "Bundler"`. See "Type-checking" above. For a loader-backed import, such as `.wgsl` as text, set the loader with the `loaders` config field, `{ ".wgsl": "text" }`, which `baseEsbuildOptions` threads into esbuild. Provide an ambient `declare module "*.wgsl"` so the import also type-checks. esbuild does the actual inlining. ts0 applies no loaders by default. The `esbuild.loader` escape hatch still works, and overrides `loaders`.

### Declaration emit (js target only)

Unless `"declarations": false`, the js target emits a parallel `*.d.ts` tree into outdir, beside the `*.js` outputs (`src/ui/x.ts` -> `dist/ui/x.js` plus `dist/ui/x.d.ts`). A deployed library therefore ships types at the same URLs as its code. For the mechanics, see `emitDeclarations` in build.ts and `declarationsPlugin` in build-js.ts:

- It is a second tsc pass, with `declaration`, `emitDeclarationOnly` and `noEmitOnError`, `outDir` set to the build outdir and `rootDir` set to the entry dir. It covers **exactly the entry-point set esbuild compiled**, plus the project's ambient `*.d.ts` files. `collectAmbientDeclarations` gathers those, so a loader-backed import resolves. An ambient input emits nothing and is exempt from `rootDir`. Two consequences follow. A test file and esbuild's `chunk-*.js` never get a `.d.ts`, and a `*.d.ts` source is not copied.
- It runs in an esbuild `onEnd` hook, one-shot AND watch, only after a successful build. An emit failure fails the build. `noEmitOnError` makes it all-or-nothing, so no partial `.d.ts` tree can land. `ts0 run` and `ts0 test` never invoke it, because they must not write output.
- Emitted declarations **keep source specifiers**, explicit `.ts` and `.tsx` extensions included. That is the standard shape for an `allowImportingTsExtensions` project. A consumer resolves `./x.ts` inside a `.d.ts` by extension substitution (`.ts` -> `.tsx` -> `.d.ts`) to the deployed sibling `x.d.ts`. This was verified under both bundler and NodeNext consumer resolution. Do NOT add `rewriteRelativeImportExtensions`. It rewrites JavaScript emit only, never declarations, and is unnecessary.
- Output is deterministic: one input gives byte-identical `.d.ts`. CI asserts this, because a consumer commits a fetched copy and diffs it.
- One known constraint. An entry that imports a source file **outside the entry directory** fails the pass with TS6059, loudly and with nothing written. A mirrored tree cannot represent such an import. The opt-out is `"declarations": false`.

## Distributing

Three consumption paths:

- **`action.yml` (repo root) for GitHub Actions consumers.** `uses: wow-look-at-my/ts0@master`, with no inputs, downloads the prebuilt `ts0.cjs` below and runs `test` then `build`. See the README's "GitHub Actions" section. It takes **no command input**. A caller that chooses the command can choose `--help`, a green check for zero work. `tests/action.dats` asserts three things. Both commands still run, in that order. No `node` line in the action interpolates an expression. The input set is exactly working-directory. Keep it that way.
- **Prebuilt ts0.cjs on buildhost, the primary path for non-npm consumers.** Some machines carry stock Node but no npm, no node_modules and no git: webhook-runner's `//go:generate` step, a CI image, a container. Each downloads one platform-neutral JavaScript file from `https://dl.pazer.build/ts0?...` and runs it with `node`, or pipes it as `curl ... | node - build`. See the README's "Prebuilt ts0.cjs" section for the URLs and the pinning semantics, and "Prebuilt ts0.cjs" below for how it is built. Recommend a `?v=N` pin to a consumer that needs reproducible output.
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
