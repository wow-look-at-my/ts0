// Explicit-`any` ban.
//
// `strict` (noImplicitAny) makes tsc reject an *implicit* any, but tsc has no
// flag at all for an *explicit* one: `let x: any`, `x as any`, `<any>x`,
// `any[]`, `Promise<any>` are all legal TypeScript. ts0 bans them outright --
// an explicit `any` silently switches type-checking off for everything it
// touches, which is exactly what the unskippable type-check gate exists to
// prevent -- so this pass runs inside `runTypecheck()` and every command that
// emits or executes code fails on it, just like a type error.
//
// The detection is a real parse, never a text search: `any` appears in
// identifiers (`const anyOf = ...`), strings, comments and JSX text
// ("Do you have any questions?"), none of which are types. TypeScript's own
// parser is used -- the AnyKeyword token only ever occurs as a type -- so a
// valid program can never be failed for a word that merely reads as "any".
// Parsing is syntax-only (no program, no checker), so it costs milliseconds.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

type TypeScriptApi = typeof import("typescript");
type TsNode = import("typescript").Node;

let tsApi: TypeScriptApi | undefined;

// typescript loads ts0's own TypeScript, resolved exactly like the tsc binary
// in build.ts (createRequire on import.meta.url), so the user's project needs
// no typescript install of its own. Under the prebuilt ts0.cjs this resolves
// to the extracted cache copy -- scripts/build-prebuilt.ts embeds
// lib/typescript.js for this pass. Memoized: watch mode re-checks on every
// rebuild and the compiler is a big module to load.
function typescript(): TypeScriptApi {
	if (!tsApi) {
		tsApi = createRequire(import.meta.url)("typescript") as TypeScriptApi;
	}
	return tsApi;
}

export interface ExplicitAnyFinding {
	file: string; // rootDir-relative, forward slashes
	line: number; // 1-based, like tsc's diagnostics
	column: number; // 1-based
}

// collectSourceFiles returns the project's TypeScript files in deterministic
// order, using the same exclusions as the type-check gate (node_modules,
// dotfiles, the output dir, nested ts0 projects, and config.exclude, all
// passed in as rootDir-relative paths). Declaration files are included: a
// hand-written `.d.ts` is project source too, and it is where an explicit
// `any` hides most easily (the gate's skipLibCheck means tsc never looks).
function collectSourceFiles(rootDir: string, excludeDirs: string[]): string[] {
	const excluded = new Set(excludeDirs.map((d) => d.split(/[\\/]/).join("/")));
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const p = join(dir, name);
			const rel = relative(rootDir, p).split(/[\\/]/).join("/");
			if (excluded.has(rel)) continue;
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

// findExplicitAny parses every project source and reports each explicit `any`
// type. Parsing is error-tolerant: a file that doesn't even parse yields a
// partial tree rather than throwing (tsc reports the syntax error properly --
// runTypecheck runs this pass only after tsc has passed).
export function findExplicitAny(rootDir: string, excludeDirs: string[]): ExplicitAnyFinding[] {
	const findings: ExplicitAnyFinding[] = [];

	for (const file of collectSourceFiles(rootDir, excludeDirs)) {
		const text = readFileSync(file, "utf-8");
		// Cheap pre-filter: no `any` token anywhere means nothing to parse for
		// -- and, on a project with none at all, the compiler is never even
		// loaded. (The reverse is not true: a match still has to be parsed to
		// know whether it is a type, an identifier, a string, or prose.)
		if (!/\bany\b/.test(text)) continue;

		const ts = typescript();
		const sourceFile = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.ESNext,
			// Parent pointers: node.getStart() consults them for the exact
			// token position (node.pos still includes leading trivia).
			/*setParentNodes*/ true,
			/\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const rel = relative(rootDir, file).split(/[\\/]/).join("/");

		const visit = (node: TsNode): void => {
			if (node.kind === ts.SyntaxKind.AnyKeyword) {
				const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
				findings.push({ file: rel, line: line + 1, column: character + 1 });
				return;
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(sourceFile, visit);
	}

	return findings;
}

// checkNoExplicitAny is the gate-facing wrapper: same {success, output} shape
// as the tsc passes, with tsc-style `file(line,col)` locations so editors and
// terminals can jump to them.
export function checkNoExplicitAny(rootDir: string, excludeDirs: string[]): { success: boolean; output: string } {
	const findings = findExplicitAny(rootDir, excludeDirs);
	if (findings.length === 0) {
		return { success: true, output: "No explicit `any` found." };
	}
	const lines = findings.map((f) => `${f.file}(${f.line},${f.column}): error: explicit \`any\` is not allowed`);
	const count = findings.length === 1 ? "1 explicit `any`" : `${findings.length} explicit \`any\` types`;
	return {
		success: false,
		output: [
			...lines,
			"",
			`Found ${count}. ts0 bans explicit \`any\` as well as implicit \`any\`: annotate the real type, or`,
			"use `unknown` when the value genuinely is untyped and narrow it before use.",
		].join("\n"),
	};
}
