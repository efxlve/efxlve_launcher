/**
 * User stylesheet.
 *
 * Settings > Appearance lets the user paste CSS over the launcher. It is kept
 * in `localStorage`, applied as one `<style>` element (so it always wins on
 * order, never on `!important` guesswork), and injected from `index.html`
 * before the first paint so a saved sheet never flashes off and on.
 */

import { CUSTOM_CSS_KEY, CUSTOM_CSS_LIMIT } from "./constants";

const STYLE_ID = "efxlve-custom-css";

export function readCustomCss(): string {
  try {
    return localStorage.getItem(CUSTOM_CSS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Applies a stylesheet; empty text removes the element. */
export function applyCustomCss(css: string): void {
  const existing = document.getElementById(STYLE_ID);
  if (!css.trim()) {
    existing?.remove();
    return;
  }
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
  if (!(existing instanceof HTMLStyleElement)) {
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/** Saves and applies. Returns false when the text is over the limit. */
export function saveCustomCss(css: string): boolean {
  const text = css.trim();
  if (text.length > CUSTOM_CSS_LIMIT) return false;
  try {
    if (text) localStorage.setItem(CUSTOM_CSS_KEY, text);
    else localStorage.removeItem(CUSTOM_CSS_KEY);
  } catch {
    return false;
  }
  applyCustomCss(text);
  return true;
}
