// .tsx entry: compiled with the automatic Preact runtime (jsx settings in
// ts0.json) and declaration-emitted like any other module -- badge.d.ts types
// the component via import("preact").JSX.Element.
export interface BadgeProps {
	label: string;
}

export function Badge(props: BadgeProps) {
	return <span class="badge">{props.label}</span>;
}
