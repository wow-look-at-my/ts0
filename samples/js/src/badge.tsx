// .tsx entry.
export interface BadgeProps {
	label: string;
}

export function Badge(props: BadgeProps) {
	return <span class="badge">{props.label}</span>;
}
