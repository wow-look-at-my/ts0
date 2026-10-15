// Ambient declaration so `import src from "./x.frag"` type-checks.
declare module "*.frag" {
	const src: string;
	export default src;
}
