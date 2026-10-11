/**
 * Surface tokens for the child-webview hosts (the notifications dropdown and
 * the changelog card).
 *
 * Those hosts live outside the app document, so they receive the launcher's
 * current values inline — the soft-black surface theme included — and paint the
 * same card as the in-page modals.
 */
const TOKENS = [
  "--bg",
  "--surface-1",
  "--surface-2",
  "--text",
  "--text-2",
  "--text-3",
  "--line",
  "--line-strong",
  "--accent",
  "--on-accent",
  "--accent-tint",
  "--ok",
  "--warn",
  "--err",
  "--r-sm",
  "--r-md",
];

export function overlayThemeStyle(): string {
  const root = getComputedStyle(document.documentElement);
  const css = TOKENS.map((name) => {
    const value = root.getPropertyValue(name).trim();
    return value ? `${name}: ${value};` : "";
  }).join("");
  return `<style>:root{${css}}</style>`;
}
