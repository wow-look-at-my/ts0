# Every sample under samples/ built with the linked `ts0`, asserting what each
# target actually writes: the single-file HTML inliner, HTML+JSX through the
# automatic runtime, the js library target (dedup, loaders, declarations,
# determinism), userscript header preservation, and bookmarklet href bundling.
#
# Each test stages its sample into the test's own directory: the repo is
# bind-mounted read-only in the sandbox, and outputs.files addresses paths
# under that directory. No network -- a build must never need one.
sandbox:
	enabled: true
	network: false

shared:
	files:
		# Copies a sample into the writable test directory (derived from the log
		# path dats hands the script) and cds there. Any dist/ carried in from a
		# host-side build is dropped first, so every assertion is about THIS build.
		stage.sh: |
			stage() {
				root="$(dirname "$1")"
				cp -r "$2/." "$root/"
				rm -rf "$root/dist"
				# In the repo a sample resolves @types/node and preact by
				# walking up to the repo's node_modules; staged elsewhere that
				# walk finds nothing and the type-check fails on the sample's
				# own imports. The link puts it back at the same relative
				# position (the repo is readable in the sandbox, just not
				# writable).
				[ -d "$PWD/node_modules" ] && ln -s "$PWD/node_modules" "$root/node_modules"
				cd "$root"
			}

		# The common shape: stage $2, build, tee the build output to $1.
		build.sh: |
			set -euo pipefail
			. {shared.stage.sh}
			stage "$1" "$2"
			ts0 build 2>&1 | tee "$1"

tests:
	- desc: "basic sample builds and its tests pass"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" samples/basic
				ts0 build 2>&1 | tee "$1"
				ts0 test 2>&1 | tee -a "$1"
	  outputs:
		files:
			dist/main.js:

	- desc: "html sample inlines JS, CSS and runtime assets into one document"
	  cmd: bash {shared.build.sh} {outputs.build.log} samples/html
	  outputs:
		files:
			dist/index.html:
				match:
					- '<style'
					- 'getElementById'
					# CSS asset embedding: the body's background-image url()
					# becomes a data: URL so the bundle works from disk.
					- 'data:image/png;base64'
					# Inline-module bundling: the inline <script type="module">
					# body imports ./src/greet.ts, bundled in place.
					- 'greeting\("inline"\)'
					# Fetch interceptor: the patched fetch and the embedded
					# shader text, with the placeholder substituted.
					- 'window\.fetch'
					- 'embedded by ts0'
				notMatch:
					# Nothing local is left as a reference.
					- '<script[^>]+src='
					- '<link[^>]+rel=["'']stylesheet["'']'
					- '__ASSETS_JSON__'

	- desc: "CLI flags override entry and outfile without a config edit"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" samples/html
				ts0 build --entry index.html --outfile out/cli-flag.html 2>&1 | tee "$1"
	  outputs:
		files:
			out/cli-flag.html:

	- desc: "html-jsx sample compiles JSX to the automatic Preact runtime"
	  cmd: bash {shared.build.sh} {outputs.build.log} samples/html-jsx
	  outputs:
		files:
			dist/index.html:
				match:
					- 'preact/jsx-runtime'
					# The rendered component's text survives bundling.
					- 'ts0 \+ Preact'
					# JSX text containing the word "any" is prose, not a type:
					# the explicit-any ban parses rather than text-searching, so
					# this component builds and its tagline reaches the output.
					- 'any questions'
				notMatch:
					# A Preact bundle emitting the classic factory throws
					# "React is not defined" at runtime.
					- 'React\.createElement'
					- 'React\.Fragment'

	- desc: "js sample mirrors the source tree, dedups shared code, emits declarations"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" samples/js
				# Running the sample's tests is the only thing that EXECUTES
				# vec.test.ts -- the parent repo's `ts0 test` skips a nested
				# project's tests. It is what catches an import that bundles
				# but that Node's ESM resolver cannot resolve at run time.
				ts0 test 2>&1 | tee "$1"
				ts0 build 2>&1 | tee -a "$1"
				# Cross-file properties, which no single-file check can state.
				# No duplication: add() is shared (vec.ts is an entry AND
				# shape.ts imports it), so its body must live in exactly one
				# output file -- a chunk -- never copied into each importer.
				test "$(grep -rl 'a\[0\] + b\[0\]' dist | wc -l)" -eq 1
				ls dist/chunk-*.js >/dev/null
				# Chunks are esbuild artifacts, not source modules: the
				# declaration tree mirrors sources, so chunks get no .d.ts.
				test -z "$(find dist -name 'chunk-*.d.ts')"
				# declarationMap is never enabled.
				test -z "$(find dist -name '*.d.ts.map')"
				# Determinism: consumers commit fetched .d.ts copies and diff
				# them for freshness, so a rebuild must be byte-identical.
				before=$(find dist -name '*.d.ts' -print0 | sort -z | xargs -0 sha256sum | sha256sum)
				rm -rf dist
				ts0 build >/dev/null 2>&1
				after=$(find dist -name '*.d.ts' -print0 | sort -z | xargs -0 sha256sum | sha256sum)
				test "$before" = "$after"
				echo "js sample OK: dedup, chunk hygiene, deterministic declarations"
	  outputs:
		stdout:
			- "js sample OK"
		files:
			# Directory entry -> js library target: every src/**/*.ts compiled
			# to a parallel dist/**/*.js, structure preserved.
			dist/math/vec.js:
			# loaders config: a non-shared .frag import inlined as text (a
			# JS-module import would have errored).
			dist/gfx/shader.js:
				match:
					- 'FRAG_MARKER'
			dist/math/shape.js:
				# shape.js imports the shared chunk rather than inlining it.
				match:
					- 'chunk-'
				notMatch:
					- 'a\[0\] \+ b\[0\]'
			dist/index.js:
				match:
					- 'export'
				# A shebang is a node-outfile convenience, never a library.
				notMatch:
					- '#!/usr/bin/env node'
			# Declarations are default-on for this target and mirror the tree.
			dist/index.d.ts:
				match:
					# .ts/.tsx specifiers are preserved (consumers resolve them
					# to the sibling .d.ts by extension substitution).
					- '"\./math/vec\.ts"'
					- '"\./badge\.tsx"'
			dist/badge.d.ts:
				match:
					- 'import\("preact"\)'
			dist/math/shape.d.ts:
				match:
					# Extensionless imports stay extensionless.
					- '"\./vec"'
			dist/gfx/shader.d.ts:
				match:
					# The loader-backed import erases to the annotated type.
					- 'triangleShader: string'
				notMatch:
					- 'triangle\.frag'
			dist/math/vec.d.ts:
		"!files":
			# *.d.ts sources are not compiled to outputs or copied to dist,
			# test files produce no output of either kind, and sourcemap:false
			# means no .map files.
			dist/shaders.js:
			dist/shaders.d.ts:
			dist/math/vec.js.map:
			dist/math/vec.test.js:
			dist/math/vec.test.d.ts:

	- desc: "declarations false emits the js tree with no .d.ts"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			# The escape hatch for projects that can't ship declarations.
			ts0.json: |
				{ "entry": "src", "target": "browser", "declarations": false }
			src/one.ts: |
				export const one: number = 1;
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" "$(dirname {inputs.ts0.json})"
				ts0 build 2>&1 | tee "$1"
				test -z "$(find dist -name '*.d.ts')"
				echo "opt-out OK: .js emitted, no .d.ts"
	  outputs:
		stdout:
			- "opt-out OK"
		files:
			dist/one.js:

	- desc: "userscript sample keeps its ==UserScript== header byte-exactly, once"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" samples/userscript
				ts0 build 2>&1 | tee "$1"
				head -1 dist/main.user.js | grep -qx '// ==UserScript=='
				# Directly below the header sits the IIFE assigned to the
				# configured global.
				sed -n '8p' dist/main.user.js | grep -q '^var __USERSCRIPT_API'
				# A rebuild rewrites the file, so headers never stack.
				ts0 build >/dev/null 2>&1
				test "$(grep -c '^// ==UserScript==$' dist/main.user.js)" -eq 1
				echo "userscript OK: header exact, once, stable across rebuild"
	  outputs:
		stdout:
			- "userscript OK"
		files:
			dist/main.user.js:
				match:
					- '(?m)^// ==UserScript==$'
					- '(?m)^// ==/UserScript==$'
					- '(?m)^// @version      1\.0$'
					# The extensionless ./lib/greet import type-checked
					# (browser targets gate-check with bundler resolution) and
					# was inlined.
					- 'hello from a bundled'
				notMatch:
					# A plain script: no module statements, and no shebang --
					# that is a node convenience and would corrupt the header.
					- '(?m)^(import|export) '
					- '#!/usr/bin/env node'

	- desc: "bookmarklet sample encodes a javascript: href into a real bookmarklet"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			# Decoding the href must yield the bundled program, with the
			# ./lib/toast import inlined into it.
			decode.js: |
				const html = require("fs").readFileSync("dist/index.html", "utf8");
				const href = html.match(/href="javascript:([^"]+)"/)[1];
				const code = decodeURIComponent(href);
				if (!code.includes("copied:")) throw new Error("entry code missing from decoded bookmarklet");
				if (!code.includes("createElement")) throw new Error("lib import not inlined into bookmarklet");
				console.log("bookmarklet decodes to the bundled program");
			run.sh: |
				set -euo pipefail
				. {shared.stage.sh}
				stage "$1" samples/bookmarklet
				ts0 build 2>&1 | tee "$1"
				node {inputs.decode.js}
	  outputs:
		stdout:
			- "bookmarklet decodes to the bundled program"
		files:
			dist/index.html:
				match:
					- 'href="javascript:\(\(\)%3D%3E'
					# A real javascript: href (not a file reference) and the
					# rest of the page stay untouched.
					- 'href="javascript:void\(0\)"'
					- 'BOOKMARKLET_PAGE_MARKER'
				notMatch:
					- 'javascript:\./src/copy-title\.ts'
					# The page has no embeddable assets, so no interceptor.
					- 'window\.fetch'
