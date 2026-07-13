// Entry point for the prebuilt ts0.cjs bundle (built by
// scripts/build-prebuilt.ts, published to buildhost). Runs on stock
// Node >= 22 with no npm, no node_modules, and no file identity of its own:
// both `node ts0.cjs build` and `curl ... | node - build` work, so nothing
// here may rely on __filename/__dirname/import.meta.url (see runtime.ts).
//
// Order matters: the cache is prepared (and the import.meta.url redirect
// global set) and the esbuild native binary ensured (ESBUILD_BINARY_PATH
// exported) BEFORE the CLI loads -- the bundled esbuild JS API snapshots
// that env var at module load time.
import assets from "ts0-prebuilt-assets";
import { ensureEsbuildBinary, prepareCache } from "./runtime.ts";

const cacheDir = prepareCache(assets);
void (async () => {
	await ensureEsbuildBinary(assets, cacheDir);
	await import("../cli.ts");
})().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
