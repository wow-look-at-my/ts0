import * as esbuild from "esbuild";
import { basename, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { loadConfig, type Ts0Config } from "../config.ts";
import { buildHtml, isHtmlEntry } from "./build-html.ts";
import { buildJs, isJsTarget } from "./build-js.ts";
import { baseEsbuildOptions } from "./esbuild-base.ts";

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

export async function build(options?: {
	watch?: boolean;
	overrides?: BuildOverrides;
	configPath?: string;
}): Promise<BuildResult> {
	const startTime = performance.now();
	const { config: loaded, rootDir } = loadConfig(options?.configPath);
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

	if (isJsTarget(config.entry, rootDir)) {
		return buildJs(config, rootDir, options);
	}

	const esbuildConfig: esbuild.BuildOptions = {
		entryPoints: [join(rootDir, config.entry)],
		...baseEsbuildOptions(config),
		// Single file output, or directory output. The `#!/usr/bin/env node`
		// shebang is a Node-target convenience (ship a CLI as one executable
		// file); a browser bundle must never start with one.
		...(config.outfile
			? {
					outfile: join(rootDir, config.outfile),
					...(config.target === "node" && { banner: { js: "#!/usr/bin/env node" } }),
				}
			: {
					outdir: join(rootDir, config.outdir || "dist"),
				}),
		// User overrides (escape hatch — spread last)
		...config.esbuild,
	};

	// Watch rebuilds re-run the type-check via an esbuild onStart hook. esbuild
	// will not write output for a build whose onStart reports errors, so a
	// rebuild that fails type-checking leaves the previous good output in place.
	// Prepended so it runs before any user-supplied plugin from the escape hatch.
	if (watch) {
		esbuildConfig.plugins = [typecheckPlugin(config, rootDir), ...(esbuildConfig.plugins ?? [])];
	}

	// preserveHeader re-prepends the entry's leading comment block to the
	// written bundle (esbuild strips comments). An onEnd plugin covers the
	// one-shot build and every watch rebuild alike -- each rebuild rewrites
	// the output file, so each rebuild gets a fresh prepend, never a double.
	if (config.preserveHeader) {
		const entryPath = join(rootDir, config.entry);
		const outPath = esbuildConfig.outfile
			? String(esbuildConfig.outfile)
			: join(String(esbuildConfig.outdir), basename(config.entry).replace(/\.(ts|tsx|mts|cts|jsx)$/i, ".js"));
		esbuildConfig.plugins = [...(esbuildConfig.plugins ?? []), preserveHeaderPlugin(entryPath, outPath)];
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

// generatedCompilerOptions returns the tsc compiler options derived from the
// ts0 config, shared by the type-check gate (runTypecheck) and the js target's
// declaration emit (emitDeclarations). Keeping them in one place guarantees
// the two passes can't drift: declaration emit compiles under exactly the
// options the gate checks with.
//
// - `lib` depends on target: browser code -- an explicit "browser" target or
//   any HTML entry (always browser) -- needs the DOM lib so document/fetch/
//   addEventListener and friends resolve. Node code gets the ESNext lib only;
//   its globals come from @types/node. Without this, every HTML/browser
//   project would fail type-checking on "Cannot find name 'document'".
// - Bundler-consumed code gets bundler module resolution: the js (library)
//   target AND any browser-target/HTML entry are compiled by esbuild, so the
//   gate checks with the resolution the bundler actually uses -- permitting
//   extensionless relative imports and loader-backed imports (e.g.
//   `import src from "./shader.wgsl"`) instead of forcing `.ts` extensions
//   on code Node never resolves. Only a Node-target single-entry app -- the
//   one case where the OUTPUT is resolved by Node's own module system --
//   keeps NodeNext.
// - When JSX is enabled, the matching tsc options are threaded so .tsx files
//   are handled (esbuild's jsx setting alone does not type-check JSX).
function generatedCompilerOptions(config: Ts0Config, rootDir: string): Record<string, unknown> {
	const isBrowser = config.target === "browser" || isHtmlEntry(config.entry);
	const jsTarget = isJsTarget(config.entry, rootDir);
	const bundlerResolved = jsTarget || isBrowser;
	const compilerOptions: Record<string, unknown> = {
		target: "ESNext",
		module: bundlerResolved ? "ESNext" : "NodeNext",
		moduleResolution: bundlerResolved ? "Bundler" : "NodeNext",
		lib: isBrowser ? ["ESNext", "DOM", "DOM.Iterable"] : ["ESNext"],
		strict: config.strict,
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
	return compilerOptions;
}

// runTsc writes a temporary tsconfig (named tempName, in rootDir, deleted in a
// finally), resolves the TypeScript binary from ts0's own dependencies (so the
// user's project doesn't need its own typescript install), and runs
// `tsc --project` against it. Whether the invocation checks or emits is driven
// entirely by the compilerOptions in tsconfigContent.
async function runTsc(
	rootDir: string,
	tempName: string,
	tsconfigContent: unknown,
): Promise<{ success: boolean; output: string }> {
	const { execSync } = await import("node:child_process");
	const { createRequire } = await import("node:module");

	// Find tsc from ts0's dependencies, not the project's
	const require = createRequire(import.meta.url);
	const tscPath = require.resolve("typescript/bin/tsc");

	// Write temporary tsconfig
	const { writeFileSync, unlinkSync } = await import("node:fs");
	const tempTsconfig = join(rootDir, tempName);
	writeFileSync(tempTsconfig, JSON.stringify(tsconfigContent, null, "\t"));

	try {
		// Quoted: tscPath/tempTsconfig may live under paths with spaces (a
		// node_modules under a spaced directory, or the prebuilt ts0.js
		// cache under e.g. "C:\\Users\\First Last\\.cache").
		const output = execSync(`node "${tscPath}" --project "${tempTsconfig}"`, {
			cwd: rootDir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { success: true, output };
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
	// so emitted artifacts aren't re-checked, and config.exclude adds
	// directories that type-check under their own separate tsconfig (a test
	// tree with its own types, an experiment dir, ...).
	const excludeDirs = [config.outdir, ...(config.exclude ?? []), ...nestedProjects].filter(
		(d): d is string => !!d,
	);

	// Nothing to check: a project with no TypeScript sources at all (e.g. a
	// plain-JS HTML entry). tsc would abort with TS18003 "No inputs were
	// found", so treat an empty source set as a vacuous pass -- there are no
	// types that could be broken.
	if (!hasTypeScriptSources(rootDir, excludeDirs)) {
		return { success: true, output: "No TypeScript sources to check." };
	}

	const tsconfigContent = {
		compilerOptions: { ...generatedCompilerOptions(config, rootDir), noEmit: true },
		// Include .tsx/.mts/.cts alongside .ts so JSX components and ESM/CJS
		// TypeScript variants are type-checked too.
		include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
		exclude: ["node_modules", ...excludeDirs],
	};

	const result = await runTsc(rootDir, ".ts0-tsconfig.json", tsconfigContent);
	if (result.success) {
		return { success: true, output: result.output || "No type errors found." };
	}
	return result;
}

// collectAmbientDeclarations returns the project's *.d.ts files (ambient
// declarations like `declare module "*.wgsl"`), excluding node_modules, the
// output directory, dotfiles, and nested ts0 projects -- the same exclusions
// as the type-check gate. The declaration-emit pass lists its inputs
// explicitly (a `files` array, not a glob), so ambient declarations must be
// added back or loader-backed imports would fail to resolve there (TS2307).
// Declaration inputs never produce output and are exempt from the rootDir
// requirement, so they may live anywhere in the project.
function collectAmbientDeclarations(rootDir: string, config: Ts0Config): string[] {
	const outDirAbs = resolve(rootDir, config.outdir || "dist");
	const excludedAbs = new Set((config.exclude ?? []).map((d) => resolve(rootDir, d)));
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (resolve(p) === outDirAbs) continue;
				if (excludedAbs.has(resolve(p))) continue; // config.exclude
				if (existsSync(join(p, "ts0.json"))) continue; // nested project
				walk(p);
				continue;
			}
			if (/\.d\.(ts|mts|cts)$/i.test(name)) found.push(p);
		}
	};
	walk(rootDir);
	return found;
}

// emitDeclarations runs a declaration-only tsc pass for the js (library)
// target: every compiled module gets a parallel *.d.ts under outDir, mirroring
// the source tree exactly like the *.js outputs (src/ui/x.ts ->
// dist/ui/x.d.ts). Only build-js.ts calls it, and only on the build path --
// `ts0 run`/`ts0 test` never emit anything, and the type-check gate stays
// exactly as strict as before (this pass is additional, never a replacement).
//
// The pass compiles exactly the entry-point set esbuild compiled (tests and
// *.d.ts sources are already excluded from it) plus the project's ambient
// declarations, so shared chunks -- an esbuild output artifact, not a source
// module -- never get a .d.ts, and loader-backed imports resolve the same way
// they do in the gate.
//
// noEmitOnError makes the pass all-or-nothing: tsc writes NOTHING unless the
// whole program is clean, so a diagnostic unique to declaration emit (e.g.
// TS4023 "cannot be named", or TS6059 when an entry imports a source from
// outside the entry directory -- unrepresentable in a mirrored tree) can never
// leave a partial .d.ts tree behind. Plain type errors can't even get this
// far: build()'s gate (or the watch plugin) already failed the build.
//
// Emitted declarations keep their source specifiers. A `./x.ts` (or `.tsx`)
// specifier in a .d.ts is the standard shape for allowImportingTsExtensions
// projects: consumers resolve it by extension substitution (.ts -> .tsx ->
// .d.ts), landing on the deployed sibling x.d.ts -- verified under both
// bundler and NodeNext consumer resolution. (TypeScript 5.7's
// rewriteRelativeImportExtensions is deliberately not used: it rewrites only
// JavaScript emit, never declaration emit, and declarations don't need it.)
export async function emitDeclarations(
	config: Ts0Config,
	rootDir: string,
	opts: { entryPoints: string[]; srcDir: string; outDir: string },
): Promise<{ success: boolean; output: string }> {
	// Relative, forward-slash, sorted file list: deterministic tsconfig
	// content for identical inputs (the .d.ts output itself is deterministic
	// too -- consumers commit fetched copies and diff them for freshness).
	const files = [...opts.entryPoints, ...collectAmbientDeclarations(rootDir, config)]
		.map((p) => relative(rootDir, p).split(/[\\/]/).join("/"))
		.sort();

	const tsconfigContent = {
		compilerOptions: {
			...generatedCompilerOptions(config, rootDir),
			declaration: true,
			emitDeclarationOnly: true,
			noEmitOnError: true,
			outDir: opts.outDir,
			rootDir: opts.srcDir,
		},
		files,
	};

	return runTsc(rootDir, ".ts0-tsconfig-emit.json", tsconfigContent);
}

// leadingCommentBlock returns the entry file's leading comment block,
// byte-exact: the maximal run of consecutive lines starting with `//` from
// byte 0 (each including its terminating newline), or a single `/* ... */`
// block starting at byte 0 (through the closing `*/` plus its trailing
// newline, if present). Returns "" when the file doesn't start with a
// comment. Byte-exactness is the point -- a userscript ==UserScript== header
// is parsed verbatim by the script manager, so nothing may be reflowed.
export function leadingCommentBlock(source: string): string {
	if (source.startsWith("//")) {
		let end = 0;
		while (source.startsWith("//", end)) {
			const nl = source.indexOf("\n", end);
			if (nl === -1) return source; // comment-only file without trailing newline
			end = nl + 1;
		}
		return source.slice(0, end);
	}
	if (source.startsWith("/*")) {
		const close = source.indexOf("*/");
		if (close === -1) return "";
		let end = close + 2;
		if (source.startsWith("\r\n", end)) end += 2;
		else if (source.startsWith("\n", end)) end += 1;
		return source.slice(0, end);
	}
	return "";
}

// preserveHeaderPlugin re-prepends the entry's leading comment block to the
// written bundle after every successful build. esbuild drops comments while
// bundling, but some headers are semantically load-bearing artifacts of the
// OUTPUT file -- a userscript's ==UserScript== metadata block, a mandated
// license banner -- so they must survive byte-exactly at the top. The header
// goes above the bundle's own first line; a leading `"use strict";` in the
// bundle stays an effective directive (comments never break the directive
// prologue).
function preserveHeaderPlugin(entryPath: string, outPath: string): esbuild.Plugin {
	return {
		name: "ts0-preserve-header",
		setup(pluginBuild) {
			pluginBuild.onEnd((result) => {
				if (result.errors.length > 0) return;
				const header = leadingCommentBlock(readFileSync(entryPath, "utf-8"));
				if (!header) return;
				const bundle = readFileSync(outPath, "utf-8");
				writeFileSync(outPath, header.endsWith("\n") ? header + bundle : header + "\n" + bundle);
			});
		},
	};
}

// typecheckPlugin runs the type-check at the start of every esbuild build,
// including each rebuild in watch mode. Returning errors from onStart makes
// esbuild fail the build and skip writing output, so a rebuild that doesn't
// type-check cannot emit a bundle. Exported so the js library target
// (build-js.ts), which has its own esbuild context, gates its watch rebuilds
// the same way.
export function typecheckPlugin(config: Ts0Config, rootDir: string): esbuild.Plugin {
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
