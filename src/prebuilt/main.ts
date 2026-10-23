// Entry point for the prebuilt ts0.cjs bundle (built by
// scripts/build-prebuilt.ts, published to buildhost).
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
