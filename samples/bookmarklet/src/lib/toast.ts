export function toast(message: string): void {
	const el = document.createElement('div');
	el.textContent = message;
	el.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#111;color:#fff;padding:8px 12px;z-index:99999';
	document.body.appendChild(el);
	setTimeout(() => el.remove(), 1500);
}
