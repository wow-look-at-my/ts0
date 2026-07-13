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
//   build-prebuilt/out/esbuild-<os>-<arch>[.exe]  the five platform-native
//       esbuild binaries (the one piece that cannot be platform-neutral),
//       taken from the npm registry tarballs and verified against the
//       package-lock sha512 -- byte-identical to what npm installs.
//   build-prebuilt/out/meta.json                  release metadata for CI's
//       publish step (esbuild version, build id, native file list).
//
// At runtime ts0.cjs fetches its matching native from
// https://dl.pazer.build/ts0/esbuild-<version>?os=..&arch=.. into the cache
// (src/prebuilt/runtime.ts); this script bakes that URL in.
//
// Usage: node --experimental-strip-types scripts/build-prebuilt.ts

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BUILD_ID_PLACEHOLDER = "TS0-PREBUILT-BUILD-ID-PLACEHOLDER-1f2e3d4c";

interface NativeTarget {
	os: "linux" | "darwin" | "windows"; // buildhost os name
	arch: "amd64" | "arm64"; // buildhost arch name
	esbuildPkg: string; // @esbuild/<name>
	esbuildBin: string; // binary subpath inside the package
	outName: string; // filename under build-prebuilt/out/
}

const NATIVE_TARGETS: NativeTarget[] = [
	{ os: "linux", arch: "amd64", esbuildPkg: "@esbuild/linux-x64", esbuildBin: "bin/esbuild", outName: "esbuild-linux-amd64" },
	{ os: "linux", arch: "arm64", esbuildPkg: "@esbuild/linux-arm64", esbuildBin: "bin/esbuild", outName: "esbuild-linux-arm64" },
	{ os: "darwin", arch: "amd64", esbuildPkg: "@esbuild/darwin-x64", esbuildBin: "bin/esbuild", outName: "esbuild-darwin-amd64" },
	{ os: "darwin", arch: "arm64", esbuildPkg: "@esbuild/darwin-arm64", esbuildBin: "bin/esbuild", outName: "esbuild-darwin-arm64" },
	{ os: "windows", arch: "amd64", esbuildPkg: "@esbuild/win32-x64", esbuildBin: "esbuild.exe", outName: "esbuild-windows-amd64.exe" },
];

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
		const dest = join(outDir, t.outName);
		copyFileSync(join(extractDir, "package", t.esbuildBin), dest);
		chmodSync(dest, 0o755);
		console.log(`  native ${t.os}/${t.arch} -> ${dest}`);
	}
}

// embeddedFiles collects the text files inlined into ts0.cjs, keyed by their
// cache-relative extraction path: the pruned typescript package (the tsc CLI
// chain and standard libraries -- typescript.js, tsserver, and the locale
// directories are never loaded) and the fetch-interceptor template.
function embeddedFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	const put = (key: string, from: string): void => {
		files[key] = readFileSync(from, "utf-8");
	};

	put("src/runtime/fetch-interceptor.js", join(repoRoot, "src/runtime/fetch-interceptor.js"));

	const tsDir = dirname(requireLocal.resolve("typescript/package.json"));
	for (const key of ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js"]) {
		put(`node_modules/typescript/${key}`, join(tsDir, key));
	}
	const libFiles = readdirSync(join(tsDir, "lib")).filter((f) => f.startsWith("lib.") && f.endsWith(".d.ts"));
	if (libFiles.length === 0) throw new Error("no lib.*.d.ts found in typescript/lib");
	for (const f of libFiles) put(`node_modules/typescript/lib/${f}`, join(tsDir, "lib", f));

	return files;
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
				natives: NATIVE_TARGETS.map((t) => ({ os: t.os, arch: t.arch, file: t.outName })),
			},
			null,
			"\t",
		),
	);

	const size = (readFileSync(outfile).length / (1024 * 1024)).toFixed(1);
	console.log(`  -> ${outfile} (${size} MiB, build id ${buildId})`);

	// Boot sanity on the host platform: extraction + CLI startup, with the
	// just-staged native supplied via the documented ESBUILD_BINARY_PATH
	// override so this never touches the network. (Full behavior is covered
	// by scripts/prebuilt-smoke.sh.)
	const hostNative = NATIVE_TARGETS.find(
		(t) =>
			(t.os === "linux" && process.platform === "linux" && ((t.arch === "amd64" && process.arch === "x64") || (t.arch === "arm64" && process.arch === "arm64"))) ||
			(t.os === "darwin" && process.platform === "darwin" && ((t.arch === "amd64" && process.arch === "x64") || (t.arch === "arm64" && process.arch === "arm64"))),
	);
	if (hostNative) {
		const sanityCache = join(tmpdir(), `ts0-prebuilt-sanity-${process.pid}`);
		rmSync(sanityCache, { recursive: true, force: true });
		execFileSync(process.execPath, [outfile], {
			stdio: ["ignore", "ignore", "inherit"],
			env: {
				...process.env,
				TS0_CACHE_DIR: sanityCache,
				ESBUILD_BINARY_PATH: join(outDir, hostNative.outName),
			},
		});
		rmSync(sanityCache, { recursive: true, force: true });
		console.log("  boot sanity OK (help ran from a fresh cache)");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
