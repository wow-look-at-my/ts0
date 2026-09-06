// build-prebuilt.ts -- packages ts0 for buildhost (dl.pazer.build) as:
//
//   build-prebuilt/out/ts0.cjs                   ONE platform-neutral bundle:
//       the CLI + the esbuild JS API + the TypeScript compiler and standard
//       libraries embedded as strings (extracted to the cache on first run).
//       Runs on stock Node >= 22 with no npm/node_modules, both saved to a
//       file (`node ts0.cjs build`) and piped (`curl ... | node - build`).
//       The .cjs extension is deliberate: the bundle is CommonJS (stdin
//       executes CJS with no flags, which is what keeps the pipe form
//       flagless), and a .js file would be mis-parsed as ESM inside any
//       consumer package declaring "type": "module".
//   build-prebuilt/out/esbuild-<ver>_<os>_<arch>[.exe]  the five platform-native
//       esbuild binaries (the one piece that cannot be platform-neutral),
//       taken from the npm registry tarballs and verified against the
//       package-lock sha512 -- byte-identical to what npm installs.
//   build-prebuilt/out/ts0_cosmo_any               a copy of ts0.cjs named for
//       the stock buildhost-publish action (maps to project "ts0", uploaded
//       under the cosmo/any multi-platform alias).
//   build-prebuilt/out/meta.json                   build metadata (esbuild
//       version, build id, native file list); ignored by the publish action.
//
// At runtime ts0.cjs fetches its matching native from
// https://dl.pazer.build/ts0/esbuild-<version>?os=..&arch=.. into the cache
// (src/prebuilt/runtime.ts); this script bakes that URL in.
//
// Usage: node --experimental-strip-types scripts/build-prebuilt.ts

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const BUILD_ID_PLACEHOLDER = "TS0-PREBUILT-BUILD-ID-PLACEHOLDER-1f2e3d4c";

interface NativeTarget {
	os: "linux" | "darwin" | "windows"; // buildhost os name
	arch: "amd64" | "arm64"; // buildhost arch name
	esbuildPkg: string; // @esbuild/<name>
	esbuildBin: string; // binary subpath inside the package
}

const NATIVE_TARGETS: NativeTarget[] = [
	{ os: "linux", arch: "amd64", esbuildPkg: "@esbuild/linux-x64", esbuildBin: "bin/esbuild" },
	{ os: "linux", arch: "arm64", esbuildPkg: "@esbuild/linux-arm64", esbuildBin: "bin/esbuild" },
	{ os: "darwin", arch: "amd64", esbuildPkg: "@esbuild/darwin-x64", esbuildBin: "bin/esbuild" },
	{ os: "darwin", arch: "arm64", esbuildPkg: "@esbuild/darwin-arm64", esbuildBin: "bin/esbuild" },
	{ os: "windows", arch: "amd64", esbuildPkg: "@esbuild/win32-x64", esbuildBin: "esbuild.exe" },
];

// nativeOutName follows the stock buildhost-publish action's artifact naming
// convention, <binary>_<os>_<arch>[.exe]: the "binary" segment carries the
// esbuild version, so the action publishes the natives to the buildhost
// project ts0/esbuild-<version> -- exactly the project ts0.cjs's baked
// fetch URL addresses.
function nativeOutName(t: NativeTarget, esbuildVersion: string): string {
	return `esbuild-${esbuildVersion}_${t.os}_${t.arch}${t.os === "windows" ? ".exe" : ""}`;
}

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const buildDir = join(repoRoot, "build-prebuilt");
const downloadDir = join(buildDir, "downloads");
const outDir = join(buildDir, "out");
const requireLocal = createRequire(join(repoRoot, "package.json"));

function sh(cmd: string, args: string[]): void {
	execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

function download(url: string, dest: string): void {
	if (existsSync(dest)) return;
	console.log(`  downloading ${url}`);
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = `${dest}.part`;
	sh("curl", ["-fsSL", "--retry", "3", "-o", tmp, url]);
	copyFileSync(tmp, dest);
	rmSync(tmp);
}

// verifyNpmTarball checks a registry tarball against the sha512 integrity
// recorded in package-lock.json for that package -- the same pin `npm ci`
// enforces for the host platform's copy.
function verifyNpmTarball(tarPath: string, pkgName: string): void {
	const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8")) as {
		packages: Record<string, { integrity?: string }>;
	};
	const entry = lock.packages[`node_modules/${pkgName}`];
	if (!entry?.integrity?.startsWith("sha512-")) {
		throw new Error(`no sha512 integrity for ${pkgName} in package-lock.json`);
	}
	const expected = entry.integrity.slice("sha512-".length);
	const actual = createHash("sha512").update(readFileSync(tarPath)).digest("base64");
	if (actual !== expected) {
		rmSync(tarPath);
		throw new Error(`integrity mismatch for ${pkgName} tarball`);
	}
}

function installedVersion(pkg: string): string {
	return (JSON.parse(readFileSync(requireLocal.resolve(`${pkg}/package.json`), "utf-8")) as { version: string }).version;
}

// stageNatives downloads each platform's @esbuild package from the npm
// registry (lock-verified) and places the bare native binary in out/.
function stageNatives(esbuildVersion: string): void {
	for (const t of NATIVE_TARGETS) {
		const bare = t.esbuildPkg.split("/")[1];
		const tarPath = join(downloadDir, `${bare}-${esbuildVersion}.tgz`);
		download(`https://registry.npmjs.org/${t.esbuildPkg}/-/${bare}-${esbuildVersion}.tgz`, tarPath);
		verifyNpmTarball(tarPath, t.esbuildPkg);

		const extractDir = join(downloadDir, `${bare}-${esbuildVersion}`);
		if (!existsSync(join(extractDir, "package", t.esbuildBin))) {
			mkdirSync(extractDir, { recursive: true });
			sh("tar", ["-xzf", tarPath, "-C", extractDir]);
		}
		const dest = join(outDir, nativeOutName(t, esbuildVersion));
		copyFileSync(join(extractDir, "package", t.esbuildBin), dest);
		chmodSync(dest, 0o755);
		console.log(`  native ${t.os}/${t.arch} -> ${dest}`);
	}
}

// TSC_DRIVER is the bin/tsc written into the extracted typescript package.
//
// The npm package ships the compiler TWICE: lib/typescript.js (the API) and
// lib/_tsc.js (the same compiler rebuilt as a CLI, reached via bin/tsc ->
// lib/tsc.js). ts0 needs both capabilities -- the gate spawns the CLI, and
// commands/explicit-any.ts requires the API in-process to parse for explicit
// `any` -- but embedding both files would put ~9 MiB of duplicated compiler
// in ts0.cjs. So only the API is embedded, and bin/tsc becomes this driver,
// which is what lib/_tsc.js does at its own tail: enable the compile cache
// (lib/tsc.js's only job), make stdout blocking so a piped diagnostic dump
// can't be truncated, then hand argv to executeCommandLine. Verified
// identical to the stock CLI on diagnostics text, exit codes, and
// declaration-emit output.
//
// executeCommandLine is exported at runtime but not in typescript.d.ts;
// embeddedFiles asserts it exists at package time, so a TypeScript upgrade
// that moved it fails the build here rather than at a consumer's first run.
const TSC_DRIVER = `#!/usr/bin/env node
// Generated by scripts/build-prebuilt.ts -- stands in for the typescript
// package's own bin/tsc + lib/tsc.js + lib/_tsc.js, which would duplicate the
// compiler already embedded as lib/typescript.js.
try {
	require("node:module").enableCompileCache?.();
} catch {}
const ts = require("../lib/typescript.js");
if (ts.sys.setBlocking) ts.sys.setBlocking();
ts.executeCommandLine(ts.sys, () => {}, ts.sys.args);
`;

// embeddedFiles collects the text files inlined into ts0.cjs, keyed by their
// cache-relative extraction path: the pruned typescript package (the compiler
// API, the standard libraries, and the generated bin/tsc driver above --
// tsserver, the CLI rebuild, and the locale directories are never shipped),
// the whole @types/node package (so a Node-target project type-checks with
// no @types/node install of its own -- see nodeTypeRootsDir in
// commands/build.ts), and the fetch-interceptor template.
function embeddedFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	const put = (key: string, from: string): void => {
		files[key] = readFileSync(from, "utf-8");
	};

	put("src/runtime/fetch-interceptor.js", join(repoRoot, "src/runtime/fetch-interceptor.js"));

	const tsDir = dirname(requireLocal.resolve("typescript/package.json"));
	for (const key of ["package.json", "lib/typescript.js"]) {
		put(`node_modules/typescript/${key}`, join(tsDir, key));
	}
	const ts = requireLocal("typescript") as { executeCommandLine?: unknown };
	if (typeof ts.executeCommandLine !== "function") {
		throw new Error(
			"typescript no longer exports executeCommandLine: the generated bin/tsc driver cannot run the CLI. " +
				"Embed lib/tsc.js + lib/_tsc.js again (and accept the duplicated compiler), or port the driver.",
		);
	}
	files["node_modules/typescript/bin/tsc"] = TSC_DRIVER;

	const libFiles = readdirSync(join(tsDir, "lib")).filter((f) => f.startsWith("lib.") && f.endsWith(".d.ts"));
	if (libFiles.length === 0) throw new Error("no lib.*.d.ts found in typescript/lib");
	for (const f of libFiles) put(`node_modules/typescript/lib/${f}`, join(tsDir, "lib", f));

	const nodeTypesDir = dirname(requireLocal.resolve("@types/node/package.json"));
	const nodeTypesFiles = (readdirSync(nodeTypesDir, { recursive: true }) as string[]).filter(
		(rel) => rel === "package.json" || rel.endsWith(".d.ts"),
	);
	if (nodeTypesFiles.length === 0) throw new Error("no .d.ts found in @types/node");
	const nodeTypesSources: string[] = [];
	for (const rel of nodeTypesFiles) {
		const key = `node_modules/@types/node/${rel.split(sep).join("/")}`;
		put(key, join(nodeTypesDir, rel));
		if (rel.endsWith(".d.ts")) nodeTypesSources.push(files[key]);
	}
	embedTypeDependencies(files, put, nodeTypesSources);

	return files;
}

// embedTypeDependencies stages the packages the embedded declarations import
// from, and every package those import from in turn.
//
// @types/node does not declare the whole platform itself. It imports
// `undici-types` for fetch, and that is where Response, Request and Headers
// live. Embedding @types/node without it leaves a `Response` with no members:
// `(await fetch(url)).ok` becomes "Property 'ok' does not exist on type
// 'Response'", in a project whose only fault is trusting the @types/node ts0
// ships. tsc reports nothing about the missing package, because an unresolved
// type import degrades to a shapeless type rather than an error.
//
// The closure is walked rather than listed, so a dependency added on the next
// version bump is embedded too. A package that cannot be resolved fails the
// packaging here, where the message can say what is missing, instead of
// surfacing as a type error in somebody else's repository.
function embedTypeDependencies(
	files: Record<string, string>,
	put: (key: string, from: string) => void,
	seedSources: string[],
): void {
	const embedded = new Set<string>();
	const pending = packagesImportedBy(seedSources);

	while (pending.size > 0) {
		const name = [...pending][0];
		pending.delete(name);
		if (embedded.has(name)) continue;
		embedded.add(name);

		let pkgDir: string;
		try {
			pkgDir = dirname(requireLocal.resolve(`${name}/package.json`));
		} catch {
			throw new Error(
				`the embedded declarations import "${name}", which is not installed. ` +
					`ts0 would ship types that reference a package no consumer has, and tsc reports that as ` +
					`missing members rather than a missing module. Add it to ts0's dependencies.`,
			);
		}

		const staged: string[] = [];
		for (const rel of readdirSync(pkgDir, { recursive: true }) as string[]) {
			if (rel !== "package.json" && !rel.endsWith(".d.ts")) continue;
			const key = `node_modules/${name}/${rel.split(sep).join("/")}`;
			put(key, join(pkgDir, rel));
			if (rel.endsWith(".d.ts")) staged.push(files[key]);
		}
		if (staged.length === 0) throw new Error(`no .d.ts found in ${name}`);
		for (const next of packagesImportedBy(staged)) pending.add(next);
	}
}

// withoutComments removes block and line comments from declaration text. A
// line comment must open at whitespace or the start of a line, so the `//` in
// a "https://..." string keeps its rest of the line.
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// packagesImportedBy returns the bare package specifiers the given DECLARATION
// sources import, with Node's own builtins left out. A subpath import is
// reduced to the package that owns it, and a `<reference types="x" />` names
// the `@types/x` package that declaration lookup resolves it to.
//
// Hand only .d.ts text to this. JavaScript carries `import("...")` calls with
// runtime arguments, and reading those as package names asks for a package
// nobody ever depended on.
function packagesImportedBy(sources: string[]): Set<string> {
	const names = new Set<string>();
	const add = (specifier: string): void => {
		if (specifier.startsWith(".") || specifier.startsWith("/")) return;
		const parts = specifier.split("/");
		const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
		// Both spellings, because a module reachable only as `node:sqlite` or
		// `node:sea` is still a builtin when @types/node writes it bare.
		if (isBuiltin(name) || isBuiltin(`node:${name}`)) return;
		names.add(name);
	};
	for (const source of sources) {
		// A `<reference types=...>` is itself a comment, so it is read before
		// the comments come out.
		for (const match of source.matchAll(/<reference\s+types\s*=\s*["']([^"']+)["']/g)) add(`@types/${match[1]}`);
		// @types/node's documentation shows imports that no consumer resolves
		// -- `import('napi_addon.node')` in an @example block. Reading those as
		// dependencies would fail the packaging over a code sample.
		const code = withoutComments(source);
		for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) add(match[1]);
		for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1]);
	}
	return names;
}

async function bundle(assetsModuleSource: string): Promise<string> {
	const esbuild = requireLocal("esbuild") as typeof import("esbuild");
	const outfile = join(outDir, "ts0.cjs");
	await esbuild.build({
		entryPoints: [join(repoRoot, "src/prebuilt/main.ts")],
		bundle: true,
		platform: "node",
		// CommonJS: `node -` executes stdin as CJS with no flags, so the
		// pipe form (`curl ... | node - build`) works; ESM would need
		// --input-type=module. The shebang additionally lets a saved,
		// chmod +x'd ts0.cjs run directly.
		format: "cjs",
		target: "node22",
		outfile,
		sourcemap: false,
		logLevel: "warning",
		banner: { js: "#!/usr/bin/env node" },
		// The bundle has no file identity of its own under `node -`
		// (__filename is "[stdin]"), so import.meta.url -- used by build.ts
		// (typescript resolution) and build-html.ts (interceptor lookup) --
		// is redirected to a global that runtime.ts points at the cache dir.
		define: { "import.meta.url": "globalThis.__ts0PrebuiltImportMetaUrl" },
		plugins: [
			{
				name: "prebuilt-assets",
				setup(b) {
					b.onResolve({ filter: /^ts0-prebuilt-assets$/ }, (args) => ({ path: args.path, namespace: "prebuilt-assets" }));
					b.onLoad({ filter: /.*/, namespace: "prebuilt-assets" }, () => ({
						contents: assetsModuleSource,
						loader: "js",
					}));
				},
			},
		],
	});
	return outfile;
}

async function main(): Promise<void> {
	const esbuildVersion = installedVersion("esbuild");
	const tsVersion = installedVersion("typescript");
	console.log(`packaging prebuilt ts0.cjs (typescript ${tsVersion}, esbuild ${esbuildVersion})`);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	mkdirSync(downloadDir, { recursive: true });

	stageNatives(esbuildVersion);

	const assets = {
		buildId: BUILD_ID_PLACEHOLDER,
		esbuildVersion,
		esbuildDlBase: `https://dl.pazer.build/ts0/esbuild-${esbuildVersion}`,
		files: embeddedFiles(),
	};
	const outfile = await bundle(`export default ${JSON.stringify(assets)};`);

	// The build id names the extraction cache dir; it covers the entire
	// bundle (CLI code, embedded compiler bytes) plus the dependency
	// versions, so ANY change extracts fresh and upgrades never collide.
	const bundled = readFileSync(outfile, "utf-8");
	if (!bundled.includes(BUILD_ID_PLACEHOLDER)) {
		throw new Error("build id placeholder missing from bundle");
	}
	const buildId = createHash("sha256")
		.update(`ts0-prebuilt\0${tsVersion}\0${esbuildVersion}\0`)
		.update(bundled)
		.digest("hex")
		.slice(0, 16);
	writeFileSync(outfile, bundled.replaceAll(BUILD_ID_PLACEHOLDER, buildId));

	writeFileSync(
		join(outDir, "meta.json"),
		JSON.stringify(
			{
				buildId,
				esbuildVersion,
				tsVersion,
				natives: NATIVE_TARGETS.map((t) => ({ os: t.os, arch: t.arch, file: nativeOutName(t, esbuildVersion) })),
			},
			null,
			"\t",
		),
	);

	// The stock buildhost-publish action discovers artifacts by the
	// <binary>_<os>_<arch> naming convention; ts0_cosmo_any maps to project
	// "ts0" uploaded once under buildhost's cosmo/any multi-platform alias
	// (one stored body, downloadable under every os/arch pair). ts0.cjs
	// stays alongside for the smoke scripts and local use; the action
	// ignores it (no _os_arch suffix).
	copyFileSync(outfile, join(outDir, "ts0_cosmo_any"));

	const size = (readFileSync(outfile).length / (1024 * 1024)).toFixed(1);
	console.log(`  -> ${outfile} (${size} MiB, build id ${buildId})`);

	// Boot sanity on the host platform: extraction, CLI startup, and a real
	// type-check through the generated bin/tsc driver -- the piece this
	// script owns, so a TypeScript upgrade that breaks it fails at package
	// time rather than at a consumer's first run. The just-staged native is
	// supplied via the documented ESBUILD_BINARY_PATH override so this never
	// touches the network. (Full behavior is covered by
	// scripts/prebuilt-smoke.sh.)
	const hostNative = NATIVE_TARGETS.find(
		(t) =>
			(t.os === "linux" && process.platform === "linux" && ((t.arch === "amd64" && process.arch === "x64") || (t.arch === "arm64" && process.arch === "arm64"))) ||
			(t.os === "darwin" && process.platform === "darwin" && ((t.arch === "amd64" && process.arch === "x64") || (t.arch === "arm64" && process.arch === "arm64"))),
	);
	if (hostNative) {
		const sanityCache = join(tmpdir(), `ts0-prebuilt-sanity-${process.pid}`);
		const sanityProj = join(tmpdir(), `ts0-prebuilt-sanity-proj-${process.pid}`);
		rmSync(sanityCache, { recursive: true, force: true });
		rmSync(sanityProj, { recursive: true, force: true });
		const env = {
			...process.env,
			TS0_CACHE_DIR: sanityCache,
			ESBUILD_BINARY_PATH: join(outDir, nativeOutName(hostNative, esbuildVersion)),
		};
		execFileSync(process.execPath, [outfile], { stdio: ["ignore", "ignore", "inherit"], env });

		mkdirSync(join(sanityProj, "src"), { recursive: true });
		writeFileSync(join(sanityProj, "ts0.json"), '{ "entry": "src/main.ts", "target": "node", "format": "esm" }\n');
		writeFileSync(join(sanityProj, "src/main.ts"), 'export const n: number = "nope";\n');
		let diagnostics = "";
		try {
			// Both streams captured: this failure is the expected outcome, so
			// it must not look like a packaging error in the log.
			execFileSync(process.execPath, [outfile, "build"], {
				cwd: sanityProj,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
			throw new Error("sanity: the prebuilt built a project with a type error");
		} catch (err) {
			const failure = err as { stdout?: string; stderr?: string };
			diagnostics = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
		}
		// The exact tsc diagnostic proves the driver ran the real compiler --
		// not that the build merely failed for some other reason.
		if (!diagnostics.includes("TS2322")) {
			throw new Error(`sanity: no tsc diagnostic from the generated bin/tsc driver:\n${diagnostics}`);
		}
		writeFileSync(join(sanityProj, "src/main.ts"), "export const n: number = 1;\n");
		execFileSync(process.execPath, [outfile, "build"], { cwd: sanityProj, stdio: ["ignore", "ignore", "inherit"], env });
		if (!existsSync(join(sanityProj, "dist", "main.js"))) {
			throw new Error("sanity: a clean project produced no output");
		}
		rmSync(sanityCache, { recursive: true, force: true });
		rmSync(sanityProj, { recursive: true, force: true });
		console.log("  boot sanity OK (fresh cache: help, tsc diagnostics via the driver, clean build)");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
