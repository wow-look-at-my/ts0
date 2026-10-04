import type * as esbuild from "esbuild";
import type { Ts0Config } from "../config.ts";

// baseEsbuildOptions returns the esbuild options shared by the single-entry
// target (build.ts) and the js library target (build-js.ts). Each caller adds
// its own entryPoints and output settings (outfile/outdir/outbase), then
// spreads `config.esbuild` last as the escape hatch. Keeping this in one place
// avoids drift between the two targets (platform, format, jsx threading, …).
export function baseEsbuildOptions(config: Ts0Config): esbuild.BuildOptions {
	return {
		bundle: true,
		// ts0 reports esbuild's errors/warnings itself (formatted, colorized,
		// annotated -- see reporter.ts), from the same `result.errors`/
		// `.warnings` this call already returns. esbuild's own default log level
		// prints a second, uncoordinated copy straight to the terminal; silence
		// that copy so there's exactly one report per diagnostic.
		logLevel: "silent",
		platform: config.target === "node" ? "node" : "browser",
		format: config.format,
		// The IIFE's exports-object global (only meaningful for format
		// "iife"; esbuild ignores it otherwise).
		...(config.globalName && { globalName: config.globalName }),
		minify: config.minify,
		sourcemap: config.sourcemap,
		target: "esnext",
		// Node code has a run-time module resolver, so an imported package stays
		// a `require("pkg")` the installed node_modules answers. bundleDependencies
		// compiles those packages in instead, for an output that must run where
		// its node_modules does not exist. Browser code has no such resolver and
		// always bundles.
		...(config.target === "node" &&
			!config.bundleDependencies && {
				packages: "external",
			}),
		// JSX support (esbuild). Spread before the caller's `config.esbuild` so
		// an explicit esbuild.jsx can still override it.
		...(config.jsx && { jsx: config.jsx }),
		...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		// Custom loaders (e.g. { ".wgsl": "text" }). Spread before the caller's
		// `config.esbuild` so an explicit esbuild.loader can still override.
		...(config.loaders && { loader: config.loaders as { [ext: string]: esbuild.Loader } }),
		// Imports that stay external references in the output: the import
		// statement is emitted verbatim and the target's contents are never
		// pulled in. Shared by both targets, since "this import is resolved at
		// runtime, not at build time" is a property of the code, not of which
		// target compiles it.
		...(config.external?.length && { external: config.external }),
	};
}
