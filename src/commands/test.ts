import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { join, extname } from "node:path";
import { loadConfig } from "../config.ts";
import { findNestedProjectDirs, runTypecheck, typecheckExcludeDirs } from "./build.ts";
import { colors, colorizeErrorBlock, colorizeTestLine, pipeColorized } from "../reporter.ts";

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
	// anything. Node's --experimental-strip-types only erases type annotations,
	// it does NOT type-check, so without this a test run would execute an
	// invalid program.
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
	const child = spawn("node", ["--experimental-strip-types", "--test", ...testFiles.map((f) => join(rootDir, f))], {
		stdio: ["inherit", "pipe", "pipe"],
		cwd: rootDir,
	});
	// stdout/stderr are piped rather than inherited so ts0 can recolor
	// node --test's TAP output (green "ok", red "not ok" + a GitHub Actions
	// annotation) as it streams -- "inherit" would hand the fd straight to the
	// terminal, bypassing ts0 entirely.
	pipeColorized(child.stdout, colorizeTestLine);
	pipeColorized(child.stderr, colorizeTestLine, process.stderr);
	return new Promise((resolve, reject) => {
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", reject);
	});
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
		if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(filename).toLowerCase())) return;
		trigger();
	});

	process.on("SIGINT", () => {
		watcher.close();
		process.exit(0);
	});

	await cycle();
}
