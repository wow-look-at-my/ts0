// SEA (single-executable application) launcher prelude. This module is ONLY
// ever bundled into the prebuilt ts0 binary (via src/sea/main.ts + the
// scripts/build-sea.ts packaging script); the npm/git-install build never
// includes it. It runs before the CLI and does three things:
//
// 1. Extracts the embedded assets -- a pruned `typescript` package, the
//    `esbuild` JS package plus its platform-native binary, and the
//    fetch-interceptor runtime template -- into a per-build cache directory
//    laid out like an installed ts0 package:
//
//        <cache>/<build-id>/
//            src/runtime/fetch-interceptor.js
//            node_modules/typescript/...
//            node_modules/esbuild/...
//            node_modules/@esbuild/<platform>/...
//
//    The cache root is $TS0_CACHE_DIR, defaulting to ~/.cache/ts0. The
//    <build-id> comes from the embedded manifest and changes whenever the
//    bundle, the dependencies, or the Node runtime change, so upgrades never
//    collide and re-runs never re-extract.
//
// 2. Points the bundle's module resolution at that directory. The packaging
//    script rewrites `import.meta.url` to `globalThis.__ts0SeaImportMetaUrl`,
//    which is set here to <cache>/<build-id>/dist/ts0 -- so the existing
//    createRequire(import.meta.url) in build.ts resolves typescript from the
//    extracted node_modules, and build-html.ts's ../src/runtime lookup finds
//    the extracted interceptor template, with no code changes. `esbuild` is
//    kept external in the SEA bundle and loaded through
//    globalThis.__ts0SeaRequire (a createRequire anchored at the same path),
//    which resolves the extracted esbuild package; esbuild then finds its
//    own @esbuild/<platform>/bin/esbuild native binary next to it.
//
// 3. Installs the SeaBridge (src/sea/bridge.ts) and intercepts dispatch
//    invocations. There is no `node` on PATH inside the SEA, so the three
//    places ts0 spawns node re-invoke this binary with
//    `--ts0-sea-dispatch=<mode>` as the first argument:
//
//        tsc  <tscPath> ...args   run the TypeScript compiler CLI in-process
//        run  <file> ...args      import() a program file (ts0 run)
//        test ...files            run test files via node:test's run() API
//
//    A dispatch invocation never reaches the CLI (src/sea/main.ts checks
//    seaDispatched()).

import { getAsset, isSea } from "node:sea";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { installSeaBridge } from "./bridge.ts";

const DISPATCH_PREFIX = "--ts0-sea-dispatch=";
const EXTRACT_MARKER = ".ts0-extracted";

interface ManifestFile {
	// Asset key AND cache-relative path, always with forward slashes.
	key: string;
	executable?: boolean;
}

interface Manifest {
	buildId: string;
	files: ManifestFile[];
}

interface SeaGlobals {
	__ts0SeaImportMetaUrl?: string;
	__ts0SeaRequire?: (id: string) => unknown;
}

let dispatched = false;

// seaDispatched reports whether this invocation was a dispatch re-invocation
// (tsc/run/test); main.ts skips the CLI entirely in that case.
export function seaDispatched(): boolean {
	return dispatched;
}

function cacheRoot(): string {
	const override = process.env.TS0_CACHE_DIR;
	if (override && override.length > 0) return override;
	return join(homedir(), ".cache", "ts0");
}

// ensureExtracted materializes the embedded assets under <root>/<buildId>,
// atomically: everything is written to a temp sibling first and renamed into
// place, so a crashed or concurrent extraction can never yield a
// half-populated directory that later runs would trust. The rename loser of
// a concurrent race just uses the winner's directory.
function ensureExtracted(manifest: Manifest): string {
	const root = cacheRoot();
	const dir = join(root, manifest.buildId);
	const marker = join(dir, EXTRACT_MARKER);
	if (existsSync(marker)) return dir;

	const tmp = join(root, `.tmp-${manifest.buildId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		for (const file of manifest.files) {
			const target = join(tmp, ...file.key.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, Buffer.from(getAsset(file.key)));
			if (file.executable) chmodSync(target, 0o755);
		}
		writeFileSync(join(tmp, EXTRACT_MARKER), manifest.buildId);
		try {
			renameSync(tmp, dir);
		} catch {
			// The target exists: either another process won the race (its
			// marker is present -- use it) or a previous extraction crashed
			// mid-write (no marker -- replace it and try once more).
			if (!existsSync(marker)) {
				rmSync(dir, { recursive: true, force: true });
				renameSync(tmp, dir);
			}
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	if (!existsSync(marker)) {
		throw new Error(`ts0: failed to extract embedded assets to ${dir}`);
	}
	return dir;
}

function readManifest(): Manifest {
	return JSON.parse(Buffer.from(getAsset("manifest.json")).toString("utf-8")) as Manifest;
}

// runTsc executes the extracted TypeScript compiler CLI in this process.
// typescript/bin/tsc is CommonJS; requiring it runs the compiler against
// process.argv.slice(2) and exits the process itself with tsc's exit code.
function runTscDispatch(anchor: string, rest: string[]): void {
	const [tscPath, ...tscArgs] = rest;
	process.argv = [process.argv[0], tscPath, ...tscArgs];
	createRequire(anchor)(tscPath);
	// tsc normally calls process.exit itself; if it ever returns, exit clean.
	process.exit(0);
}

// runProgramDispatch imports a program file, mirroring `node <file> ...args`.
// Node 22.18+ strips types by default for on-disk .ts files outside
// node_modules, so this also covers `ts0 run --no-build`'s
// --experimental-strip-types path.
function runProgramDispatch(rest: string[]): void {
	const [file, ...args] = rest;
	process.argv = [process.argv[0], resolve(file), ...args];
	import(pathToFileURL(resolve(file)).href).catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}

// runTestDispatch runs test files via node:test's programmatic runner,
// mirroring `node --experimental-strip-types --test ...files`. isolation
// "none" executes the files in THIS process -- the SEA binary cannot be
// re-invoked with node's own --test CLI flags, and in-process execution
// needs no child node at all.
function runTestDispatch(files: string[]): void {
	void (async () => {
		const { run } = await import("node:test");
		const reporters = await import("node:test/reporters");
		let failed = false;
		const stream = run({
			files: files.map((f) => resolve(f)),
			isolation: "none",
		} as Parameters<typeof run>[0]);
		stream.on("test:fail", () => {
			failed = true;
		});
		const spec = reporters.spec as unknown as () => NodeJS.ReadWriteStream;
		const out = stream.compose(spec);
		out.pipe(process.stdout);
		out.on("end", () => {
			process.exitCode = failed ? 1 : 0;
		});
	})().catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}

function handleDispatch(anchor: string): boolean {
	const arg = process.argv[2];
	if (typeof arg !== "string" || !arg.startsWith(DISPATCH_PREFIX)) return false;
	const mode = arg.slice(DISPATCH_PREFIX.length);
	const rest = process.argv.slice(3);
	switch (mode) {
		case "tsc":
			runTscDispatch(anchor, rest);
			return true;
		case "run":
			runProgramDispatch(rest);
			return true;
		case "test":
			runTestDispatch(rest);
			return true;
		default:
			console.error(`ts0: unknown SEA dispatch mode: ${mode}`);
			process.exit(2);
	}
}

// Initialize immediately on import (src/sea/main.ts imports this module
// before the CLI, so everything below runs before any command code
// evaluates). Outside an actual SEA (e.g. someone runs the bundle with plain
// node for debugging) this is a no-op and the bundle behaves like the npm
// build.
if (isSea()) {
	const manifest = readManifest();
	const cacheDir = ensureExtracted(manifest);
	// The anchor mimics the installed layout: <pkg>/dist/ts0 next to
	// <pkg>/node_modules and <pkg>/src/runtime/fetch-interceptor.js.
	const anchor = join(cacheDir, "dist", "ts0");
	const seaGlobals = globalThis as SeaGlobals;
	seaGlobals.__ts0SeaImportMetaUrl = pathToFileURL(anchor).href;
	seaGlobals.__ts0SeaRequire = createRequire(anchor);
	installSeaBridge({
		execPath: process.execPath,
		tscArgs: (tscPath, projectPath) => [`${DISPATCH_PREFIX}tsc`, tscPath, "--project", projectPath],
		runArgs: (file, args) => [`${DISPATCH_PREFIX}run`, file, ...args],
		testArgs: (files) => [`${DISPATCH_PREFIX}test`, ...files],
	});
	dispatched = handleDispatch(anchor);
}
