import * as esbuild from "esbuild";
import { join, resolve, extname } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import type { Ts0Config } from "../config.ts";
import type { BuildResult } from "./build.ts";

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

// buildJs compiles a directory of TypeScript modules into a parallel tree of
// ESM JavaScript under outdir. Each source file is its own esbuild entry point
// (no cross-module entry splitting), so a consumer can import any single output
// module by URL and get a self-contained file with its local dependencies and
// any loader-backed imports (e.g. .wgsl text) inlined. This is the shape a
// library deployed to static hosting (GitHub Pages, a CDN) wants.
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
		bundle: true,
		platform: config.target === "node" ? "node" : "browser",
		format: config.format,
		minify: config.minify,
		sourcemap: config.sourcemap,
		target: "esnext",
		// Node-specific settings: keep node_modules out of the bundle.
		...(config.target === "node" && {
			packages: "external",
		}),
		// JSX support (esbuild). Threaded before the escape hatch so an
		// explicit esbuild.jsx can still override it.
		...(config.jsx && { jsx: config.jsx }),
		...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		// User overrides (e.g. loader: { ".wgsl": "text" }).
		...config.esbuild,
	};

	try {
		if (options?.watch) {
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
			errors: result.errors.map((e) => e.text),
			duration: performance.now() - startTime,
		};
	} catch (err) {
		const error = err as esbuild.BuildFailure;
		return {
			success: false,
			outputFiles: [],
			errors: error.errors?.map((e) => e.text) || [String(err)],
			duration: performance.now() - startTime,
		};
	}
}
