import styles from "./styles.css" with { type: "css" };
import { THEME_NAME } from "./theme.ts";

// The stylesheet is fetched and constructed by the browser, not embedded in
// this bundle: the import above survives bundling verbatim.
document.adoptedStyleSheets = [styles];
document.documentElement.dataset.theme = THEME_NAME;
