# `test.build`: `ts0 test` runs the project's declared build ONCE, after the
# gate and before any test file is compiled or run. Test files that read the
# build's output must never build it themselves, since several running at once
# would race on the same output directory.
sandbox:
	network: false

shared:
	files:
		stage.sh: |
			# Copies a directory into the writable test directory (derived from
			# the log path dats hands the script) and cds there.
			stage() {
				root="$(dirname "$1")"
				cp -r "$2/." "$root/"
				rm -rf "$root/dist" "$root/events.log"
				[ -d "$PWD/node_modules" ] && ln -s "$PWD/node_modules" "$root/node_modules"
				cd "$root"
			}

tests:
	- desc: "the declared build runs exactly once, before every test file"
	  cmd: bash {inputs.run.sh} {outputs.run.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "exclude": ["test/fixtures"], "test": { "build": "bash build.sh" } }
			src/main.ts: |
				export const ok: number = 1;
			# The sleep holds the build open, so a test file started before it
			# finished would read no marker and fail.
			build.sh: |
				set -eu
				echo build >> events.log
				sleep 1
				mkdir -p dist
				echo built > dist/marker.txt
			# Each test file records that it ran and what the build left it. The
			# staged project may lack @types/node, so fs comes through an
			# untyped-safe lookup instead of an import.
			src/a.test.ts: |
				const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { appendFileSync(p: string, d: string): void; readFileSync(p: string, e: string): string } } }).process.getBuiltinModule("node:fs");
				fs.appendFileSync("events.log", `test saw ${fs.readFileSync("dist/marker.txt", "utf-8").trim()}\n`);
				export const done = 1;
			test/b.test.ts: |
				const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { appendFileSync(p: string, d: string): void; readFileSync(p: string, e: string): string } } }).process.getBuiltinModule("node:fs");
				fs.appendFileSync("events.log", `test saw ${fs.readFileSync("dist/marker.txt", "utf-8").trim()}\n`);
				export const done = 1;
			test/c.test.ts: |
				const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { appendFileSync(p: string, d: string): void; readFileSync(p: string, e: string): string } } }).process.getBuiltinModule("node:fs");
				fs.appendFileSync("events.log", `test saw ${fs.readFileSync("dist/marker.txt", "utf-8").trim()}\n`);
				export const done = 1;
			# Under an `exclude`d directory: discovery must skip it, or it fails.
			test/fixtures/never.test.ts: |
				throw new Error("an excluded fixture was run as a test");
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				ts0 test 2>&1 | tee "$1"
				builds=$(grep -c '^build$' events.log)
				tests=$(grep -c '^test saw built$' events.log)
				if [ "$builds" -ne 1 ]; then echo "FAIL: the build ran $builds times" | tee -a "$1"; exit 1; fi
				if [ "$(head -n 1 events.log)" != "build" ]; then echo "FAIL: a test ran before the build" | tee -a "$1"; exit 1; fi
				if [ "$tests" -ne 3 ]; then echo "FAIL: $tests test files saw the build output, not 3" | tee -a "$1"; exit 1; fi
				if [ "$(wc -l < events.log)" -ne 4 ]; then echo "FAIL: unexpected events:" | tee -a "$1"; cat events.log | tee -a "$1"; exit 1; fi
				echo "test.build OK: built once, then every test file saw the output" | tee -a "$1"
	  outputs:
		stdout:
			- "Building for tests: bash build.sh"
			- "test.build OK: built once, then every test file saw the output"

	- desc: "a failing build fails ts0 test loudly and runs no test"
	  cmd: bash {inputs.run.sh} {outputs.run.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "test": { "build": "bash build.sh" } }
			src/main.ts: |
				export const ok: number = 1;
			build.sh: |
				echo "BUILD BROKE" >&2
				exit 3
			src/a.test.ts: |
				const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { appendFileSync(p: string, d: string): void } } }).process.getBuiltinModule("node:fs");
				fs.appendFileSync("events.log", "test ran\n");
				export const done = 1;
			run.sh: |
				set -uo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				ts0 test > "$1" 2>&1
				code=$?
				cat "$1"
				if [ "$code" -ne 3 ]; then echo "FAIL: ts0 test exited $code, not the build's 3"; exit 1; fi
				if [ -e events.log ]; then echo "FAIL: a test ran after the build failed"; exit 1; fi
				shopt -s nullglob
				compiled=(src/*.ts0.*)
				if [ "${#compiled[@]}" -ne 0 ]; then echo "FAIL: tests were compiled after the build failed: ${compiled[*]}"; exit 1; fi
				grep -q 'BUILD BROKE' "$1" || { echo "FAIL: the build's own output was not shown"; exit 1; }
				grep -q 'Build failed: test.build `bash build.sh` exited with code 3; no tests were run' "$1" || { echo "FAIL: no build failure message"; exit 1; }
				echo "test.build failure OK: ts0 test failed before any test"
	  outputs:
		stdout:
			- "test.build failure OK: ts0 test failed before any test"

	- desc: "the build never runs when the gate fails"
	  cmd: bash {inputs.run.sh} {outputs.run.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "test": { "build": "bash build.sh" } }
			src/main.ts: |
				const n: number = "nope";
				export {};
			build.sh: |
				echo build >> events.log
			src/noop.test.ts: |
				export {};
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				if ts0 test; then echo "FAIL: ts0 test passed despite a type error"; exit 1; fi
				if [ -e events.log ]; then echo "FAIL: the build ran on code the gate rejected"; exit 1; fi
				echo "test.build gate OK" | tee "$1"
	  outputs:
		stdout:
			- "test.build gate OK"

	- desc: "an empty test.build is a config error"
	  cmd: bash {inputs.run.sh} {outputs.run.log}
	  exit: 1
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "test": { "build": "" } }
			src/main.ts: |
				export const ok: number = 1;
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				ts0 test 2>&1 | tee "$1"
	  outputs:
		stdout:
			- "test.build must be a non-empty shell command string"
