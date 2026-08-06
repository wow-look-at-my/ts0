# `"inlineAssets": false` on an HTML entry emits a multi-file static site
# instead of one inlined document: each referenced local script/stylesheet is
# bundled to its own file under `assetPath`, and the tag keeps referencing it.
# This suite builds samples/html-referenced with the linked `ts0` and asserts
# the shape of what lands on disk -- that nothing was inlined, that the
# references point at assetPath, that the bundles are real bundles, and that
# two sources competing for one output name fail the build with nothing
# written. See CLAUDE.md, "Referenced assets (inlineAssets: false)".
#
# The sample is copied into the test's own directory before building: the
# repo is bind-mounted read-only in the sandbox, and outputs.files addresses
# paths under that directory. No network: a build must never need one.
sandbox:
	enabled: true
	network: false

shared:
	files:
		# Stages samples/html-referenced into the test directory (derived from
		# the log path dats hands us) and builds it there. Any dist/ carried in
		# from a host-side build is removed first, so every assertion is about
		# what THIS build wrote.
		stage.sh: |
			stage() {
				root="$(dirname "$1")"
				cp -r samples/html-referenced/. "$root/"
				rm -rf "$root/dist"
				[ -d "$PWD/node_modules" ] && ln -s "$PWD/node_modules" "$root/node_modules"
				cd "$root"
			}

		build.sh: |
			set -euo pipefail
			. {shared.stage.sh}
			stage "$1"
			ts0 build 2>&1 | tee "$1"

		# A second entry whose basename also bundles to main.js. The build must
		# refuse it rather than letting one bundle overwrite the other.
		collide.sh: |
			set -euo pipefail
			. {shared.stage.sh}
			stage "$1"
			mkdir -p src/other
			printf 'export const extra: number = 1;\nconsole.log(extra);\n' > src/other/main.ts
			printf '%s\n' '<script type="module" src="./src/other/main.ts"></script>' >> index.html
			ts0 build 2>&1 | tee "$1"

tests:
	- desc: "inlineAssets false emits the shell plus one bundle per reference"
	  cmd: bash {shared.build.sh} {outputs.build.log}
	  outputs:
		files:
			dist/index.html:
				match:
					# References rewritten to assetPath, verbatim as authored
					# ("/assets" is used as the URL prefix exactly as given).
					- '<script type="module" src="/assets/main\.js"></script>'
					- 'href="/assets/app\.css"'
					# The external stylesheet is left completely alone.
					- '<link rel="stylesheet" href="https://example\.com/theme\.css" />'
				notMatch:
					# Nothing was inlined: no <style>, no <script> with a body,
					# and no application source text in the shell.
					- '<style'
					- '<script[^>]*>[^<]'
					- 'REFERENCED_BUNDLE_MARKER'
					- 'getElementById'
					# No source path survives the rewrite.
					- '\./src/'
			dist/assets/main.js:
				match:
					- 'REFERENCED_BUNDLE_MARKER'
			dist/assets/app.css:
				# A real bundle, not a passthrough copy: esbuild flattened both
				# @imports into one file.
				match:
					- 'letter-spacing: 0\.04em'
					- 'backdrop-filter: blur\(3px\)'
				notMatch:
					- '@import'

	- desc: "colliding output basenames fail the build and write nothing"
	  cmd: bash {shared.collide.sh} {outputs.build.log}
	  exit: 1
	  outputs:
		stdout:
			- 'src/main.ts and src/other/main.ts both bundle to "main.js"'
		"!files":
			dist/index.html:
			dist/assets/main.js:
			dist/assets/app.css:
