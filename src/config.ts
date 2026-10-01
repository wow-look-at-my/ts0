import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface Ts0Config {
	// Entry point - auto-detected if not specified
	entry?: string;

	// Output file (single bundled executable) or directory
	outfile?: string;
	outdir?: string;

	// Target runtime
	target: "node" | "browser";

	// Module format. "iife" wraps the bundle in an immediately-invoked
	// function (browser-script style, no module system needed); pair it with
	// `globalName` to expose the entry's exports on a global variable.
	format: "esm" | "cjs" | "iife";

	// Global variable that receives the entry's exports when format is
	// "iife" (esbuild's globalName), e.g. "MyLib" makes the bundle assign
	// `var MyLib = (() => { ... })()`. Ignored by other formats.
	globalName?: string;

	// TypeScript strictness
	strict: boolean;

	// Minify output
	minify: boolean;

	// Generate sourcemaps
	sourcemap: boolean;

	// Test configuration
	test: {
		pattern: string;
	};

	// HTML entries only: embed runtime-fetched assets (shaders, .hdr, .glb,
	// images, .json, …) into a window.fetch interceptor at the top of
	// <head>. Default true; set false to skip the interceptor entirely
	// (e.g. when the bundle will only ever be served from a real origin
	// where the asset tree is reachable).
	embedAssets?: boolean;

	// HTML entries only: directories to scan for embeddable assets, relative
	// to the config file (rootDir). When set, ONLY these directories are
	// scanned (instead of the HTML entry's directory). Asset keys in the
	// fetch interceptor are relative to rootDir, so fetch("people/foo.xml")
	// matches assetDirs: ["people"].
	assetDirs?: string[];

	// HTML entries only: inline every referenced script and stylesheet into the
	// HTML (default true). Set false to emit a normal multi-file static site
	// instead: each referenced local script/stylesheet is bundled to its own
	// file under `assetPath` and the tag keeps referencing it via src=/href=,
	// so the bundles are independently cacheable.
	inlineAssets?: boolean;

	// HTML entries with `inlineAssets: false`: where the per-reference bundles
	// go. Used VERBATIM as the URL prefix written into the HTML; the same
	// string minus any leading `/` or `./` is the subdirectory under the HTML's
	// own output directory. So "/assets" writes <outdir>/assets/main.js and
	// emits src="/assets/main.js" -- the absolute form a single-page app needs,
	// where a relative URL would resolve against the wrong directory on a deep
	// link. Default "assets".
	assetPath?: string;

	// JSX support. Set `jsx` to enable JSX/TSX in both the type-checker and the
	// bundler. Values follow esbuild's naming: "automatic" (modern runtime, no
	// factory import needed; pair with `jsxImportSource`), "transform" (classic
	// React.createElement), or "preserve". When set, `.tsx` files are included
	// in the type-check and esbuild is configured to match, so a Preact/React
	// project needs no esbuild escape hatch. `jsxImportSource` sets the module
	// the automatic runtime imports from (e.g. "preact", "react").
	jsx?: "automatic" | "transform" | "preserve";
	jsxImportSource?: string;

	// js (library) target only: emit TypeScript declaration files. Every
	// compiled module gets a parallel *.d.ts under outdir, mirroring the
	// source tree exactly like the *.js outputs (src/ui/x.ts ->
	// dist/ui/x.d.ts), so a deployed library ships types next to its code.
	// Default true (undefined = on); set false to skip declaration emit.
	// Ignored by the single-entry and HTML targets.
	declarations?: boolean;

	// Single-entry target only: re-prepend the entry file's leading comment
	// block (a run of consecutive `//` lines, or one `/* ... */` block,
	// starting at byte 0) to the bundled output, byte-exactly. esbuild strips
	// comments when bundling; this preserves headers that are semantically
	// load-bearing -- a userscript's ==UserScript== metadata block, a license
	// banner a distributor requires at the top of the artifact, etc. The
	// header is inserted above the bundle's own first line (a leading
	// `"use strict";` directive stays effective -- comments don't break the
	// directive prologue). Default false.
	preserveHeader?: boolean;

	// Directories (relative to the config file) to exclude from the
	// type-check gate, e.g. ["test", "spike"] for trees that type-check
	// under their own separate tsconfig. node_modules, the output dir, and
	// nested ts0 projects are always excluded; this adds to that list.
	// It does not change what gets built -- only what the gate checks.
	exclude?: string[];

	// Map file extensions to how their imports are loaded, e.g.
	// { ".wgsl": "text" } to import shader files as strings, or
	// { ".png": "dataurl" } to inline images. Values are loader names
	// (text, dataurl, base64, binary, file, json, …). This is the friendly way
	// to handle non-JS/TS imports without reaching for the `esbuild` escape
	// hatch; it applies to the default single-entry target and the js library
	// target. (Add an ambient `declare module "*.wgsl"` so the import also
	// type-checks.)
	loaders?: Record<string, string>;

	// Import specifiers that stay EXTERNAL references in the output instead of
	// being bundled or inlined: the `import ... from "<specifier>"` statement is
	// emitted verbatim and the imported file's contents appear nowhere in the
	// output. This is what a runtime-resolved import needs -- a CSS module
	// script (`import styles from "./styles.css" with { type: "css" }`, resolved
	// by the browser), an import map entry, a peer dependency a library must not
	// embed.
	//
	// Entries are matched the way an import specifier is written, not as file
	// paths: "./styles.css" externalizes that relative specifier, "lit"
	// externalizes the bare package, and a "*" wildcard matches any run of
	// characters ("*.css" externalizes every CSS import). Relative specifiers
	// are resolved relative to the importing module, exactly as written.
	//
	// Applies to the single-entry target and the js (library) target. It is
	// deliberately NOT a way to silence an unsupported import: an import ts0
	// cannot handle and that is not listed here still fails the build.
	external?: string[];

	// Whether imports of installed packages are compiled INTO the output
	// (default false on the node target, always true on browser). A node bundle
	// leaves them as `require("pkg")`/`import ... from "pkg"` calls that Node
	// resolves from node_modules at run time, which is what a CLI installed
	// alongside its dependencies wants.
	//
	// Set true when the output file has to run somewhere its node_modules does
	// not exist -- a GitHub Action, whose release tag ships dist/ and nothing
	// else; a script copied onto a machine on its own. Every package the entry
	// reaches is then compiled into the one output file. A specifier listed in
	// `external` stays a reference even so, which is how a package that must not
	// be embedded (a native addon, a peer dependency) opts back out.
	//
	// Browser code has no run-time module resolver to leave the work to, so the
	// browser target ignores this field and always bundles.
	bundleDependencies?: boolean;

	// Whether code shared by more than one output module may be factored into a
	// shared chunk that the outputs import (default true). Only the js (library)
	// target emits more than one module, so only it is affected; the
	// single-entry and HTML targets always produce one self-contained bundle.
	//
	// Set false to force every emitted module to be fully self-contained: shared
	// code is copied into each output that uses it, so a consumer fetching one
	// output file needs no sibling chunk. That costs duplication, which is the
	// right trade only when outputs are consumed in isolation (a snippet pasted
	// somewhere, a file served on its own).
	bundleShared?: boolean;

	// Additional esbuild options (raw escape hatch). Merged last, so an
	// esbuild.loader here overrides `loaders` above.
	esbuild?: Record<string, unknown>;
}

const DEFAULT_CONFIG: Ts0Config = {
	outdir: "dist",
	target: "node",
	format: "esm",
	strict: true,
	minify: false,
	sourcemap: true,
	test: {
		pattern: "**/*.test.ts",
	},
};

export function findConfigFile(startDir: string = process.cwd()): string | null {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const configPath = join(dir, "ts0.json");
		if (existsSync(configPath)) {
			return configPath;
		}
		dir = dirname(dir);
	}
	return null;
}

export function loadConfig(configPath?: string): { config: Ts0Config; rootDir: string } {
	// An explicit path (the --config CLI flag) is resolved against the cwd so
	// rootDir -- dirname of the config -- is always absolute. Multiple builds
	// of one repo (e.g. a bundle and an HTML page with different settings) can
	// each keep their own named config file this way.
	const foundPath = configPath ? resolve(configPath) : findConfigFile();

	if (!foundPath || !existsSync(foundPath)) {
		// No config file - use defaults and auto-detect entry
		const rootDir = process.cwd();
		const config = { ...DEFAULT_CONFIG };
		config.entry = autoDetectEntry(rootDir);
		return { config, rootDir };
	}

	const rootDir = dirname(foundPath);
	const userConfig = JSON.parse(readFileSync(foundPath, "utf-8"));

	const config: Ts0Config = {
		...DEFAULT_CONFIG,
		...userConfig,
		test: {
			...DEFAULT_CONFIG.test,
			...userConfig.test,
		},
	};

	if (config.assetDirs !== undefined) {
		if (!Array.isArray(config.assetDirs) || !config.assetDirs.every((d: unknown) => typeof d === "string" && d.length > 0)) {
			throw new Error("ts0: assetDirs must be an array of non-empty strings");
		}
	}

	if (config.inlineAssets !== undefined && typeof config.inlineAssets !== "boolean") {
		throw new Error("ts0: inlineAssets must be a boolean");
	}

	if (config.assetPath !== undefined) {
		if (typeof config.assetPath !== "string" || config.assetPath.length === 0) {
			throw new Error("ts0: assetPath must be a non-empty string");
		}
		// It resolves under the output directory; escaping it is a build error,
		// not something to sanitize into something the author didn't write.
		if (config.assetPath.split(/[\\/]/).includes("..")) {
			throw new Error("ts0: assetPath must not contain \"..\"");
		}
	}

	if (config.exclude !== undefined) {
		if (!Array.isArray(config.exclude) || !config.exclude.every((d: unknown) => typeof d === "string" && d.length > 0)) {
			throw new Error("ts0: exclude must be an array of non-empty strings");
		}
	}

	if (config.loaders !== undefined) {
		const ok =
			typeof config.loaders === "object" &&
			config.loaders !== null &&
			!Array.isArray(config.loaders) &&
			Object.entries(config.loaders).every(
				([ext, loader]) => typeof ext === "string" && ext.length > 0 && typeof loader === "string" && loader.length > 0,
			);
		if (!ok) {
			throw new Error("ts0: loaders must be an object mapping file extensions to loader names");
		}
	}

	if (config.external !== undefined) {
		if (!Array.isArray(config.external) || !config.external.every((s: unknown) => typeof s === "string" && s.length > 0)) {
			throw new Error("ts0: external must be an array of non-empty import specifiers");
		}
	}

	if (config.bundleShared !== undefined && typeof config.bundleShared !== "boolean") {
		throw new Error("ts0: bundleShared must be a boolean");
	}

	if (config.bundleDependencies !== undefined && typeof config.bundleDependencies !== "boolean") {
		throw new Error("ts0: bundleDependencies must be a boolean");
	}

	// Auto-detect entry if not specified
	if (!config.entry) {
		config.entry = autoDetectEntry(rootDir);
	}

	return { config, rootDir };
}

function autoDetectEntry(rootDir: string): string {
	const candidates = [
		"src/main.ts",
		"src/index.ts",
		"main.ts",
		"index.ts",
		"index.html",
		"src/index.html",
	];

	for (const candidate of candidates) {
		if (existsSync(join(rootDir, candidate))) {
			return candidate;
		}
	}

	return "src/main.ts"; // Default even if doesn't exist yet
}

export function getDefaultConfig(): Ts0Config {
	return { ...DEFAULT_CONFIG };
}
