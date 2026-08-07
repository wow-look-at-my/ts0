# The command surface end-to-end: `ts0 init` scaffolds a project that `build`,
# `run` and `test` then handle, and `--config` points the whole build at a
# named config file elsewhere in the tree.
#
# No network: init's `npm install` cannot reach a registry here (it is a soft
# step -- init reports the failure and carries on), so the scaffolded project
# gets the repo's node_modules linked in, exactly the position it resolves
# @types/node from when a project is built inside the repo. What is under test
# is the scaffolding and the three commands, not npm.
sandbox:
	enabled: true
	network: false

tests:
	- desc: "init scaffolds a project that builds, runs and tests"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		env:
			# Fail the unreachable registry fast instead of burning the test's
			# time in npm's retry backoff.
			npm_config_offline: "true"
			npm_config_audit: "false"
			npm_config_fund: "false"
		files:
			run.sh: |
				set -euo pipefail
				repo="$PWD"
				root="$(dirname "$1")"
				mkdir -p "$root/proj"
				cd "$root/proj"
				ts0 init 2>&1 | tee "$1"
				ln -s "$repo/node_modules" node_modules
				ts0 build 2>&1 | tee -a "$1"
				ts0 run 2>&1 | tee -a "$1"
				ts0 test 2>&1 | tee -a "$1"
	  outputs:
		stdout:
			- "Created ts0.json"
			# `ts0 run` executes the scaffolded entry...
			- "Hello from ts0!"
			# ...and `ts0 test` runs the scaffolded test through node --test.
			- "example test"
		files:
			proj/ts0.json:
			proj/package.json:
			proj/src/main.ts:
			proj/src/main.test.ts:
			proj/dist/main.js:

	- desc: "--config builds a named config from elsewhere in the tree"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			# Several differently-configured builds can live in one repo:
			# rootDir stays the config file's own directory, so entry/outfile
			# resolve exactly as a walk-up find would resolve them.
			run.sh: |
				set -euo pipefail
				repo="$PWD"
				root="$(dirname "$1")"
				mkdir -p "$root/sample"
				cp -r samples/userscript/. "$root/sample/"
				rm -rf "$root/sample/dist"
				ln -s "$repo/node_modules" "$root/node_modules"
				cd "$root"
				ts0 build --config sample/ts0.json 2>&1 | tee "$1"
	  outputs:
		files:
			sample/dist/main.user.js:
				match:
					- '(?m)^// ==UserScript==$'
