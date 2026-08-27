# The GitHub Actions composite (action.yml) is the one consumption path whose
# contract is "ts0 ran" rather than a CLI invocation, and a workflow author
# cannot be the one who decides what that means. `args: --help` exits 0 with
# nothing type-checked, nothing tested and nothing built -- a green check for
# no work -- so the action takes no command input at all and always runs test
# then build.
#
# These assertions are on the FILE, because that is where the property lives:
# a composite action's steps are its YAML, and nothing else in CI would notice
# a free-form command input coming back.
sandbox:
	network: false

tests:
	- desc: "the action runs test and then build, with no command input"
	  cmd: bash {inputs.run.sh} {outputs.check.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				action="$PWD/action.yml"
				exec > >(tee "$1") 2>&1

				# Both commands run, and test comes first: it is the gate
				# (type-check + the explicit-any ban) and build emits after it.
				test_line="$(grep -n 'node "\$TS0" test' "$action" | cut -d: -f1)"
				build_line="$(grep -n 'node "\$TS0" build' "$action" | cut -d: -f1)"
				[ -n "$test_line" ] || { echo "the action never runs ts0 test"; exit 1; }
				[ -n "$build_line" ] || { echo "the action never runs ts0 build"; exit 1; }
				[ "$test_line" -lt "$build_line" ] || { echo "build runs before test"; exit 1; }

				# The regression that made `args: --help` possible: a caller
				# value substituted into the command line. No line that invokes
				# node may carry an expression at all.
				if grep -nE '^[^#]*node .*\$\{\{' "$action"; then
					echo "a node command line interpolates an expression"
					exit 1
				fi

				# args survives only to fail a stale caller, loudly.
				grep -q 'REMOVED' "$action" || { echo "args is not marked REMOVED"; exit 1; }
				grep -q 'exit 1' "$action" || { echo "a stale caller does not fail"; exit 1; }

				echo "action OK: always test then build, no command input"
	  outputs:
		stdout:
			- "action OK: always test then build, no command input"
