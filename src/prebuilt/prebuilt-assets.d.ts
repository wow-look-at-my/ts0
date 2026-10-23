// Ambient declaration for the "ts0-prebuilt-assets" virtual module, which
// exists ONLY inside the prebuilt ts0.cjs bundle.
declare module "ts0-prebuilt-assets" {
	interface PrebuiltAssets {
		// Names the per-release cache directory (~/.cache/ts0/<buildId>).
		buildId: string;
		// The exact esbuild version bundled into ts0.cjs; the native binary fetched at runtime must match it.
		esbuildVersion: string;
		// Download base for the platform-native esbuild binary, e.g. "https://dl.pazer.build/ts0/esbuild-0.28.1" (os/arch appended as query parameters at runtime).
		esbuildDlBase: string;
		// Embedded text files, keyed by cache-relative path (forward slashes).
		files: Record<string, string>;
	}
	const assets: PrebuiltAssets;
	export default assets;
}
