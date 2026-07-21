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
    commands/
        init.ts         # scaffolds ts0.json + src/ + package.json
        build.ts        # type-check gate (runTypecheck) + declaration emit (emitDeclarations) + esbuild bundle (dispatches HTML/js)
        build-html.ts   # bundles an .html entry into a single inlined .html
        build-js.ts     # compiles a directory entry into a parallel .js (+ .d.ts) tree (type-checked)
        esbuild-base.ts # baseEsbuildOptions() shared by build.ts + build-js.ts
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
    js/                 # directory-entry "js" library target sample (CI)
.github/workflows/ci.yml
ts0.json                # ts0 builds itself with these settings
```

`ts0` is self-hosting: `package.json`'s `build` script invokes the CLI from
source via `node --experimental-strip-types src/cli.ts build`, which reads the
repo's own `ts0.json` and produces `dist/ts0`.

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
```

The only unit test is `src/runtime/fetch-interceptor.test.ts` (run in CI via
`node --experimental-strip-types --test`), which evaluates the single-file fetch
interceptor against a window/document shim and asserts it serves embedded assets
for string, `URL`-object, and `Request` fetch inputs. Otherwise CI exercises the
CLI end-to-end by:

1. Building `dist/ts0` from source.
2. `npm link`ing it.
3. Running `ts0 init`, `build`, `run`, `test` against a fresh tmp project.
4. Running `ts0 build` and `ts0 test` against `samples/basic`.
5. Running `ts0 build` against `samples/html` and asserting the bundled JS/CSS
    are inlined into a single `dist/index.html`.
6. Running `ts0 build` against `samples/html-jsx` and asserting the JSX compiled
    to the automatic Preact runtime (`preact/jsx-runtime`) with no
    `React.createElement`/`React.Fragment` &mdash; the regression guard for the
    "React is not defined" bug where JSX config wasn't threaded into the HTML
    build path. (Both HTML samples also now exercise the type-check on the HTML
    path, since HTML entries are type-checked rather than skipped.)
7. Running `ts0 build` against `samples/js` (a **directory** entry) and asserting
    the js library target compiled every `src/**/*.ts` to a parallel
    `dist/**/*.js`, skipped `*.d.ts`, **deduplicated** a shared module into a
    chunk (the shared body appears in exactly one output file, not copied into
    each importer), inlined a non-shared `.frag` text-loader import, and emitted
    no sourcemaps. The same step asserts the **declaration emit**: a parallel
    `dist/**/*.d.ts` tree mirroring the sources (including a `.tsx` component),
    `.ts`/`.tsx` extension specifiers preserved in declaration output,
    no `.d.ts` for test files or esbuild chunks, the ambient `*.d.ts` source
    not copied, no `.d.ts.map`, and byte-identical `.d.ts` across a rebuild
    (determinism). A follow-up step proves `"declarations": false` opts out
    (`.js` emitted, zero `.d.ts`).
8. The "Type-check gate blocks broken output" step: a project with a deliberate
    type error must make **every** code path &mdash; `ts0 build`, `ts0 run`,
    `ts0 run --no-build`, and `ts0 test` &mdash; exit non-zero and emit/execute
    nothing (no `dist/`, no test run). The error strips to valid JS and the test
    file registers no tests, so a `--no-build` or `test` run would exit 0 if the
    check were ever skipped &mdash; this step catches exactly that regression.
    It also repeats the check for a **js (directory) target**, proving a type
    error leaves no `dist/` at all &mdash; no `.js` tree and no partial `.d.ts`
    tree.

If you change CLI behavior, update the relevant `samples/*` and CI smoke steps so
the new behavior is covered.

## Conventions

- **Indentation:** tabs (4-wide), per `.editorconfig`. Match this in every file.
- **Modules:** ESM only (`"type": "module"`). Use `.ts` extensions in relative
    imports (e.g. `import { build } from "./commands/build.ts"`) so
    `--experimental-strip-types` resolves them.
- **Dependencies:** keep them minimal. Production deps are `esbuild` and
    `typescript`. Dev deps are `@types/node` and `preact` (the latter only so the
    `samples/html-jsx` regression sample can resolve `preact/jsx-runtime` when CI
    builds it). Don't add a CLI parser, a test framework, or a bundler
    abstraction &mdash; the whole point is that ts0 stays small.
- **Argument parsing:** `src/cli.ts` parses `process.argv` by hand. New commands
    should follow the same pattern (no new dependency).

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
    scripts fails the build like any other project.
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

Module resolution in the generated tsconfig depends on the target: the default
single-entry target uses `NodeNext` (Node app, `.ts` extensions required), while
the **js library target** (directory entry) uses `Bundler` resolution to match
esbuild &mdash; so a library can use extensionless relative imports and
loader-backed imports (`import x from "./y.wgsl"`) without `.ts` extensions. HTML
entries skip type-checking entirely.

Module resolution in the generated tsconfig depends on the target: the default
single-entry target uses `NodeNext` (Node app, `.ts` extensions required), while
the **js library target** (directory entry) uses `Bundler` resolution to match
esbuild &mdash; so a library can use extensionless relative imports and
loader-backed imports (`import x from "./y.wgsl"`) without `.ts` extensions. HTML
entries skip type-checking entirely.

## JSX

`jsx`/`jsxImportSource` are threaded into esbuild from **both** the Node/TS path
(`build.ts`) and the HTML path (`build-html.ts`'s `<script>` bundling). Keep them
in sync: if only one path sets them, HTML+JSX projects silently fall back to
esbuild's classic `React.createElement` transform and break Preact at runtime.

## HTML entries

When `entry` ends with `.html`, `build.ts` delegates to `commands/build-html.ts`.
That module reads the HTML and inlines four classes of dependency:

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
text, etc.) stay inlined. The `esbuild` escape hatch can set `splitting: false`
to force self-contained (duplicating) outputs.

It is mutually exclusive with the HTML target and the default single-entry
target. `outfile` is ignored (always `outdir`), and `ts0 run` rejects it (no
single entry to run). The non-output esbuild options (platform, format, jsx, …)
come from `baseEsbuildOptions()` in `commands/esbuild-base.ts`, shared with the
default target so the two can't drift.

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

Two consumption paths, for two kinds of consumer:

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
    path's behavior (see the npm-path invariant below).

## Prebuilt ts0.cjs (buildhost packaging)

`scripts/build-prebuilt.ts` packages ts0 for buildhost as ONE platform-neutral
CommonJS file plus five small platform-native esbuild binaries. CI publishes
them to buildhost on merges to master; consumers run
`node ts0.cjs <cmd>` (or `curl ... | node - <cmd>`) on stock Node >= 22 with
no npm. Node is the deliberate prerequisite &mdash; ts0 is a Node tool, and
hosting duplicated Node runtimes per platform was rejected as waste.

How the pieces fit:

- **The bundle** (`src/prebuilt/main.ts` &rarr; `ts0.cjs`): the CLI, the
    esbuild JS API, and the ENTIRE TypeScript compiler (pure JS) in one file.
    The tsc CLI chain (`bin/tsc`, `lib/tsc.js`, `lib/_tsc.js`) and every
    `lib/lib.*.d.ts` standard library are embedded as strings via the
    generated `ts0-prebuilt-assets` virtual module (an esbuild plugin injects
    it at package time; `src/prebuilt/prebuilt-assets.d.ts` is the ambient
    declaration that keeps the repo type-check happy without it).
- **Format is CommonJS, extension is .cjs, and both are load-bearing.**
    `node -` executes stdin as CJS with no flags, which is what keeps the
    pipe form (`curl ... | node - build`) flagless; and a `.js` file would be
    mis-parsed as ESM inside any consumer package declaring
    `"type": "module"` (including this repo). Do not rename the artifact to
    `.js` or switch the bundle to ESM without solving both.
- **Stdin-runnable invariant: nothing may depend on the bundle's own path.**
    Under `node -`, `__filename` is `[stdin]` and there is no
    `import.meta.url`. The packaging `define`s `import.meta.url` to
    `globalThis.__ts0PrebuiltImportMetaUrl`, which `runtime.ts` points at
    `<cache>/<build-id>/dist/ts0` &mdash; so build.ts's
    `createRequire(...).resolve("typescript/bin/tsc")` finds the EXTRACTED
    compiler under `<cache>/node_modules/typescript`, and build-html.ts's
    `../src/runtime/fetch-interceptor.js` candidate finds the extracted
    template, with zero source changes. If you add a new
    `__filename`/`__dirname`/`import.meta.url` use to shared code, it must
    resolve via that anchor (or the cache), never via the bundle's location.
    (The bundled esbuild lib references `__filename` only on error paths that
    `ESBUILD_BINARY_PATH` short-circuits.)
- **Extraction** (`src/prebuilt/runtime.ts`): first run writes the embedded
    files to `$TS0_CACHE_DIR`-or-`~/.cache/ts0/<build-id>/` (atomic
    temp+rename; concurrent racers use the winner's tree). The build id is a
    hash of the final bundle + dependency versions (placeholder-substituted
    after bundling), so any change extracts fresh and upgrades never collide.
    tsc then runs exactly as in the npm build: `node <extracted tsc>
    --project ...` &mdash; `node` is on PATH by prerequisite, so `ts0 run` /
    `ts0 test` need no changes at all.
- **The one native piece: esbuild.** `ensureEsbuildBinary` fetches the
    platform's native binary (~11 MB) from
    `https://dl.pazer.build/ts0/esbuild-<version>?os=..&arch=..` into the
    cache (atomic, once) and exports `ESBUILD_BINARY_PATH` BEFORE the CLI
    (and therefore the bundled esbuild module, which snapshots that env var
    at load time) is imported &mdash; keep that ordering. A set-and-existing
    `ESBUILD_BINARY_PATH` is respected as a user override; `TS0_ESBUILD_URL`
    overrides the fetch URL (mirrors/tests). Fetch failures name the URL and
    destination &mdash; never a silent fallback. The natives come from the
    npm registry tarballs, verified against the package-lock sha512, so they
    are byte-identical to what npm installs; there is no esbuild-wasm
    fallback (deliberate &mdash; not worth the weight).
- **npm-path invariant**: the prebuilt machinery lives entirely in
    `src/prebuilt/` + the packaging script. The only shared-source change is
    quoting in `runTsc`'s exec string (spaced paths). The npm/git-install
    path must never notice the prebuilt exists.
- **What must stay in sync when deps bump**: the typescript embed list in
    `embeddedFiles` (the `bin/tsc` &rarr; `lib/tsc.js` &rarr; `lib/_tsc.js`
    chain is a TypeScript-5.x layout &mdash; the script throws at package
    time if renamed); the esbuild version is read from the lockfile and baked
    into both the native-fetch URL and the buildhost project name
    (`ts0/esbuild-<version>`), so an esbuild bump automatically publishes a
    new natives project on the next master merge.
- **CI/publish** (`.github/workflows/ci.yml`): the `prebuilt` job builds
    everything and runs `scripts/prebuilt-smoke.sh` &mdash; a bare-node smoke
    (`env -i`, PATH holds ONLY node; npm/npx asserted unreachable) that
    exercises the real fetch path against a local HTTP server, the
    fetch-failure message, the PIPE form (`cat ts0.cjs | node - build`), the
    init flow, the type-error gate, every sample assertion incl. declaration
    determinism, and offline cache reuse; `smoke-prebuilt-linux-arm64`
    repeats it on `ubuntu-24.04-arm` (exercising the arm64 native).
    macOS/windows natives ship without a CI execution job on purpose: they
    are upstream esbuild release binaries, lock-verified, and ts0.cjs itself
    is platform-neutral. The `publish` job (master only) is the STOCK
    `wow-look-at-my/buildhost/.github/actions/buildhost-publish@master`
    action with `artifact_name: prebuilt` &mdash; no inline publish
    scripting; if the action ever lacks something, fix it upstream in the
    buildhost repo, never with a hand-rolled step here. It self-serves the
    run artifact (needs `actions: read`), authenticates via GHA OIDC
    (`id-token: write`; buildhost auto-provisions the projects, public
    because this repo is public), and maps files by naming convention:
    `ts0_cosmo_any` &rarr; project `ts0`, one artifact under the cosmo/any
    multi-platform alias (one stored body, resolvable under every
    `?os=..&arch=..` pair); `esbuild-<version>_<os>_<arch>[.exe]` &rarr;
    project `ts0/esbuild-<version>`. Each master merge creates a new release
    of BOTH projects (the natives' bytes are identical across re-publishes
    of the same esbuild version, and ts0.cjs's version-less fetch URL always
    resolves the latest); `scripts/build-prebuilt.ts` owns the naming, so a
    rename there is a publish-layout change. PR branches build and smoke but
    never publish.
- **Org merge gate / job naming**: merging into master needs a green
    `all-builds` commit status on the PR head SHA, posted automatically by
    an org app (required-builds-manager) that aggregates every build on the
    SHA &mdash; no special CI job naming is needed for the gate. Never name
    a job `all-builds`: the buildhost publish actions fail any run whose
    SHA carries a job by that name (the error says to rename); use a
    neutral name like `aggregate` if a fan-in job is ever wanted.

## Documentation

Per global instructions: when you change project structure, commands, config
fields, or tooling, update `README.md` and this file in the same commit. Don't
let the docs drift.

## Git workflow

- Develop on the branch the task specifies.
- Commit and push frequently; the VM can reset.
- PRs in this org are squash-merged &mdash; don't rebase or force-push.
