# Testing

Extracted verbatim from `CLAUDE.md`, where this had outgrown an index entry.
See `CLAUDE.md`'s "Working on the code" section for the short version and the
commands to run these locally.

The only unit test is `src/runtime/fetch-interceptor.test.ts` (run in CI via
`node --experimental-strip-types --test`), which evaluates the single-file fetch
interceptor against a window/document shim and asserts it serves embedded assets
for string, `URL`-object, and `Request` fetch inputs.
Unit tests are every `src/**/*.test.ts`, run in CI by one globbed
`node --experimental-strip-types --test "src/**/*.test.ts"` step, so a new test
file is picked up without touching the workflow:

- `src/runtime/fetch-interceptor.test.ts` evaluates the single-file fetch
    interceptor against a window/document shim and asserts it serves embedded
    assets for string, `URL`-object, and `Request` fetch inputs.
- `src/commands/typecheck-entry.test.ts` drives the real `runTypecheck` over
    temp projects and pins the gate's file set: a type error in the configured
    entry fails the gate whether or not the entry sits in a dot-directory.
- `src/commands/test-discovery.test.ts` drives the real CLI over a temp project
    with a nested ts0 project and pins the recursion: a broken nested project
    fails the parent's `build` AND `test`, a clean one is built and tested by
    it, and `ts0 run` builds only its own project.

Everything else is a **behavioural suite** in `tests/*.dats`, run by
[dats](https://github.com/wow-look-at-my/dats). CI builds `dist/ts0`,
`npm link`s it, fetches the dats binary and runs the suites. Every test stages
its project into its own directory and asserts what the build WROTE --
declarative `outputs.files` match/notMatch checks, with shell only for
properties that span files. A staged project gets the repo's `node_modules`
symlinked in, the position it resolves `@types/node`/`preact` from when built
in place.
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
    path, since HTML entries are type-checked rather than skipped.) The
    component's tagline contains the word "any" as JSX text, and CI asserts it
    reaches the output &mdash; the guard that the explicit-`any` ban stays a
    parse and never becomes a text search.
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
8. Running `ts0 build` against `samples/userscript` and asserting the
    userscript-bundling features: the `==UserScript==` header re-prepended
    byte-exactly at the top (exactly once, stable across a rebuild &mdash;
    `preserveHeader`), the IIFE assigned to the configured `globalName`, no
    module statements and no shebang in the browser output, and the
    extensionless `./lib/greet` import both type-checked (browser targets
    gate-check with bundler resolution) and inlined. Follow-up steps prove
    `--config <path>` builds the sample from the repo root and that the
    `exclude` config skips a broken directory the gate would otherwise fail on.
9. Running `ts0 build` against `samples/bookmarklet` and asserting the
    `javascript:<file>` href was replaced by a percent-encoded minified
    bundle that decodes back to the program (lib import inlined), while a
    real `javascript:void(0)` href and the rest of the page stay untouched
    and no fetch interceptor is injected.
10. The "Type-check gate blocks broken output" step: a project with a deliberate
    type error must make **every** code path &mdash; `ts0 build`, `ts0 run`,
    `ts0 run --no-build`, and `ts0 test` &mdash; exit non-zero and emit/execute
    nothing (no `dist/`, no test run). The error strips to valid JS and the test
    file registers no tests, so a `--no-build` or `test` run would exit 0 if the
    check were ever skipped &mdash; this step catches exactly that regression.
    It also repeats the check for a **js (directory) target**, proving a type
    error leaves no `dist/` at all &mdash; no `.js` tree and no partial `.d.ts`
    tree, and for an entry under a **dot-directory** (`.github/scripts/step.ts`),
    which `**/*` alone never reaches.
11. The "Explicit any is a build error" step: a program that is *valid*
    TypeScript except for an explicit `any` must fail `build`, `run`,
    `run --no-build`, and `test`, and emit nothing &mdash; tsc has no flag for
    this, so a skipped ban would build cleanly and only this step catches it.
    It walks every spelling (`x: any`, `as any`, `<any>`, `any[]`,
    `Promise<any>`, `type A = any`, and an `any` inside a `.d.ts`), then
    proves the look-alikes still build: identifiers, object keys, strings,
    comments and regexes containing the word `any`.
The files declare `network: false`, so a local run proves a build never needs
one. **CI runs `--no-sandbox` and therefore does not**: the org's self-hosted
runner denies unprivileged user namespaces, so bwrap cannot start and there is
no docker fallback. Run the suites locally (with bwrap installed) to exercise
the sandboxed contract.

- `tests/cli.dats` -- `ts0 init` scaffolds a project that `build`, `run` and
    `test` then handle end to end; `--config <path>` builds a named config from
    elsewhere in the tree (rootDir stays the config file's own directory).
- `tests/gate.dats` -- the unskippable gate. A type error must make **every**
    path (`build`, `run`, `run --no-build`, `test`) exit non-zero and emit or
    execute nothing, for the node target and the js (directory) target alike
    (no `.js` tree, no partial `.d.ts`). The fixtures are shaped so a skipped
    check would look fine: the error strips to valid JS and the test file
    registers no tests, so `--no-build` and `test` would exit 0 if the gate were
    bypassed. Then the explicit-`any` ban across every spelling (`x: any`,
    `as any`, `<any>`, `any[]`, `Promise<any>`, `type A = any`, and an `any`
    inside a `.d.ts`), the look-alikes that must still build (identifiers,
    object keys, strings, comments, regexes reading "any" -- the guard that the
    ban stays a parse), `exclude` limiting the gate without changing the build,
    and a type error in an **HTML** entry failing the build (they were once
    exempt and reported success regardless).
- `tests/samples.dats` -- one test per sample: `basic` (build + `ts0 test`);
    `html` (JS/CSS inlined into one document, `url()` rewritten to `data:`,
    inline-module bundling, the fetch interceptor with no leftover
    `__ASSETS_JSON__`) and the CLI `--entry`/`--outfile` overrides; `html-jsx`
    (automatic Preact runtime, no `React.createElement`, and a JSX tagline
    reading "any questions" that must survive); `js` (`ts0 test` first &mdash;
    which EXECUTES `vec.test.ts` and so catches an import that bundles but that
    Node cannot resolve at run time &mdash; then tree mirrored, shared code
    deduped into a chunk rather than copied, `.frag` text loader, the parallel
    `.d.ts` tree with `.ts`/`.tsx` specifiers preserved, no `.d.ts` for tests or
    chunks, no `.d.ts.map`, and byte-identical declarations across a rebuild)
    plus the `"declarations": false` opt-out and the `"bundleShared": false`
    inverse (the same sample built both ways: chunk + single shared body by
    default, then zero chunks with the body copied into each importer);
    `userscript` (the `==UserScript==`
    header byte-exact at the top, exactly once, stable across a rebuild, IIFE on
    the configured global, no module statements, no shebang); `bookmarklet` (the
    `javascript:<file>` href percent-encoded and decoding back to the bundled
    program, a real `javascript:void(0)` href untouched); `external-css` (the
    `with { type: "css" }` import emitted verbatim, the stylesheet text absent
    from every emitted file, a neighbouring ordinary import still bundled) plus
    its guardrail &mdash; the same program WITHOUT `external` must fail the
    build and write nothing, since silent inlining would defeat the feature.
- `tests/html-referenced.dats` -- the multi-file HTML target
    (`inlineAssets: false`): the shell plus one bundle per reference under
    `assetPath`, nothing inlined, references rewritten, the external stylesheet
    untouched, real bundles, and a **basename collision** failing the build with
    nothing written.

CI still builds the two HTML samples into the workspace after the suites, but
that step is not a test -- it only produces the downloadable artifacts.

If you change CLI behavior, update the relevant `samples/*` and the matching
`tests/*.dats` suite so the new behavior is covered.
