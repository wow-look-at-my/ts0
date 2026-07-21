#!/usr/bin/env bash
# prebuilt-smoke.sh -- verifies the prebuilt ts0.js end-to-end the way a
# consumer runs it: stock Node only. The environment is stripped so `node`
# is the ONLY toolchain reachable (no npm, no npx), and the esbuild-native
# fetch is exercised against a local HTTP server holding the just-built
# natives (so the smoke needs no external network). It then runs the same
# assertions CI makes against the npm build: the init flow, the type-check
# gate, and the samples (basic, js incl. declaration emit + determinism,
# html, html-jsx, userscript, bookmarklet) -- plus the prebuilt-specific
# behaviors: the pipe form
# (`cat ts0.js | node - build`), the clear fetch-failure message, and
# offline cache reuse.
#
# Usage: scripts/prebuilt-smoke.sh <path-to-ts0.js> <path-to-natives-dir>
#
# Must run from a repo checkout with node_modules installed (the samples'
# type-check resolves @types/node and preact from it -- project dependencies
# are the project's business; ts0.js supplies the toolchain).
set -euo pipefail

TS0JS=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
NATIVES=$(cd "$2" && pwd)
REPO=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$TS0JS" ] || { echo "not a file: $TS0JS"; exit 1; }

case "$(uname -m)" in
	x86_64) ARCH=amd64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) echo "unsupported smoke arch: $(uname -m)"; exit 1 ;;
esac
# Natives are named esbuild-<version>_<os>_<arch> (the buildhost-publish
# action's convention); glob so this script needs no version knowledge.
NATIVE_FILE=$(cd "$NATIVES" && ls esbuild-*_linux_"$ARCH" 2>/dev/null | head -1)
[ -n "$NATIVE_FILE" ] || { echo "missing native esbuild-*_linux_$ARCH in $NATIVES"; exit 1; }

# The stripped environment: a bin dir holding ONLY node, plus /usr/bin:/bin
# for the shell utilities this script itself needs inside `env -i`. GitHub
# runners and dev machines install npm next to node (excluded); asserted
# below.
NODE_BIN=$(command -v node)
BINDIR=$(mktemp -d)
ln -s "$NODE_BIN" "$BINDIR/node"
CLEAN_PATH="$BINDIR:/usr/bin:/bin"
TS0_CACHE=$(mktemp -d)

# Local server for the esbuild-native fetch (runs with the full environment;
# only ts0 invocations are stripped).
SERVER_LOG=$(mktemp)
node -e '
	const http = require("http"), fs = require("fs"), path = require("path");
	const dir = process.argv[1];
	http.createServer((req, res) => {
		const f = path.join(dir, path.basename(new URL(req.url, "http://x").pathname));
		fs.createReadStream(f).on("error", () => { res.statusCode = 404; res.end(); }).pipe(res);
	}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
' "$NATIVES" > "$SERVER_LOG" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
until grep -q '^PORT ' "$SERVER_LOG"; do sleep 0.1; done
PORT=$(awk '/^PORT /{print $2; exit}' "$SERVER_LOG")
ESBUILD_URL="http://127.0.0.1:$PORT/$NATIVE_FILE"

t0() {
	env -i PATH="$CLEAN_PATH" HOME="$HOME" TS0_CACHE_DIR="$TS0_CACHE" TS0_ESBUILD_URL="$ESBUILD_URL" \
		node "$TS0JS" "$@"
}

echo "== clean environment has node but NO npm/npx =="
env -i PATH="$CLEAN_PATH" sh -c 'command -v node' >/dev/null
if env -i PATH="$CLEAN_PATH" sh -c 'command -v npm || command -v npx'; then
	echo "FAIL: npm/npx reachable on the stripped PATH; this smoke proves nothing"
	exit 1
fi

echo "== fetch failure names the URL and destination =="
failcache=$(mktemp -d)
out=$(env -i PATH="$CLEAN_PATH" HOME="$HOME" TS0_CACHE_DIR="$failcache" \
	TS0_ESBUILD_URL="http://127.0.0.1:1/unreachable" node "$TS0JS" build 2>&1) && {
	echo "FAIL: ts0 succeeded with an unreachable esbuild URL"; exit 1; } || true
echo "$out" | grep -q "http://127.0.0.1:1/unreachable" || { echo "FAIL: error does not name the URL"; echo "$out"; exit 1; }
echo "$out" | grep -q "dest:" || { echo "FAIL: error does not name the destination path"; echo "$out"; exit 1; }

echo "== init flow (init/build/run/test in a fresh project) =="
proj=$(mktemp -d)
(
	cd "$proj"
	# Without npm on PATH, init's dependency install step prints a warning
	# and skips -- expected. The scaffold's node-target type-check needs the
	# project's OWN @types/node (a project dependency, exactly what `npm
	# install` would have provided), so stand in for it by copying the
	# repo's copy. ts0.js supplies node + tsc + esbuild; it does not (and
	# should not) supply the project's dependencies.
	t0 init
	mkdir -p node_modules
	cp -R "$REPO/node_modules/@types" node_modules/@types
	t0 build
	t0 run
	t0 run --no-build
	t0 test
)

echo "== pipe form: curl ... | node - build (simulated with cat) =="
(
	cd "$proj"
	rm -rf dist
	cat "$TS0JS" | env -i PATH="$CLEAN_PATH" HOME="$HOME" TS0_CACHE_DIR="$TS0_CACHE" \
		TS0_ESBUILD_URL="$ESBUILD_URL" node - build
	test -f dist/main.js
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
	# Determinism: byte-identical .d.ts across a rebuild.
	dts_digest() {
		find dist -name '*.d.ts' | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done | sha256sum
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

echo "== samples/userscript (iife + globalName + preserveHeader) =="
(
	cd "$REPO/samples/userscript"
	rm -rf dist
	t0 build
	test -f dist/main.user.js
	head -1 dist/main.user.js | grep -qx '// ==UserScript=='
	test "$(grep -c '^// ==UserScript==$' dist/main.user.js)" -eq 1
	grep -q '^var __USERSCRIPT_API' dist/main.user.js
	grep -q 'hello from a bundled' dist/main.user.js
	# A rebuild must not stack a second header on top of the first.
	t0 build
	test "$(grep -c '^// ==UserScript==$' dist/main.user.js)" -eq 1
)

echo "== samples/bookmarklet (javascript: href bundling) =="
(
	cd "$REPO/samples/bookmarklet"
	rm -rf dist
	t0 build
	test -f dist/index.html
	! grep -q 'javascript:./src/copy-title.ts' dist/index.html
	grep -q 'href="javascript:(()%3D%3E' dist/index.html
	grep -q 'href="javascript:void(0)"' dist/index.html
	grep -q 'BOOKMARKLET_PAGE_MARKER' dist/index.html
)

echo "== cache extracted exactly once; esbuild native fetched exactly once =="
extractions=$(find "$TS0_CACHE" -mindepth 1 -maxdepth 1 -type d | wc -l)
test "$extractions" -eq 1
test -f "$TS0_CACHE"/*/.ts0-extracted
test -f "$TS0_CACHE"/*/node_modules/typescript/lib/_tsc.js
test -f "$TS0_CACHE"/*/src/runtime/fetch-interceptor.js
test -x "$TS0_CACHE"/*/esbuild/esbuild

echo "== offline reuse: server down, warm cache still builds =="
kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
(
	cd "$REPO/samples/basic"
	rm -rf dist
	t0 build
	test -f dist/main.js
)

echo "prebuilt-smoke OK: $TS0JS runs on bare node (no npm), pipe form works, fetch/caching verified"
