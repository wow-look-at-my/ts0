// The bridge between ts0's normal command code and the single-executable
// (SEA) launcher. ts0 shells out to `node` in three places (the tsc
// type-check child, `ts0 run`'s program execution, and `ts0 test`'s test
// runner). Inside the prebuilt SEA binary there is no `node` on PATH -- the
// binary IS the Node runtime -- so those spawns must re-invoke the binary
// itself (process.execPath) with a dispatch argv that src/sea/prelude.ts
// intercepts before the CLI runs.
//
// The npm/git-install build never sets the global, so seaBridge() returns
// undefined there and every caller keeps its plain-`node` behavior. Only the
// SEA prelude (bundled exclusively into the SEA build) installs a bridge.

export interface SeaBridge {
	// The executable to spawn for dispatch invocations (the SEA binary itself).
	execPath: string;
	// Argv for running `tsc --project <projectPath>` (tscPath is the resolved
	// typescript/bin/tsc inside the extracted cache).
	tscArgs(tscPath: string, projectPath: string): string[];
	// Argv for running a program file (the `ts0 run` replacement for
	// `node [--experimental-strip-types] <file> ...args`).
	runArgs(file: string, args: string[]): string[];
	// Argv for running test files (the `ts0 test` replacement for
	// `node --experimental-strip-types --test ...files`).
	testArgs(files: string[]): string[];
}

interface SeaGlobal {
	__ts0SeaBridge?: SeaBridge;
}

export function seaBridge(): SeaBridge | undefined {
	return (globalThis as SeaGlobal).__ts0SeaBridge;
}

export function installSeaBridge(bridge: SeaBridge): void {
	(globalThis as SeaGlobal).__ts0SeaBridge = bridge;
}
