// Regression test for which files `ts0 test` runs.
//
// The gate deliberately does not type-check a nested ts0 project (its own
// ts0.json, possibly its own JSX/resolution settings). Test discovery used to
// ignore that and glob the whole tree, so `ts0 test` in the parent SPAWNED a
// nested project's test files -- executing a program nothing had type-checked,
// which is the one thing the gate exists to prevent. A nested test file with a
// blatant type error was reported `ok`.
//
// These tests drive the real CLI over temp projects: the parent must not run
// the nested project's tests, and that project must still catch the error when
// tested directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

// A parent project whose nested/ subdirectory is its own ts0 project, carrying
// a test file that only a type-check can reject.
function nestedProject(): string {
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
	writeFileSync(join(nested, "src", "main.test.ts"), TYPE_ERROR_TEST);
	return root;
}

test("ts0 test does not run tests inside a nested ts0 project", async () => {
	const root = nestedProject();
	try {
		const { code, output } = await runCli(root, ["test"]);
		assert.match(output, /Found 1 test file/, `parent discovered the nested project's tests:\n${output}`);
		assert.doesNotMatch(output, /nested/, `parent ran a test the gate never checked:\n${output}`);
		assert.equal(code, 0, output);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a nested ts0 project still type-checks its own tests", async () => {
	const root = nestedProject();
	try {
		const { code, output } = await runCli(join(root, "nested"), ["test"]);
		assert.equal(code, 1, `nested project ran an un-type-checked test:\n${output}`);
		assert.match(output, /TS2322/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
