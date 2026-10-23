import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync, watch as fsWatch } from "node:fs";
import { dirname, resolve, basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ts0Config } from "../config.ts";
import type { BuildResult } from "./build.ts";
import { formatEsbuildDiagnostic } from "../reporter.ts";

// Loaders applied when bundling CSS, so that url(./fonts/foo.woff2) and
// url(./img/bar.png) get embedded as data: URLs instead of left as relative
// paths that 404 in a single-file bundle. esbuild walks the imported CSS
// graph and rewrites these references in the output.
const CSS_ASSET_LOADERS: Record<string, esbuild.Loader> = {
	".css": "css",
	".woff2": "dataurl",
	".woff": "dataurl",
	".ttf": "dataurl",
	".otf": "dataurl",
	".eot": "dataurl",
	".png": "dataurl",
	".jpg": "dataurl",
	".jpeg": "dataurl",
	".gif": "dataurl",
	".webp": "dataurl",
	".svg": "dataurl",
};

// Extensions whose contents we'll embed for the runtime fetch interceptor.
// Text assets are inlined as JSON strings; binary assets as data: URLs that
// the browser decodes back into an ArrayBuffer when the interceptor's
// fall-through fetch hits them.
//
// .json is intentionally NOT here: it's a common config-file extension
// (ts0.json, package.json) and embedding those is never desired. Users
// fetching runtime JSON should either rename the extension or use
// esbuild's import-assertion JSON loader from JS code.
const TEXT_ASSET_EXTS = new Set([".glsl", ".wgsl", ".vert", ".frag", ".txt", ".xml"]);
const BINARY_ASSET_EXTS = new Set([".hdr", ".glb", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bin"]);

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".hdr": "application/octet-stream",
	".glb": "model/gltf-binary",
	".bin": "application/octet-stream",
};

// Two candidate locations for the runtime template:
//   - src/commands/build-html.ts → ../runtime/fetch-interceptor.js (running
//     from source, via --experimental-strip-types)
//   - dist/ts0 → ../src/runtime/fetch-interceptor.js (running from the
//     bundled binary, with the source tree shipped alongside it via the
//     package.json "files" field)
const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveInterceptorPath(): string {
	const candidates = [
		resolve(__dirname, "../runtime/fetch-interceptor.js"),
		resolve(__dirname, "../src/runtime/fetch-interceptor.js"),
	];
	for (const p of candidates) if (existsSync(p)) return p;
	throw new Error(
		`ts0: fetch-interceptor.js not found. Looked in:\n  ${candidates.join("\n  ")}`,
	);
}

export function isHtmlEntry(entry: string | undefined): boolean {
	return !!entry && entry.toLowerCase().endsWith(".html");
}

export async function buildHtml(
	config: Ts0Config,
	rootDir: string,
	options?: { watch?: boolean; typecheck?: () => Promise<{ success: boolean; output: string }> },
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

	const htmlPath = resolve(rootDir, config.entry);
	const htmlSourceDir = dirname(htmlPath);

	const outFile = config.outfile
		? resolve(rootDir, config.outfile)
		: resolve(rootDir, config.outdir || "dist", basename(config.entry));

	const buildOnce = async (): Promise<{ errors: string[]; outputs: string[] }> => {
		// In watch mode build() can't gate up front (later rebuilds would slip
		// past), so it hands us the type-check to run before each rebuild. If it
		// fails we report the errors and write nothing -- the previous good
		// output stays in place. Non-watch builds are already gated by build()
		// and pass no typecheck here.
		if (options?.typecheck) {
			const check = await options.typecheck();
			if (!check.success) {
				return { errors: [`Type-checking failed:\n${check.output}`], outputs: [] };
			}
		}
		const html = readFileSync(htmlPath, "utf-8");
		const result = await processHtml(html, htmlSourceDir, rootDir, config, dirname(outFile));
		// Nothing is written when the pass had errors: a new HTML pointing at
		// bundles that were never emitted (or stale bundles beside a new shell)
		// is worse than leaving the previous good output in place.
		if (result.errors.length) return { errors: result.errors, outputs: [] };
		for (const asset of result.assets) {
			mkdirSync(dirname(asset.path), { recursive: true });
			writeFileSync(asset.path, asset.contents);
		}
		mkdirSync(dirname(outFile), { recursive: true });
		writeFileSync(outFile, result.html);
		return { errors: [], outputs: [outFile, ...result.assets.map((a) => a.path)] };
	};

	if (options?.watch) {
		const initial = await buildOnce();
		if (initial.errors.length) {
			initial.errors.forEach((e) => console.error(`	${e}`));
		} else {
			console.log(`Wrote ${outFile}`);
		}

		const watcher = fsWatch(rootDir, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			if (filename.startsWith("dist/") || filename.startsWith("node_modules/")) return;
			const ext = extname(filename).toLowerCase();
			if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html"].includes(ext)) return;
			rebuild(buildOnce, filename);
		});

		process.on("SIGINT", () => {
			watcher.close();
			process.exit(0);
		});

		console.log("Watching for changes...");
		return {
			success: true,
			outputFiles: initial.outputs,
			errors: [],
			duration: performance.now() - startTime,
		};
	}

	const { errors, outputs } = await buildOnce();

	return {
		success: errors.length === 0,
		outputFiles: outputs,
		errors,
		duration: performance.now() - startTime,
	};
}

let rebuildPending = false;
async function rebuild(
	buildOnce: () => Promise<{ errors: string[]; outputs: string[] }>,
	filename: string,
): Promise<void> {
	if (rebuildPending) return;
	rebuildPending = true;
	// Coalesce rapid changes from editors that write multiple times
	setTimeout(async () => {
		rebuildPending = false;
		try {
			const start = performance.now();
			const { errors } = await buildOnce();
			const ms = (performance.now() - start).toFixed(0);
			if (errors.length) {
				console.error(`Rebuild failed (${filename}):`);
				errors.forEach((e) => console.error(`	${e}`));
			} else {
				console.log(`Rebuilt in ${ms}ms (${filename})`);
			}
		} catch (err) {
			console.error(err);
		}
	}, 50);
}

interface EmittedAsset {
	path: string;
	contents: Uint8Array;
}

interface ProcessResult {
	html: string;
	errors: string[];
	// Files the caller must write alongside the HTML. Always empty in inline
	// mode (inlineAssets defaults to true).
	assets: EmittedAsset[];
}

// Output basename for a referenced source: its own basename with the bundled
// extension (src/main.ts -> main.js). Deterministic and hash-free -- the
// serving side owns cache headers and ETags.
function assetOutputName(sourcePath: string, ext: string): string {
	return basename(sourcePath).replace(/\.[^.]*$/, "") + ext;
}

async function processHtml(
	html: string,
	sourceDir: string,
	rootDir: string,
	config: Ts0Config,
	outDir: string,
): Promise<ProcessResult> {
	const errors: string[] = [];
	const replacements: Array<{ match: string; replacement: string }> = [];
	const assets: EmittedAsset[] = [];

	// Referenced mode: every referenced script/stylesheet is bundled to its own
	// file under assetPath and the tag keeps pointing at it. assetPath is the
	// URL prefix verbatim; the same string without a leading `/` or `./` is the
	// subdirectory under the HTML's output directory.
	const referenced = config.inlineAssets === false;
	const assetUrlPrefix = (config.assetPath ?? "assets").replace(/\/+$/, "");
	const assetDir = resolve(outDir, assetUrlPrefix.replace(/^(?:\.?\/)+/, ""));

	// Output path -> the source that claimed it. Two sources with the same
	// basename want the same output file; that is an error naming both, never a
	// silent overwrite and never an invented suffix.
	const assetOwners = new Map<string, string>();
	const claimAsset = (name: string, source: string): string | null => {
		const path = join(assetDir, name);
		const owner = assetOwners.get(path);
		if (owner) {
			errors.push(
				`${relative(rootDir, owner)} and ${relative(rootDir, source)} both bundle to "${name}" under assetPath "${assetUrlPrefix}" -- rename one of them.`,
			);
			return null;
		}
		assetOwners.set(path, source);
		return path;
	};
	// Every output file, not just the first: an entry that imports CSS makes
	// esbuild emit a companion .css beside the JS, and dropping it ships an
	// unstyled page.
	const collectOutputs = (files: esbuild.OutputFile[] | undefined, source: string): void => {
		for (const file of files ?? []) {
			const owner = assetOwners.get(file.path);
			if (owner && owner !== source) {
				errors.push(
					`${relative(rootDir, owner)} and ${relative(rootDir, source)} both write "${basename(file.path)}" under assetPath "${assetUrlPrefix}" -- rename one of them.`,
				);
				continue;
			}
			assetOwners.set(file.path, source);
			assets.push({ path: file.path, contents: file.contents });
		}
	};

	// <script ...>...</script> — three cases handled below:
	//   1. <script src="local.js"> — bundle the file at src.
	//   2. <script type="module">...inline code...</script> — bundle the
	//      inline body via esbuild stdin so relative imports resolve.
	//   3. <script src="https://..."> or inline classic <script> — leave
	//      alone. (Classic inline scripts already work as-is in a bundle.)
	const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	for (const match of html.matchAll(scriptRe)) {
		const [fullMatch, attrStr, inlineBody] = match;
		const attrs = parseAttrs(attrStr);
		const isModule = (attrs.type || "").toLowerCase() === "module";

		const buildOpts: esbuild.BuildOptions = {
			bundle: true,
			platform: "browser",
			format: isModule ? "esm" : "iife",
			minify: config.minify,
			sourcemap: config.sourcemap ? "inline" : false,
			target: "esnext",
			write: false,
			logLevel: "silent",
			// JSX support (esbuild). Without this an .tsx/.jsx script entry
			// falls back to esbuild's default classic transform
			// (React.createElement), which breaks Preact/automatic-runtime
			// projects with "React is not defined". Threaded before the
			// escape hatch so an explicit esbuild.jsx can still override it.
			...(config.jsx && { jsx: config.jsx }),
			...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
		};

		let entryDescription: string;
		let referencedName: string | null = null;
		if (attrs.src) {
			if (isExternal(attrs.src)) continue;
			entryDescription = resolve(sourceDir, attrs.src);
			buildOpts.entryPoints = [entryDescription];
			if (referenced) {
				referencedName = assetOutputName(entryDescription, ".js");
				// esbuild is told the real output path rather than being asked
				// for bytes we place ourselves: companion files (a .css emitted
				// for an entry that imports CSS) are only named correctly when
				// it knows where the entry lands.
				const outPath = claimAsset(referencedName, entryDescription);
				if (!outPath) continue;
				buildOpts.outfile = outPath;
			}
		} else if (isModule && inlineBody.trim()) {
			entryDescription = "<inline module>";
			buildOpts.stdin = {
				contents: inlineBody,
				resolveDir: sourceDir,
				sourcefile: "inline.js",
				loader: "js",
			};
		} else {
			continue;
		}

		try {
			const result = await esbuild.build({ ...buildOpts, ...config.esbuild });

			if (result.errors.length > 0) {
				errors.push(...result.errors.map((e) => formatEsbuildMessage(e)));
				continue;
			}

			if (referencedName) {
				collectOutputs(result.outputFiles, entryDescription);
				const rewritten = { ...attrs, src: `${assetUrlPrefix}/${referencedName}` };
				replacements.push({
					match: fullMatch,
					replacement: `<script ${formatAttrs(rewritten)}>${inlineBody}</script>`,
				});
				continue;
			}

			const code = result.outputFiles?.[0]?.text ?? "";
			const remainingAttrs = { ...attrs };
			delete remainingAttrs.src;
			const attrPart = formatAttrs(remainingAttrs);
			const opening = attrPart ? `<script ${attrPart}>` : `<script>`;
			replacements.push({
				match: fullMatch,
				replacement: `${opening}${escapeForScript(code)}</script>`,
			});
		} catch (err) {
			errors.push(formatBuildError(err, entryDescription));
		}
	}

	// <link rel="stylesheet" href="...">
	const linkRe = /<link\b([^>]*?)\/?>/gi;
	for (const match of html.matchAll(linkRe)) {
		const [fullMatch, attrStr] = match;
		const attrs = parseAttrs(attrStr);
		if ((attrs.rel || "").toLowerCase() !== "stylesheet") continue;
		if (!attrs.href) continue;
		if (isExternal(attrs.href)) continue;

		const filePath = resolve(sourceDir, attrs.href);

		let referencedName: string | null = null;
		let outfile: string | undefined;
		if (referenced) {
			referencedName = assetOutputName(filePath, ".css");
			const outPath = claimAsset(referencedName, filePath);
			if (!outPath) continue;
			outfile = outPath;
		}

		try {
			const result = await esbuild.build({
				entryPoints: [filePath],
				bundle: true,
				minify: config.minify,
				sourcemap: false,
				target: "esnext",
				write: false,
				logLevel: "silent",
				loader: CSS_ASSET_LOADERS,
				...(outfile && { outfile }),
				...config.esbuild,
			});

			if (result.errors.length > 0) {
				errors.push(...result.errors.map((e) => formatEsbuildMessage(e)));
				continue;
			}

			if (referencedName) {
				collectOutputs(result.outputFiles, filePath);
				const rewritten = { ...attrs, href: `${assetUrlPrefix}/${referencedName}` };
				const selfClosing = /\/\s*>$/.test(fullMatch);
				replacements.push({
					match: fullMatch,
					replacement: `<link ${formatAttrs(rewritten)}${selfClosing ? " /" : ""}>`,
				});
				continue;
			}

			const css = result.outputFiles?.[0]?.text ?? "";
			const remainingAttrs = { ...attrs };
			delete remainingAttrs.rel;
			delete remainingAttrs.href;
			delete remainingAttrs.type;
			const attrPart = formatAttrs(remainingAttrs);
			const opening = attrPart ? `<style ${attrPart}>` : `<style>`;
			replacements.push({
				match: fullMatch,
				replacement: `${opening}${escapeForStyle(css)}</style>`,
			});
		} catch (err) {
			errors.push(formatBuildError(err, filePath));
		}
	}

	// Bookmarklet links: an href of the form `javascript:<local source file>`
	// (e.g. <a href="javascript:./src/tool.ts">) gets the referenced file
	// bundled and substituted in as a real bookmarklet URL --
	// `javascript:` + the percent-encoded bundle. Only hrefs whose remainder
	// ends in a bundleable source extension are treated as file references;
	// actual inline JavaScript hrefs (javascript:void(0), ...) are left
	// untouched. The bundle is always minified regardless of config.minify: a
	// bookmarklet is a URL, and its length is the constraint that matters.
	const bookmarkletSrcRe = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
	const bookmarkletRe = /(href\s*=\s*)(["'])javascript:([^"']+)\2/gi;
	for (const match of html.matchAll(bookmarkletRe)) {
		const [fullMatch, prefix, quote, ref] = match;
		if (!bookmarkletSrcRe.test(ref)) continue;
		const filePath = resolve(sourceDir, ref);
		if (!existsSync(filePath)) {
			errors.push(`${ref}: bookmarklet href references a missing file (resolved to ${filePath})`);
			continue;
		}

		try {
			const result = await esbuild.build({
				entryPoints: [filePath],
				bundle: true,
				platform: "browser",
				format: "iife",
				minify: true,
				sourcemap: false,
				target: "esnext",
				write: false,
				logLevel: "silent",
				...(config.jsx && { jsx: config.jsx }),
				...(config.jsxImportSource && { jsxImportSource: config.jsxImportSource }),
				...config.esbuild,
			});

			if (result.errors.length > 0) {
				errors.push(...result.errors.map((e) => formatEsbuildMessage(e)));
				continue;
			}

			const code = (result.outputFiles?.[0]?.text ?? "").trim();
			// encodeURIComponent escapes every character that could terminate
			// the attribute or the URL (quotes, &, #, whitespace), so the
			// encoded bundle is attribute-safe as-is.
			replacements.push({
				match: fullMatch,
				replacement: `${prefix}${quote}javascript:${encodeURIComponent(code)}${quote}`,
			});
		} catch (err) {
			errors.push(formatBuildError(err, filePath));
		}
	}

	let result = html;
	for (const { match, replacement } of replacements) {
		result = result.replace(match, () => replacement);
	}

	// Inject the runtime fetch interceptor. Off if explicitly disabled, or
	// if no embeddable assets exist next to the entry — keeps trivial HTML
	// samples (no shaders, no HDR) byte-identical to pre-feature output.
	if (config.embedAssets !== false) {
		const embedded = config.assetDirs
			? collectAssetsFromDirs(rootDir, config.assetDirs)
			: collectAssets(sourceDir);
		if (Object.keys(embedded.text).length || Object.keys(embedded.binary).length) {
			result = injectFetchInterceptor(result, embedded);
		}
	}

	return { html: result, errors, assets };
}

interface AssetMap {
	text: Record<string, string>;
	binary: Record<string, string>; // value is a data: URL
}

function collectAssets(sourceDir: string): AssetMap {
	const text: Record<string, string> = {};
	const binary: Record<string, string> = {};

	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				walk(p);
				continue;
			}
			const ext = extname(name).toLowerCase();
			const rel = relative(sourceDir, p).split(/[\\/]/).join("/");
			if (TEXT_ASSET_EXTS.has(ext)) {
				text[rel] = readFileSync(p, "utf-8");
			} else if (BINARY_ASSET_EXTS.has(ext)) {
				const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
				binary[rel] = `data:${mime};base64,${readFileSync(p).toString("base64")}`;
			}
		}
	};

	walk(sourceDir);
	return { text, binary };
}

function collectAssetsFromDirs(rootDir: string, assetDirs: string[]): AssetMap {
	const text: Record<string, string> = {};
	const binary: Record<string, string> = {};
	const realRoot = realpathSync(rootDir);

	const walk = (dir: string, baseDir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				walk(p, baseDir);
				continue;
			}
			const ext = extname(name).toLowerCase();
			const rel = relative(baseDir, p).split(/[\\/]/).join("/");
			if (TEXT_ASSET_EXTS.has(ext)) {
				text[rel] = readFileSync(p, "utf-8");
			} else if (BINARY_ASSET_EXTS.has(ext)) {
				const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
				binary[rel] = `data:${mime};base64,${readFileSync(p).toString("base64")}`;
			}
		}
	};

	for (const dir of assetDirs) {
		const resolved = resolve(rootDir, dir);
		const real = realpathSync(resolved);
		if (!real.startsWith(realRoot + "/") && real !== realRoot) {
			throw new Error(`ts0: assetDirs entry "${dir}" resolves outside the project root`);
		}
		if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
			throw new Error(`ts0: assetDirs entry "${dir}" is not a directory`);
		}
		walk(resolved, rootDir);
	}

	return { text, binary };
}

function injectFetchInterceptor(html: string, assets: AssetMap): string {
	const template = readFileSync(resolveInterceptorPath(), "utf-8");
	// Defensively escape sequences that could end the host <script> tag if
	// a shader or other asset ever contained them. JSON's escaped forward
	// slash is legal everywhere, so this stays valid JS.
	const payload = JSON.stringify(assets).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
	const script = `<script>\n${template.replaceAll("__ASSETS_JSON__", payload)}</script>\n`;

	const headOpen = /<head\b[^>]*>/i.exec(html);
	if (headOpen) {
		const insertAt = headOpen.index + headOpen[0].length;
		return html.slice(0, insertAt) + "\n" + script + html.slice(insertAt);
	}
	// No <head>? Prepend at the top so it still installs before any other
	// script runs.
	return script + html;
}

function isExternal(url: string): boolean {
	return /^(?:[a-z]+:|\/\/)/i.test(url);
}

function parseAttrs(attrStr: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attrStr)) !== null) {
		const [, name, dq, sq, uq] = m;
		attrs[name.toLowerCase()] = dq ?? sq ?? uq ?? "";
	}
	return attrs;
}

function formatAttrs(attrs: Record<string, string>): string {
	return Object.entries(attrs)
		.map(([k, v]) => (v === "" ? k : `${k}="${escapeAttr(v)}"`))
		.join(" ");
}

function escapeAttr(v: string): string {
	return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Prevent embedded JS from prematurely closing the script tag.
function escapeForScript(code: string): string {
	return code.replace(/<\/script/gi, "<\\/script");
}

// Prevent embedded CSS content from closing the style tag.
function escapeForStyle(css: string): string {
	return css.replace(/<\/style/gi, "<\\/style");
}

// Same tsc-style shape formatEsbuildDiagnostic produces for the other
// targets, so reporter.ts's colorizeErrorBlock can find a file/line to
// annotate in an HTML build's errors too, not just the default target's.
function formatEsbuildMessage(msg: esbuild.Message): string {
	return formatEsbuildDiagnostic(msg, "error");
}

function formatBuildError(err: unknown, filePath: string): string {
	const e = err as esbuild.BuildFailure & { message?: string };
	if (e.errors?.length) {
		return e.errors.map(formatEsbuildMessage).join("\n");
	}
	return `${filePath}: ${e.message ?? String(err)}`;
}
