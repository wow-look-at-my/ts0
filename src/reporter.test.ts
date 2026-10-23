import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isGithubActions,
	colorEnabled,
	colors,
	formatAnnotation,
	annotate,
	formatDiagnostic,
	formatEsbuildDiagnostic,
	colorizeErrorBlock,
	colorizeTestLine,
	pipeColorized,
} from "./reporter.ts";
import { PassThrough } from "node:stream";

// withEnv runs `fn` with the given env vars set (or deleted, for `undefined`),
// restoring the previous values afterward even if `fn` throws.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) prev[k] = process.env[k];
	try {
		for (const [k, v] of Object.entries(vars)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("isGithubActions reads GITHUB_ACTIONS exactly", () => {
	assert.equal(isGithubActions({ GITHUB_ACTIONS: "true" }), true);
	assert.equal(isGithubActions({ GITHUB_ACTIONS: "false" }), false);
	assert.equal(isGithubActions({}), false);
});

test("colorEnabled forces on for GitHub Actions even on a non-TTY stream", () => {
	withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, GITHUB_ACTIONS: "true" }, () => {
		assert.equal(colorEnabled({ isTTY: false } as NodeJS.WriteStream), true);
	});
});

test("colorEnabled follows the stream's TTY-ness outside Actions", () => {
	withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, GITHUB_ACTIONS: undefined }, () => {
		assert.equal(colorEnabled({ isTTY: true } as NodeJS.WriteStream), true);
		assert.equal(colorEnabled({ isTTY: false } as NodeJS.WriteStream), false);
	});
});

test("NO_COLOR wins over GitHub Actions and a TTY alike", () => {
	withEnv({ NO_COLOR: "1", FORCE_COLOR: undefined, GITHUB_ACTIONS: "true" }, () => {
		assert.equal(colorEnabled({ isTTY: true } as NodeJS.WriteStream), false);
	});
});

test("FORCE_COLOR=0 disables color even under GitHub Actions", () => {
	withEnv({ NO_COLOR: undefined, FORCE_COLOR: "0", GITHUB_ACTIONS: "true" }, () => {
		assert.equal(colorEnabled({ isTTY: false } as NodeJS.WriteStream), false);
	});
});

test("FORCE_COLOR (non-zero) enables color on a non-TTY stream", () => {
	withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1", GITHUB_ACTIONS: undefined }, () => {
		assert.equal(colorEnabled({ isTTY: false } as NodeJS.WriteStream), true);
	});
});

test("colors() wraps text in ANSI codes only when enabled, and never otherwise", () => {
	const on = colors(true);
	const off = colors(false);
	assert.equal(on.green("x"), "\x1b[32mx\x1b[0m");
	assert.equal(off.green("x"), "x");
	assert.equal(on.dimRed("x"), "\x1b[2m\x1b[31mx\x1b[0m");
	assert.equal(off.dimRed("x"), "x");
});

test("formatAnnotation escapes % CR LF in the message and : , in properties", () => {
	assert.equal(formatAnnotation("error", "100% done\r\nnext line"), "::error::100%25 done%0D%0Anext line");
	assert.equal(
		formatAnnotation("error", "boom", { file: "a:b,c" }),
		"::error file=a%3Ab%2Cc::boom",
	);
});

test("formatAnnotation omits the property list entirely when none are given", () => {
	assert.equal(formatAnnotation("warning", "careful"), "::warning::careful");
});

test("annotate is a no-op outside GitHub Actions, and prints the command inside it", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => logs.push(args.join(" "));
	try {
		withEnv({ GITHUB_ACTIONS: undefined }, () => annotate("error", "nope"));
		assert.deepEqual(logs, []);
		withEnv({ GITHUB_ACTIONS: "true" }, () => annotate("error", "yep", { file: "a.ts", line: 1, col: 2 }));
		assert.deepEqual(logs, ["::error file=a.ts,line=1,col=2::yep"]);
	} finally {
		console.log = orig;
	}
});

test("formatDiagnostic matches tsc's own file(line,col): severity: message shape", () => {
	assert.equal(
		formatDiagnostic("src/a.ts", 3, 7, "error", "nope", "TS2322"),
		"src/a.ts(3,7): error TS2322: nope",
	);
	assert.equal(formatDiagnostic("src/a.ts", 3, 7, "warning", "careful"), "src/a.ts(3,7): warning: careful");
});

test("formatEsbuildDiagnostic recasts a located message, and passes an unlocated one through", () => {
	assert.equal(
		formatEsbuildDiagnostic({ text: "nope", location: { file: "x.ts", line: 1, column: 2 } }, "error"),
		"x.ts(1,2): error: nope",
	);
	assert.equal(formatEsbuildDiagnostic({ text: "unresolved import", location: null }), "unresolved import");
});

test("colorizeErrorBlock highlights a diagnostic line's marker without breaking its code token", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		const out = colorizeErrorBlock("src/a.ts(3,7): error TS2322: nope");
		// The digits of the diagnostic code must stay contiguous -- anything
		// that greps for "TS2322" (dats, other unit tests) must still find it.
		assert.match(out, /TS2322/);
		assert.equal(out.includes("\x1b[91merror TS2322:\x1b[0m"), true);
	});
});

test("colorizeErrorBlock falls back to a solid-colored whole line with nothing to highlight", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		assert.equal(colorizeErrorBlock("Build failed:"), "\x1b[91mBuild failed:\x1b[0m");
		assert.equal(colorizeErrorBlock("careful:", "warning"), "\x1b[93mcareful:\x1b[0m");
	});
});

test("colorizeErrorBlock leaves blank lines alone and preserves line count", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		const out = colorizeErrorBlock("first\n\nsrc/a.ts(1,1): error TS1: x");
		assert.equal(out.split("\n").length, 3);
		assert.equal(out.split("\n")[1], "");
	});
});

test("colorizeErrorBlock emits one GitHub Actions annotation per diagnostic line", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => logs.push(args.join(" "));
	try {
		withEnv({ GITHUB_ACTIONS: "true" }, () => {
			colorizeErrorBlock("not a diagnostic\nsrc/a.ts(1,1): error TS1: bad\nsrc/b.ts(2,2): warning: careful");
		});
		assert.deepEqual(logs, [
			"::error file=src/a.ts,line=1,col=1::bad",
			"::warning file=src/b.ts,line=2,col=2::careful",
		]);
	} finally {
		console.log = orig;
	}
});

test("colorizeTestLine colors only the \"ok\" token on a pass, never the rest of the line", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		const out = colorizeTestLine("ok 282 - getReasoningEffort ignores missing or non-string values");
		assert.equal(out, "\x1b[32mok\x1b[0m 282 - getReasoningEffort ignores missing or non-string values");
	});
});

test('colorizeTestLine does not mistake "not ok" for a pass', () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		const out = colorizeTestLine("not ok 3 - it broke");
		assert.equal(out.includes("\x1b[32m"), false, "a failing line must never carry the green pass color");
		assert.equal(out.startsWith("\x1b[91mnot ok\x1b[0m"), true);
	});
});

test("colorizeTestLine reports a failure as a GitHub Actions error annotation", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => logs.push(args.join(" "));
	try {
		withEnv({ GITHUB_ACTIONS: "true" }, () => colorizeTestLine("not ok 3 - it broke"));
		assert.deepEqual(logs, ["::error::not ok 3 - it broke"]);
		logs.length = 0;
		withEnv({ GITHUB_ACTIONS: "true" }, () => colorizeTestLine("ok 3 - it worked"));
		assert.deepEqual(logs, []);
	} finally {
		console.log = orig;
	}
});

test("colorizeTestLine colors a nonzero failure summary solid red", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		assert.equal(colorizeTestLine("# fail 2"), "\x1b[31m# fail 2\x1b[0m");
		assert.equal(colorizeTestLine("# fail 0"), "# fail 0");
	});
});

test("colorizeTestLine passes an unremarkable line through unchanged", () => {
	withEnv({ GITHUB_ACTIONS: undefined, NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
		assert.equal(colorizeTestLine("TAP version 13"), "TAP version 13");
		assert.equal(colorizeTestLine("# pass 5"), "# pass 5");
	});
});

test("pipeColorized recolors complete lines as they arrive and flushes a trailing partial line", async () => {
	const input = new PassThrough();
	const chunks: string[] = [];
	const out = { write: (s: string) => chunks.push(s) } as unknown as NodeJS.WritableStream;
	pipeColorized(input, (line) => `<${line}>`, out);
	input.write("ok 1 - a\nnot ok 2 - b\n");
	input.write("partial");
	input.end();
	await new Promise((resolve) => input.on("end", resolve));
	// pipeColorized's own "end" handler runs after the stream's; give it a tick.
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(chunks, ["<ok 1 - a>\n", "<not ok 2 - b>\n", "<partial>"]);
});
