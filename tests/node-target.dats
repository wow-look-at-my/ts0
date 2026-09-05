# What a Node-target project needs from ts0, beyond compiling: an artifact that
# runs where its node_modules does not exist, and a test run that executes the
# sources in the module format they were written in.
#
# Both are regressions from wow-look-at-my/actions, where every action is a
# CommonJS-format project that ships one file to a release tag.
#
# Each project is staged under inputs/ and copied into outputs/ before the
# build, so the artifact lands where the file assertions read it. No network:
# each project brings its own node_modules, and ts0 supplies @types/node and
# the compiler, so nothing here reaches a registry.
sandbox:
	network: false

tests:
	- desc: "bundleDependencies compiles an imported package into the artifact"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				mkdir -p "$(dirname "$1")/proj"
				cp -r "$(dirname "$0")/proj/." "$(dirname "$1")/proj/"
				cd "$(dirname "$1")/proj"
				ts0 build 2>&1 | tee "$1"
				# Running it without node_modules is the whole test: that is the
				# position a release tag ships the artifact in.
				mv node_modules elsewhere
				node dist/index.js 2>&1 | tee -a "$1"
			proj/package.json: |
				{ "name": "bundled", "version": "1.0.0", "type": "commonjs" }
			proj/ts0.json: |
				{
					"entry": "src/index.ts",
					"outfile": "dist/index.js",
					"target": "node",
					"format": "cjs",
					"bundleDependencies": true,
					"sourcemap": false
				}
			proj/src/index.ts: |
				import { greet } from 'greeter';
				console.log(greet('world'));
			proj/node_modules/greeter/package.json: |
				{ "name": "greeter", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }
			proj/node_modules/greeter/index.js: |
				exports.greet = (who) => 'hello ' + who;
			proj/node_modules/greeter/index.d.ts: |
				export declare function greet(who: string): string;
	  outputs:
		stdout:
			- "hello world"
		files:
			proj/dist/index.js:
				match:
					# The package's own body, compiled in.
					- '"hello " \+ who'
				notMatch:
					- 'require\("greeter"\)'

	- desc: "without bundleDependencies the package stays a runtime require"
	  cmd: bash {inputs.run.sh} {outputs.build.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				mkdir -p "$(dirname "$1")/proj"
				cp -r "$(dirname "$0")/proj/." "$(dirname "$1")/proj/"
				cd "$(dirname "$1")/proj"
				ts0 build 2>&1 | tee "$1"
				node dist/index.js 2>&1 | tee -a "$1"
			proj/package.json: |
				{ "name": "external", "version": "1.0.0", "type": "commonjs" }
			proj/ts0.json: |
				{
					"entry": "src/index.ts",
					"outfile": "dist/index.js",
					"target": "node",
					"format": "cjs",
					"sourcemap": false
				}
			proj/src/index.ts: |
				import { greet } from 'greeter';
				console.log(greet('world'));
			proj/node_modules/greeter/package.json: |
				{ "name": "greeter", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }
			proj/node_modules/greeter/index.js: |
				exports.greet = (who) => 'hello ' + who;
			proj/node_modules/greeter/index.d.ts: |
				export declare function greet(who: string): string;
	  outputs:
		stdout:
			- "hello world"
		files:
			proj/dist/index.js:
				match:
					- 'require\("greeter"\)'
				notMatch:
					- '"hello " \+ who'

	- desc: "a CommonJS project's tests run with the globals that format has"
	  cmd: bash {inputs.run.sh} {outputs.test.log}
	  inputs:
		files:
			# node --experimental-strip-types cannot run any of this: it erases
			# type annotations without turning `import` into `require`, so the
			# whole file died on "Cannot use import statement outside a module".
			# __dirname, require and require.main are the globals this format
			# has, and a compile into ESM would take all three away.
			run.sh: |
				set -euo pipefail
				mkdir -p "$(dirname "$1")/proj"
				cp -r "$(dirname "$0")/proj/." "$(dirname "$1")/proj/"
				cd "$(dirname "$1")/proj"
				ts0 test 2>&1 | tee "$1"
				# The compiled copies are ts0's, and it deletes them.
				find . -name '*.ts0.*' | tee -a "$1"
			proj/package.json: |
				{ "name": "cjs-project", "version": "1.0.0", "type": "commonjs" }
			proj/ts0.json: |
				{
					"entry": "src/index.ts",
					"outfile": "dist/index.js",
					"target": "node",
					"format": "cjs",
					"sourcemap": false
				}
			proj/src/fixture.txt: |
				read from beside the test
			proj/src/index.ts: |
				export function shout(word: string): string {
					return word.toUpperCase();
				}

				if (require.main === module) {
					console.log(shout('entry'));
				}
			proj/src/shout.test.ts: |
				import assert from 'node:assert/strict';
				import { readFileSync } from 'node:fs';
				import { join } from 'node:path';
				import { test } from 'node:test';
				import { shout } from './index';

				test('an extensionless relative import resolves', () => {
					assert.equal(shout('ok'), 'OK');
				});

				test('__dirname points at the source directory', () => {
					assert.match(readFileSync(join(__dirname, 'fixture.txt'), 'utf-8'), /beside the test/);
				});

				test('a main-module guard cannot tell it is imported', () => {
					// Every module in the bundle shares one module object, so
					// this guard fires and index.ts runs its entry work here.
					// A module under test exports its work and leaves the
					// invocation to the entry file.
					assert.equal(require.main, module);
				});
	  outputs:
		stdout:
			- "an extensionless relative import resolves"
			- "__dirname points at the source directory"
			- "a main-module guard cannot tell it is imported"
			# index.ts's own guard fires and prints, for the same reason.
			- "ENTRY"
			- "# fail 0"
		!stdout:
			# The find above prints any compiled copy ts0 failed to remove.
			- '\.ts0\.'

	- desc: "an ES module project's tests keep import.meta pointing at their own directory"
	  cmd: bash {inputs.run.sh} {outputs.test.log}
	  inputs:
		files:
			run.sh: |
				set -euo pipefail
				mkdir -p "$(dirname "$1")/proj"
				cp -r "$(dirname "$0")/proj/." "$(dirname "$1")/proj/"
				cd "$(dirname "$1")/proj"
				ts0 test 2>&1 | tee "$1"
			proj/package.json: |
				{ "name": "esm-project", "version": "1.0.0", "type": "module" }
			proj/ts0.json: |
				{
					"entry": "src/index.ts",
					"outfile": "dist/index.js",
					"target": "node",
					"format": "esm",
					"sourcemap": false
				}
			proj/src/fixture.txt: |
				read from beside the test
			proj/src/index.ts: |
				export function shout(word: string): string {
					return word.toUpperCase();
				}
			proj/src/shout.test.ts: |
				import assert from 'node:assert/strict';
				import { readFileSync } from 'node:fs';
				import { join } from 'node:path';
				import { test } from 'node:test';
				import { shout } from './index.ts';

				test('import.meta.dirname points at the source directory', () => {
					assert.match(readFileSync(join(import.meta.dirname, 'fixture.txt'), 'utf-8'), /beside the test/);
					assert.equal(shout('ok'), 'OK');
				});
	  outputs:
		stdout:
			- "import.meta.dirname points at the source directory"
			- "# fail 0"
