# Testing

Extracted verbatim from `CLAUDE.md`, where this had outgrown an index entry. See `CLAUDE.md`'s "Working on the code" section for the short version and the commands to run these locally.

This file documents the WIRING: where a test goes, what runs it, and the properties a reader cannot learn from any single test. What each suite covers is written in that suite's own header comment, and what each case asserts is its `desc:` string, which `dats test tests/` prints by name. Do not restate either here. A per-test catalogue in a file nothing checks is a third copy of the header and the `desc:`, and it drifts: nothing fails when it credits a test with an assertion that test does not make.

## Where a test goes

A **unit test** is `src/**/*.test.ts`, for logic that can be called directly. One globbed CI step runs them all, `node --experimental-strip-types --test "src/**/*.test.ts"`, so a new file needs no edit to the workflow.

Everything else is a **behavioural suite** in `tests/*.dats`, run by [dats](https://github.com/wow-look-at-my/dats). A test that spawns the CLI and asserts on what it wrote or printed belongs here, whatever its file extension carries: `src/commands/test-discovery.test.ts` spawns `ts0 build` and `ts0 test` over temp projects, so it is a dats suite wearing a `.test.ts` name.

Every suite stages its project into its own directory. It then asserts what the build WROTE, through declarative `outputs.files` match and notMatch checks, and uses shell only for a property that spans files. A staged project gets the repo's `node_modules` symlinked in. That is the position it resolves `@types/node` and `preact` from when it is built in place.

## What CI runs, and what it does not prove

CI builds `dist/ts0`, `npm link`s it, fetches the dats binary and runs the suites. Two properties follow from that wiring rather than from any one test.

The unit-test step invokes node directly, never `ts0 test`. So it gets none of what `ts0 test` does for a suite. In particular it gets no explicit `--test-concurrency`, and node then runs test files at `availableParallelism() - 1`, which is 1 on a two-core runner.

Every suite declares `network: false`, so a local run proves a build never needs a network. **CI runs `--no-sandbox` and therefore does not prove it.** The org's self-hosted runner denies unprivileged user namespaces, so bwrap cannot start and there is no docker fallback. Run the suites locally, with bwrap installed, to exercise the sandboxed contract.

CI also builds the two HTML samples into the workspace after the suites. That step is not a test. It only produces the downloadable artifacts.

If you change CLI behavior, update the relevant `samples/*` and the matching `tests/*.dats` suite so the new behavior is covered.
