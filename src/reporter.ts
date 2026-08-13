// GitHub Actions log annotations and ANSI coloring for ts0's own console
// output: type-check/esbuild diagnostics and `node --test`'s TAP stream.
// Colors and `::error::`/`::warning::` annotations are two independent
// features layered on the same diagnostics -- annotations put a finding in
// GitHub's Files-changed/Checks UI; colors make the raw log readable, in a
// terminal or in the Actions log viewer (which renders ANSI same as a
// terminal, despite its stdout being a pipe, not a TTY).

export function isGithubActions(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GITHUB_ACTIONS === "true";
}

// colorEnabled forces color on under GitHub Actions (see module comment --
// its stdout is never a TTY, so a bare isTTY check would leave every CI run
// uncolored) and otherwise follows the stream's own TTY-ness, with the usual
// NO_COLOR/FORCE_COLOR opt-outs taking precedence over both.
export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
	if (isGithubActions()) return true;
	return !!stream.isTTY;
}

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	brightRed: "\x1b[91m",
	yellow: "\x1b[33m",
	brightYellow: "\x1b[93m",
	green: "\x1b[32m",
} as const;

export interface Colors {
	green(text: string): string;
	yellow(text: string): string;
	red(text: string): string;
	brightRed(text: string): string;
	brightYellow(text: string): string;
	dimRed(text: string): string;
	dimYellow(text: string): string;
}

// colors() is derived fresh on every call rather than cached at module load,
// so it always reflects the current environment -- tests exercise both the
// enabled and disabled branches in one process.
export function colors(enabled: boolean = colorEnabled()): Colors {
	const wrap =
		(code: string) =>
		(text: string): string =>
			enabled ? `${code}${text}${ANSI.reset}` : text;
	return {
		green: wrap(ANSI.green),
		yellow: wrap(ANSI.yellow),
		red: wrap(ANSI.red),
		brightRed: wrap(ANSI.brightRed),
		brightYellow: wrap(ANSI.brightYellow),
		dimRed: wrap(ANSI.dim + ANSI.red),
		dimYellow: wrap(ANSI.dim + ANSI.yellow),
	};
}

// --- GitHub Actions workflow-command annotations ----------------------------
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions

function escapeData(value: string): string {
	return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value: string): string {
	return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export interface AnnotationLocation {
	file?: string;
	line?: number;
	col?: number;
	endLine?: number;
	endColumn?: number;
	title?: string;
}

export function formatAnnotation(kind: "error" | "warning" | "notice", message: string, loc: AnnotationLocation = {}): string {
	const props = Object.entries(loc)
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${k}=${escapeProperty(String(v))}`)
		.join(",");
	return `::${kind}${props ? ` ${props}` : ""}::${escapeData(message)}`;
}

// annotate prints a workflow command that GitHub Actions turns into a log
// annotation. A no-op outside Actions: the command syntax would otherwise
// print as literal `::error::...` noise in a local terminal.
export function annotate(kind: "error" | "warning" | "notice", message: string, loc?: AnnotationLocation): void {
	if (!isGithubActions()) return;
	console.log(formatAnnotation(kind, message, loc));
}

// --- tsc-style diagnostics: "file(line,col): error TSxxxx: message" --------

export function formatDiagnostic(
	file: string,
	line: number,
	col: number,
	severity: "error" | "warning",
	message: string,
	code?: string,
): string {
	return `${file}(${line},${col}): ${severity}${code ? ` ${code}` : ""}: ${message}`;
}

export interface EsbuildLikeMessage {
	text: string;
	location: { file: string; line: number; column: number } | null;
}

// formatEsbuildDiagnostic recasts an esbuild Message into the same tsc-style
// shape formatDiagnostic produces, so the one diagnostic parser below
// (colorizeErrorBlock, and the GitHub annotations it emits) covers esbuild's
// errors and warnings too, not just tsc's. A message with no location (esbuild
// reports some errors that way) has nothing to recast -- its plain text passes
// through unchanged.
export function formatEsbuildDiagnostic(msg: EsbuildLikeMessage, severity: "error" | "warning" = "error"): string {
	if (!msg.location) return msg.text;
	return formatDiagnostic(msg.location.file, msg.location.line, msg.location.column, severity, msg.text);
}

const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning)(\s+TS\d+)?: (.*)$/;

// colorizeErrorBlock recolors a block of ts0 error/warning text for a
// terminal and, on GitHub Actions, emits one annotation per diagnostic line --
// the only shape ts0 knows how to point at a file and location. A line
// matching that shape gets its location dim and its "error"/"warning TSxxxx"
// marker bright, in the marker's own severity color (a warning line is
// yellow even inside an otherwise-red error block). Any other non-blank line
// -- a header like "Type-checking failed:", a message with no location -- is
// colored solid in `fallbackSeverity`'s bright color: there's nothing more
// specific in it to highlight, so the whole line carries the signal.
export function colorizeErrorBlock(text: string, fallbackSeverity: "error" | "warning" = "error"): string {
	const c = colors();
	return text
		.split("\n")
		.map((line) => {
			if (line.trim() === "") return line;
			const m = DIAGNOSTIC_RE.exec(line);
			if (!m) return fallbackSeverity === "warning" ? c.brightYellow(line) : c.brightRed(line);
			const [, file, lineNo, col, severity, code, message] = m;
			annotate(severity as "error" | "warning", message, { file, line: Number(lineNo), col: Number(col) });
			const isWarn = severity === "warning";
			const dim = isWarn ? c.dimYellow : c.dimRed;
			const bright = isWarn ? c.brightYellow : c.brightRed;
			const marker = bright(`${severity}${code ?? ""}:`);
			return dim(`${file}(${lineNo},${col}): `) + marker + dim(` ${message}`);
		})
		.join("\n");
}

// --- `node --test` TAP output -----------------------------------------------

// colorizeTestLine recolors one line of `node --test`'s TAP output.
//   - "ok N - ..." (a pass): only the "ok" token turns green. Coloring the
//     whole line would drown out anything that actually needs attention once
//     a suite has hundreds of passes.
//   - "not ok N - ..." (a failure): "not ok" turns bright red, the rest of the
//     line dim red, and it is reported as a GitHub Actions error annotation
//     (a no-op outside Actions) -- a TAP line carries no file/line ts0 could
//     point at instead.
//   - "# fail N" with N > 0 (the run's own summary): colored solid red. Unlike
//     a per-test line this IS the overall result, the one case allowed to
//     color a whole line for something other than overall success.
//   - anything mentioning "warning": colored solid yellow.
// Everything else (the TAP version line, "# pass N", indentation-only lines)
// passes through unchanged.
export function colorizeTestLine(line: string): string {
	const c = colors();
	const notOk = /^(\s*)not ok\b(.*)$/.exec(line);
	if (notOk) {
		const [, indent, rest] = notOk;
		annotate("error", line.trim());
		return `${indent}${c.brightRed("not ok")}${c.dimRed(rest)}`;
	}
	const ok = /^(\s*)ok\b(.*)$/.exec(line);
	if (ok) {
		const [, indent, rest] = ok;
		return `${indent}${c.green("ok")}${rest}`;
	}
	const fail = /^#\s*fail\s+(\d+)/.exec(line);
	if (fail && Number(fail[1]) > 0) return c.red(line);
	if (/warning/i.test(line)) return c.yellow(line);
	return line;
}

// pipeColorized streams `readable` to `out` line by line, recoloring each
// complete line with `colorizeLine`. Used to recolor a spawned child's output
// live: `stdio: "inherit"` hands the fd straight to the terminal, bypassing
// ts0 entirely, so nothing written that way could ever be recolored.
export function pipeColorized(
	readable: NodeJS.ReadableStream,
	colorizeLine: (line: string) => string,
	out: NodeJS.WritableStream = process.stdout,
): void {
	let buffer = "";
	readable.setEncoding("utf-8");
	readable.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) out.write(`${colorizeLine(line)}\n`);
	});
	readable.on("end", () => {
		if (buffer) out.write(colorizeLine(buffer));
	});
}
