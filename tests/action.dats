# The GitHub Actions composite (action.yml) is the one consumption path whose
# contract is "ts0 ran" rather than a CLI invocation, and a workflow author
# cannot be the one who decides what that means. A caller-chosen command can be
# `--help`, which exits 0 with nothing type-checked, nothing tested and nothing
# built -- a green check for no work. So the action takes no command input at
# all and always runs test then build.
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

				# A caller value substituted into the command line is how a
				# command input comes back. No line that invokes node may
				# carry an expression at all.
				if grep -nE '^[^#]*node .*\$\{\{' "$action"; then
					echo "a node command line interpolates an expression"
					exit 1
				fi

				# The whole input set, pinned. A command input is the thing this
				# action must not have, and it does not get in under another
				# name: adding ANY input has to be a deliberate edit here.
				declared="$(awk '/^inputs:/{f=1;next} /^[a-z]/{f=0} f && /^  [a-z-]+:/{gsub(/[ :]/,"");print}' "$action" | sort | tr '\n' ' ')"
				[ "$declared" = "branch version working-directory " ] || {
					echo "unexpected action inputs: $declared"
					exit 1
				}

				# Every input the steps read must be declared. An undeclared one
				# expands to the empty string, so the step keeps running and
				# silently does something other than what it reads like.
				for ref in $(grep -oE 'inputs\.[a-z-]+' "$action" | cut -d. -f2 | sort -u); do
					grep -qE "^  $ref:" "$action" || { echo "steps read an undeclared input: $ref"; exit 1; }
				done

				echo "action OK: always test then build, no command input"
	  outputs:
		stdout:
			- "action OK: always test then build, no command input"
