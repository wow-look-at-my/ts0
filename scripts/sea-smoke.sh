#!/usr/bin/env bash
# sea-smoke.sh -- verifies a prebuilt ts0 SEA binary end-to-end in a CLEAN
# environment: PATH is stripped so no `node`, `npm`, or `npx` is reachable,
# proving the binary is truly self-contained. It runs the same assertions the
# CI smoke steps make against the npm build: the init flow, the type-check
# gate, and the samples (basic, js incl. declaration emit, html, html-jsx).
#
# Usage: scripts/sea-smoke.sh <path-to-ts0-binary>
#
# Must run from a repo checkout with node_modules installed (the samples'
# type-check resolves @types/node and preact from it -- project dependencies
# are the project's own business; the binary supplies node+tsc+esbuild).
set -euo pipefail

BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO=$(cd "$(dirname "$0")/.." && pwd)
[ -x "$BIN" ] || { echo "not executable: $BIN"; exit 1; }

# The stripped environment. /usr/bin:/bin covers the shell utilities this
# script itself needs inside `env -i` (sh, grep, ...); GitHub runners and dev
# machines install node elsewhere (/usr/local/bin, hostedtoolcache, /opt), so
# this PATH must NOT resolve a node -- asserted below. Windows (git-bash)
# additionally needs the system vars without which no process runs sanely.
CLEAN_PATH="/usr/bin:/bin"
TS0_CACHE=$(mktemp -d)
CLEAN_ENV=(env -i PATH="$CLEAN_PATH" HOME="$HOME" TS0_CACHE_DIR="$TS0_CACHE")
case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*)
		# Windows processes malfunction without the system vars; bash sees
		# whatever casing the runner exported, so try both.
		CLEAN_ENV+=(
			SYSTEMROOT="${SYSTEMROOT:-${SystemRoot:-}}"
			WINDIR="${WINDIR:-${windir:-}}"
			TEMP="${TEMP:-}" TMP="${TMP:-}"
		)
		;;
esac

# sha256 helper: GNU coreutils has sha256sum, macOS ships shasum.
sha() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

t0() {
	"${CLEAN_ENV[@]}" "$BIN" "$@"
}

echo "== clean environment has no node =="
if "${CLEAN_ENV[@]}" sh -c 'command -v node'; then
	echo "FAIL: node is reachable on the stripped PATH; this smoke proves nothing"
	exit 1
fi

echo "== init flow (init/build/run/test in a fresh project) =="
proj=$(mktemp -d)
(
	cd "$proj"
	# Without npm on PATH, init's dependency install step prints a warning
	# and skips -- expected. The scaffold's node-target type-check needs the
	# project's OWN @types/node (a project dependency, exactly what `npm
	# install` would have provided), so stand in for it by copying the repo's
	# copy. The ts0 binary itself supplies node + tsc + esbuild; it does not
	# (and should not) supply the project's dependencies.
	t0 init
	mkdir -p node_modules
	cp -R "$REPO/node_modules/@types" node_modules/@types
	t0 build
	t0 run
	t0 run --no-build
	t0 test
)

echo "== type-check gate blocks broken output =="
dir=$(mktemp -d)
printf '%s\n' '{ "entry": "src/main.ts", "outdir": "dist", "target": "node", "format": "esm", "strict": true }' > "$dir/ts0.json"
mkdir -p "$dir/src"
printf 'const n: number = "nope";\nexport {};\n' > "$dir/src/main.ts"
printf 'export {};\n' > "$dir/src/noop.test.ts"
(
	cd "$dir"
	if t0 build; then echo "FAIL: ts0 build succeeded despite a type error"; exit 1; fi
	if [ -e dist ]; then echo "FAIL: ts0 build wrote dist/ despite a type error"; exit 1; fi
	if t0 run; then echo "FAIL: ts0 run succeeded despite a type error"; exit 1; fi
	if t0 run --no-build; then echo "FAIL: ts0 run --no-build executed code despite a type error"; exit 1; fi
	if t0 test; then echo "FAIL: ts0 test ran tests despite a type error"; exit 1; fi
)
jsdir=$(mktemp -d)
printf '%s\n' '{ "entry": "src", "target": "browser" }' > "$jsdir/ts0.json"
mkdir -p "$jsdir/src"
printf 'export const ok: number = 1;\n' > "$jsdir/src/good.ts"
printf 'export const n: number = "nope";\n' > "$jsdir/src/bad.ts"
(
	cd "$jsdir"
	if t0 build; then echo "FAIL: js-target build succeeded despite a type error"; exit 1; fi
	if [ -e dist ]; then echo "FAIL: js-target build wrote dist/ despite a type error"; exit 1; fi
)

echo "== samples/basic (build + test) =="
(
	cd "$REPO/samples/basic"
	rm -rf dist
	t0 build
	t0 test
)

echo "== samples/js (directory target + declaration emit) =="
(
	cd "$REPO/samples/js"
	rm -rf dist
	t0 build
	test -f dist/math/vec.js
	test -f dist/math/shape.js
	test -f dist/gfx/shader.js
	! test -e dist/shaders.js
	! test -e dist/math/vec.js.map
	grep -q 'export' dist/math/vec.js
	test "$(grep -rl 'a\[0\] + b\[0\]' dist | wc -l)" -eq 1
	ls dist/chunk-*.js >/dev/null
	grep -q 'chunk-' dist/math/shape.js
	grep -q 'FRAG_MARKER' dist/gfx/shader.js
	test -f dist/index.d.ts
	test -f dist/badge.d.ts
	test -f dist/math/vec.d.ts
	test -f dist/math/shape.d.ts
	test -f dist/gfx/shader.d.ts
	grep -q '"./math/vec.ts"' dist/index.d.ts
	grep -q '"./badge.tsx"' dist/index.d.ts
	grep -q 'import("preact")' dist/badge.d.ts
	grep -q 'triangleShader: string' dist/gfx/shader.d.ts
	! test -e dist/math/vec.test.js
	! test -e dist/shaders.d.ts
	test -z "$(find dist -name 'chunk-*.d.ts')"
	# Determinism: byte-identical .d.ts across a rebuild. (A while-read loop:
	# xargs cannot invoke the sha() shell function, and the sample tree has
	# no exotic filenames.)
	dts_digest() {
		find dist -name '*.d.ts' | LC_ALL=C sort | while read -r f; do sha "$f"; done | sha
	}
	before=$(dts_digest)
	rm -rf dist
	t0 build
	after=$(dts_digest)
	test "$before" = "$after"
)

echo "== samples/html (inlined bundle + fetch interceptor) =="
(
	cd "$REPO/samples/html"
	rm -rf dist out
	t0 build
	test -f dist/index.html
	grep -q '<style' dist/index.html
	grep -q 'getElementById' dist/index.html
	grep -q 'window.fetch' dist/index.html
	grep -q 'embedded by ts0' dist/index.html
	! grep -q '__ASSETS_JSON__' dist/index.html
	rm -rf dist
	t0 build --entry index.html --outfile out/cli-flag.html
	test -f out/cli-flag.html
	rm -rf out
)

echo "== samples/html-jsx (automatic Preact runtime) =="
(
	cd "$REPO/samples/html-jsx"
	rm -rf dist
	t0 build
	test -f dist/index.html
	! grep -q 'React.createElement' dist/index.html
	grep -q 'preact/jsx-runtime' dist/index.html
)

echo "== asset cache extracted exactly once and reused =="
extractions=$(find "$TS0_CACHE" -mindepth 1 -maxdepth 1 -type d | wc -l)
test "$extractions" -eq 1
test -f "$TS0_CACHE"/*/.ts0-extracted
test -f "$TS0_CACHE"/*/node_modules/typescript/lib/_tsc.js
test -f "$TS0_CACHE"/*/src/runtime/fetch-interceptor.js

echo "sea-smoke OK: $BIN is self-contained (no node on PATH) and passes the CI assertions"
