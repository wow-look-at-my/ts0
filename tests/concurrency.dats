# `ts0 test` must run a project's test files AT THE SAME TIME.
#
# node's test runner defaults its concurrency to `availableParallelism() - 1`.
# That is 1 on a two-core CI runner, so each file waited for the one before it
# and a suite cost the SUM of its files. Measured on a real run: five files, 62s
# then 43s back to back, 106s total. ts0 now passes an explicit
# `--test-concurrency`.
#
# The proof is a wall clock, because a flag in an argv list is not the
# behaviour. Two files each block for BLOCK_MS. One run forces a concurrency of
# 1 through TS0_TEST_CONCURRENCY, the other takes the default. The forced run is
# also the negative control: if ts0 stops passing the flag, that run goes
# parallel too and stops costing both files.
sandbox:
	network: false

tests:
	- desc: "a project's test files run at the same time, not one after the other"
	  cmd: bash {inputs.run.sh} {outputs.run.log}
	  inputs:
		files:
			ts0.json: |
				{ "entry": "src/main.ts", "outdir": "dist", "target": "node" }
			src/main.ts: |
				export const ok: number = 1;
			# A staged project has no @types/node, so the fixture cannot import
			# node:test or call setTimeout without failing the gate for the wrong
			# reason. Atomics.wait is in the standard library and blocks the
			# thread it runs on, which is the right shape anyway: node isolates
			# each test file in its own process, so a blocked thread is what a
			# slow test file looks like to the runner.
			src/a.test.ts: |
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
				export const done = 1;
			src/b.test.ts: |
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
				export const done = 1;
			run.sh: |
				set -euo pipefail
				block_ms=1500
				root="$(dirname "$1")"
				cp -r "$(dirname {inputs.ts0.json})/." "$root/"
				[ -d "$PWD/node_modules" ] && ln -s "$PWD/node_modules" "$root/node_modules"
				cd "$root"

				# Milliseconds of wall clock spent in one `ts0 test`.
				elapsed_ms() {
					start=$(date +%s%N)
					"$@" >/dev/null 2>&1
					end=$(date +%s%N)
					echo $(( (end - start) / 1000000 ))
				}

				serial=$(elapsed_ms env TS0_TEST_CONCURRENCY=1 ts0 test)
				parallel=$(elapsed_ms env -u TS0_TEST_CONCURRENCY ts0 test)
				echo "serial=${serial}ms parallel=${parallel}ms" | tee "$1"

				# The forced run pays for both files. Anything under that means
				# ts0 ignored TS0_TEST_CONCURRENCY, which is what happens when it
				# stops passing --test-concurrency at all.
				if [ "$serial" -lt $(( block_ms * 2 )) ]; then
					echo "FAIL: a forced concurrency of 1 finished in ${serial}ms, under the $(( block_ms * 2 ))ms the two files cost back to back" | tee -a "$1"
					exit 1
				fi
				# The default run pays for one file plus startup. A whole
				# block_ms of daylight cannot be reached by two files run in
				# sequence.
				if [ "$parallel" -ge $(( serial - block_ms + 300 )) ]; then
					echo "FAIL: the default run took ${parallel}ms against ${serial}ms serial -- the files still ran one after the other" | tee -a "$1"
					exit 1
				fi
				echo "concurrency OK: the default run overlapped its test files" | tee -a "$1"
	  outputs:
		stdout:
			- "concurrency OK: the default run overlapped its test files"
