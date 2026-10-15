// Extensionless cross-module import.
import { add, type Vec2 } from "./vec";

export function midpoint(a: Vec2, b: Vec2): Vec2 {
	const sum = add(a, b);
	return [sum[0] / 2, sum[1] / 2];
}
