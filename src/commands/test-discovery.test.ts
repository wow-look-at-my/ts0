// Regression test for which files `ts0 test` and `ts0 build` reach.
//
// A nested ts0 project (its own ts0.json, possibly its own JSX/resolution
// settings) cannot be type-checked under the parent's config, so the parent's
// own gate leaves it out. That must never mean it goes unchecked: ts0 recurses
// into it and runs it under ITS config. Two ways to get this wrong, and both
// have been shipped -- globbing the nested tests into the parent's run, which
// EXECUTES a program nothing type-checked (a nested test with a blatant type
// error was reported `ok`), and dropping them entirely, which reports green
// over tests that never ran.
//
// These tests drive the real CLI over temp projects and pin the recursion: a
// broken nested project must fail the parent's `test` AND its `build`, and the
// error must come from the nested project's own gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "cli.ts");

// The fixtures pull in nothing: a temp project has no @types/node, so
// importing node:test would fail the gate on its own and prove nothing.
const CLEAN_TEST = "export const parentRan = 1;\n";
// Valid JS after type-stripping: if this is ever executed it exits 0, so only
// the type-check can catch it. That is what makes an un-checked run look green.
const TYPE_ERROR_TEST = 'const n: number = "nope";\nexport { n };\n';

function runCli(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("node", ["--experimental-strip-types", CLI, ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (d: Buffer) => (output += d.toString()));
		child.stderr.on("data", (d: Buffer) => (output += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});
}

// A parent project whose nested/ subdirectory is its own ts0 project. The
// nested test file is the payload: only a type-check rejects it.
function nestedProject(nestedTest: string): string {
	const root = mkdtempSync(join(tmpdir(), "ts0-discovery-"));
	const cfg = '{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }\n';
	writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
	writeFileSync(join(root, "ts0.json"), cfg);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "main.ts"), "export const ok: number = 1;\n");
	writeFileSync(join(root, "src", "main.test.ts"), CLEAN_TEST);

	const nested = join(root, "nested");
	mkdirSync(join(nested, "src"), { recursive: true });
	writeFileSync(join(nested, "ts0.json"), cfg);
	writeFileSync(join(nested, "src", "main.ts"), "export const ok: number = 1;\n");
	writeFileSync(join(nested, "src", "main.test.ts"), nestedTest);
	return root;
}

test("ts0 test recurses into a nested ts0 project", async () => {
	const root = nestedProject(CLEAN_TEST);
	try {
		const { code, output } = await runCli(root, ["test"]);
		assert.equal(code, 0, output);
		// Both projects ran, each finding the one test file it owns.
		assert.match(output, /\nnested:/, `nested project was never entered:\n${output}`);
		assert.equal(
			output.match(/Found 1 test file/g)?.length,
			2,
			`expected one test run per project:\n${output}`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a type error in a nested project's test fails the parent's ts0 test", async () => {
	const root = nestedProject(TYPE_ERROR_TEST);
	try {
		const { code, output } = await runCli(root, ["test"]);
		assert.equal(code, 1, `parent reported success over a broken nested project:\n${output}`);
		assert.match(output, /TS2322/, `nested project's gate never ran:\n${output}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a type error in a nested project fails the parent's ts0 build", async () => {
	const root = nestedProject(TYPE_ERROR_TEST);
	try {
		const { code, output } = await runCli(root, ["build"]);
		assert.equal(code, 1, `parent build reported success over a broken nested project:\n${output}`);
		assert.match(output, /TS2322/);
		// The parent's own output still landed; only the nested build failed.
		assert.ok(existsSync(join(root, "dist", "main.js")), "parent's own build did not run");
		assert.ok(!existsSync(join(root, "nested", "dist")), "nested project emitted despite a type error");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ts0 build recurses into a nested ts0 project", async () => {
	const root = nestedProject(CLEAN_TEST);
	try {
		const { code, output } = await runCli(root, ["build"]);
		assert.equal(code, 0, output);
		assert.ok(existsSync(join(root, "dist", "main.js")), "parent's own build did not run");
		assert.ok(existsSync(join(root, "nested", "dist", "main.js")), `nested project was not built:\n${output}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ts0 run builds only its own project, not nested ones", async () => {
	const root = nestedProject(CLEAN_TEST);
	try {
		const { code } = await runCli(root, ["run"]);
		assert.equal(code, 0);
		assert.ok(!existsSync(join(root, "nested", "dist")), "run built a nested project it will not execute");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
