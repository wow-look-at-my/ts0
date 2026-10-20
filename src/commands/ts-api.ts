// ts0's own TypeScript compiler.

import { createRequire } from "node:module";

type TypeScriptApi = typeof import("typescript");

let tsApi: TypeScriptApi | undefined;

export function typescript(): TypeScriptApi {
	if (!tsApi) {
		tsApi = createRequire(import.meta.url)("typescript") as TypeScriptApi;
	}
	return tsApi;
}
