
// The header above is metadata the userscript manager parses from the BUILT file, so ts0 re-prepends it byte-exactly.
import { greet } from './lib/greet';

export function banner(): string {
	return greet('userscript');
}

document.title = banner();
