import * as esbuild from "esbuild";
import { join, resolve, extname } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import type { Ts0Config } from "../config.ts";
import { emitDeclarations, typecheckPlugin, type BuildResult } from "./build.ts";
import { baseEsbuildOptions } from "./esbuild-base.ts";
import { formatEsbuildDiagnostic } from "../reporter.ts";

// isJsTarget reports whether the configured entry selects the "js" library
// target: a *directory* of TypeScript modules compiled in place — every file
// becomes a separate output preserving the directory structure, rather than a
// single bundled entry. It is adjacent to and mutually exclusive with the HTML
// target (entry ending in .html) and the default single-entry target (entry is
// a .ts/.tsx file). Selection is by entry shape, mirroring how the HTML target
// is chosen by extension.
export function isJsTarget(entry: string | undefined, rootDir: string): boolean {
	if (!entry) return false;
	const p = resolve(rootDir, entry);
	return existsSync(p) && statSync(p).isDirectory();
}

// Extensions compiled as entry points by the js target.
const ENTRY_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// collectEntryPoints walks srcDir and returns the absolute path of every
// compilable module: .ts/.tsx/.mts/.cts, excluding declaration files (*.d.ts)
// and tests (*.test.* / *.spec.*). node_modules, the output directory, and
// dotfiles are skipped.
function collectEntryPoints(srcDir: string, outDirAbs: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				if (resolve(p) === outDirAbs) continue;
				walk(p);
				continue;
			}
			if (name.endsWith(".d.ts")) continue;
			if (/\.(test|spec)\.[mc]?tsx?$/.test(name)) continue;
			if (ENTRY_EXTS.has(extname(name))) found.push(p);
		}
	};
	walk(srcDir);
	return found;
}

// declarationsPlugin emits the parallel *.d.ts tree (tsc, declaration-only;
// see emitDeclarations in build.ts) after each successful esbuild build --
// the one-shot build AND every watch rebuild, so the .js and .d.ts trees never
// drift apart in either mode. It runs in onEnd, after esbuild wrote the .js
// outputs, and reports an emit failure as a build error: the one-shot build
// comes back failed (ts0 build exits non-zero) and a watch rebuild logs it.
// A build that already failed (type-check gate, bundle error) skips the pass,
// and noEmitOnError inside the pass means a failure writes no .d.ts at all.
function declarationsPlugin(
	config: Ts0Config,
	rootDir: string,
	opts: { entryPoints: string[]; srcDir: string; outDir: string },
): esbuild.Plugin {
	return {
		name: "ts0-declarations",
		setup(pluginBuild) {
			pluginBuild.onEnd(async (result) => {
				if (result.errors.length > 0) return null;
				const emit = await emitDeclarations(config, rootDir, opts);
				if (!emit.success) {
					return { errors: [{ text: `Declaration emit failed:\n${emit.output}` }] };
				}
				return null;
			});
		},
	};
}

// buildJs compiles a directory of TypeScript modules into a parallel tree of
// ESM JavaScript under outdir. Each source file is its own esbuild entry point,
// so a consumer can import any single output module by URL. Code splitting is
// enabled (for esm output): a module imported by more than one entry is emitted
// once into a shared chunk and imported, never duplicated into each output. The
// consumer still writes a single import — the browser fetches any shared chunk
// transitively. Loader-backed imports (e.g. .wgsl text) and non-shared local
// imports stay inlined in the importing module. This is the shape a library
// deployed to static hosting (GitHub Pages, a CDN) wants.
//
// Unless config.declarations is false, a parallel *.d.ts tree is emitted next
// to the *.js outputs (declarationsPlugin above), so a deployed library ships
// type declarations at the same URLs as its code.
export async function buildJs(
	config: Ts0Config,
	rootDir: string,
	options?: { watch?: boolean },
): Promise<BuildResult> {
	const startTime = performance.now();

	if (!config.entry) {
		return {
			success: false,
			outputFiles: [],
			errors: ["No entry point specified"],
			duration: performance.now() - startTime,
		};
	}

	const srcDir = resolve(rootDir, config.entry);
	const outDir = resolve(rootDir, config.outdir || "dist");
	const entryPoints = collectEntryPoints(srcDir, outDir);

	if (entryPoints.length === 0) {
		return {
			success: false,
			outputFiles: [],
			errors: [`No TypeScript modules found under "${config.entry}"`],
			duration: performance.now() - startTime,
		};
	}

	const esbuildConfig: esbuild.BuildOptions = {
		entryPoints,
		// outdir + outbase mirror the source tree under outdir:
		// <src>/webgpu/sky.ts -> <outdir>/webgpu/sky.js.
		outdir: outDir,
		outbase: srcDir,
		...baseEsbuildOptions(config),
		// Deduplicate code shared across entry points into chunks instead of
		// inlining a copy into each output -- unless `bundleShared: false` asks
		// for self-contained outputs. Chunking is only expressible for esm
		// output; other formats fall back to (duplicating) inlined output
		// regardless.
		...(config.format === "esm" && config.bundleShared !== false && { splitting: true }),
		// User overrides (escape hatch - e.g. loader: { ".wgsl": "text" }).
		...config.esbuild,
	};

	// Declaration emit is on by default for this target (a library's whole
	// point is consumption); "declarations": false opts out. Prepended so it
	// runs before any user-supplied plugin from the escape hatch.
	if (config.declarations !== false) {
		esbuildConfig.plugins = [
			declarationsPlugin(config, rootDir, { entryPoints, srcDir, outDir }),
			...(esbuildConfig.plugins ?? []),
		];
	}

	try {
		if (options?.watch) {
			// Type-check on every build, initial and rebuild (see typecheckPlugin):
			// build() skips its one-shot gate in watch mode, so the plugin is what
			// covers the watch path. esbuild writes no output for a build whose
			// onStart reports errors, so a rebuild that doesn't type-check can't
			// emit a broken .js tree -- the previous good output stays in place.
			esbuildConfig.plugins = [typecheckPlugin(config, rootDir), ...(esbuildConfig.plugins ?? [])];
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

		return {
			success: result.errors.length === 0,
			outputFiles: result.outputFiles?.map((f) => f.path) ?? [],
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
