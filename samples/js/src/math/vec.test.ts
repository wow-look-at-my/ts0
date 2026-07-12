// Test files are skipped by the js build AND by declaration emit: the build
// must produce neither dist/math/vec.test.js nor dist/math/vec.test.d.ts.
// (Still type-checked by the gate like every project source.)
import { add } from "./vec";

export function checkAdd(): boolean {
	const sum = add([1, 2], [3, 4]);
	return sum[0] === 4 && sum[1] === 6;
}
