import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Ts0Config {
	// Entry point - auto-detected if not specified
	entry?: string;

	// Output file (single bundled executable) or directory
	outfile?: string;
	outdir?: string;

	// Target runtime
	target: "node" | "browser";

	// Module format
	format: "esm" | "cjs";

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

	// Map file extensions to how their imports are loaded, e.g.
	// { ".wgsl": "text" } to import shader files as strings, or
	// { ".png": "dataurl" } to inline images. Values are loader names
	// (text, dataurl, base64, binary, file, json, …). This is the friendly way
	// to handle non-JS/TS imports without reaching for the `esbuild` escape
	// hatch; it applies to the default single-entry target and the js library
	// target. (Add an ambient `declare module "*.wgsl"` so the import also
	// type-checks.)
	loaders?: Record<string, string>;

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
	const foundPath = configPath || findConfigFile();

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
