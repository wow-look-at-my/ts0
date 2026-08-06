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
		platform: config.target === "node" ? "node" : "browser",
		format: config.format,
		// The IIFE's exports-object global (only meaningful for format
		// "iife"; esbuild ignores it otherwise).
		...(config.globalName && { globalName: config.globalName }),
		minify: config.minify,
		sourcemap: config.sourcemap,
		target: "esnext",
		// Node-specific: keep node_modules out of the bundle.
		...(config.target === "node" && {
			packages: "external",
		}),
		// JSX support (esbuild). Spread before the caller's `config.esbuild` so
		// an explicit esbuild.jsx can still override it.
		...(config.jsx && { jsx: config.jsx }),
		...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		// Custom loaders (e.g. { ".wgsl": "text" }). Spread before the caller's
		// `config.esbuild` so an explicit esbuild.loader can still override.
		...(config.loaders && { loader: config.loaders as { [ext: string]: esbuild.Loader } }),
	};
}
