import { toast } from './lib/toast';

// A tiny bookmarklet: copy the page title, then show a toast. Bundled,
// minified, percent-encoded, and substituted into the javascript: href by
// `ts0 build` on the HTML entry.
void navigator.clipboard.writeText(document.title).then(() => {
	toast(`copied: ${document.title}`);
});
