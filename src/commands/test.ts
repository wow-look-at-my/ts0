import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, watch as fsWatch } from "node:fs";
import { dirname, join, extname } from "node:path";
import { availableParallelism } from "node:os";
import { loadConfig, type Ts0Config } from "../config.ts";
import { findNestedProjectDirs, runTypecheck, typecheckExcludeDirs } from "./build.ts";
import { baseEsbuildOptions } from "./esbuild-base.ts";
import {
	colors,
	colorizeErrorBlock,
	colorizeTestLine,
	formatEsbuildDiagnostic,
	pipeColorized,
	type LineSink,
} from "../reporter.ts";

// Where one project's output goes. The root project writes straight through.
interface Sink {
	out: LineSink;
	err: LineSink;
}

const processSink: Sink = { out: process.stdout, err: process.stderr };

// bufferedSink records what a project writes, in order, across BOTH streams,
// and replays it on flush. Keeping one ordered list rather than buffers is
// what makes an error land where it was written instead of after everything.
function bufferedSink(): { sink: Sink; flush: () => void } {
	const chunks: Array<{ err: boolean; text: string }> = [];
	const collect = (err: boolean): LineSink => ({
		write(text: string): void {
			chunks.push({ err, text });
		},
	});
	return {
		sink: { out: collect(false), err: collect(true) },
		// Synchronous, so a sibling finishing mid-flush cannot cut into it.
		flush(): void {
			for (const c of chunks) (c.err ? process.stderr : process.stdout).write(c.text);
		},
	};
}

// How many nested projects run at once.
function projectConcurrency(): number {
	const override = Number(process.env.TS0_PROJECT_CONCURRENCY);
	if (Number.isInteger(override) && override > 0) return override;
	return Math.max(2, Math.min(4, availableParallelism()));
}

// mapConcurrent runs `work` over `items` with at most `limit` in flight, and
// keeps each result at its item's index.
async function mapConcurrent<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			const item = items[i];
			if (item === undefined) return;
			results[i] = await work(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// What a compiled test file is called: the source's name, with its extension
// replaced by this infix plus `.cjs` or `.mjs`.
const COMPILED_INFIX = ".ts0";
const COMPILED_EXTS = [".cjs", ".mjs"];

// How many test files run at once.
function testConcurrency(): number {
	const override = Number(process.env.TS0_TEST_CONCURRENCY);
	if (Number.isInteger(override) && override > 0) return override;
	return Math.max(4, availableParallelism());
}

export interface TestOptions {
	pattern?: string;
	watch?: boolean;
	// Explicit ts0 config file (the --config CLI flag); default: walk up from the cwd looking for ts0.json.
	configPath?: string;
}

// testProject type-checks ONE project and runs the test files it owns,
// resolving with an exit code (0 = pass). It never exits the process: the
// recursive caller needs every project's result, not the first failure's.
async function testProject(configPath: string | undefined, patternOverride: string | undefined, io: Sink): Promise<number> {
	const { config, rootDir } = loadConfig(configPath);
	const pattern = patternOverride || config.test.pattern;

	// This project's discovery covers this project's files.
	const otherProjectDirs = typecheckExcludeDirs(config, rootDir).map((d) => d.split(/[\\/]/).join("/"));
	const belongsToAnotherProject = (file: string): boolean => {
		const rel = file.split(/[\\/]/).join("/");
		return otherProjectDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
	};

	const testFiles: string[] = [];
	// The gate: type-check the whole project (sources AND tests) before running anything.
	const check = await runTypecheck(config, rootDir);
	if (!check.success) {
		io.err.write(`${colors().red("Type-checking failed:")}\n`);
		io.err.write(`${colorizeErrorBlock(check.output)}\n`);
		return 1;
	}
	for await (const file of glob(pattern, { cwd: rootDir, exclude: (name) => name === "node_modules" })) {
		if (!belongsToAnotherProject(file)) testFiles.push(file);
	}
	if (testFiles.length === 0) {
		io.out.write(`No test files found matching: ${pattern}\n`);
		return 0;
	}

	io.out.write(`Found ${testFiles.length} test file(s)\n\n`);

	const compiled = await compileTests(config, rootDir, testFiles);
	if (!compiled.success) {
		io.err.write(`${colors().red("Compiling tests failed:")}\n`);
		io.err.write(`${colorizeErrorBlock(compiled.errors.join("\n"))}\n`);
		return 1;
	}

	try {
		// Source maps are inlined in each compiled file, so a stack trace names
		// the line of TypeScript the reader wrote.
		const child = spawn(
			"node",
			[
				"--enable-source-maps",
				`--test-concurrency=${testConcurrency()}`,
				"--test",
				...compiled.files.map((f) => f.compiled),
			],
			{
				stdio: ["inherit", "pipe", "pipe"],
				cwd: rootDir,
			},
		);
		// stdout/stderr are piped rather than inherited so ts0 can recolor node --test's TAP output (green "ok", red "not ok" + a GitHub Actions annotation) as it streams.
		const rename = sourceNameRewriter(compiled.files);
		pipeColorized(child.stdout, (line) => colorizeTestLine(rename(line)), io.out);
		pipeColorized(child.stderr, (line) => colorizeTestLine(rename(line)), io.err);
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
// ts0 used to hand the .ts sources straight to `node
// --experimental-strip-types`. Stripping only ERASES type annotations. It
// cannot turn an `import` statement into a `require` call, and it cannot
// resolve an extensionless relative specifier the way a bundler does. So a
// CommonJS-format project -- one whose package.json says `"type":
// "commonjs"`, which is what a project that ships a cjs bundle usually
// says. It passed the gate and then died inside node with "Cannot use
// import statement outside a module". Compiling closes that hole. It also
// lets a test import whatever the build supports: a `loaders` extension,
// JSX, an `external` specifier. Stripping could never do that.
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
	// A run killed mid-flight leaves its compiled copies behind.
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
// takes a single format per call. One call per format is what mixed sources
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
			// A test runs in node whatever the code targets.
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
// this directory. The `type` of the nearest package.json above it, defaulting
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

// sourceNameRewriter replaces a compiled test path with the source file it
// came from, so node --test names files the reader has. The mapping comes
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

// testTree runs this project's tests. Then those of every ts0 project nested inside it, each under its OWN ts0.json -- so a nested project's tests are checked by the gate. That gate understands them instead of being left unrun. Depth is unlimited (each nested run recurses in turn) and every project runs even after one fails, because a suite that stops at the first failure hides the rest. Resolves with the worst exit code seen. Nested projects run at the same time, bounded by projectConcurrency. Each writes into its own buffer and is printed whole the moment it finishes,
// so concurrency costs the reader nothing: no TAP streams interleave. The order is the order they completed in.
async function testTree(configPath: string | undefined, patternOverride: string | undefined, io: Sink): Promise<number> {
	let worst = await testProject(configPath, patternOverride, io);
	const { rootDir } = loadConfig(configPath);
	const dirs = findNestedProjectDirs(rootDir);
	if (dirs.length === 0) return worst;
	const codes = await mapConcurrent(dirs, projectConcurrency(), async (dir) => {
		const buffered = bufferedSink();
		buffered.sink.out.write(`\n${dir}:\n`);
		// The nested project's own test.pattern applies; only an explicit --pattern from the command line overrides it.
		const code = await testTree(join(rootDir, dir, "ts0.json"), patternOverride, buffered.sink);
		buffered.flush();
		return code;
	});
	for (const code of codes) {
		if (code !== 0) worst = code;
	}
	return worst;
}

export async function test(options: TestOptions = {}): Promise<void> {
	const { rootDir } = loadConfig(options.configPath);

	if (!options.watch) {
		const code = await testTree(options.configPath, options.pattern, processSink);
		if (code !== 0) process.exit(code);
		return;
	}

	// Watch mode: we own the loop rather than using `node --test --watch`.
	let running = false;
	let queued = false;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	// Each cycle is the same full recursive pass as a one-shot run, so watching
	// covers nested projects too. The recursive fsWatch below already wakes on
	// their files. A cycle that re-ran only this project's tests would report
	// green while a nested project sat broken.
	const cycle = async (): Promise<void> => {
		running = true;
		try {
			await testTree(options.configPath, options.pattern, processSink);
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
		// A cycle writes a compiled copy beside every test file.
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
