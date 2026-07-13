// Runtime support for the prebuilt ts0.cjs bundle (see src/prebuilt/main.ts
// and scripts/build-prebuilt.ts). Everything here must work when the bundle
// is piped into `node -` as well as run from a saved file: NOTHING may
// depend on the bundle's own location (__filename is "[stdin]" under a
// pipe), so all paths derive from the cache directory -- $TS0_CACHE_DIR or
// ~/.cache/ts0 -- plus constants baked into the bundle at package time.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

export interface PrebuiltAssets {
	buildId: string;
	esbuildVersion: string;
	esbuildDlBase: string;
	files: Record<string, string>;
}

const EXTRACT_MARKER = ".ts0-extracted";

interface PrebuiltGlobals {
	__ts0PrebuiltImportMetaUrl?: string;
}

function cacheRoot(): string {
	const override = process.env.TS0_CACHE_DIR;
	if (override && override.length > 0) return override;
	return join(homedir(), ".cache", "ts0");
}

// prepareCache extracts the embedded files (the pruned typescript package
// and the interceptor template) into <cacheRoot>/<buildId>/ in an
// installed-ts0 layout, then points the bundle's module resolution there:
// the packaging script rewrites every `import.meta.url` in the bundle to
// `globalThis.__ts0PrebuiltImportMetaUrl`, which is set here to
// <dir>/dist/ts0 -- so build.ts's createRequire(...).resolve("typescript/
// bin/tsc") finds <dir>/node_modules/typescript, and build-html.ts's
// ../src/runtime/fetch-interceptor.js candidate finds the extracted
// template, with no source changes.
//
// Extraction is atomic (write a temp sibling, rename into place); a crashed
// or concurrent extraction can never yield a half-populated directory that
// later runs would trust, and the rename loser of a race just uses the
// winner's directory.
export function prepareCache(assets: PrebuiltAssets): string {
	const root = cacheRoot();
	const dir = join(root, assets.buildId);
	const marker = join(dir, EXTRACT_MARKER);
	if (!existsSync(marker)) {
		const tmp = join(root, `.tmp-${assets.buildId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		try {
			for (const [key, content] of Object.entries(assets.files)) {
				const target = join(tmp, ...key.split("/"));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, content);
			}
			writeFileSync(join(tmp, EXTRACT_MARKER), assets.buildId);
			try {
				renameSync(tmp, dir);
			} catch {
				// The target exists: another process won the race (marker
				// present -- use theirs) or a previous extraction crashed
				// mid-write (no marker -- replace it and try once more).
				if (!existsSync(marker)) {
					rmSync(dir, { recursive: true, force: true });
					renameSync(tmp, dir);
				}
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		if (!existsSync(marker)) {
			throw new Error(`ts0: failed to extract the embedded toolchain to ${dir}`);
		}
	}
	(globalThis as PrebuiltGlobals).__ts0PrebuiltImportMetaUrl = pathToFileURL(join(dir, "dist", "ts0")).href;
	return dir;
}

// platformKeys maps the running platform to buildhost's os/arch download
// parameters, failing with a clear message on anything unsupported.
function platformKeys(): { os: string; arch: string } {
	const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform as string];
	const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
	if (!os || !arch) {
		throw new Error(
			`ts0: no prebuilt esbuild binary for ${process.platform}/${process.arch}. ` +
				`Supported: linux/darwin/windows on x64/arm64. ` +
				`Set ESBUILD_BINARY_PATH to a local esbuild binary to override.`,
		);
	}
	return { os, arch };
}

// ensureEsbuildBinary makes esbuild's platform-native binary available and
// points the bundled esbuild JS API at it via ESBUILD_BINARY_PATH. The
// binary is the ONE piece of ts0 that cannot live inside a platform-neutral
// ts0.cjs; it is fetched once from buildhost (a ~11 MB sibling artifact of
// this release, byte-identical to the npm registry's @esbuild package) into
// the cache, atomically, and reused forever after.
//
// MUST complete before the CLI (and therefore the esbuild module) loads:
// esbuild's JS API snapshots process.env.ESBUILD_BINARY_PATH at module load
// time, and with the API bundled there is no node_modules fallback.
export async function ensureEsbuildBinary(assets: PrebuiltAssets, cacheDir: string): Promise<void> {
	const existing = process.env.ESBUILD_BINARY_PATH;
	if (existing && existing.length > 0 && existsSync(existing)) {
		return; // explicit user override wins
	}
	const bin = join(cacheDir, "esbuild", process.platform === "win32" ? "esbuild.exe" : "esbuild");
	if (!existsSync(bin)) {
		await downloadEsbuild(assets, bin);
	}
	process.env.ESBUILD_BINARY_PATH = bin;
}

async function downloadEsbuild(assets: PrebuiltAssets, bin: string): Promise<void> {
	const { os, arch } = platformKeys();
	const url = process.env.TS0_ESBUILD_URL || `${assets.esbuildDlBase}?os=${os}&arch=${arch}`;
	const fail = (detail: string): Error =>
		new Error(
			`ts0: failed to download the esbuild native binary (${detail})\n` +
				`  url:  ${url}\n` +
				`  dest: ${bin}\n` +
				`The prebuilt ts0.cjs needs this one platform-native piece on first run. ` +
				`Check network access, set TS0_ESBUILD_URL to a mirror of esbuild ${assets.esbuildVersion} ` +
				`for ${os}/${arch}, or place the binary at the destination path yourself.`,
		);

	let resp: Response;
	try {
		resp = await fetch(url, { redirect: "follow" });
	} catch (err) {
		throw fail(err instanceof Error ? err.message : String(err));
	}
	if (!resp.ok) throw fail(`HTTP ${resp.status}`);
	const bytes = Buffer.from(await resp.arrayBuffer());

	mkdirSync(dirname(bin), { recursive: true });
	const tmp = `${bin}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		writeFileSync(tmp, bytes);
		chmodSync(tmp, 0o755);
		try {
			renameSync(tmp, bin);
		} catch (err) {
			// Lost a concurrent-download race: the winner's binary is in
			// place and equally good.
			if (!existsSync(bin)) throw err;
		}
	} finally {
		rmSync(tmp, { force: true });
	}
}
