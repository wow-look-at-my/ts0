// Regression test for the type-check gate's file set.
//
// The gate's tsconfig `include` is `**/*.ts` (+ the other TS extensions), and
// tsc never descends into a dot-directory while expanding a leading wildcard.
// So an entry under one -- a build script in `.github/scripts/` -- used to be
// bundled by esbuild against an EMPTY type-check program, and the build
// reported success: a green build over a file that was never checked at all.
//
// These tests drive `runTypecheck` over a real temp project and assert the
// gate fails on a type error in the entry, whether or not the entry sits in a
// dot-directory, and that a clean entry still passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runTypecheck } from "./build.ts";
import type { Ts0Config } from "../config.ts";

const BAD = 'interface E { to: string }\nconst e: E = { to: "x" };\nconst s: string = e.nope;\nexport { s };\n';
const GOOD = 'interface E { to: string }\nconst e: E = { to: "x" };\nconst s: string = e.to;\nexport { s };\n';

function project(entry: string, source: string): { root: string; config: Ts0Config } {
	const root = mkdtempSync(join(tmpdir(), "ts0-entry-"));
	writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
	const file = join(root, entry);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	return { root, config: { entry, outfile: "out/x.js", target: "node", sourcemap: false } as Ts0Config };
}

for (const entry of [".github/scripts/build-step.ts", "scripts/build-step.ts"]) {
	test(`type error in entry ${entry} fails the gate`, async () => {
		const { root, config } = project(entry, BAD);
		try {
			const result = await runTypecheck(config, root);
			assert.equal(result.success, false, `entry ${entry} was not type-checked at all`);
			assert.match(result.output, /TS2339/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`clean entry ${entry} passes the gate`, async () => {
		const { root, config } = project(entry, GOOD);
		try {
			const result = await runTypecheck(config, root);
			assert.equal(result.success, true, result.output);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

// Naming the entry in `include` must not make tsc the thing that reports an
// entry holding no TypeScript. Globs matching nothing abort with TS18003
// naming ts0's temp tsconfig; the gate has to stay a vacuous pass here so the
// js target's own "No TypeScript modules found under ..." is what the user sees.
test("a JS-only directory entry stays a vacuous pass", async () => {
	const { root, config } = project("lib/a.js", "export const a = 1;\n");
	config.entry = "lib";
	config.outfile = undefined;
	config.outdir = "out";
	try {
		const result = await runTypecheck(config, root);
		assert.equal(result.success, true, result.output);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a directory entry under a dot-directory is type-checked too", async () => {
	const { root, config } = project(".build/lib/mod.ts", BAD);
	config.entry = ".build/lib";
	config.outfile = undefined;
	config.outdir = "out";
	try {
		const result = await runTypecheck(config, root);
		assert.equal(result.success, false, "directory entry under a dot-directory was not type-checked");
		assert.match(result.output, /TS2339/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
