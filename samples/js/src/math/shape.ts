// Extensionless cross-module import: under the js target this type-checks with
// bundler resolution, and esbuild inlines add() into this module's output so
// shape.js is self-contained (no runtime import of ./vec).
import { add, type Vec2 } from "./vec";

export function midpoint(a: Vec2, b: Vec2): Vec2 {
	const sum = add(a, b);
	return [sum[0] / 2, sum[1] / 2];
}
