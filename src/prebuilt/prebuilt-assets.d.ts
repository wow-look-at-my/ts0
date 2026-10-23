// Ambient declaration for the "ts0-prebuilt-assets" virtual module, which
// exists ONLY inside the prebuilt ts0.cjs bundle: scripts/build-prebuilt.ts
// generates its contents (the embedded TypeScript compiler files, the
// interceptor template, and the release constants) and injects it with an
// esbuild plugin. Nothing outside src/prebuilt/ may import it, and the npm
// build never bundles it; this declaration exists so the repo's type-check
// gate can check src/prebuilt/ without the generated module present.
declare module "ts0-prebuilt-assets" {
	interface PrebuiltAssets {
		// Names the per-release cache directory (~/.cache/ts0/<buildId>).
		// Derived from the bundle + embedded file bytes + dependency
		// versions, so any change extracts fresh and upgrades never collide.
		buildId: string;
		// The exact esbuild version bundled into ts0.cjs; the native binary
		// fetched at runtime must match it.
		esbuildVersion: string;
		// Download base for the platform-native esbuild binary, e.g.
		// "https://dl.pazer.build/ts0/esbuild-0.28.1" (os/arch appended as
		// query parameters at runtime).
		esbuildDlBase: string;
		// Embedded text files, keyed by cache-relative path (forward
		// slashes): the pruned typescript package and the fetch-interceptor
		// runtime template.
		files: Record<string, string>;
	}
	const assets: PrebuiltAssets;
	export default assets;
}
