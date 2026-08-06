# The type-check gate and the explicit-`any` ban: there must be NO way to build
# or run code that has not passed tsc. Every path that emits or executes --
# build, run, run --no-build, test -- has to refuse broken code and leave
# nothing behind, for the node target, the js (directory) target and HTML
# entries alike. The fixtures are deliberately shaped so a skipped check would
# LOOK fine: the type error strips to valid JS and the test file registers no
# tests, so `run --no-build` and `test` would exit 0 if the gate were ever
# bypassed. See CLAUDE.md, "Type-checking".
sandbox:
	enabled: true
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
	- desc: "a type error in an HTML entry fails the build"
	  cmd: bash {shared.build.sh} {outputs.build.log} samples/html-jsx-typeerror
	  exit: 1
	  outputs:
		stdout:
			- "TS2322"
		"!files":
			dist/index.html:
