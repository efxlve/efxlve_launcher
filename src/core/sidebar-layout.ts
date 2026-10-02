/**
 * Resizable left sidebar that also snaps open/closed like a drawer.
 *
 * Width is set as a real pixel length on #sidebar so CSS can interpolate it.
 * Custom properties do not animate in WebView2 unless registered, which still
 * snapped here — so the rail animates `width`, not `--sidebar-w`.
 */

import { SIDEBAR_EXPANDED_W_KEY, SIDEBAR_W_KEY } from "./constants";
import { handleWindowResize, throttledWindowResize } from "./window";
import { t } from "../i18n";

export const SIDEBAR_MIN = 72;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 252;
export const SIDEBAR_COLLAPSE_AT = 160;

/** Window width that folds the rail and the header search into compact mode. */
const COMPACT_AT = 1180;
/** Unfold again only after this much room (hysteresis: no flapping). */
const COMPACT_LEAVE_AT = 1240;

const DRAWER_MS = 280;
const DRAWER_EASE = "cubic-bezier(0.2, 0, 0, 1)";

function clampWidth(px: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}

function readStoredWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (Number.isFinite(raw)) return clampWidth(raw);
  } catch {
    /* ignore quota / private mode */
  }
  return SIDEBAR_DEFAULT;
}

function readExpandedWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_EXPANDED_W_KEY));
    if (Number.isFinite(raw) && raw >= SIDEBAR_COLLAPSE_AT) return clampWidth(raw);
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT;
}

function persist(key: string, px: number): void {
  try {
    localStorage.setItem(key, String(px));
  } catch {
    /* ignore */
  }
}

function sidebarEl(): HTMLElement | null {
  return document.getElementById("sidebar");
}

function measuredWidth(): number {
  const el = sidebarEl();
  if (el) {
    const w = el.getBoundingClientRect().width;
    if (w > 0) return w;
  }
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || SIDEBAR_DEFAULT;
}

function syncToggleUi(width: number): void {
  const collapsed = width < SIDEBAR_COLLAPSE_AT;
  const btn = document.getElementById("sb-toggle");
  if (!btn) return;
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.title = collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar");
  const label = btn.querySelector<HTMLElement>(".sb-toggle-label");
  if (label) label.textContent = collapsed ? t("nav.expand") : t("nav.collapse");
}

let drawerTimer = 0;
let drawerLocked = false;

function finishDrawerAnim(): void {
  const root = document.documentElement;
  root.classList.remove("sb-animating");
  root.classList.add("sb-no-anim");
  const el = sidebarEl();
  if (el) el.style.transition = "";
  drawerLocked = false;
  handleWindowResize();
}

function paintWidth(width: number): void {
  document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
  const el = sidebarEl();
  if (el) el.style.width = `${width}px`;
}

/** Applies width to :root, the rail element, and the icon-only class. */
export function applySidebarWidth(px: number, persistWidth = false, syncLabels = true): void {
  const width = clampWidth(px);
  paintWidth(width);
  if (syncLabels) document.documentElement.classList.toggle("sb-narrow", width < SIDEBAR_COLLAPSE_AT);
  syncToggleUi(width);
  if (persistWidth) {
    persist(SIDEBAR_W_KEY, width);
    if (width >= SIDEBAR_COLLAPSE_AT) persist(SIDEBAR_EXPANDED_W_KEY, width);
  }
}

/** Open or close the rail with an interpolated pixel width. */
export function toggleSidebarDrawer(): void {
  if (drawerLocked) return;
  drawerLocked = true;
  const from = measuredWidth();
  const collapsing = from >= SIDEBAR_COLLAPSE_AT;
  const target = collapsing ? SIDEBAR_MIN : readExpandedWidth();
  const root = document.documentElement;
  const el = sidebarEl();
  window.clearTimeout(drawerTimer);

  if (collapsing) persist(SIDEBAR_EXPANDED_W_KEY, from);

  // Pin the current pixel width, then enable the transition, then set the target.
  if (el) {
    el.style.transition = "none";
    el.style.width = `${from}px`;
    void el.offsetWidth;
    el.style.transition = `width ${DRAWER_MS}ms ${DRAWER_EASE}`;
  }
  root.classList.remove("sb-no-anim");
  root.classList.add("sb-animating");
  root.classList.toggle("sb-narrow", target < SIDEBAR_COLLAPSE_AT);
  syncToggleUi(target);

  paintWidth(target);
  persist(SIDEBAR_W_KEY, target);
  if (target >= SIDEBAR_COLLAPSE_AT) persist(SIDEBAR_EXPANDED_W_KEY, target);

  drawerTimer = window.setTimeout(() => {
    finishDrawerAnim();
  }, DRAWER_MS);
}

/** Refresh the drawer chevron label after i18n is ready. */
export function refreshSidebarToggle(): void {
  syncToggleUi(measuredWidth());
}

let compactMode = false;

/**
 * Folds the rail to icons on a narrow window and unfolds it when there is room
 * again. The player's own width is kept for the next unfold.
 */
function autoFitSidebar(): void {
  const width = window.innerWidth;
  if (!compactMode && width < COMPACT_AT) {
    compactMode = true;
  } else if (compactMode && width >= COMPACT_LEAVE_AT) {
    compactMode = false;
  } else {
    return;
  }
  document.documentElement.classList.toggle("win-compact", compactMode);
  if (compactMode) {
    if (measuredWidth() >= SIDEBAR_COLLAPSE_AT) applySidebarWidth(SIDEBAR_MIN);
  } else {
    applySidebarWidth(readExpandedWidth());
  }
  handleWindowResize();
}

export function initSidebarLayout(): void {
  applySidebarWidth(readStoredWidth());

  const handle = document.getElementById("sb-resize");
  if (!handle || handle.dataset.ready === "1") return;
  handle.dataset.ready = "1";

  autoFitSidebar();
  window.addEventListener("resize", autoFitSidebar);

  let dragging = false;
  let dragMoved = false;
  let startX = 0;

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    if (Math.abs(e.clientX - startX) > 6) dragMoved = true;
    applySidebarWidth(e.clientX);
    throttledWindowResize();
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sb-resizing");
    document.documentElement.classList.remove("sb-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!dragMoved) {
      toggleSidebarDrawer();
      return;
    }
    applySidebarWidth(measuredWidth(), true);
    handleWindowResize();
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    dragMoved = false;
    startX = e.clientX;
    document.body.classList.add("sb-resizing");
    document.documentElement.classList.add("sb-resizing");
    handle.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    applySidebarWidth(SIDEBAR_DEFAULT, true);
    handleWindowResize();
  });

  handle.addEventListener("keydown", (e) => {
    const width = measuredWidth();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applySidebarWidth(width - 16, true);
      handleWindowResize();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applySidebarWidth(width + 16, true);
      handleWindowResize();
    } else if (e.key === "Home" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSidebarDrawer();
    } else if (e.key === "End") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_MAX, true);
      handleWindowResize();
    }
  });
}
