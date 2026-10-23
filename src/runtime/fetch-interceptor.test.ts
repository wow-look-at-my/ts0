// Regression tests for the single-file fetch interceptor. The interceptor is a
// browser IIFE; here we evaluate it against a minimal window/document shim and
// assert it serves embedded assets for every fetch() input shape -- string, a
// URL object (the `fetch(new URL(...))` form its own header documents), and a
// Request-like object with a `.url`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "fetch-interceptor.js"), "utf-8");

interface AssetMap {
	text: Record<string, string>;
	binary: Record<string, string>;
}

function install(assets: AssetMap): { fetch: typeof globalThis.fetch; fellThrough: () => boolean } {
	let fellThrough = false;
	const win = {
		fetch: ((_input: unknown, _init?: unknown) => {
			fellThrough = true;
			return Promise.resolve(new Response("FALLTHROUGH"));
		}) as typeof globalThis.fetch,
	} as { fetch: typeof globalThis.fetch };
	const doc = { baseURI: "https://example.com/app/" };
	const src = template.replaceAll("__ASSETS_JSON__", JSON.stringify(assets));
	// Run the IIFE with our shims bound to the free `window`/`document` names.
	new Function("window", "document", src)(win, doc);
	return { fetch: win.fetch, fellThrough: () => fellThrough };
}

const ASSETS: AssetMap = { text: { "assets/example.glsl": "EMBEDDED" }, binary: {} };

test("serves embedded text for a URL-object input", async () => {
	const { fetch } = install(ASSETS);
	const res = await fetch(new URL("https://example.com/app/assets/example.glsl"));
	assert.equal(await res.text(), "EMBEDDED");
});

test("serves embedded text for a string input", async () => {
	const { fetch } = install(ASSETS);
	const res = await fetch("assets/example.glsl");
	assert.equal(await res.text(), "EMBEDDED");
});

test("serves embedded text for a Request-like input", async () => {
	const { fetch } = install(ASSETS);
	const res = await fetch({ url: "https://example.com/app/assets/example.glsl" } as unknown as Request);
	assert.equal(await res.text(), "EMBEDDED");
});

test("falls through to the real fetch for an unknown path", async () => {
	const { fetch, fellThrough } = install({ text: {}, binary: {} });
	await fetch(new URL("https://example.com/app/not-embedded.bin"));
	assert.ok(fellThrough(), "unknown paths must reach the underlying fetch");
});
