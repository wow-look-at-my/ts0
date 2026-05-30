import { build, typecheck } from "./commands/build.ts";
import { run } from "./commands/run.ts";
import { test } from "./commands/test.ts";
import { init } from "./commands/init.ts";

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

	// Positional args, skipping option pairs like `--entry foo.html`.
	const getPositional = (index: number) => {
		const optionsTakingValue = new Set(["entry", "outfile", "outdir"]);
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
		return filtered[index - 1];
	};

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

			console.log("Type-checking...");
			const checkResult = await typecheck(overrides);
			if (!checkResult.success) {
				console.error(checkResult.output);
				process.exit(1);
			}

			console.log("Building...");
			const result = await build({ watch: hasFlag("watch", "w"), overrides });

			if (!hasFlag("watch", "w")) {
				if (result.success) {
					console.log(`Built in ${result.duration.toFixed(0)}ms`);
				} else {
					console.error("Build failed:");
					result.errors.forEach((e) => console.error(`	${e}`));
					process.exit(1);
				}
			}
			break;
		}

		case "run": {
			const file = getPositional(1);
			await run({
				file,
				noBuild: hasFlag("no-build"),
				args: args.slice(file ? 2 : 1).filter((a) => !a.startsWith("-")),
			});
			break;
		}

		case "test": {
			const pattern = getPositional(1);
			await test({
				pattern,
				watch: hasFlag("watch", "w"),
			});
			break;
		}

		default:
			console.error(`Unknown command: ${command}`);
			console.log(HELP);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
