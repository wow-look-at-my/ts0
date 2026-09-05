import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, watch as fsWatch } from "node:fs";
import { dirname, join, extname } from "node:path";
import { loadConfig, type Ts0Config } from "../config.ts";
import { findNestedProjectDirs, runTypecheck, typecheckExcludeDirs } from "./build.ts";
import { baseEsbuildOptions } from "./esbuild-base.ts";
import { colors, colorizeErrorBlock, colorizeTestLine, formatEsbuildDiagnostic, pipeColorized } from "../reporter.ts";

// What a compiled test file is called: the source's name, with its extension
// replaced by this infix plus `.cjs` or `.mjs`. `scan.test.ts` compiles to
// `scan.test.ts0.cjs` or `scan.test.ts0.mjs`, BESIDE the source rather than
// under a build directory -- a test that reads a fixture through
// `import.meta.dirname` or `__dirname` must see the directory it was written
// in. The `.ts0` infix marks the file as ts0's to delete; nothing else in a
// project carries it.
const COMPILED_INFIX = ".ts0";
const COMPILED_EXTS = [".cjs", ".mjs"];

export interface TestOptions {
	pattern?: string;
	watch?: boolean;
	// Explicit ts0 config file (the --config CLI flag); default: walk up
	// from the cwd looking for ts0.json.
	configPath?: string;
}

// testProject type-checks ONE project and runs the test files it owns,
// resolving with an exit code (0 = pass). It never exits the process: the
// recursive caller needs every project's result, not the first failure's.
async function testProject(configPath: string | undefined, patternOverride?: string): Promise<number> {
	const { config, rootDir } = loadConfig(configPath);
	const pattern = patternOverride || config.test.pattern;

	// This project's discovery covers this project's files: the output dir,
	// config.exclude'd trees and nested ts0 projects are left out, exactly as
	// the gate leaves them out. A nested project's tests are NOT dropped --
	// testTree runs them under their own config, where the gate can check
	// them. Running them here would execute a program this gate never checked,
	// under settings they were not written for.
	//
	// Filtering the results rather than the glob's `exclude` hook is
	// deliberate: the hook is handed a mix of bare names and relative paths,
	// while a result is always a path from rootDir.
	const otherProjectDirs = typecheckExcludeDirs(config, rootDir).map((d) => d.split(/[\\/]/).join("/"));
	const belongsToAnotherProject = (file: string): boolean => {
		const rel = file.split(/[\\/]/).join("/");
		return otherProjectDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
	};

	const testFiles: string[] = [];
	// The gate: type-check the whole project (sources AND tests) before running
	// anything. The compile below erases type annotations, it does NOT check
	// them, so without this a test run would execute an invalid program.
	const check = await runTypecheck(config, rootDir);
	if (!check.success) {
		console.error(colors().red("Type-checking failed:"));
		console.error(colorizeErrorBlock(check.output));
		return 1;
	}
	for await (const file of glob(pattern, { cwd: rootDir, exclude: (name) => name === "node_modules" })) {
		if (!belongsToAnotherProject(file)) testFiles.push(file);
	}
	if (testFiles.length === 0) {
		console.log(`No test files found matching: ${pattern}`);
		return 0;
	}

	console.log(`Found ${testFiles.length} test file(s)\n`);

	const compiled = await compileTests(config, rootDir, testFiles);
	if (!compiled.success) {
		console.error(colors().red("Compiling tests failed:"));
		console.error(colorizeErrorBlock(compiled.errors.join("\n")));
		return 1;
	}

	try {
		// Source maps are inlined in each compiled file, so a stack trace names
		// the line of TypeScript the reader wrote.
		const child = spawn("node", ["--enable-source-maps", "--test", ...compiled.files.map((f) => f.compiled)], {
			stdio: ["inherit", "pipe", "pipe"],
			cwd: rootDir,
		});
		// stdout/stderr are piped rather than inherited so ts0 can recolor
		// node --test's TAP output (green "ok", red "not ok" + a GitHub Actions
		// annotation) as it streams -- "inherit" would hand the fd straight to the
		// terminal, bypassing ts0 entirely. The same pass renames each compiled
		// file back to its source, so the reader never sees a build artifact.
		const rename = sourceNameRewriter(compiled.files);
		pipeColorized(child.stdout, (line) => colorizeTestLine(rename(line)));
		pipeColorized(child.stderr, (line) => colorizeTestLine(rename(line)), process.stderr);
		return await new Promise<number>((resolve, reject) => {
			child.on("close", (code) => resolve(code ?? 1));
			child.on("error", reject);
		});
	} finally {
		for (const file of compiled.files) rmSync(file.compiled, { force: true });
	}
}

interface CompiledTest {
	source: string;
	compiled: string;
	format: "cjs" | "esm";
}

// compileTests bundles each test file with the same compiler and settings the
// build uses, and writes the result beside its source as ESM (`.mjs`).
//
// ts0 used to hand the .ts sources straight to `node --experimental-strip-types`.
// Stripping only ERASES type annotations. It cannot turn an `import` statement
// into a `require` call, and it cannot resolve an extensionless relative
// specifier the way a bundler does. So a CommonJS-format project -- one whose
// package.json says `"type": "commonjs"`, which is what a project that ships a
// cjs bundle usually says -- passed the gate and then died inside node with
// "Cannot use import statement outside a module". Compiling closes that hole.
// It also lets a test import whatever the build supports: a `loaders`
// extension, JSX, an `external` specifier. Stripping could never do that.
//
// One bundle per test file matches how `node --test` runs them. Each file gets
// its own process, so each already had its own copy of the module graph.
// Package imports stay external and resolve from the project's node_modules at
// run time: a test is not a shipped artifact, so nothing here must be
// self-contained.
//
// Each file is written next to its source, not into a build directory. A test
// that reads a fixture relative to `import.meta.dirname` -- or spawns a sibling
// script, or resolves a path against its own location -- has to see the
// directory it was written in. Relocating the compiled copy silently moves that
// anchor and breaks such a test at run time.
//
// Each file also keeps the module format its own source has, in an extension
// that states that format outright. A CommonJS file may say `__dirname`,
// `require` and `require.main === module`; an ES module file may say
// `import.meta`. Compiling either one into the other format drops the globals
// the source was written against, and the test dies on a name that was there a
// moment ago.
async function compileTests(
	config: Ts0Config,
	rootDir: string,
	testFiles: string[],
): Promise<{ success: boolean; files: CompiledTest[]; errors: string[] }> {
	const projectFormat = moduleFormat(rootDir);
	const files = testFiles.map((f) => {
		const format = fileModuleFormat(f, projectFormat);
		return {
			source: join(rootDir, f),
			compiled: join(rootDir, f.replace(/\.(ts|tsx|mts|cts|jsx)$/i, `${COMPILED_INFIX}.${format === "cjs" ? "cjs" : "mjs"}`)),
			format,
		};
	});
	// A run killed mid-flight leaves its compiled copies behind. Clear this
	// run's names before writing them, so a stale file is never executed.
	for (const file of files) rmSync(file.compiled, { force: true });

	const errors: string[] = [];
	for (const format of ["cjs", "esm"] as const) {
		const group = files.filter((f) => f.format === format);
		if (group.length === 0) continue;
		errors.push(...(await compileGroup(config, rootDir, group, format)));
	}
	return { success: errors.length === 0, files, errors };
}

// compileGroup compiles the test files that share one module format. esbuild
// takes a single format per call, so one call per format is what mixed sources
// need -- an .mts test beside a .cts one, or either beside the project default.
async function compileGroup(
	config: Ts0Config,
	rootDir: string,
	group: CompiledTest[],
	format: "cjs" | "esm",
): Promise<string[]> {
	try {
		const result = await esbuild.build({
			...baseEsbuildOptions(config),
			...config.esbuild,
			// A test runs in node whatever the code targets. These settings
			// describe the test run, which is ts0's to choose, so they sit after
			// the escape hatch rather than under it.
			entryPoints: group.map((f) => f.source),
			platform: "node",
			format,
			packages: "external",
			minify: false,
			sourcemap: "inline",
			outbase: rootDir,
			outdir: rootDir,
			// `scan.test.ts` -> `scan.test.ts0.cjs`, in its own directory.
			entryNames: `[dir]/[name]${COMPILED_INFIX}`,
			outExtension: { ".js": format === "cjs" ? ".cjs" : ".mjs" },
		});
		return result.errors.map((e) => formatEsbuildDiagnostic(e, "error"));
	} catch (err) {
		const failure = err as esbuild.BuildFailure;
		return failure.errors?.map((e) => formatEsbuildDiagnostic(e, "error")) || [String(err)];
	}
}

// moduleFormat reports the module format Node gives a `.js` or `.ts` file in
// this directory: the `type` of the nearest package.json above it, defaulting
// to CommonJS exactly as Node does when no package.json declares one.
function moduleFormat(startDir: string): "cjs" | "esm" {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
				const type = (parsed as { type?: unknown }).type;
				return type === "module" ? "esm" : "cjs";
			} catch {
				// An unreadable package.json says nothing about the format. Node
				// keeps walking up on one, so keep walking too.
			}
		}
		dir = dirname(dir);
	}
	return "cjs";
}

// fileModuleFormat reports the format of one test file. A `.mts`/`.cts`
// extension declares the format by itself and outranks the package; every other
// extension takes the project's.
function fileModuleFormat(relPath: string, projectFormat: "cjs" | "esm"): "cjs" | "esm" {
	if (/\.mts$/i.test(relPath)) return "esm";
	if (/\.cts$/i.test(relPath)) return "cjs";
	return projectFormat;
}

// sourceNameRewriter replaces a compiled test path with the source file it came
// from, so node --test names files the reader actually has. The mapping comes
// from the compile itself, never from a guess at the original extension.
function sourceNameRewriter(files: CompiledTest[]): (line: string) => string {
	return (line) => {
		let out = line;
		for (const file of files) {
			if (out.includes(file.compiled)) out = out.split(file.compiled).join(file.source);
		}
		return out;
	};
}

// testTree runs this project's tests and then those of every ts0 project
// nested inside it, each under its OWN ts0.json -- so a nested project's tests
// are checked by the gate that understands them instead of being left unrun.
// Depth is unlimited (each nested run recurses in turn) and every project runs
// even after one fails, because a suite that stops at the first failure hides
// the rest. Resolves with the worst exit code seen.
async function testTree(configPath: string | undefined, patternOverride?: string): Promise<number> {
	let worst = await testProject(configPath, patternOverride);
	const { rootDir } = loadConfig(configPath);
	for (const dir of findNestedProjectDirs(rootDir)) {
		console.log(`\n${dir}:`);
		// The nested project's own test.pattern applies; only an explicit
		// --pattern from the command line overrides it.
		const code = await testTree(join(rootDir, dir, "ts0.json"), patternOverride);
		if (code !== 0) worst = code;
	}
	return worst;
}

export async function test(options: TestOptions = {}): Promise<void> {
	const { rootDir } = loadConfig(options.configPath);

	if (!options.watch) {
		const code = await testTree(options.configPath, options.pattern);
		if (code !== 0) process.exit(code);
		return;
	}

	// Watch mode: we own the loop rather than using `node --test --watch`. The
	// node watcher re-runs tests on every change WITHOUT re-type-checking, which
	// would run an invalid program after a bad edit. Here every cycle
	// type-checks first and only runs tests when it passes; a type error is
	// reported and the run skipped, but watching continues.
	let running = false;
	let queued = false;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	// Each cycle is the same full recursive pass as a one-shot run, so watching
	// covers nested projects too -- the recursive fsWatch below already wakes on
	// their files, and a cycle that re-ran only this project's tests would
	// report green while a nested project sat broken.
	const cycle = async (): Promise<void> => {
		running = true;
		try {
			await testTree(options.configPath, options.pattern);
		} catch (err) {
			console.error(err);
		} finally {
			running = false;
			console.log("\nWatching for changes...");
			// A change that arrived mid-run is coalesced into exactly one re-run.
			if (queued) {
				queued = false;
				void cycle();
			}
		}
	};

	const trigger = (): void => {
		if (running) {
			queued = true;
			return;
		}
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			void cycle();
		}, 50);
	};

	const watcher = fsWatch(rootDir, { recursive: true }, (_event, filename) => {
		if (!filename) return;
		if (filename.startsWith("dist/") || filename.startsWith("node_modules/")) return;
		// A cycle writes a compiled copy beside every test file. Waking on those
		// writes would make each run schedule the next one, forever.
		if (COMPILED_EXTS.some((ext) => filename.endsWith(`${COMPILED_INFIX}${ext}`))) return;
		if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(filename).toLowerCase())) return;
		trigger();
	});

	process.on("SIGINT", () => {
		watcher.close();
		process.exit(0);
	});

	await cycle();
}
