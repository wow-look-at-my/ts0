import { greeting } from "./greet.ts";

const greetingEl = document.getElementById("greeting");
const countEl = document.getElementById("count");
const bumpEl = document.getElementById("bump");
const shaderEl = document.getElementById("shader");

if (greetingEl) {
	greetingEl.textContent = greeting("ts0");
}

let count = 0;
bumpEl?.addEventListener("click", () => {
	count += 1;
	if (countEl) countEl.textContent = String(count);
});

// Exercise the runtime fetch interceptor: this URL points at a sibling
// shader file that doesn't exist on disk next to the bundled output.
// In the bundle, the interceptor serves the embedded contents.
fetch(new URL("./assets/example.glsl", import.meta.url))
	.then((r) => r.text())
	.then((text) => {
		if (shaderEl) shaderEl.textContent = text.split("\n")[0];
	})
	.catch((err) => {
		if (shaderEl) shaderEl.textContent = `failed: ${err}`;
	});
