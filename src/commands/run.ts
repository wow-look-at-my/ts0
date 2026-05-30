import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { loadConfig } from "../config.ts";
import { build } from "./build.ts";
import { isHtmlEntry } from "./build-html.ts";

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

	if (options.file) {
		// Run specific file
		const fileToRun = join(rootDir, options.file);

		if (options.noBuild) {
			await runWithNode(fileToRun, options.args || [], true);
		} else {
			const result = await build();
			if (!result.success) {
				console.error("Build failed:");
				result.errors.forEach((e) => console.error(`	${e}`));
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
				result.errors.forEach((e) => console.error(`	${e}`));
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

	const child = spawn("node", nodeArgs, {
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
