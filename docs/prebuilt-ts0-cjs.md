# Prebuilt ts0.cjs (buildhost packaging)

`scripts/build-prebuilt.ts` packages ts0 for buildhost as ONE platform-neutral
CommonJS file plus five small platform-native esbuild binaries. CI publishes
them to buildhost on merges to master; consumers run
`node ts0.cjs <cmd>` (or `curl ... | node - <cmd>`) on stock Node >= 22 with
no npm. Node is the deliberate prerequisite &mdash; ts0 is a Node tool, and
hosting duplicated Node runtimes per platform was rejected as waste.

How the pieces fit:

- **The bundle** (`src/prebuilt/main.ts` &rarr; `ts0.cjs`): the CLI, the
    esbuild JS API, and the ENTIRE TypeScript compiler (pure JS) in one file.
    The compiler API (`lib/typescript.js`), every `lib/lib.*.d.ts` standard
    library, and the whole `@types/node` package are embedded as strings via
    the generated `ts0-prebuilt-assets` virtual module (an esbuild plugin
    injects it at package time; `src/prebuilt/prebuilt-assets.d.ts` is the
    ambient declaration that keeps the repo type-check happy without it).
    ~14 MiB total, ~2 MiB gzipped on the wire.
- **`@types/node` ships embedded too**, so a Node-target project type-checks
    with no `@types/node` install of its own. `commands/build.ts`'s
    `generatedCompilerOptions` sets `typeRoots` to the extracted
    `node_modules/@types` (resolved via `nodeTypeRootsDir`, the same
    `createRequire(import.meta.url)` trick `runTsc` uses for `typescript`)
    plus the consumer's own `node_modules/@types`, so an explicit install
    still resolves too -- it is just never required. `@types/node` is a
    regular `dependencies` entry (not `devDependencies`) precisely because
    every consumption path, including a plain `npm install`, needs it
    resolvable from ts0's own installed tree.
- **So do the packages `@types/node` imports from**, walked by
    `embedTypeDependencies` in `scripts/build-prebuilt.ts` rather than listed,
    so a dependency added on a version bump comes along and one that cannot be
    resolved fails the packaging. Today that closure is `undici-types`, and it
    is where `fetch` returns its `Response`. Embedding `@types/node` alone left
    a `Response` with no members: `(await fetch(url)).ok` failed with
    "Property 'ok' does not exist on type 'Response'" in a project whose only
    fault was trusting the types ts0 supplies. tsc reports the members rather
    than the missing package, because an unresolved type import degrades to a
    shapeless type instead of an error -- which is why the guard lives in the
    packaging, and why `scripts/prebuilt-smoke.sh` builds a program that calls
    `fetch`. From source there is nothing to catch: `undici-types` sits beside
    `@types/node` in ts0's own `node_modules`.
- **The compiler is embedded ONCE.** The npm package ships it twice --
    `lib/typescript.js` (the API) and `lib/_tsc.js` (the same compiler
    rebuilt as a CLI, reached through `bin/tsc` &rarr; `lib/tsc.js`) -- and
    ts0 needs both capabilities: the gate spawns the CLI, and the
    explicit-`any` pass requires the API in-process. Embedding both would add
    ~9 MiB of duplicated compiler, so only the API ships and
    `scripts/build-prebuilt.ts` GENERATES `bin/tsc` (`TSC_DRIVER`) doing what
    `_tsc.js` does at its tail: enable the compile cache, `sys.setBlocking()`
    (so a piped diagnostic dump can't be truncated), then
    `executeCommandLine(sys, noop, sys.args)`. Verified identical to the
    stock CLI on diagnostics text, exit codes, and declaration-emit bytes,
    and `runTsc` still spawns `node <bin/tsc> --project ...` unchanged, so
    the gate behaves exactly as it does on the npm path. `executeCommandLine`
    is a runtime export absent from `typescript.d.ts`: the packaging script
    asserts it exists, and the boot sanity runs a real failing + passing
    build through the driver, so a TypeScript upgrade that moved it breaks
    packaging rather than a consumer's first run.
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
    `src/prebuilt/` + the packaging script. The shared-source changes are
    quoting in `runTsc`'s exec string (spaced paths) and `nodeTypeRootsDir`'s
    `createRequire(import.meta.url).resolve(...)` in `build.ts` -- both
    resolve relative to wherever the running code actually lives, so they
    behave identically on the npm/git-install path (ts0's own
    `node_modules`) and the prebuilt path (the extraction cache), with no
    prebuilt-specific branch. The npm/git-install path must never notice the
    prebuilt exists.
- **What must stay in sync when deps bump**: the typescript embed list in
    `embeddedFiles` (`lib/typescript.js` + `lib/lib.*.d.ts` is a
    TypeScript-5.x layout, and the generated `bin/tsc` driver depends on the
    `executeCommandLine` runtime export &mdash; the script throws at package
    time if either moves); the whole `@types/node` package (walked
    recursively, so a version bump adding/removing files needs no list edit);
    the esbuild version is read from the lockfile and baked
    into both the native-fetch URL and the buildhost project name
    (`ts0/esbuild-<version>`), so an esbuild bump automatically publishes a
    new natives project on the next master merge.
- **CI/publish** (`.github/workflows/ci.yml`): the `prebuilt` job builds
    everything and runs `scripts/prebuilt-smoke.sh` &mdash; a bare-node smoke
    (`env -i`, PATH holds ONLY node; npm/npx asserted unreachable) that
    exercises the real fetch path against a local HTTP server, the
    fetch-failure message, the PIPE form (`cat ts0.cjs | node - build`), the
    init flow, the type-error gate, the explicit-`any` ban (the pass that
    requires the extracted `lib/typescript.js` in-process, checked in the
    pipe form too), the extracted tree's shape (API + generated `bin/tsc`,
    and NO `_tsc.js` &mdash; the no-duplicated-compiler assertion), every
    sample assertion incl. declaration determinism, and offline cache reuse; `smoke-prebuilt-linux-arm64`
    repeats it on `ubuntu-24.04-arm` (exercising the arm64 native).
    macOS/windows natives ship without a CI execution job on purpose: they
    are upstream esbuild release binaries, lock-verified, and ts0.cjs itself
    is platform-neutral. The `publish` job (master only) is the STOCK
    `wow-look-at-my/buildhost/.github/actions/buildhost-publish@master`
    action with `artifact_name: prebuilt` &mdash; no inline publish
    scripting; if the action ever lacks something, fix it upstream in the
    buildhost repo, never with a hand-rolled step here. It self-serves the
    run artifact and runs a pre-publish guard that scans the run's jobs and
    the head commit's check runs (hence `actions: read` + `checks: read`
    &mdash; the guard fails closed without both), authenticates via GHA OIDC
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
