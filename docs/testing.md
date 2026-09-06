# Testing

Extracted verbatim from `CLAUDE.md`, where this had outgrown an index entry. See `CLAUDE.md`'s "Working on the code" section for the short version and the commands to run these locally.

This file documents the WIRING. It says where a test goes and what runs it. It states the properties that no single test can show. Each suite's own header comment says what that suite covers. Each case's `desc:` string says what that case asserts. `dats test tests/` prints every one of them by name. Do not restate either one here. A per-test catalogue is a third copy of that same text. Nothing checks it, so it drifts.

## Where a test goes

A **unit test** is `src/**/*.test.ts`, for logic a caller can invoke directly. One globbed CI step runs them all: `node --experimental-strip-types --test "src/**/*.test.ts"`. A new file needs no edit to the workflow.

Everything else is a **behavioural suite** in `tests/*.dats`, run by [dats](https://github.com/wow-look-at-my/dats). A test that spawns the CLI and asserts on its output belongs here, whatever the file extension says. `src/commands/test-discovery.test.ts` spawns `ts0 build` and `ts0 test` over temp projects. It is a dats suite wearing a `.test.ts` name.

Every suite stages its project into its own directory. It then asserts what the build WROTE, through declarative `outputs.files` match and notMatch checks. Shell covers only a property that spans files. A staged project gets the repo's `node_modules` symlinked in. That is where it resolves `@types/node` and `preact`.

## What CI runs, and what it does not prove

CI builds `dist/ts0`, `npm link`s it, fetches the dats binary and runs the suites. Two properties follow from that wiring rather than from any one test.

The unit-test step invokes node directly, never `ts0 test`. So it gets none of what `ts0 test` does for a suite. In particular it gets no explicit `--test-concurrency`. node then runs test files at `availableParallelism() - 1`, which is 1 on a two-core runner.

Every suite declares `network: false`, so a run proves that a build never needs a network. The dats action supplies the backend on its own: it installs bubblewrap and clears Ubuntu's `apparmor_restrict_unprivileged_userns`, which otherwise denies bwrap the user namespace it needs. The action's surface has no way to turn the sandbox off, so a green leg is a sandboxed leg.

CI also builds the two HTML samples into the workspace after the suites. That step is not a test. It stages the pages the publish job serves, so a human can open a sample build in a browser.

Nothing here uses GitHub Actions artifact storage. A job-to-job hand-off rides `wow-look-at-my/actions@cache-upload#latest` and its download sibling, and the publish job deletes the run's hand-offs at the end. The org's artifact quota is billed in accrued GB-hours, which deleting cannot free.

If you change CLI behavior, update the relevant `samples/*` and the matching `tests/*.dats` suite so the new behavior is covered.
