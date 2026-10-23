// Library root: re-exports with explicit .ts/.tsx extension specifiers (the
// style allowImportingTsExtensions projects use). The emitted index.d.ts keeps
// these specifiers as-is; consumers resolve them by extension substitution
// (.ts -> .tsx -> .d.ts) to the deployed sibling declaration files.
export { add, type Vec2 } from "./math/vec.ts";
export { Badge, type BadgeProps } from "./badge.tsx";
