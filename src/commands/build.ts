import * as esbuild from "esbuild";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadConfig, type Ts0Config } from "../config.ts";
import { buildHtml, isHtmlEntry } from "./build-html.ts";
import { buildJs, isJsTarget } from "./build-js.ts";
import { baseEsbuildOptions } from "./esbuild-base.ts";
import { checkNoExplicitAny } from "./explicit-any.ts";
import { formatEsbuildDiagnostic } from "../reporter.ts";

const require = createRequire(import.meta.url);

// nodeTypeRootsDir resolves the directory holding the @types packages ts0
// ships with (@types/node), the same way runTsc resolves the typescript
// binary from ts0's own dependencies -- via createRequire(import.meta.url),
// which the prebuilt bundle rewrites to the extraction cache. A Node-target
// project then type-checks with no @types/node install of its own, on every
// consumption path (prebuilt, npm/git install, running from source).
function nodeTypeRootsDir(): string {
	return dirname(dirname(require.resolve("@types/node/package.json")));
}

export interface BuildResult {
	success: boolean;
	outputFiles: string[];
	errors: string[];
	// esbuild warnings (e.g. an unused import), formatted like errors. Absent
	// or empty on a target that hasn't been wired up to report them.
	warnings?: string[];
	duration: number;
}

export interface BuildOverrides {
	entry?: string;
	outfile?: string;
	outdir?: string;
}

// build compiles this project and then every ts0 project nested inside it,
// each under its OWN ts0.json. A nested project is not a directory to skip:
// its settings (JSX, target, loaders) make it unbuildable under the parent's
// config, so the parent delegates to it instead of ignoring it. Recursion is
// depth-unlimited -- each nested build recurses in turn -- and a failure
// anywhere fails the whole build, with every project's errors reported rather
// than just the first.
export async function build(options?: {
	watch?: boolean;
	overrides?: BuildOverrides;
	configPath?: string;
	// Build only this project. `ts0 run` sets it: it builds the one entry it
	// is about to execute, and running N nested projects is not a thing.
	selfOnly?: boolean;
}): Promise<BuildResult> {
	const startTime = performance.now();
	const self = await buildSelf(options);
	if (options?.selfOnly) return self;

	const { rootDir } = loadConfig(options?.configPath);
	const nested = findNestedProjectDirs(rootDir);
	if (nested.length === 0) return self;

	const outputFiles = [...self.outputFiles];
	const errors = [...self.errors];
	const warnings = [...(self.warnings ?? [])];
	let success = self.success;

	for (const dir of nested) {
		console.log(`\n${dir}:`);
		// Overrides are NOT passed down: --entry/--outfile/--outdir name paths
		// in the project the user invoked, and mean nothing in a nested one.
		const result = await build({ watch: options?.watch, configPath: join(rootDir, dir, "ts0.json") });
		outputFiles.push(...result.outputFiles);
		errors.push(...result.errors.map((e) => `${dir}: ${e}`));
		warnings.push(...(result.warnings ?? []).map((w) => `${dir}: ${w}`));
		if (!result.success) success = false;
	}

	return { success, outputFiles, errors, warnings, duration: performance.now() - startTime };
}

async function buildSelf(options?: {
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
			errors: result.errors.map((e) => formatEsbuildDiagnostic(e, "error")),
			warnings: result.warnings.map((w) => formatEsbuildDiagnostic(w, "warning")),
			duration: performance.now() - startTime,
		};
	} catch (err) {
		const error = err as esbuild.BuildFailure;
		return {
			success: false,
			outputFiles: [],
			errors: error.errors?.map((e) => formatEsbuildDiagnostic(e, "error")) || [String(err)],
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
// that are themselves ts0 projects (they contain their own ts0.json). These
// are the recursion targets for `ts0 build` and `ts0 test`: the parent's own
// type-check leaves them out so a nested project's settings (e.g. JSX) don't
// leak into it, and then builds/tests them under their own config instead.
// node_modules/dist/dotfiles are not walked, and descent stops at a nested
// project boundary -- that project's own recursion covers its subtree.
export function findNestedProjectDirs(rootDir: string): string[] {
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
//   its globals (console, process, node:fs, ...) come from @types/node, which
//   ts0 ships with itself via `typeRoots` (nodeTypeRootsDir) -- a Node-target
//   project needs no @types/node install of its own. Without the DOM lib,
//   every HTML/browser project would fail type-checking on "Cannot find name
//   'document'".
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
	if (!isBrowser) {
		// The consumer's own node_modules/@types stays in the search too, so an
		// explicit @types/node install (or another @types package) still resolves;
		// ts0's bundled copy is what makes that install unnecessary, not forbidden.
		compilerOptions.typeRoots = [nodeTypeRootsDir(), join(rootDir, "node_modules", "@types")];
	}
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
	const { execFile } = await import("node:child_process");
	const { createRequire } = await import("node:module");

	// Find tsc from ts0's dependencies, not the project's
	const require = createRequire(import.meta.url);
	const tscPath = require.resolve("typescript/bin/tsc");

	// Write temporary tsconfig
	const { writeFileSync, unlinkSync } = await import("node:fs");
	const tempTsconfig = join(rootDir, tempName);
	writeFileSync(tempTsconfig, JSON.stringify(tsconfigContent, null, "\t"));

	try {
		// execFile, not execSync: this is the one call a whole project's check
		// waits on, and execSync blocks the event loop, so a caller running
		// several projects at once got no concurrency at all whatever it did.
		// Passing argv rather than a command line also drops the quoting
		// question -- tscPath and tempTsconfig may live under a path with
		// spaces, such as "C:\\Users\\First Last\\.cache".
		return await new Promise((resolve) => {
			// A default 1 MB buffer truncates a large project's diagnostics and
			// reports the truncation as the failure, which reads as a compiler
			// crash rather than as the type errors it actually found.
			const opts = { cwd: rootDir, encoding: "utf-8" as const, maxBuffer: 64 * 1024 * 1024 };
			execFile("node", [tscPath, "--project", tempTsconfig], opts, (err, stdout, stderr) => {
				if (!err) return resolve({ success: true, output: stdout });
				resolve({ success: false, output: stdout || stderr || String(err) });
			});
		});
	} finally {
		unlinkSync(tempTsconfig);
	}
}

// runTypecheck type-checks the project with `tsc --noEmit` using a temporary
// tsconfig derived from the ts0 config, then bans explicit `any` (see
// commands/explicit-any.ts -- tsc has no flag for it, so it is a second,
// parse-only pass over the same file set). It is the single source of truth
// for "does this project type-check"; build() (for build/run) and run() (for
// the --no-build path) call it before emitting OR executing anything, so it is
// the chokepoint that makes type-checking unskippable.
export async function runTypecheck(config: Ts0Config, rootDir: string): Promise<{ success: boolean; output: string }> {
	const excludeDirs = typecheckExcludeDirs(config, rootDir);

	// The entry, named explicitly. tsc's `**/*` never descends into a
	// dot-directory, so an entry under one -- a build script in `.github/`,
	// `.config/` -- is bundled against an EMPTY type-check program while the
	// build still reports success. Naming it puts it (and everything it
	// imports) in the program wherever it lives.
	const entryPaths = entryTypeCheckPaths(config, rootDir, excludeDirs);

	// Nothing to check: a project with no TypeScript sources at all (e.g. a
	// plain-JS HTML entry). tsc would abort with TS18003 "No inputs were
	// found", so treat an empty source set as a vacuous pass -- there are no
	// types that could be broken. (The explicit-`any` pass below still runs:
	// a project can consist of declaration files only, which don't count as
	// sources here but can still write `any`.)
	let output = "No TypeScript sources to check.";
	if (entryPaths.length > 0 || hasTypeScriptSources(rootDir, excludeDirs)) {
		const tsconfigContent = {
			compilerOptions: { ...generatedCompilerOptions(config, rootDir), noEmit: true },
			// Include .tsx/.mts/.cts alongside .ts so JSX components and ESM/CJS
			// TypeScript variants are type-checked too.
			include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", ...entryPaths],
			exclude: ["node_modules", ...excludeDirs],
		};

		const result = await runTsc(rootDir, ".ts0-tsconfig.json", tsconfigContent);
		if (!result.success) return result;
		output = result.output || "No type errors found.";
	}

	// Explicit `any` is a hard error too -- tsc has no flag for it, so this is
	// a separate parse-only pass over the same files the gate checks. It runs
	// after tsc so a syntax error is reported as the syntax error it is,
	// rather than as whatever a partial parse made of it.
	const explicitAny = checkNoExplicitAny(rootDir, excludeDirs);
	if (!explicitAny.success) return explicitAny;

	return { success: true, output };
}

// typecheckExcludeDirs returns the directories this project's own gate does
// not check, as paths relative to rootDir. A nested project (its own ts0.json)
// may use different settings -- e.g. JSX -- that would make the parent's
// type-check fail on it, so it is checked under its own config when build/test
// recurse into it. The output dir is excluded so emitted artifacts aren't
// re-checked, and config.exclude adds directories that type-check under their
// own separate tsconfig (a test tree with its own types, an experiment dir).
//
// `ts0 test` leaves the same directories out of ITS OWN discovery, for the
// same reason and with the same follow-through: a nested project's tests run
// in the recursive pass, under the gate that can actually check them. Nothing
// here means "never checked" -- only "not checked by this project".
export function typecheckExcludeDirs(config: Ts0Config, rootDir: string): string[] {
	return [config.outdir, ...(config.exclude ?? []), ...findNestedProjectDirs(rootDir)].filter(
		(d): d is string => !!d,
	);
}

// entryTypeCheckPaths returns tsconfig `include` entries naming the configured
// entry: the file itself, or one glob per TypeScript extension for a directory
// entry. Both forms name the entry's path explicitly, which is what makes them
// reach inside a dot-directory -- tsc skips those only while expanding a
// leading wildcard, never a path segment it was given. An HTML entry yields
// nothing: its scripts are discovered from the markup, not from the config.
function entryTypeCheckPaths(config: Ts0Config, rootDir: string, excludeDirs: string[]): string[] {
	const entry = config.entry;
	if (!entry) return [];
	const rel = entry.split(/[\\/]/).join("/");
	const abs = resolve(rootDir, entry);
	if (!existsSync(abs)) return [];
	if (statSync(abs).isDirectory()) {
		// Globs that match nothing would make tsc abort with TS18003, so a
		// JS-only directory entry must yield none: it has to reach build-js
		// and get that target's own "No TypeScript modules found" error.
		if (!hasTypeScriptSources(rootDir, excludeDirs, abs)) return [];
		return ["ts", "tsx", "mts", "cts"].map((ext) => `${rel}/**/*.${ext}`);
	}
	return /\.(ts|tsx|mts|cts)$/i.test(rel) ? [rel] : [];
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

// hasTypeScriptSources reports whether the tree under startDir (the project
// root by default) contains any TypeScript source file (.ts/.tsx/.mts/.cts,
// excluding .d.ts declarations) outside node_modules, the output dir, and
// nested ts0 projects. Used to skip the type-check for a project with no TS to
// check (e.g. a plain-JS HTML entry), which would otherwise make tsc abort with
// TS18003. excludeDirs stay relative to rootDir whatever startDir is.
function hasTypeScriptSources(rootDir: string, excludeDirs: string[], startDir: string = rootDir): boolean {
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
	walk(startDir);
	return found;
}
