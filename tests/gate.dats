# The type-check gate and the explicit-`any` ban: there must be NO way to build
# or run code that has not passed tsc. Every path that emits or executes --
# build, run, run --no-build, test -- has to refuse broken code and leave
# nothing behind, for the node target, the js (directory) target and HTML
# entries alike. The fixtures are deliberately shaped so a skipped check would
# LOOK fine: the type error strips to valid JS and the test file registers no
# tests, so `run --no-build` and `test` would exit 0 if the gate were ever
# bypassed. See CLAUDE.md, "Type-checking".
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
				rm -rf "$root/dist"
				[ -d "$PWD/node_modules" ] && ln -s "$PWD/node_modules" "$root/node_modules"
				cd "$root"
			}

		# Runs a staged project's build and tees the output; the build's own
		# exit code is the test's.
		build.sh: |
			set -euo pipefail
			. {shared.stage.sh}
			stage "$1" "$2"
			ts0 build 2>&1 | tee "$1"

tests:
	- desc: "a type error refuses build, run, run --no-build and test, writing nothing"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }
			src/main.ts: |
				const n: number = "nope";
				export {};
			src/noop.test.ts: |
				export {};
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				if ts0 build; then echo "FAIL: ts0 build succeeded despite a type error"; exit 1; fi
				if [ -e dist ]; then echo "FAIL: ts0 build wrote dist/"; exit 1; fi
				if ts0 run; then echo "FAIL: ts0 run succeeded despite a type error"; exit 1; fi
				if [ -e dist ]; then echo "FAIL: ts0 run wrote dist/"; exit 1; fi
				if ts0 run --no-build; then echo "FAIL: ts0 run --no-build executed broken code"; exit 1; fi
				if ts0 test; then echo "FAIL: ts0 test ran tests despite a type error"; exit 1; fi
				echo "gate OK: build, run, run --no-build and test all refused broken code" | tee "$1"
	  outputs:
		stdout:
			- "gate OK: build, run, run --no-build and test all refused broken code"
		"!files":
			dist/main.js:

	- desc: "a type error in a js (directory) target emits no .js and no partial .d.ts"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src", "target": "browser" }
			src/good.ts: |
				export const ok: number = 1;
			src/bad.ts: |
				export const n: number = "nope";
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				if ts0 build; then echo "FAIL: js-target build succeeded despite a type error"; exit 1; fi
				if [ -e dist ]; then echo "FAIL: js-target build wrote dist/"; exit 1; fi
				echo "js-target gate OK: no .js and no partial .d.ts emitted" | tee "$1"
	  outputs:
		stdout:
			- "js-target gate OK"
		"!files":
			dist/good.js:
			dist/good.d.ts:

	# tsc's `**/*` never descends into a dot-directory, so an entry living in one
	# was bundled against an EMPTY program and the build reported success. The
	# gate names the configured entry for exactly this reason.
	- desc: "an entry under a dot-directory is type-checked like any other"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": ".github/scripts/step.ts", "outfile": "out/step.js", "target": "node" }
			.github/scripts/step.ts: |
				const n: number = "nope";
				export { n };
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				# dats creates the parent of every declared !files entry, so
				# out/ exists before the build does anything; drop it first or
				# the check below asserts dats' own artifact.
				rm -rf out
				if ts0 build; then echo "FAIL: entry under a dot-directory built despite a type error"; exit 1; fi
				if [ -e out ]; then echo "FAIL: entry under a dot-directory wrote out/"; exit 1; fi
				echo "dot-directory entry gate OK: type-checked like any other entry" | tee "$1"
	  outputs:
		stdout:
			- "dot-directory entry gate OK"
		"!files":
			out/step.js:

	- desc: "an explicit any refuses build, run, run --no-build and test"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }
			# Valid TypeScript apart from the explicit `any` -- tsc has no flag
			# for it, so a skipped ban would build this cleanly.
			src/main.ts: |
				export function f(x: any): number {
					return Number(x);
				}
			src/noop.test.ts: |
				export {};
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				if ts0 build; then echo "FAIL: ts0 build succeeded despite an explicit any"; exit 1; fi
				if [ -e dist ]; then echo "FAIL: ts0 build wrote dist/"; exit 1; fi
				if ts0 run; then echo "FAIL: ts0 run succeeded despite an explicit any"; exit 1; fi
				if ts0 run --no-build; then echo "FAIL: ts0 run --no-build executed it"; exit 1; fi
				if ts0 test; then echo "FAIL: ts0 test ran tests despite an explicit any"; exit 1; fi
				echo "explicit-any gate OK on every path" | tee "$1"
	  outputs:
		stdout:
			- "explicit-any gate OK on every path"
		"!files":
			dist/main.js:

	- desc: "every spelling of an explicit any is a build error"
	  cmd: bash {shared.build.sh} {outputs.build.log} "$(dirname {inputs.ts0.json})"
	  exit: 1
	  matrix:
		form:
			- "const a = 1 as any;"
			- "const a = <any>1;"
			- "const a: any[] = [];"
			- "let a: Promise<any>;"
			- "type A = any;"
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }
			src/main.ts: |
				export {};
				{matrix.form}
				void 0;
	  outputs:
		"!files":
			dist/main.js:

	- desc: "an explicit any inside a .d.ts is a build error"
	  cmd: bash {shared.build.sh} {outputs.build.log} "$(dirname {inputs.ts0.json})"
	  exit: 1
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }
			src/main.ts: |
				export const ok: number = 1;
			# The gate's skipLibCheck means tsc never looks inside a .d.ts, so
			# only the ban's own pass catches this.
			src/shim.d.ts: |
				declare module "*.frag" {
					const src: any;
					export default src;
				}
	  outputs:
		"!files":
			dist/main.js:

	- desc: "the word any outside a type still builds -- the ban parses, never text-searches"
	  cmd: bash {shared.build.sh} {outputs.build.log} "$(dirname {inputs.ts0.json})"
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }
			src/main.ts: |
				// a comment about any, as any, any[]
				const anyOf = 1;
				const bag = { any: 2, note: "as any" };
				const re = /any/;
				export const total = anyOf + bag.any + (re.test(bag.note) ? 1 : 0);
	  outputs:
		files:
			dist/main.js:

	- desc: "exclude limits the gate without changing what gets built"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm" }
			src/main.ts: |
				export const ok: number = 1;
			# A tree that type-checks under its own separate tsconfig.
			junk/broken.ts: |
				const n: number = "nope";
				export {};
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				if ts0 build; then echo "FAIL: the gate ignored junk/broken.ts"; exit 1; fi
				printf '%s\n' '{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "exclude": ["junk"] }' > ts0.json
				ts0 build 2>&1 | tee "$1"
				echo "exclude OK: gate skipped the excluded dir, build unchanged"
	  outputs:
		stdout:
			- "exclude OK"
		files:
			dist/main.js:

	# HTML entries were once exempt from the gate and reported success
	# regardless, shipping type errors to the browser behind a
	# "Type-checking..." line that had checked nothing.
	#
	# Staged inline rather than kept under samples/: build and test recurse
	# into every nested ts0 project, so a permanently-broken one living in the
	# tree would fail the repo's own build forever.
	- desc: "a type error in an HTML entry fails the build"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  exit: 1
	  inputs:
		files:
			ts0.json: |
				{ "entry": "index.html", "outdir": "dist", "target": "browser", "format": "esm", "strict": true }
			index.html: |
				<!DOCTYPE html>
				<html lang="en">
					<head>
						<meta charset="utf-8" />
						<title>HTML entry with a type error (expected to FAIL)</title>
					</head>
					<body>
						<script type="module" src="./src/main.ts"></script>
					</body>
				</html>
			src/main.ts: |
				const answer: number = "forty-two";
				console.log(answer);
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				ts0 build 2>&1 | tee "$1"
	  outputs:
		stdout:
			- "TS2322"
		"!files":
			dist/index.html:

	# Nested projects are RECURSED INTO, never skipped. A nested ts0.json means
	# different settings (JSX, target, loaders), so the parent's gate cannot
	# check that tree -- it delegates instead, building and testing it under its
	# own config. Skipping it was the alternative, and it reports green over
	# code nothing ever checked.
	- desc: "a broken nested project fails the parent's build and test"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			src/main.ts: |
				export const ok: number = 1;
			nested/ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			nested/src/main.ts: |
				export const ok: number = 1;
			# Strips to valid JS and registers no tests, so an un-checked run
			# of it would exit 0 -- only the nested gate rejects it.
			nested/src/main.test.ts: |
				const n: number = "nope";
				export { n };
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				rm -rf dist nested/dist
				if ts0 build; then echo "FAIL: build passed over a broken nested project"; exit 1; fi
				if ts0 test; then echo "FAIL: test passed over a broken nested project"; exit 1; fi
				# The parent's own build still ran; only the nested one refused.
				test -f dist/main.js
				if [ -e nested/dist ]; then echo "FAIL: nested project emitted output"; exit 1; fi
				ts0 build 2>&1 | tee "$1" || true
				echo "recursion OK: the nested project was entered and refused" | tee -a "$1"
	  outputs:
		stdout:
			- "TS2322"
			- "recursion OK: the nested project was entered and refused"

	# Each project must find the one test file IT owns. The other way to get
	# this wrong is to glob the nested tests into the parent's own run, which
	# EXECUTES a program the parent's gate never checked, under settings it was
	# not written for. Counting the discovery lines is what tells the two apart:
	# a green run says nothing about which project ran what.
	- desc: "a clean nested project is built and tested by the parent, each finding its own tests"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			src/main.ts: |
				export const ok: number = 1;
			src/main.test.ts: |
				export const parentRan = 1;
			nested/ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			nested/src/main.ts: |
				export const ok: number = 1;
			nested/src/main.test.ts: |
				export const nestedRan = 1;
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				rm -rf dist nested/dist
				ts0 build 2>&1 | tee "$1"
				ts0 test 2>&1 | tee -a "$1"

				grep -q "^nested:$" "$1" || { echo "FAIL: the nested project was never entered" | tee -a "$1"; exit 1; }
				found=$(grep -c "Found 1 test file" "$1" || true)
				if [ "$found" -ne 2 ]; then
					echo "FAIL: expected one test run per project, saw $found" | tee -a "$1"
					exit 1
				fi
				echo "recursion OK: both projects built" | tee -a "$1"
	  outputs:
		stdout:
			- "recursion OK: both projects built"
		files:
			dist/main.js:
			nested/dist/main.js:

	# `ts0 run` is the one command that does NOT recurse, and only because it
	# executes a single entry. Building a nested project it will never run is
	# work nobody asked for, and it writes output into a tree the caller did not
	# name.
	- desc: "ts0 run builds only its own project, not nested ones"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			src/main.ts: |
				export const ok: number = 1;
			nested/ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			nested/src/main.ts: |
				export const ok: number = 1;
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				rm -rf dist nested/dist
				ts0 run 2>&1 | tee "$1"
				if [ -e nested/dist ]; then
					echo "FAIL: run built a nested project it will not execute" | tee -a "$1"
					exit 1
				fi
				echo "run OK: only this project was built" | tee -a "$1"
	  outputs:
		stdout:
			- "run OK: only this project was built"
		files:
			dist/main.js:
		"!files":
			nested/dist/main.js:
