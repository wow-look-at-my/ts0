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
        build.ts        # tsc --noEmit, then esbuild bundle (dispatches HTML)
        build-html.ts   # bundles an .html entry into a single inlined .html
        run.ts          # build (or strip-types) + node
        test.ts         # node --test on discovered test files
samples/
    basic/              # Node-entry smoke-test sample exercised by CI
    html/               # HTML-entry smoke-test sample exercised by CI
    html-jsx/           # HTML+JSX (Preact, automatic runtime) regression sample
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

There is currently no unit test suite for `ts0` itself. CI exercises the CLI
end-to-end by:

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
    build path.

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
2. If it changes build behavior, thread it through the `esbuildConfig` object
    in `commands/build.ts`. The user-supplied `esbuild` field is spread last so
    it stays an escape hatch &mdash; keep it that way.
3. Document it in `README.md`'s configuration table.

`loadConfig()` walks up from the cwd looking for `ts0.json` and falls back to
defaults plus auto-detected entry. Don't break the no-config-file path.

## Type-checking

`commands/build.ts` writes a temporary `.ts0-tsconfig.json` (gitignored), runs
`tsc --noEmit` against it, and deletes it in a `finally`. The TypeScript binary
is resolved from `ts0`'s own `node_modules` via `createRequire` so the user's
project doesn't need its own `typescript` install. Preserve both behaviors.

The generated tsconfig excludes nested ts0 projects (any subdirectory with its
own `ts0.json`, via `findNestedProjectDirs`). Without this, building ts0 itself
would type-check `samples/html-jsx/*.tsx` under the root config (no JSX) and fail
with `TS17004`. A nested project is type-checked on its own when built directly.

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

## Distributing via `npm install github:wow-look-at-my/bundler`

`package.json` has a `prepare` script that runs `npm run build`; npm runs
`prepare` automatically when installing from a git URL, so `dist/ts0` is built
on the consumer's machine and `npx ts0 …` works without a separate build step.
The `"files"` field is irrelevant for git installs but matters for `npm publish`
&mdash; keep `dist/ts0` and `src/runtime/fetch-interceptor.js` in it.

## Documentation

Per global instructions: when you change project structure, commands, config
fields, or tooling, update `README.md` and this file in the same commit. Don't
let the docs drift.

## Git workflow

- Develop on the branch the task specifies.
- Commit and push frequently; the VM can reset.
- PRs in this org are squash-merged &mdash; don't rebase or force-push.
