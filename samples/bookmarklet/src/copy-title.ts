import { toast } from './lib/toast';

// A tiny bookmarklet: copy the page title, then show a toast.
void navigator.clipboard.writeText(document.title).then(() => {
	toast(`copied: ${document.title}`);
});
