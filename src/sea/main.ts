// Entry point for the prebuilt single-executable (SEA) build of ts0, bundled
// by scripts/build-sea.ts. The prelude import runs first (asset extraction,
// module-resolution globals, dispatch interception); the CLI is then loaded
// dynamically so a dispatch invocation (--ts0-sea-dispatch=...) never
// evaluates -- or races -- the normal command path.
import { seaDispatched } from "./prelude.ts";

if (!seaDispatched()) {
	import("../cli.ts").catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
