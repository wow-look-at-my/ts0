# Type-checking

**Type-checking is an unskippable gate. There is NO way to build or run code that has not passed `tsc`.** The exported `runTypecheck(config, rootDir)` is the single chokepoint. Every command that emits or executes code calls it:

- `build()` runs it before it emits anything, and returns a failed `BuildResult` with no output written. Every path that produces output goes through `build()`: `ts0 build`, `ts0 run` without `--no-build`, and any programmatic caller. None of them can emit an un-checked artifact. Do **not** move the check back up into the command layer. That reintroduces the hole where `ts0 run` bundled and executed un-type-checked code.
- `run()` runs it for the `--no-build` path, before it hands sources to `node --experimental-strip-types`. Strip-types only *erases* annotations. It does **not** type-check, so without this gate `ts0 run --no-build` executes broken code. `--no-build` therefore skips only the bundle and the artifact, not the check.
- `test()` runs it before it compiles or spawns anything. The compile erases type annotations without checking them, so an un-checked test run executes an invalid program. A type error anywhere in the project fails `ts0 test`, and no test process is spawned.

The gate is more than `tsc`. It also bans explicit `any`, as "Explicit `any` is banned" below describes. Everything said here about unskippability covers that ban too.

There is intentionally **no escape hatch**. Every command that runs or emits code type-checks first. A new command, or a new branch in an existing one, that runs or emits code MUST call `runTypecheck()` first and bail on failure. The only thing `--no-build` and its peers may skip is the bundle and the artifact, not the check.

`runTypecheck()` writes a temporary `.ts0-tsconfig.json`, which is gitignored, runs `tsc --noEmit` against it, and deletes it in a `finally`. It resolves the TypeScript binary from `ts0`'s own `node_modules` through `createRequire`, so the user's project needs no `typescript` install. Preserve both behaviors. `build()`, `run()` and `test()` each already hold a loaded config, so each calls `runTypecheck(config, rootDir)` directly rather than re-loading.

The tsconfig generation is shared. `generatedCompilerOptions(config, rootDir)` builds the compiler options used by BOTH the gate and the js target's declaration emit. That emit is `emitDeclarations`, whose temp file `.ts0-tsconfig-emit.json` is also gitignored. `runTsc()` owns the write-temp-tsconfig, exec and cleanup plumbing for both. Keep them shared. If the passes drift, declaration emit can succeed on code the gate rejects, or the reverse.

The declaration pass is **more** to the gate, not a replacement. It compiles only the js target's entry modules plus the ambient `*.d.ts` files. It therefore does not see test files, or sources outside the entry set, the way the project-wide gate does. Do not "optimize" the gate away on the build path.

Key details of the generated tsconfig:

- **`lib` depends on target.** Browser code gets `["ESNext", "DOM", "DOM.Iterable"]`, so `document`, `fetch` and `addEventListener` resolve. That covers an explicit `"browser"` target and *any* HTML entry, which is always browser. Node code gets `["ESNext"]` only, and its globals come from `@types/node`. Without the DOM lib, every HTML and browser project fails with "Cannot find name 'document'".
- **HTML entries ARE type-checked.** They used to be skipped. An HTML project's `.ts` and `.tsx` files are checked before bundling, so a type error in HTML scripts fails the build like any other project. Do not reintroduce an entry-shaped skip. The `tests/gate.dats` case "a type error in an HTML entry fails the build" exists to keep this honest. Its project is staged inline, not kept under `samples/`. Build and test recurse into every nested ts0 project, so a permanently-broken one in the tree fails the repo's own build forever.
- **The configured entry is named in `include`, not just globbed** (`entryTypeCheckPaths`). The compiler skips a dot-directory while it expands a leading wildcard, but never a path segment it was handed. Without this, an entry under `.github/` or `.config/` is bundled against an EMPTY program and the build reports success. A directory entry yields one glob per TS extension, but only when it actually holds TypeScript. A glob that matches nothing aborts with TS18003, instead of letting build-js report "No TypeScript modules found". An HTML entry yields none, because its scripts come from the markup.
- **Empty source sets are skipped, not failed.** `hasTypeScriptSources()` walks the project. With no `.ts`, `.tsx`, `.mts` or `.cts` file, as in a plain-JS HTML entry, the check is a vacuous pass. Without this, `tsc` aborts with `TS18003`, "No inputs were found", and incorrectly blocks a valid JS-only build.
- **Nested ts0 projects are excluded**, meaning any subdirectory with its own `ts0.json`, through `findNestedProjectDirs`. Without this, building ts0 itself type-checks `samples/html-jsx/*.tsx` under the root config, which has no JSX, and fails with `TS17004`. A nested project is type-checked on its own when it is built directly.

**Watch mode re-checks on every cycle** for all commands. A one-shot up-front check lets a later rebuild or re-run slip past:

- `ts0 build --watch` on the JS path adds `typecheckPlugin`. That is an esbuild `onStart` hook. It runs `runTypecheck()` and returns errors on failure, so the bundler skips writing output for a rebuild that does not type-check. The HTML path threads a `typecheck` callback into `buildHtml`. `buildOnce` runs that before each rebuild and bails on failure, writing nothing. Either way the previous good output stays in place, rather than being overwritten with something broken.
- `ts0 test --watch` does **not** use `node --test --watch`. That re-runs tests on change without re-type-checking, which runs an invalid program. `test()` owns the loop instead. An `fsWatch` debounces changes into a `cycle()` that type-checks, then runs the tests one-shot only if the check passes. Do not switch it back to `node --test --watch`. The watcher ignores the compiled test copies a cycle writes, or each run schedules the next one.

## `ts0 test` compiles each test file; it does not strip it

`compileTests` in `commands/test.ts` bundles every discovered test file with `baseEsbuildOptions`, the same settings the build uses. `node --test` then runs the results. Properties are load-bearing:

- **The format is the source's own.** It comes from the nearest package.json, with `.mts` and `.cts` outranking it, in an extension that states it: `.ts0.cjs` or `.ts0.mjs`. `--experimental-strip-types` only erases annotations. It cannot turn `import` into `require`, so a `"type": "commonjs"` project passed the gate and died inside node on "Cannot use import statement outside a module". Compiling one format into the other is just as incorrect. It drops `__dirname`, `require` and `require.main`, or it drops `import.meta`. The test then fails on a global that was there a moment ago. esbuild takes one format per call. The files are therefore grouped by format.
- **The copy is written BESIDE its source**, not under a build directory. A test that reads a fixture through `import.meta.dirname` or `__dirname` has to see the directory it was written in. The copy is deleted in a `finally`. `sourceNameRewriter` rewrittens `node --test` output, from the mapping the compile produced.
- **`require.main === module` in a module under test always fires**, because every module in one bundle shares one module object. Nothing can fix that here. A module under test exports its work and leaves the invocation to the entry file. `tests/node-target.dats` pins this. It is learned from a test rather than from a mystifying CI failure.

Module resolution in the generated tsconfig follows who consumes the code. A **Node-target single-entry** app uses `NodeNext`, which requires `.ts` extensions. That is the one case where Node's own module system resolves the output. Everything esbuild compiles uses `Bundler` resolution to match esbuild: the **js library target**, any **browser-target** entry, and every **HTML** entry. An extensionless relative import and a loader-backed import, such as `import x from "./y.wgsl"`, therefore type-check exactly as the bundler resolves them.

The gate excludes things: the output dir, nested ts0 projects, and any directory listed in the config's `exclude` field. That field is for a tree that type-checks under its own separate tsconfig, such as a test harness. This holds with different types or an experiment dir. `exclude` never changes what gets built. It changes only what the gate checks.

`typecheckExcludeDirs(config, rootDir)` owns that list. `ts0 test` leaves the same directories out of its own discovery, so it never spawns a test this gate did not check. Nothing on that list goes unchecked, though. See "Nested projects" below for the recursion that covers them.

## Nested projects: recurse, never skip

A subdirectory with its own `ts0.json` is a separate project. **`ts0 build` and `ts0 test` recurse into every one of them.** `findNestedProjectDirs` finds them, then `build` or `testTree` re-enters with that project's config. Depth is unlimited, because each nested run recurses in turn. Every project runs even after one fails, and any failure fails the parent.

This is the whole reason the parent's gate may leave those directories out. A nested project's settings, such as JSX, target and loaders, make it uncheckable under the parent's tsconfig. The parent therefore **delegates** rather than ignores. Never convert that delegation back into a skip. A nested project dropped from both the gate and the recursion is code nothing checks, reported green. Equally, not fold nested files into the parent's own run.

They then execute under a config they were not written for, un-type-checked.

`ts0 run` is the exception, and only because it executes a single entry. It builds its own project (`selfOnly`) and nothing else.

**`ts0 test` runs nested projects at the same time.** Each one writes into its own buffer. It is printed whole the moment it finishes, so no TAP streams interleave. The order is the order they completed in. The bound is `min(4, availableParallelism())`, well below the per-file `--test-concurrency`. Each project spawns its own tsc AND its own `node --test`.

`TS0_PROJECT_CONCURRENCY` overrides it. This needed `runTsc` to stop using `execSync`. That call blocks the event loop, so the recursion got no concurrency at all whatever it did. `tests/concurrency.dats` proves both halves on a wall clock, with a forced concurrency of 1 as the control.

The consequence for this repo: `ts0 build` at the root builds every `samples/*` project, and `ts0 test` runs their tests. A deliberately-broken fixture therefore cannot live in the tree. Stage it inline from a `.dats` test instead.

## Explicit `any` is banned (unconditionally)

`strict` gives `noImplicitAny`. The compiler has **no flag at all** for an *explicit* `any`. ts0 enforces that itself in `commands/explicit-any.ts`, as a second pass inside `runTypecheck()`. The pass runs after tsc. A syntax error is therefore reported as one. Every `any` type annotation is an error: `x: any`, `x as any`, `<any>x`, `any[]`, `Promise<any>`, `type A = any`.

There is **no config option and no escape hatch**. The ban applies even with `"strict": false`, exactly like the gate itself. This pass too skips a directory in `exclude`, from the same exclusion list as the gate.

- **It parses. It does not text-search.** `checkNoExplicitAny` loads the TypeScript compiler API through `createRequire(import.meta.url)("typescript")`, the same resolution as the tsc binary, memoized. It then walks for `SyntaxKind.AnyKeyword`, which only ever occurs as a type. A text search fails a valid build on an identifier such as `anyOf`, and on object keys, strings, comments, regexes and JSX prose ("any questions?"). `samples/html-jsx` carries such a tagline on purpose, as the regression guard. Keep it a parse. A cheap `/\bany\b/` pre-filter skips a file that cannot match. A project with none therefore never loads the compiler.
- **Declaration files are scanned.** The gate does not scan them, because its `skipLibCheck` stops tsc from looking inside a `.d.ts`. A hand-written ambient declaration is project source. It is also the easiest place for an `any` to hide.
- The `.d.ts` files ts0 *emits* live in the output dir, which is excluded. They cannot contain an explicit `any` anyway, because the sources they come from cannot.
