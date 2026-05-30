// A Preact component authored in JSX. With the automatic runtime and
// jsxImportSource "preact", this must compile to preact/jsx-runtime calls
// (jsx/jsxs/Fragment) -- never React.createElement. A fragment is included
// on purpose so the Fragment import path is exercised too.
export function App() {
	return (
		<>
			<h1>ts0 + Preact</h1>
			<p class="tagline">JSX bundled through an HTML entry.</p>
		</>
	);
}
