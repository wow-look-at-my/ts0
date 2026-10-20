// Source-file discovery shared by the gate's non-tsc passes (explicit-`any`,
// comment span).

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceScanOptions {
	// Skip directories whose name starts with "." -- what the explicit-`any` pass wants (it mirrors the tsc glob).
	skipDotDirs: boolean;
}

// collectSourceFiles walks rootDir for TypeScript sources, skipping
// node_modules, `.git`, and each rootDir-relative path in excludeDirs.
// Declaration files are included: a hand-written `.d.ts` is project source too.
export function collectSourceFiles(rootDir: string, excludeDirs: string[], options: SourceScanOptions): string[] {
	const excluded = new Set(excludeDirs.map((d) => toPosix(d)));
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "node_modules" || name === ".git") continue;
			if (options.skipDotDirs && name.startsWith(".")) continue;
			const p = join(dir, name);
			if (excluded.has(toPosix(relative(rootDir, p)))) continue;
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (/\.(ts|tsx|mts|cts)$/i.test(name)) found.push(p);
		}
	};
	walk(rootDir);
	return found;
}

export function toPosix(p: string): string {
	return p.split(/[\\/]/).join("/");
}
