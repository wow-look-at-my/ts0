// A Preact component authored in JSX. With the automatic runtime and
// jsxImportSource "preact", this must compile to preact/jsx-runtime calls
// (jsx/jsxs/Fragment) -- never React.createElement. A fragment is included
// on purpose so the Fragment import path is exercised too.
//
// The tagline's "any" is deliberate: it is JSX *text*, not a type, so the
// explicit-`any` ban must leave it alone. (The ban parses; a text search
// would fail this build.)
export function App() {
	return (
		<>
			<h1>ts0 + Preact</h1>
			<p class="tagline">JSX bundled through an HTML entry -- any questions?</p>
		</>
	);
}
