// A CSS module script evaluates to a CSSStyleSheet. The import is never
// bundled (see "external" in ts0.json), so this ambient declaration is what
// makes it type-check -- the file is resolved by the browser at runtime.
declare module "*.css" {
	const sheet: CSSStyleSheet;
	export default sheet;
}
