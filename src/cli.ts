import { build } from "./commands/build.ts";
import { run } from "./commands/run.ts";
import { test } from "./commands/test.ts";
import { init } from "./commands/init.ts";
import { colors, colorizeErrorBlock } from "./reporter.ts";

const HELP = `
ts0 - Simple TypeScript framework

Usage:
	ts0 <command> [options]

Commands:
	init							Create ts0.json and sample files
	build						 Type-check and build the project
	run [file]				Build and run (or run specific file)
	test [pattern]		Run tests

Options:
	--watch, -w			 Watch mode (build, test)
	--no-build				Skip build step (run)
	--config <path>	 Use an explicit config file instead of the nearest
								ts0.json (build, run, test)
	--entry <path>		Override the configured entry (build)
	--outfile <path>	Override outfile, single-file output (build)
	--outdir <path>	 Override outdir (build)
	--force					 Overwrite existing files (init)
	--help, -h				Show this help

Examples:
	ts0 init					# Initialize a new project
	ts0 build				 # Type-check and build (TS or HTML entry)
	ts0 run					 # Build and run entry point
	ts0 run src/app.ts			# Run specific file
	ts0 run --no-build			# Run without building (fast dev)
	ts0 test					# Run all tests
	ts0 test --watch	# Run tests in watch mode

Entry points:
	*.ts					# Bundled to a single JS file (or directory)
	*.html					# All <script src> and <link rel=stylesheet>
								referenced locally are inlined into the output HTML
	<dir>/					# "js" library target: every *.ts under the
								directory is compiled to a parallel *.js tree,
								structure preserved (e.g. src/a/b.ts -> dist/a/b.js)
`;

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	const hasFlag = (name: string, short?: string): boolean =>
		args.includes(`--${name}`) || (short ? args.includes(`-${short}`) : false);

	const getOption = (name: string): string | undefined => {
		const eq = args.find((a) => a.startsWith(`--${name}=`));
		if (eq) return eq.slice(name.length + 3);
		const i = args.indexOf(`--${name}`);
		if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("-")) return args[i + 1];
		return undefined;
	};

	// Positional args, skipping option pairs like `--entry foo.html` (the
	// option value must not be mistaken for a positional).
	const getPositionals = () => {
		const optionsTakingValue = new Set(["entry", "outfile", "outdir", "config"]);
		const filtered: string[] = [];
		for (let i = 1; i < args.length; i++) {
			const a = args[i];
			if (a.startsWith("--")) {
				const name = a.slice(2).split("=")[0];
				if (optionsTakingValue.has(name) && !a.includes("=")) i++;
				continue;
			}
			if (a.startsWith("-")) continue;
			filtered.push(a);
		}
		return filtered;
	};
	const getPositional = (index: number) => getPositionals()[index - 1];

	if (!command || hasFlag("help", "h")) {
		console.log(HELP);
		return;
	}

	switch (command) {
		case "init": {
			await init({ force: hasFlag("force") });
			break;
		}

		case "build": {
			const overrides = {
				entry: getOption("entry"),
				outfile: getOption("outfile"),
				outdir: getOption("outdir"),
			};

			// build() type-checks before emitting anything (see commands/build.ts);
			// a type error comes back as a failed result here, never as output.
			const result = await build({
				watch: hasFlag("watch", "w"),
				overrides,
				configPath: getOption("config"),
			});

			const c = colors();
			if (result.warnings?.length) {
				result.warnings.forEach((w) => console.error(colorizeErrorBlock(w, "warning")));
			}
			if (!hasFlag("watch", "w")) {
				if (result.success) {
					console.log(c.green(`Built in ${result.duration.toFixed(0)}ms`));
				} else {
					console.error(c.red("Build failed:"));
					result.errors.forEach((e) => console.error(colorizeErrorBlock(e)));
					process.exit(1);
				}
			}
			break;
		}

		case "run": {
			const positionals = getPositionals();
			const file = positionals[0];
			await run({
				file,
				noBuild: hasFlag("no-build"),
				// Positionals after the file are the program's own arguments
				// (option values like `--config x.json` are never leaked here).
				args: positionals.slice(1),
				configPath: getOption("config"),
			});
			break;
		}

		case "test": {
			const pattern = getPositional(1);
			await test({
				pattern,
				watch: hasFlag("watch", "w"),
				configPath: getOption("config"),
			});
			break;
		}

		default:
			console.error(colors().red(`Unknown command: ${command}`));
			console.log(HELP);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
