import { invoke } from "@tauri-apps/api/core";

/** A click target that must keep its normal action. */
const INTERACTIVE =
  "button, a, input, select, textarea, label, [role='button'], [contenteditable='true']";

/**
 * Drags the window from the window bar without Tauri's `data-tauri-drag-region`.
 *
 * On Windows the drag region becomes a native caption click. After a full-screen
 * modal covers the bar, or after an HMR reload, that native state can swallow
 * every click in the top strip until the webview is recreated. A plain mousedown
 * handler has no native hit area, so the bar's buttons and the page below stay
 * clickable.
 */
export function initWinbarDrag(): void {
  const bar = document.getElementById("winbar");
  if (!bar || bar.dataset.dragReady === "1") return;
  bar.dataset.dragReady = "1";

  bar.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest(INTERACTIVE)) return;
    void invoke("app_start_drag").catch(() => undefined);
  });

  bar.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest(INTERACTIVE)) return;
    void invoke<boolean>("app_toggle_maximize").catch(() => undefined);
  });
}
