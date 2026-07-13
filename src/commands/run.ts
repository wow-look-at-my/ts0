import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { loadConfig } from "../config.ts";
import { seaBridge } from "../sea/bridge.ts";
import { build, runTypecheck } from "./build.ts";
import { isHtmlEntry } from "./build-html.ts";
import { isJsTarget } from "./build-js.ts";

export interface RunOptions {
	// Skip build step (use for development with --experimental-strip-types)
	noBuild?: boolean;
	// Additional arguments to pass to the script
	args?: string[];
	// Specific file to run (overrides entry)
	file?: string;
}

export async function run(options: RunOptions = {}): Promise<void> {
	const { config, rootDir } = loadConfig();

	if (isHtmlEntry(options.file ?? config.entry)) {
		console.error("ts0 run does not support HTML entries. Use 'ts0 build' to produce a bundled HTML file.");
		process.exit(1);
	}

	if (isJsTarget(options.file ?? config.entry, rootDir)) {
		console.error("ts0 run does not support the js (library) target. Use 'ts0 build' to compile the module tree.");
		process.exit(1);
	}

	// --no-build skips the bundle, NOT the type-check. There must be no path
	// that runs code which hasn't passed tsc: `node --experimental-strip-types`
	// only strips type annotations, it does not type-check, so without this gate
	// `ts0 run --no-build` would happily execute broken code. The build path
	// (below) type-checks inside build(); this covers the one path that doesn't.
	if (options.noBuild) {
		const check = await runTypecheck(config, rootDir);
		if (!check.success) {
			console.error("Type-checking failed:");
			console.error(check.output);
			process.exit(1);
		}
	}

	if (options.file) {
		// Run specific file
		const fileToRun = join(rootDir, options.file);

		if (options.noBuild) {
			await runWithNode(fileToRun, options.args || [], true);
		} else {
			const result = await build();
			if (!result.success) {
				console.error("Build failed:");
				result.errors.forEach((e) => console.error(e));
				process.exit(1);
			}
			// For specific files with outfile config, still need outdir
			const outdir = config.outdir || "dist";
			const outFile = join(rootDir, outdir, basename(options.file).replace(/\.ts$/, ".js"));
			await runWithNode(outFile, options.args || [], false);
		}
	} else {
		// Run entry point
		if (!config.entry) {
			console.error("No entry point found. Specify one in ts0.json or pass a file.");
			process.exit(1);
		}

		if (options.noBuild) {
			const fileToRun = join(rootDir, config.entry);
			await runWithNode(fileToRun, options.args || [], true);
		} else {
			const result = await build();
			if (!result.success) {
				console.error("Build failed:");
				result.errors.forEach((e) => console.error(e));
				process.exit(1);
			}
			// Use outfile if specified, otherwise derive from outdir
			const fileToRun = config.outfile
				? join(rootDir, config.outfile)
				: join(rootDir, config.outdir || "dist", basename(config.entry).replace(/\.ts$/, ".js"));
			await runWithNode(fileToRun, options.args || [], false);
		}
	}
}

async function runWithNode(file: string, args: string[], stripTypes: boolean): Promise<void> {
	const nodeArgs = stripTypes ? ["--experimental-strip-types", file, ...args] : [file, ...args];

	// Inside the prebuilt SEA binary there is no `node` on PATH; the bridge
	// re-invokes the binary itself in run-dispatch mode, which import()s the
	// file (Node strips types for on-disk .ts by default there, covering the
	// --no-build path). The npm build has no bridge and spawns node as before.
	const bridge = seaBridge();
	const child = bridge
		? spawn(bridge.execPath, bridge.runArgs(file, args), {
				stdio: "inherit",
				cwd: process.cwd(),
			})
		: spawn("node", nodeArgs, {
				stdio: "inherit",
				cwd: process.cwd(),
			});

	return new Promise((resolve, reject) => {
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				process.exit(code || 1);
			}
		});

		child.on("error", reject);
	});
}
