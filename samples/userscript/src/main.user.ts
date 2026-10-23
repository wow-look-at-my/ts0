// ==UserScript==
// @name         ts0 sample userscript
// @version      1.0
// @description  Bundled by ts0: iife + globalName + preserveHeader
// @match        https://example.com/*
// @grant        none
// ==/UserScript==

// The header above is metadata the userscript manager parses from the BUILT
// file, so ts0 re-prepends it byte-exactly (preserveHeader). The import below
// is extensionless: browser-target entries are type-checked with bundler
// module resolution, matching how esbuild actually resolves it.
import { greet } from './lib/greet';

export function banner(): string {
	return greet('userscript');
}

document.title = banner();
