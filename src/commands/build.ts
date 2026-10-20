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
// ships with (@types/node).
function nodeTypeRootsDir(): string {
	return dirname(dirname(require.resolve("@types/node/package.json")));
}

export interface BuildResult {
	success: boolean;
	outputFiles: string[];
	errors: string[];
	// esbuild warnings (e.g. an unused import), formatted like errors.
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
// config. The parent delegates to it instead of ignoring it. Recursion is
// depth-unlimited -- each nested build recurses in turn. A failure anywhere
// fails the whole build, with every project's errors reported rather than the
// first.
export async function build(options?: {
	watch?: boolean;
	overrides?: BuildOverrides;
	configPath?: string;
	// Build only this project.
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
		// Overrides are NOT passed down: --entry/--outfile/--outdir name paths in the project the user invoked.
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
	// haven't passed tsc. A one-shot build checks once, here, before anything is
	// written -- so every caller of build() (including `ts0 run`) is covered,
	// not the `build` command.
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
	// will not write output for a build whose onStart reports errors.
	if (watch) {
		esbuildConfig.plugins = [typecheckPlugin(config, rootDir), ...(esbuildConfig.plugins ?? [])];
	}

	// preserveHeader re-prepends the entry's leading comment block to the
	// written bundle (esbuild strips comments). An onEnd plugin covers the
	// one-shot build and every watch rebuild alike. Each rebuild rewrites
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
		// outfile and outdir are mutually exclusive — clearing outdir keeps the existing precedence in build().
		out.outdir = undefined;
	}
	if (overrides.outdir !== undefined) {
		out.outdir = overrides.outdir;
		out.outfile = undefined;
	}
	return out;
}

// findNestedProjectDirs returns the rootDir-relative paths of subdirectories
// that are themselves ts0 projects (they contain their own ts0.json).
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
// ts0 config, shared by the type-check gate (runTypecheck) and the js
// target's declaration emit (emitDeclarations). Keeping them in one place
// guarantees both passes can't drift: declaration emit compiles under
// exactly the options the gate checks with.
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
		// The consumer's own node_modules/@types stays in the search too, so an explicit @types/node install (or another @types package) still resolves.
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
		// execFile, not execSync: this is the call a whole project's check waits
		// on, and execSync blocks the event loop. A caller running several
		// projects at once got no concurrency at all whatever it did.
		return await new Promise((resolve) => {
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
// parse-only pass over the same file set). It is the source of truth for
// "does this project type-check". Build() (for build/run) and run() (for the
// --no-build path) call it before emitting OR executing anything, so it is
// the chokepoint that makes type-checking unskippable.
export async function runTypecheck(config: Ts0Config, rootDir: string): Promise<{ success: boolean; output: string }> {
	const excludeDirs = typecheckExcludeDirs(config, rootDir);

	// The entry, named explicitly. tsc's `**/*` never descends into a dot-directory, so an entry under one -- a build script in `.github/`, `.config/`.
	const entryPaths = entryTypeCheckPaths(config, rootDir, excludeDirs);

	// Nothing to check: a project with no TypeScript sources at all (e.g. a plain-JS HTML entry). tsc would abort with TS18003 "No inputs were found".
	let output = "No TypeScript sources to check.";
	if (entryPaths.length > 0 || hasTypeScriptSources(rootDir, excludeDirs)) {
		const tsconfigContent = {
			compilerOptions: { ...generatedCompilerOptions(config, rootDir), noEmit: true },
			// Include .tsx/.mts/.cts alongside .ts so JSX components and ESM/CJS TypeScript variants are type-checked too.
			include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", ...entryPaths],
			exclude: ["node_modules", ...excludeDirs],
		};

		const result = await runTsc(rootDir, ".ts0-tsconfig.json", tsconfigContent);
		if (!result.success) return result;
		output = result.output || "No type errors found.";
	}

	// Explicit `any` is a hard error too -- tsc has no flag for it.
	const explicitAny = checkNoExplicitAny(rootDir, excludeDirs);
	if (!explicitAny.success) return explicitAny;

	return { success: true, output };
}

// typecheckExcludeDirs returns the directories this project's own gate does
// not check, as paths relative to rootDir.
export function typecheckExcludeDirs(config: Ts0Config, rootDir: string): string[] {
	return [config.outdir, ...(config.exclude ?? []), ...findNestedProjectDirs(rootDir)].filter(
		(d): d is string => !!d,
	);
}

// entryTypeCheckPaths returns tsconfig `include` entries naming the configured
// entry: the file itself, or one glob per TypeScript extension for a directory
// entry. Both forms name the entry's path explicitly, which is what makes them
// reach inside a dot-directory. Tsc skips those only while expanding a leading
// wildcard, never a path segment it was given. An HTML entry yields nothing:
// its scripts are discovered from the markup, not from the config.
function entryTypeCheckPaths(config: Ts0Config, rootDir: string, excludeDirs: string[]): string[] {
	const entry = config.entry;
	if (!entry) return [];
	const rel = entry.split(/[\\/]/).join("/");
	const abs = resolve(rootDir, entry);
	if (!existsSync(abs)) return [];
	if (statSync(abs).isDirectory()) {
		// Globs that match nothing would make tsc abort with TS18003, so a JS-only directory entry must yield none.
		if (!hasTypeScriptSources(rootDir, excludeDirs, abs)) return [];
		return ["ts", "tsx", "mts", "cts"].map((ext) => `${rel}/**/*.${ext}`);
	}
	return /\.(ts|tsx|mts|cts)$/i.test(rel) ? [rel] : [];
}

// collectAmbientDeclarations returns the project's *.d.ts files (ambient
// declarations like `declare module "*.wgsl"`), excluding node_modules, the
// output directory, dotfiles. collectAmbientDeclarations nested ts0 projects
// -- the same exclusions as the type-check gate. The declaration-emit pass
// lists its inputs explicitly (a `files` array, not a glob). Ambient
// declarations must be added back or loader-backed imports would fail to
// resolve there (TS2307). Declaration inputs never produce output and are
// exempt from the rootDir requirement, so they may live anywhere in the
// project.
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
// target. Every compiled module gets a parallel *.d.ts under outDir, mirroring
// the source tree exactly like the *.js outputs (src/ui/x.ts ->
// dist/ui/x.d.ts). Only build-js.ts calls it, and only on the build path --
// `ts0 run`/`ts0 test` never emit anything. The type-check gate stays exactly
// as strict as before (this pass is additional, never a replacement).
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
// byte-exact. This also covers the maximal run of consecutive lines starting
// with `//` from one byte (each including its terminating newline), or a
// single `/* ... */` block starting at one byte (through the closing `*/`
// plus its trailing newline, if present). Returns "" when the file doesn't
// start with a comment.
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
// bundling. However, some headers are semantically load-bearing artifacts
// of the OUTPUT file -- a userscript's ==UserScript== metadata block, a
// mandated license banner. So they must survive byte-exactly at the top.
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
// type-check cannot emit a bundle.
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
