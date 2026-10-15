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

	// Module format.
	format: "esm" | "cjs" | "iife";

	// Global variable that receives the entry's exports.
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
		// Shell command that builds what the tests run against, e.g. "just build" or "ts0 build".
		build?: string;
	};

	// HTML entries only: embed runtime-fetched assets.
	embedAssets?: boolean;

	// HTML entries only: directories to scan for embeddable assets, relative to the config file (rootDir).
	assetDirs?: string[];

	// HTML entries only: inline every referenced script and stylesheet into the HTML (default true).
	inlineAssets?: boolean;

	// HTML entries with `inlineAssets: false`: where the per-reference bundles go.
	assetPath?: string;

	// JSX support. Set `jsx` to enable JSX/TSX in both the type-checker and the bundler.
	jsx?: "automatic" | "transform" | "preserve";
	jsxImportSource?: string;

	// js (library) target only: emit TypeScript declaration files.
	declarations?: boolean;

	// Single-entry target only: re-prepend the entry file's leading comment block.
	preserveHeader?: boolean;

	// Directories (relative to the config file) to exclude from the type-check
	// gate, e.g. ["test", "spike"] for trees that type-check under their own
	// separate tsconfig. node_modules, the output dir, and nested ts0 projects
	// are always excluded; this adds to that list.
	exclude?: string[];

	// Map file extensions to how their imports are loaded, e.g. { ".wgsl": "text" } to import shader files as strings, or { ".png".
	loaders?: Record<string, string>;

	// Import specifiers that stay EXTERNAL references in the output instead of being bundled or inlined.
	external?: string[];

	// Whether imports of installed packages are compiled INTO.
	bundleDependencies?: boolean;

	// Whether code shared by more than one output module may be factored into a shared chunk that the outputs import (default true).
	bundleShared?: boolean;

	// Additional esbuild options (raw escape hatch). Merged last, so an esbuild.loader here overrides `loaders` above.
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
	// An explicit path (the --config CLI flag) is resolved against the cwd so rootDir -- dirname of the config.
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

	if (config.test.build !== undefined && (typeof config.test.build !== "string" || config.test.build.trim().length === 0)) {
		throw new Error("ts0: test.build must be a non-empty shell command string");
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

	return "src/main.ts";
}

export function getDefaultConfig(): Ts0Config {
	return { ...DEFAULT_CONFIG };
}
