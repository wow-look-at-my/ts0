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
	const watch = !!options?.watch;

	if (!config.entry) {
		return {
			success: false,
			outputFiles: [],
			errors: ["No entry point specified"],
			duration: performance.now() - startTime,
		};
	}

	// Type-checking is a hard gate: ts0 never emits output from sources that
	// haven't passed tsc. A one-shot build checks once, here, before anything
	// is written -- so every caller of build() (including `ts0 run`) is covered,
	// not just the `build` command. A watch build can't use this single check
	// (later rebuilds would slip past it), so it re-checks on every rebuild
	// instead: the esbuild onStart plugin below for the JS path, and buildHtml's
	// per-rebuild hook for HTML. Either way, no artifact is produced from code
	// that doesn't type-check.
	if (!watch) {
		console.log("Type-checking...");
		const check = await runTypecheck(config, rootDir);
		if (!check.success) {
			return {
				success: false,
				outputFiles: [],
				errors: [`Type-checking failed:\n${check.output}`],
				duration: performance.now() - startTime,
			};
		}
	}

	if (isHtmlEntry(config.entry)) {
		return buildHtml(config, rootDir, {
			watch,
			typecheck: watch ? () => runTypecheck(config, rootDir) : undefined,
		});
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

	// Watch rebuilds re-run the type-check via an esbuild onStart hook. esbuild
	// will not write output for a build whose onStart reports errors, so a
	// rebuild that fails type-checking leaves the previous good output in place.
	// Prepended so it runs before any user-supplied plugin from the escape hatch.
	if (watch) {
		esbuildConfig.plugins = [typecheckPlugin(config, rootDir), ...(esbuildConfig.plugins ?? [])];
	}

	try {
		if (watch) {
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

// runTypecheck type-checks the project with `tsc --noEmit` using a temporary
// tsconfig derived from the ts0 config. It is the single source of truth for
// "does this project type-check"; build() (for build/run) and run() (for the
// --no-build path) call it before emitting OR executing anything, so it is the
// chokepoint that makes type-checking unskippable.
export async function runTypecheck(config: Ts0Config, rootDir: string): Promise<{ success: boolean; output: string }> {
	const nestedProjects = findNestedProjectDirs(rootDir);
	// A nested project (its own ts0.json) may use different settings -- e.g.
	// JSX -- that would make the parent's type-check fail on it; it is
	// type-checked on its own when built directly. The output dir is excluded
	// so emitted artifacts aren't re-checked.
	const excludeDirs = [config.outdir, ...nestedProjects].filter((d): d is string => !!d);

	// Nothing to check: a project with no TypeScript sources at all (e.g. a
	// plain-JS HTML entry). tsc would abort with TS18003 "No inputs were
	// found", so treat an empty source set as a vacuous pass -- there are no
	// types that could be broken.
	if (!hasTypeScriptSources(rootDir, excludeDirs)) {
		return { success: true, output: "No TypeScript sources to check." };
	}

	// Browser code -- an explicit "browser" target or any HTML entry (always
	// browser) -- needs the DOM lib so document/fetch/addEventListener and
	// friends resolve. Node code gets the ESNext lib only; its globals come
	// from @types/node. Without this, every HTML/browser project would fail
	// type-checking on "Cannot find name 'document'".
	const isBrowser = config.target === "browser" || isHtmlEntry(config.entry);

	// Generate a temporary tsconfig based on ts0 config. When JSX is enabled,
	// thread the matching tsc options so .tsx files are type-checked (esbuild's
	// jsx setting alone does not type-check JSX).
	const compilerOptions: Record<string, unknown> = {
		target: "ESNext",
		module: "NodeNext",
		moduleResolution: "NodeNext",
		lib: isBrowser ? ["ESNext", "DOM", "DOM.Iterable"] : ["ESNext"],
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
		exclude: ["node_modules", ...excludeDirs],
	};

	const { execSync } = await import("node:child_process");
	const { createRequire } = await import("node:module");

	// Find tsc from ts0's dependencies, not the project's
	const require = createRequire(import.meta.url);
	const tscPath = require.resolve("typescript/bin/tsc");

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
	} catch (err) {
		const error = err as { stdout?: string; stderr?: string };
		return {
			success: false,
			output: error.stdout || error.stderr || String(err),
		};
	} finally {
		unlinkSync(tempTsconfig);
	}
}

// typecheckPlugin runs the type-check at the start of every esbuild build,
// including each rebuild in watch mode. Returning errors from onStart makes
// esbuild fail the build and skip writing output, so a rebuild that doesn't
// type-check cannot emit a bundle.
function typecheckPlugin(config: Ts0Config, rootDir: string): esbuild.Plugin {
	return {
		name: "ts0-typecheck",
		setup(pluginBuild) {
			pluginBuild.onStart(async () => {
				const check = await runTypecheck(config, rootDir);
				if (!check.success) {
					return { errors: [{ text: `Type-checking failed:\n${check.output}` }] };
				}
				return null;
			});
		},
	};
}

// hasTypeScriptSources reports whether the project contains any TypeScript
// source file (.ts/.tsx/.mts/.cts, excluding .d.ts declarations) outside
// node_modules, the output dir, and nested ts0 projects. Used to skip the
// type-check for a project with no TS to check (e.g. a plain-JS HTML entry),
// which would otherwise make tsc abort with TS18003.
function hasTypeScriptSources(rootDir: string, excludeDirs: string[]): boolean {
	const excluded = new Set(excludeDirs.map((d) => d.split(/[\\/]/).join("/")));
	let found = false;
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (found) return;
			if (name === "node_modules" || name.startsWith(".")) continue;
			const p = join(dir, name);
			const rel = relative(rootDir, p).split(/[\\/]/).join("/");
			if (excluded.has(rel)) continue;
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			const isDeclaration = /\.d\.(ts|mts|cts)$/i.test(name);
			if (!isDeclaration && /\.(ts|tsx|mts|cts)$/i.test(name)) {
				found = true;
				return;
			}
		}
	};
	walk(rootDir);
	return found;
}
