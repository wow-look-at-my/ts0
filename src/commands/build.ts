import * as esbuild from "esbuild";
import { join, relative } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { loadConfig, type Ts0Config } from "../config.ts";
import { buildHtml, isHtmlEntry } from "./build-html.ts";

export interface BuildResult {
	success: boolean;
	outputFiles: string[];
	errors: string[];
	duration: number;
}

export interface BuildOverrides {
	entry?: string;
	outfile?: string;
	outdir?: string;
}

export async function build(options?: { watch?: boolean; overrides?: BuildOverrides }): Promise<BuildResult> {
	const startTime = performance.now();
	const { config: loaded, rootDir } = loadConfig();
	const config = applyOverrides(loaded, options?.overrides);

	if (!config.entry) {
		return {
			success: false,
			outputFiles: [],
			errors: ["No entry point specified"],
			duration: performance.now() - startTime,
		};
	}

	if (isHtmlEntry(config.entry)) {
		return buildHtml(config, rootDir, options);
	}

	const esbuildConfig: esbuild.BuildOptions = {
		entryPoints: [join(rootDir, config.entry)],
		bundle: true,
		platform: config.target === "node" ? "node" : "browser",
		format: config.format,
		minify: config.minify,
		sourcemap: config.sourcemap,
		target: "esnext",
		// Single file output with shebang, or directory output
		...(config.outfile
			? {
					outfile: join(rootDir, config.outfile),
					banner: { js: "#!/usr/bin/env node" },
				}
			: {
					outdir: join(rootDir, config.outdir || "dist"),
				}),
		// Node-specific settings
		...(config.target === "node" && {
			packages: "external",
		}),
		// JSX support (esbuild). Threaded before the escape hatch so an
		// explicit esbuild.jsx can still override it.
		...(config.jsx && { jsx: config.jsx }),
		...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		// User overrides
		...config.esbuild,
	};

	try {
		if (options?.watch) {
			const ctx = await esbuild.context(esbuildConfig);
			await ctx.watch();
			console.log("Watching for changes...");
			return {
				success: true,
				outputFiles: [],
				errors: [],
				duration: performance.now() - startTime,
			};
		}

		const result = await esbuild.build(esbuildConfig);

		const outputFiles = result.outputFiles?.map((f) => f.path) || [];

		return {
			success: result.errors.length === 0,
			outputFiles,
			errors: result.errors.map((e) => e.text),
			duration: performance.now() - startTime,
		};
	} catch (err) {
		const error = err as esbuild.BuildFailure;
		return {
			success: false,
			outputFiles: [],
			errors: error.errors?.map((e) => e.text) || [String(err)],
			duration: performance.now() - startTime,
		};
	}
}

function applyOverrides(config: Ts0Config, overrides?: BuildOverrides): Ts0Config {
	if (!overrides) return config;
	const out: Ts0Config = { ...config };
	if (overrides.entry !== undefined) out.entry = overrides.entry;
	if (overrides.outfile !== undefined) {
		out.outfile = overrides.outfile;
		// outfile and outdir are mutually exclusive — clearing outdir keeps
		// the existing precedence in build() (outfile wins) explicit.
		out.outdir = undefined;
	}
	if (overrides.outdir !== undefined) {
		out.outdir = overrides.outdir;
		out.outfile = undefined;
	}
	return out;
}

// findNestedProjectDirs returns the rootDir-relative paths of subdirectories
// that are themselves ts0 projects (they contain their own ts0.json). The
// self-type-check excludes these so a nested project's settings (e.g. JSX)
// don't leak into the parent's type-check. node_modules/dist/dotfiles are
// skipped, and descent stops at a nested project boundary.
function findNestedProjectDirs(rootDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
			const p = join(dir, name);
			if (!statSync(p).isDirectory()) continue;
			if (existsSync(join(p, "ts0.json"))) {
				found.push(relative(rootDir, p).split(/[\\/]/).join("/"));
				continue; // a nested project handles its own subtree
			}
			walk(p);
		}
	};
	walk(rootDir);
	return found;
}

// tsconfigJsx maps ts0's esbuild-style jsx setting to the corresponding
// TypeScript tsconfig `jsx` value, so the type-checker and bundler agree.
//   automatic -> react-jsx   (modern runtime; uses jsxImportSource)
//   transform -> react       (classic React.createElement)
//   preserve  -> preserve
function tsconfigJsx(jsx: "automatic" | "transform" | "preserve"): string {
	switch (jsx) {
		case "automatic":
			return "react-jsx";
		case "transform":
			return "react";
		case "preserve":
			return "preserve";
	}
}

export async function typecheck(overrides?: BuildOverrides): Promise<{ success: boolean; output: string }> {
	const { config: loaded, rootDir } = loadConfig();
	const config = applyOverrides(loaded, overrides);

	// Skip type-checking for HTML entries: an HTML project may have no .ts
	// files at all (it can be plain JS), and the bundling step delegates to
	// esbuild's stdin/css loaders which don't honour TypeScript types
	// anyway. The entry's <script src> targets are still type-checked
	// transitively if they're .ts files via the bundler.
	if (isHtmlEntry(config.entry)) {
		return { success: true, output: "Skipped (HTML entry)." };
	}

	// Generate a temporary tsconfig based on ts0 config. When JSX is enabled,
	// thread the matching tsc options and widen the include glob so .tsx files
	// are type-checked (esbuild's jsx setting alone does not type-check JSX).
	const compilerOptions: Record<string, unknown> = {
		target: "ESNext",
		module: "NodeNext",
		moduleResolution: "NodeNext",
		strict: config.strict,
		noEmit: true,
		skipLibCheck: true,
		esModuleInterop: true,
		allowImportingTsExtensions: true,
	};
	if (config.jsx) {
		compilerOptions.jsx = tsconfigJsx(config.jsx);
		if (config.jsxImportSource) {
			compilerOptions.jsxImportSource = config.jsxImportSource;
		}
	}
	const tsconfigContent = {
		compilerOptions,
		// Include .tsx/.mts/.cts alongside .ts so JSX components and ESM/CJS
		// TypeScript variants are type-checked too.
		include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
		// Exclude node_modules, the output dir, and any nested ts0 projects.
		// A nested project (its own ts0.json) may use different settings --
		// e.g. JSX -- that would make the parent's type-check fail on it; it
		// is type-checked on its own when built directly.
		exclude: ["node_modules", config.outdir, ...findNestedProjectDirs(rootDir)].filter(Boolean),
	};

	const { execSync } = await import("node:child_process");
	const { createRequire } = await import("node:module");

	// Find tsc from ts0's dependencies, not the project's
	const require = createRequire(import.meta.url);
	const tscPath = require.resolve("typescript/bin/tsc");

	try {
		// Write temporary tsconfig
		const { writeFileSync, unlinkSync } = await import("node:fs");
		const tempTsconfig = join(rootDir, ".ts0-tsconfig.json");
		writeFileSync(tempTsconfig, JSON.stringify(tsconfigContent, null, "\t"));

		try {
			const output = execSync(`node ${tscPath} --project ${tempTsconfig}`, {
				cwd: rootDir,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			return { success: true, output: output || "No type errors found." };
		} finally {
			unlinkSync(tempTsconfig);
		}
	} catch (err) {
		const error = err as { stdout?: string; stderr?: string };
		return {
			success: false,
			output: error.stdout || error.stderr || String(err),
		};
	}
}
