import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { join, extname } from "node:path";
import { loadConfig } from "../config.ts";
import { runTypecheck } from "./build.ts";

export interface TestOptions {
	pattern?: string;
	watch?: boolean;
	// Explicit ts0 config file (the --config CLI flag); default: walk up
	// from the cwd looking for ts0.json.
	configPath?: string;
}

export async function test(options: TestOptions = {}): Promise<void> {
	const { config, rootDir } = loadConfig(options.configPath);
	const pattern = options.pattern || config.test.pattern;

	const findTestFiles = async (): Promise<string[]> => {
		const files: string[] = [];
		for await (const file of glob(pattern, { cwd: rootDir, exclude: (name) => name === "node_modules" })) {
			files.push(file);
		}
		return files;
	};

	// The gate: type-check the whole project (sources AND tests) before running
	// anything. Node's --experimental-strip-types only erases type annotations,
	// it does NOT type-check, so without this a test run would execute an invalid
	// program. Returns false (after printing the errors) on failure.
	const typecheckPasses = async (): Promise<boolean> => {
		const check = await runTypecheck(config, rootDir);
		if (!check.success) {
			console.error("Type-checking failed:");
			console.error(check.output);
			return false;
		}
		return true;
	};

	// Run the discovered tests once under Node's built-in runner; resolves with
	// the exit code (0 = pass). Only ever called after typecheckPasses().
	const runTests = (testFiles: string[]): Promise<number> => {
		console.log(`Found ${testFiles.length} test file(s)\n`);
		const child = spawn(
			"node",
			["--experimental-strip-types", "--test", ...testFiles.map((f) => join(rootDir, f))],
			{ stdio: "inherit", cwd: rootDir },
		);
		return new Promise((resolve, reject) => {
			child.on("close", (code) => resolve(code ?? 1));
			child.on("error", reject);
		});
	};

	if (!options.watch) {
		// Type-check first; a type error anywhere in the project fails the run
		// and no test process is spawned.
		if (!(await typecheckPasses())) process.exit(1);
		const testFiles = await findTestFiles();
		if (testFiles.length === 0) {
			console.log(`No test files found matching: ${pattern}`);
			return;
		}
		const code = await runTests(testFiles);
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

	const cycle = async (): Promise<void> => {
		running = true;
		try {
			if (await typecheckPasses()) {
				const testFiles = await findTestFiles();
				if (testFiles.length === 0) {
					console.log(`No test files found matching: ${pattern}`);
				} else {
					await runTests(testFiles);
				}
			}
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
