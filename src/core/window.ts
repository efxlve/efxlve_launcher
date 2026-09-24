/**
 * Window shell: maximize icon, throttled resize handling and global shortcuts.
 *
 * The resize handler keeps the embedded store webview, the nav indicator and
 * the downloads chart in sync without layout thrashing (rAF-throttled).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./constants";
import { S } from "./state";
import { drawSpeedCanvas } from "../features/downloads/downloads-view";
import { syncStoreViewSize } from "../features/store/store-view";
export function updateMaxIcon(isMax?: boolean): void {
  const iconEl = document.getElementById("win-max-icon");
  if (!iconEl) return;
  const setIcon = (max: boolean) => {
    if (max) {
      iconEl.innerHTML = `<rect width="7" height="7" x="2.5" y="0.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M0.5 2.5v7h7v-7h-7z" fill="none" stroke="currentColor" stroke-width="1"/>`;
    } else {
      iconEl.innerHTML = `<rect width="9" height="9" x="0.5" y="0.5" fill="none" stroke="currentColor" stroke-width="1"/>`;
    }
  };
  if (typeof isMax === "boolean") {
    setIcon(isMax);
  } else if (isTauri) {
    invoke<boolean>("app_is_maximized").then(setIcon).catch(() => {});
  }
}

export function handleWindowResize(): void {
  updateMaxIcon();
  if (S.view === "downloads" && typeof drawSpeedCanvas === "function") {
    drawSpeedCanvas();
  }
  if (S.view === "store") {
    syncStoreViewSize();
    window.clearTimeout(S.storeResizeTimer);
    S.storeResizeTimer = window.setTimeout(() => {
      syncStoreViewSize();
      window.setTimeout(syncStoreViewSize, 80);
      window.setTimeout(syncStoreViewSize, 200);
      window.setTimeout(syncStoreViewSize, 450);
    }, 40);
  }
}

document.getElementById("winbar")?.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a")) return;
  if (isTauri) {
    void invoke<boolean>("app_toggle_maximize").then((isMax) => {
      updateMaxIcon(isMax);
      handleWindowResize();
      window.setTimeout(handleWindowResize, 100);
      window.setTimeout(handleWindowResize, 250);
      window.setTimeout(handleWindowResize, 500);
    });
  }
});


export function throttledWindowResize(): void {
  if (S.resizeRaf !== null) return;
  S.resizeRaf = window.requestAnimationFrame(() => {
    S.resizeRaf = null;
    handleWindowResize();
  });
}

window.addEventListener("resize", throttledWindowResize, { passive: true });

/* ---------- Sidebar keyboard shortcuts ----------
   Ctrl+1 Store · Ctrl+2 Library · Ctrl+3 Downloads · Ctrl+, Settings */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (!S.epicAccount || S.epicPhase !== "library" || S.authLoading) return;
  const targets: Record<string, string> = {
    "1": '[data-act="open-store"]',
    "2": '[data-view="library"]',
    "3": '[data-view="downloads"]',
    ",": '[data-view="settings"]',
  };
  const sel = targets[e.key];
  if (!sel) return;
  e.preventDefault();
  document.querySelector<HTMLElement>(`#sidebar ${sel}`)?.click();
});

/* ---------- Webview hardening: block accidental reload and zoom ----------
   F5 / Ctrl+R (reload) and Ctrl +/-/0 (zoom) break the console experience. */
document.addEventListener(
  "keydown",
  (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "f5" || (ctrl && (k === "r" || k === "+" || k === "-" || k === "=" || k === "0"))) {
      e.preventDefault();
    }
  },
  { capture: true },
);
