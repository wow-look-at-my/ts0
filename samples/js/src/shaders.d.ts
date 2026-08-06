// Ambient declaration so `import src from "./x.frag"` type-checks. The actual
// text is inlined by esbuild's text loader (configured via ts0.json's esbuild
// escape hatch: loader { ".frag": "text" }).
declare module "*.frag" {
	const src: string;
	export default src;
}
