// Installed at the top of every single-file ts0 HTML bundle that has
// embeddable assets. Any fetch() the page makes for one of those assets is
// served from the embedded ASSETS map instead of going to the network, so
// code like
//
//     fetch(new URL("shaders/scene.wgsl", import.meta.url))
//
// keeps working when the bundle is opened from disk (file://) with no
// asset tree alongside it.
//
// The bundler substitutes the literal token at the const-assignment line
// below with the JSON-encoded { text, binary } map collected from the
// entry's directory. Binary assets are pre-encoded as data: URLs and
// handed back to the underlying fetch so the browser does the base64
// decode into a real ArrayBuffer.
(function () {
	const ASSETS = __ASSETS_JSON__;
	window.__ts0_embedded_paths__ = [].concat(Object.keys(ASSETS.text), Object.keys(ASSETS.binary));
	const _fetch = window.fetch.bind(window);

	function findKey(pathname) {
		for (const key in ASSETS.text) {
			if (pathname === key || pathname.endsWith("/" + key)) return ["text", key];
		}
		for (const key in ASSETS.binary) {
			if (pathname === key || pathname.endsWith("/" + key)) return ["binary", key];
		}
		return null;
	}

	window.fetch = function (input, init) {
		const url = typeof input === "string" ? input : (input && input.url) || "";
		let pathname;
		try {
			pathname = new URL(url, document.baseURI).pathname;
		} catch (_) {
			return _fetch(input, init);
		}
		const hit = findKey(pathname);
		if (!hit) return _fetch(input, init);
		const [kind, key] = hit;
		if (kind === "binary") return _fetch(ASSETS.binary[key], init);
		return Promise.resolve(
			new Response(ASSETS.text[key], {
				status: 200,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			}),
		);
	};
})();
