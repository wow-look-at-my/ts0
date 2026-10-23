import fs from "node:fs/promises";
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
		...(config.cssModules === "construct" && { plugins: [constructCssModules(config.external ?? [])] }),
	};
}

// matchesSpecifier applies the `external` rule: a pattern matches the
// specifier as written, and "*" matches any run of characters.
function matchesSpecifier(pattern: string, specifier: string): boolean {
	const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	return re.test(specifier);
}

// constructCssModules builds each CSS module script import into the output as
// a CSSStyleSheet made from the file's text. An import that `external` lists
// stays a reference, so `external` wins.
export function constructCssModules(external: string[]): esbuild.Plugin {
	const namespace = "ts0-css-module";
	return {
		name: "ts0-css-modules-construct",
		setup(build) {
			build.onResolve({ filter: /.*/ }, async (args) => {
				if (args.with?.type !== "css" || args.pluginData === namespace) return undefined;
				if (external.some((p) => matchesSpecifier(p, args.path))) return undefined;
				const resolved = await build.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: namespace,
				});
				if (resolved.errors.length) return { errors: resolved.errors };
				return { path: resolved.path, namespace };
			});
			build.onLoad({ filter: /.*/, namespace }, async (args) => {
				const css = await fs.readFile(args.path, "utf8");
				return {
					loader: "js",
					contents: `const sheet = new CSSStyleSheet();\nsheet.replaceSync(${JSON.stringify(css)});\nexport default sheet;\n`,
					watchFiles: [args.path],
				};
			});
		},
	};
}
