// Test files are skipped by the js build AND by declaration emit.
import { add } from "./vec.ts";

export function checkAdd(): boolean {
	const sum = add([1, 2], [3, 4]);
	return sum[0] === 4 && sum[1] === 6;
}
