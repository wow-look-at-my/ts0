import type * as esbuild from "esbuild";
import type { Ts0Config } from "../config.ts";

// baseEsbuildOptions returns the esbuild options shared by the single-entry
// target (build.ts) and the js library target (build-js.ts). Each caller adds
// its own entryPoints and output settings (outfile/outdir/outbase), then
// spreads `config.esbuild` last as the escape hatch. Keeping this in one place
// avoids drift between both targets (platform, format, jsx threading, …).
export function baseEsbuildOptions(config: Ts0Config): esbuild.BuildOptions {
	return {
		bundle: true,
		// ts0 reports esbuild's errors/warnings itself (formatted, colorized, annotated -- see reporter.ts), from the same `result.errors`/ `.warnings` this call already returns. esbuild's own default log level prints a second.
		logLevel: "silent",
		platform: config.target === "node" ? "node" : "browser",
		format: config.format,
		// The IIFE's exports-object global (only meaningful for format "iife"; esbuild ignores it otherwise).
		...(config.globalName && { globalName: config.globalName }),
		minify: config.minify,
		sourcemap: config.sourcemap,
		target: "esnext",
		// Node code has a run-time module resolver, so an imported package stays a
		// `require("pkg")` the installed node_modules answers.
		...(config.target === "node" &&
			!config.bundleDependencies && {
				packages: "external",
			}),
		// JSX support (esbuild).
		...(config.jsx && { jsx: config.jsx }),
		...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		// Custom loaders (e.g. { ".wgsl": "text" }).
		...(config.loaders && { loader: config.loaders as { [ext: string]: esbuild.Loader } }),
		// Imports that stay external references in the output.
		...(config.external?.length && { external: config.external }),
	};
}
