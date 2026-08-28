# CLAUDE.md

Notes for Claude working in this repository.

## What this project is

`ts0` &mdash; a small TypeScript framework CLI that wraps esbuild, the TypeScript
compiler, and Node's built-in test runner. The repository directory is named
`bundler`; the published package and binary are both named `ts0`.

The CLI exposes four commands: `init`, `build`, `run`, `test`. See `README.md` for
user-facing documentation.

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
    action.dats         # action.yml: always test then build, no command input
.github/workflows/ci.yml
ts0.json                # ts0 builds itself with these settings
```

`ts0` is self-hosting: `package.json`'s `build` script invokes the CLI from
source via `node --experimental-strip-types src/cli.ts build`, which reads the
repo's own `ts0.json` and produces `dist/ts0`. Every `samples/*` directory is a
nested ts0 project, so that one command builds them too &mdash; see "Nested
projects" under Type-checking.

## Runtime requirements

- Node.js **22 or newer**. The CLI relies on `--experimental-strip-types` and
    the built-in `node --test` runner, both Node 22+ features. Do not lower the
    `engines.node` field.
- This is a Node/TypeScript project. **Do not** apply the `go-toolchain` rules
    here &mdash; they do not apply.

## Working on the code

```sh
npm install
npm run build                                       # build dist/ts0
node --experimental-strip-types src/cli.ts <cmd>    # run from source without building
npm link && dats test tests/                        # behavioural suites (needs bwrap)
```

The suites need the linked `ts0` on PATH (hence `npm link`) and bubblewrap for
the sandbox; `.dats` files are tab-indented YAML.

Unit tests are every `src/**/*.test.ts` (`node --experimental-strip-types
--test`), and every `tests/*.dats` file is a behavioural suite run by
[dats](https://github.com/wow-look-at-my/dats): CI builds `dist/ts0`, `npm
link`s it, and each suite stages a project and asserts what the build WROTE.
A staged project gets the repo's `node_modules` symlinked in, the position it
resolves `@types/node`/`preact` from when built in place. `network: false` on
every file proves a build never needs one; CI itself runs `--no-sandbox` (the
org's self-hosted runner denies unprivileged user namespaces), so run the
suites locally (with bwrap installed) to exercise the sandboxed contract.
What each suite and each CI step actually covers: `docs/testing.md`.

If you change CLI behavior, update the relevant `samples/*` and the matching
`tests/*.dats` suite so the new behavior is covered.

## Conventions

- **Indentation:** tabs (4-wide), per `.editorconfig`. Match this in every file.
- **Modules:** ESM only (`"type": "module"`). Use `.ts` extensions in relative
    imports (e.g. `import { build } from "./commands/build.ts"`) so
    `--experimental-strip-types` resolves them.
- **Dependencies:** keep them minimal. Production deps are `esbuild`,
    `typescript`, and `@types/node` (ts0 embeds and re-exposes it via
    `typeRoots` so a Node-target project needs no install of its own -- see
    docs/prebuilt-ts0-cjs.md). The one dev dep is `preact`, only so the
    `samples/html-jsx` regression sample can resolve `preact/jsx-runtime` when
    CI builds it. Don't add a CLI parser, a test framework, or a bundler
    abstraction &mdash; the whole point is that ts0 stays small.
- **Argument parsing:** `src/cli.ts` parses `process.argv` by hand. New commands
    should follow the same pattern (no new dependency).

## Output: colors + GitHub Actions annotations

`reporter.ts` is the one place that formats a diagnostic for display: ANSI
color (forced on under `GITHUB_ACTIONS=true`, since its log viewer renders
color despite stdout being a pipe) and `::error::`/`::warning::` annotations
(no-op outside Actions). Depth, including why esbuild's own logging is off:
`docs/reporter.md`.

## Configuration model

`config.ts` defines `Ts0Config` and a single `DEFAULT_CONFIG` object. When
adding a new option:

1. Add the field to the `Ts0Config` interface and `DEFAULT_CONFIG`.
2. If it changes build behavior shared by the default and js targets, thread it
    through `baseEsbuildOptions()` in `commands/esbuild-base.ts` (both targets
    call it); target-specific options live in `build.ts` / `build-js.ts`. The
    user-supplied `esbuild` field is spread last so it stays an escape hatch
    &mdash; keep it that way.
3. Document it in `README.md`'s configuration table.

`loadConfig()` walks up from the cwd looking for `ts0.json` and falls back to
defaults plus auto-detected entry. Don't break the no-config-file path.

## Type-checking

**Type-checking is an unskippable gate: there is NO way to build or run code
that hasn't passed `tsc`.** The exported `runTypecheck(config, rootDir)` is the
single chokepoint, called from every command that emits or executes code:

- `build()` runs it before it emits anything and returns a failed `BuildResult`
    (no output written) on failure. Every path that produces output goes through
    `build()` (`ts0 build`, `ts0 run` without `--no-build`, and any programmatic
    caller), so none can emit an un-checked artifact. Do **not** move the check
    back up into the command layer &mdash; that reintroduces the hole where
    `ts0 run` bundled and executed un-type-checked code.
- `run()` runs it for the `--no-build` path before handing sources to
    `node --experimental-strip-types`. Strip-types only *erases* annotations, it
    does **not** type-check, so without this gate `ts0 run --no-build` would
    execute broken code. `--no-build` therefore skips only the bundle/artifact,
    never the check.
- `test()` runs it before spawning `node --test`. The test runner uses
    `--experimental-strip-types` too, so an un-checked test run would execute an
    invalid program. A type error anywhere in the project fails `ts0 test` and no
    test process is spawned.

The gate is more than `tsc`: it also bans explicit `any` (see "Explicit `any`
is banned" below), so everything said here about unskippability covers that
ban too.

There is intentionally **no escape hatch** &mdash; every command that runs or
emits code type-checks first. If you add a new command (or a new branch in an
existing one) that runs/emits code, it MUST call `runTypecheck()` first and bail
on failure. The only thing `--no-build` and the like may skip is the
bundle/artifact, never the check.

`runTypecheck()` writes a temporary `.ts0-tsconfig.json` (gitignored), runs
`tsc --noEmit` against it, and deletes it in a `finally`. The TypeScript binary
is resolved from `ts0`'s own `node_modules` via `createRequire` so the user's
project doesn't need its own `typescript` install. Preserve both behaviors.
`build()`, `run()`, and `test()` each already hold a loaded config, so they call
`runTypecheck(config, rootDir)` directly rather than re-loading.

The tsconfig generation is shared: `generatedCompilerOptions(config, rootDir)`
builds the compiler options used by BOTH the gate and the js target's
declaration emit (`emitDeclarations`, temp file `.ts0-tsconfig-emit.json`, also
gitignored), and `runTsc()` owns the write-temp-tsconfig/exec/cleanup plumbing
for both. Keep them shared &mdash; if the two passes drift, declaration emit
can succeed on code the gate rejects (or vice versa). The declaration pass is
**additional** to the gate, never a replacement: it compiles only the js
target's entry modules (+ ambient `*.d.ts`), so it does not see test files or
sources outside the entry set the way the project-wide gate does. Do not
"optimize" the gate away on the build path.

Key details of the generated tsconfig:

- **`lib` depends on target.** Browser code (an explicit `"browser"` target, or
    *any* HTML entry &mdash; always browser) gets `["ESNext", "DOM", "DOM.Iterable"]`
    so `document`/`fetch`/`addEventListener` resolve. Node code gets `["ESNext"]`
    only; its globals come from `@types/node`. Without the DOM lib, every
    HTML/browser project would fail with "Cannot find name 'document'".
- **HTML entries ARE type-checked.** (They used to be skipped.) An HTML project's
    `.ts`/`.tsx` files are checked before bundling, so a type error in HTML
    scripts fails the build like any other project. Do not reintroduce an
    entry-shaped skip; the `tests/gate.dats` case "a type error in an HTML
    entry fails the build" exists to keep this honest. Its project is staged
    inline, not kept under `samples/`: build and test recurse into every
    nested ts0 project, so a permanently-broken one in the tree would fail the
    repo's own build forever.
- **The configured entry is named in `include`, not just globbed**
    (`entryTypeCheckPaths`). tsc skips dot-directories while expanding a leading
    wildcard but never a path segment it was handed, so without this an entry
    under `.github/`, `.config/`, … is bundled against an EMPTY program and the
    build reports success. A directory entry yields one glob per TS extension,
    but only when it actually holds TypeScript &mdash; globs matching nothing
    would abort with TS18003 instead of letting build-js report "No TypeScript
    modules found". An HTML entry yields none (its scripts come from the markup).
- **Empty source sets are skipped, not failed.** `hasTypeScriptSources()` walks
    the project; if there are no `.ts/.tsx/.mts/.cts` files (e.g. a plain-JS HTML
    entry), the check is a vacuous pass. Without this, `tsc` aborts with `TS18003`
    "No inputs were found" and would wrongly block a perfectly valid JS-only build.
- **Nested ts0 projects are excluded** (any subdirectory with its own `ts0.json`,
    via `findNestedProjectDirs`). Without this, building ts0 itself would
    type-check `samples/html-jsx/*.tsx` under the root config (no JSX) and fail
    with `TS17004`. A nested project is type-checked on its own when built directly.

**Watch mode re-checks on every cycle** for all three commands &mdash; a one-shot
up-front check would let later rebuilds/re-runs slip past:

- `ts0 build --watch` (JS) adds `typecheckPlugin`, an esbuild `onStart` hook that
    runs `runTypecheck()` and returns errors on failure, so esbuild skips writing
    output for a rebuild that doesn't type-check. The HTML path threads a
    `typecheck` callback into `buildHtml`, which `buildOnce` runs before each
    rebuild and bails (writing nothing) on failure. Either way the previous good
    output stays in place rather than being overwritten with something broken.
- `ts0 test --watch` does **not** use `node --test --watch` (it re-runs tests on
    change without re-type-checking, which would run an invalid program). Instead
    `test()` owns the loop: an `fsWatch` debounces changes into a `cycle()` that
    type-checks, then runs the tests one-shot only if the check passes. Do not
    switch it back to `node --test --watch`.

Module resolution in the generated tsconfig follows who consumes the code: a
**Node-target single-entry** app &mdash; the one case where the output is
resolved by Node's own module system &mdash; uses `NodeNext` (`.ts` extensions
required), while everything esbuild compiles &mdash; the **js library target**,
any **browser-target** entry, and **HTML** entries &mdash; uses `Bundler`
resolution to match esbuild, so extensionless relative imports and
loader-backed imports (`import x from "./y.wgsl"`) type-check exactly as the
bundler resolves them.

The gate's exclusions are the output dir, nested ts0 projects, and any
directories listed in the config's `exclude` field (for trees that type-check
under their own separate tsconfig &mdash; a test harness with different types,
an experiment dir). `exclude` never changes what gets built, only what the
gate checks.

`typecheckExcludeDirs(config, rootDir)` owns that list, and `ts0 test` leaves
the same directories out of its own discovery, so it never spawns a test this
gate did not check. Nothing on that list goes unchecked, though &mdash; see
"Nested projects" below for the recursion that covers them.

### Nested projects: recurse, never skip

A subdirectory with its own `ts0.json` is a separate project, and **`ts0 build`
and `ts0 test` recurse into every one of them** (`findNestedProjectDirs`, then
`build`/`testTree` re-entering with that project's config). Depth is unlimited
&mdash; each nested run recurses in turn &mdash; every project runs even after
one fails, and any failure fails the parent.

This is the whole reason the parent's gate may leave those directories out: a
nested project's settings (JSX, target, loaders) make it uncheckable under the
parent's tsconfig, so the parent **delegates** rather than ignores. Never
convert that delegation back into a skip &mdash; a nested project dropped from
both the gate and the recursion is code nothing checks, reported green. Equally,
never fold nested files into the parent's own run: they would execute under a
config they were not written for, un-type-checked.

`ts0 run` is the one exception, and only because it executes a single entry:
it builds its own project (`selfOnly`) and nothing else.

Consequence for this repo: `ts0 build` at the root builds every `samples/*`
project, and `ts0 test` runs their tests. A deliberately-broken fixture
therefore cannot live in the tree &mdash; stage it inline from a `.dats` test
instead.

### Explicit `any` is banned (unconditionally)

`strict` gives `noImplicitAny`; tsc has **no flag at all** for an *explicit*
`any`, so ts0 enforces that itself in `commands/explicit-any.ts`, as a second
pass inside `runTypecheck()` (after tsc, so a syntax error is reported as
one). Every `any` type annotation is an error &mdash; `x: any`, `x as any`,
`<any>x`, `any[]`, `Promise<any>`, `type A = any` &mdash; and there is **no
config option and no escape hatch**: the ban applies even with
`"strict": false`, exactly like the gate itself. A directory in `exclude` is
skipped by this pass too (same exclusion list as the gate).

- **It parses; it does not text-search.** `checkNoExplicitAny` loads the
    TypeScript compiler API (`createRequire(import.meta.url)("typescript")`,
    same resolution as the tsc binary, memoized) and walks for
    `SyntaxKind.AnyKeyword`, which only ever occurs as a type. A text search
    would fail valid builds on identifiers (`anyOf`), object keys, strings,
    comments, regexes, and JSX prose ("any questions?") &mdash;
    `samples/html-jsx` carries such a tagline on purpose as the regression
    guard. Keep it a parse. A cheap `/\bany\b/` pre-filter skips files that
    can't match, so a project with none never even loads the compiler.
- **Declaration files are scanned** (unlike the gate, whose `skipLibCheck`
    means tsc never looks inside a `.d.ts`) &mdash; a hand-written ambient
    declaration is project source, and it is the easiest place for an `any`
    to hide.
- The `.d.ts` files ts0 *emits* live in the output dir, which is excluded, and
    can't contain an explicit `any` anyway (the sources they come from can't).

## JSX

`jsx`/`jsxImportSource` are threaded into esbuild from **both** the Node/TS path
(`build.ts`) and the HTML path (`build-html.ts`'s `<script>` bundling). Keep them
in sync: if only one path sets them, HTML+JSX projects silently fall back to
esbuild's classic `React.createElement` transform and break Preact at runtime.

## HTML entries

When `entry` ends with `.html`, `build.ts` delegates to `commands/build-html.ts`.
That module reads the HTML and inlines five classes of dependency:

1. `<script src="local">` &mdash; bundled with esbuild, inlined as `<script>…</script>`.
2. `<script type="module">…inline body…</script>` &mdash; bundled via esbuild's
    `stdin` API with `resolveDir` set to the HTML's directory, so relative imports
    in the inline body work.
3. `<link rel="stylesheet" href="local">` &mdash; bundled with esbuild, inlined as
    `<style>…</style>`. The CSS bundling uses a `dataurl` loader for fonts and
    images so `url(...)` references inside the CSS become `data:` URLs.
4. Runtime-fetched assets &mdash; files under the entry directory (or directories
    specified by `assetDirs`) matching the text-asset extensions in
    `TEXT_ASSET_EXTS` and binary-asset extensions in `BINARY_ASSET_EXTS`
    (both defined at the top of `src/commands/build-html.ts`) are embedded
    into a `window.fetch` interceptor inserted at the top of `<head>`. The
    interceptor template lives at
    `src/runtime/fetch-interceptor.js` &mdash; it has a `__ASSETS_JSON__`
    placeholder that's replaced at build time. Use `replaceAll` (not `replace`)
    when substituting; the file's own header comment necessarily mentions the
    placeholder name.

5. Bookmarklet links &mdash; an `href="javascript:<local source file>"`
    (extension `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`) is bundled as a
    browser IIFE, **always minified** (a bookmarklet is a URL; length is the
    constraint), percent-encoded with `encodeURIComponent`, and substituted
    back as `javascript:<encoded>`. Real inline-JS hrefs
    (`javascript:void(0)`) don't match the extension test and are left
    untouched; a file-looking reference that doesn't exist is a build error.
    encodeURIComponent escapes quotes/`&`/`#`/whitespace, so the encoded
    bundle is attribute-safe raw.

`.json` is deliberately not in the asset extension list, so `ts0.json` and
`package.json` aren't picked up. Disable embedding entirely with
`"embedAssets": false` in `ts0.json`.

When `assetDirs` is set in `ts0.json`, `build-html.ts` scans only those
directories (relative to rootDir) instead of the HTML entry's directory.
Asset keys in the interceptor map are relative to rootDir, so
`"assetDirs": ["people"]` produces keys like `people/foo.xml`. The
interceptor also exposes `window.__ts0_embedded_paths__` &mdash; an array
of all embedded asset keys &mdash; so client code can discover available
assets at runtime.

External URLs (`https://`, `//`, `data:`, etc.) are left alone. Tag attributes
on the script/link (other than `src`/`href`/`rel`/`type`) are preserved.

Keep the HTML parser regex-based and dependency-free &mdash; do not add an HTML
parser package.

### Referenced assets (`inlineAssets: false`)

`"inlineAssets": false` (HTML entries only) bundles each referenced local
script/stylesheet to its own file under `assetPath` and rewrites the tag's
`src`/`href` instead of inlining. Load-bearing invariants:

- **The default is unchanged inline mode.** `inlineAssets` absent or `true`
    emits exactly the same bytes as before; `assets` comes back empty from
    `processHtml` and no other code path differs.
- **Output name = source basename + bundled extension**, no content hash
    (`src/main.ts` &rarr; `main.js`). Two sources that want the same name are a
    **build error naming both** &mdash; never an overwrite, never an invented
    suffix.
- **Nothing is written when the pass has errors.** `buildOnce` returns before
    writing the HTML or any asset, so a new shell can never point at bundles
    that were not emitted (and in watch mode the previous good output stays).
- **esbuild is given the `outfile`**, and *every* `outputFiles` entry is
    written &mdash; an entry that imports CSS makes esbuild emit a companion
    `.css`, which only lands beside the JS if esbuild knows the real path.
- `assetPath` is the URL prefix verbatim; minus a leading `/` or `./` it is the
    subdirectory under the HTML's out dir. `..` in it is a config error
    (`loadConfig`), not something to sanitize.

Covered by `tests/html-referenced.dats`, not a CI shell step.

### Interceptor template lookup

`build-html.ts` resolves the interceptor template via two candidate paths so
both running modes work:

- `<__dirname>/../runtime/fetch-interceptor.js` &mdash; running from source
    (e.g. `node --experimental-strip-types src/cli.ts build`).
- `<__dirname>/../src/runtime/fetch-interceptor.js` &mdash; running from the
    bundled `dist/ts0`.

`package.json`'s `"files"` ships both `dist/ts0` and
`src/runtime/fetch-interceptor.js` so installs from a published tarball or
git URL find the template.

## Userscript bundling (iife + globalName + preserveHeader)

`format: "iife"` (plus optional `globalName`) is threaded through
`baseEsbuildOptions()` like the other formats, so it applies to the default and
js targets alike. `preserveHeader: true` (single-entry target only) re-prepends
the entry's leading comment block to the written bundle: esbuild strips
comments, but a userscript's `==UserScript==` block (or a mandated license
banner) is load-bearing metadata of the OUTPUT file and must survive
byte-exactly at the top. Mechanics (`leadingCommentBlock` +
`preserveHeaderPlugin` in build.ts): an esbuild `onEnd` hook &mdash; covering
the one-shot build and every watch rebuild, each of which rewrites the file, so
headers never stack &mdash; reads the entry, extracts the maximal leading run
of `//` lines (or one `/* … */` block) byte-exactly, and prepends it to the
output file. The header sits above the bundle's own first line; a leading
`"use strict";` (esbuild emits one when the consumer project's tsconfig sets
`alwaysStrict`/`strict`) stays an effective directive because comments never
break the directive prologue. Node-target outfiles keep their
`#!/usr/bin/env node` shebang; browser-target outfiles get none (a shebang is
a Node convenience and would corrupt a userscript header).

## js (library) target

When `entry` resolves to a **directory** (not a `.ts`/`.html` file), `build.ts`
delegates to `commands/build-js.ts` (`isJsTarget` does the directory check;
checked after `isHtmlEntry`). This target compiles every `*.ts`/`*.tsx`/`*.mts`/
`*.cts` under the directory as a separate esbuild entry point, with
`outbase` = the entry dir and `outdir` = `dist`, so the source tree is mirrored
(`src/webgpu/sky.ts` → `dist/webgpu/sky.js`). `*.d.ts` and `*.test.*`/`*.spec.*`
are skipped.

Code shared across entries is **deduplicated**, not duplicated: `splitting: true`
(enabled for `esm` output) makes esbuild emit a module imported by 2+ entries
once into a chunk and import it, rather than inlining a copy into every output.
A consumer still imports a single entry file — the browser fetches any shared
chunk transitively. Non-shared local imports and loader-backed imports (`.wgsl`
text, etc.) stay inlined. `"bundleShared": false` turns splitting off to force
self-contained (duplicating) outputs — a first-class option, NOT the `esbuild`
escape hatch, which is slated for removal along with esbuild itself. Splitting is
only expressible for `esm`, so other formats duplicate regardless.

It is mutually exclusive with the HTML target and the default single-entry
target. `outfile` is ignored (always `outdir`), and `ts0 run` rejects it (no
single entry to run). The non-output esbuild options (platform, format, jsx, …)
come from `baseEsbuildOptions()` in `commands/esbuild-base.ts`, shared with the
default target so the two can't drift.

## External imports (`external`)

`external` lists import specifiers that stay **references** in the output: the
import statement is emitted verbatim and the target's contents are never pulled
in. It is threaded through `baseEsbuildOptions()`, so the single-entry and js
targets both honor it — "this import is resolved at runtime" is a property of
the code, not of which target compiles it.

The motivating case is a CSS module script
(`import s from "./x.css" with { type: "css" }`), which the browser resolves and
constructs itself; also peer dependencies a library must not embed, and import-map
entries.

- **It is ts0 vocabulary, not an esbuild passthrough.** The `esbuild` escape
    hatch and esbuild itself are slated for removal; `external` is defined in
    terms of import specifiers and must survive a bundler swap. Do not
    reintroduce it as a raw passthrough or document it in esbuild's terms.
- **It must never become a way to silence an unsupported import.** An import
    the bundler cannot handle and that is NOT listed in `external` has to keep
    failing the build, with nothing written. That hard failure is the whole
    guardrail: silent inlining would put stylesheet text into the JS and defeat
    the feature. `tests/samples.dats` carries "an unsupported CSS-type import
    errors instead of silently inlining" specifically to keep this honest — if
    that test ever starts passing, the guardrail is gone.
- Matching is by specifier as written (`"./styles.css"`, `"lit"`, `"*.css"`
    with `*` matching any run of characters), never by resolved file path.
- External imports are still type-checked; the sample pairs one with an ambient
    `declare module "*.css"`.

Type-checking for this target uses `moduleResolution: "Bundler"` (see
"Type-checking" above). For loader-backed imports (e.g. `.wgsl` as text), set
the loader with the `loaders` config field (`{ ".wgsl": "text" }`, threaded into
esbuild by `baseEsbuildOptions`) and provide an ambient `declare module "*.wgsl"`
so the import also type-checks; esbuild does the actual inlining. ts0 applies no
loaders by default. (The `esbuild.loader` escape hatch still works and overrides
`loaders`.)

### Declaration emit (js target only)

Unless `"declarations": false`, the js target emits a parallel `*.d.ts` tree
into outdir next to the `*.js` outputs (`src/ui/x.ts` → `dist/ui/x.js` +
`dist/ui/x.d.ts`), so a deployed library ships types at the same URLs as its
code. Mechanics (see `emitDeclarations` in build.ts and `declarationsPlugin`
in build-js.ts):

- It is a second tsc pass (`declaration` + `emitDeclarationOnly` +
    `noEmitOnError`, `outDir` = the build outdir, `rootDir` = the entry dir)
    over **exactly the entry-point set esbuild compiled** plus the project's
    ambient `*.d.ts` files (`collectAmbientDeclarations` &mdash; needed so
    loader-backed imports resolve; ambient inputs emit nothing and are exempt
    from `rootDir`). Consequences: test files and esbuild's `chunk-*.js` never
    get a `.d.ts`, and `*.d.ts` sources aren't copied.
- It runs in an esbuild `onEnd` hook, one-shot AND watch, only after a
    successful build; an emit failure fails the build. `noEmitOnError` makes
    it all-or-nothing &mdash; no partial `.d.ts` tree can ever land. `ts0 run`
    / `ts0 test` never invoke it (they must not write output).
- Emitted declarations **keep source specifiers**, including explicit
    `.ts`/`.tsx` extensions &mdash; that is the standard shape for
    `allowImportingTsExtensions` projects. Consumers resolve `./x.ts` inside a
    `.d.ts` via extension substitution (`.ts` → `.tsx` → `.d.ts`) to the
    deployed sibling `x.d.ts`; verified under both bundler and NodeNext
    consumer resolution. Do NOT add `rewriteRelativeImportExtensions`: it
    rewrites JavaScript emit only (never declarations) and is unnecessary.
- Output is deterministic (same input → byte-identical `.d.ts`); CI asserts
    this, because consumers commit fetched copies and diff them.
- Known constraint: an entry importing a source file **outside the entry
    directory** fails the pass with TS6059 (a mirrored tree can't represent
    it), loudly and with nothing written. The opt-out is
    `"declarations": false`.

## Distributing

Three consumption paths:

- **`action.yml` (repo root) for GitHub Actions consumers.** `uses:
    wow-look-at-my/ts0@master`, with no inputs, downloads the prebuilt
    `ts0.cjs` below and runs `test` then `build` &mdash; see the README's
    "GitHub Actions" section. It takes **no command input**: a caller choosing
    the command can choose `--help`, a green check for zero work.
    `tests/action.dats` asserts both commands still run, in that order, that no
    `node` line in the action interpolates an expression, and that the input
    set is exactly working-directory. Keep it that way.
- **Prebuilt ts0.cjs on buildhost (primary for non-npm consumers).**
    Machines with stock Node but no npm/node_modules/git &mdash;
    webhook-runner's `//go:generate` step, CI images, containers &mdash;
    download one platform-neutral JavaScript file from
    `https://dl.pazer.build/ts0?...` and run it with `node` (or pipe it:
    `curl ... | node - build`). See the README's "Prebuilt ts0.cjs" section
    for URLs and pinning semantics, and "Prebuilt ts0.cjs" below for how it is
    built. Recommend `?v=N` pins to consumers that need reproducible output.
- **npm / git installs (for node projects).**
    `npm install github:wow-look-at-my/bundler`: `package.json` has a `prepare`
    script that runs `npm run build`; npm runs `prepare` automatically when
    installing from a git URL, so `dist/ts0` is built on the consumer's machine
    and `npx ts0 …` works without a separate build step. The `"files"` field is
    irrelevant for git installs but matters for `npm publish` &mdash; keep
    `dist/ts0` and `src/runtime/fetch-interceptor.js` in it. js-snippets
    consumes ts0 this way; the prebuilt machinery must never change this
    path's behavior (see the npm-path invariant in docs/prebuilt-ts0-cjs.md).

## Prebuilt ts0.cjs (buildhost packaging)

`scripts/build-prebuilt.ts` packages ts0 for buildhost as ONE platform-neutral
CommonJS file plus five small platform-native esbuild binaries; CI publishes them
on merges to master, and consumers run `node ts0.cjs <cmd>` on stock Node >= 22
with no npm. CommonJS, `.cjs`, and stdin-runnable are all load-bearing; the
compiler is embedded exactly once; and nothing in shared code may depend on the
bundle's own path.

- docs/prebuilt-ts0-cjs.md -- the whole contract: bundle contents, the generated
    `bin/tsc` driver, cache extraction, the esbuild native fetch, the npm-path
    invariant, what must stay in sync on a dependency bump, and CI/publish.

## Documentation

Per global instructions: when you change project structure, commands, config
fields, or tooling, update `README.md` and this file in the same commit. Don't
let the docs drift.

## Git workflow

- Develop on the branch the task specifies.
- Commit and push frequently; the VM can reset.
- PRs in this org are squash-merged &mdash; don't rebase or force-push.
