/**
 * Overlay floating widgets: pin state, ghost opacity, saved position and size,
 * plus the pointer drag/resize handles.
 *
 * One-way dependency: the page configures its queries through
 * configureWidgets; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";

type TabId = string;

interface WidgetDeps {
  isWidgetOpen: (tab: string) => boolean;
  bringToFront: (tab: string) => void;
  tabIds: () => string[];
}

let deps: WidgetDeps | null = null;

export function configureWidgets(next: WidgetDeps): void {
  deps = next;
  // The saved pins can only be validated against the tab list now: at module
  // load the deps are still null, and filtering then would erase every pin.
  widgetPins = loadWidgetPins();
}

function tabList(): string[] {
  return deps?.tabIds() ?? [];
}

/* ---------- Pinned widgets ---------- */

/** A pinned widget keeps its place and size, and stays over the game as a
 *  click-through HUD when the panel closes. */
const PIN_KEY = "efxlve-overlay-pins";
let widgetPins: Set<TabId> = new Set();

export function loadWidgetPins(): Set<TabId> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((id) => tabList().includes(id)) as TabId[]);
      }
    }
  } catch {
    // fallback
  }
  return new Set();
}

export function saveWidgetPins(): void {
  localStorage.setItem(PIN_KEY, JSON.stringify([...widgetPins]));
}

export function isWidgetPinned(tab: TabId): boolean {
  return widgetPins.has(tab);
}

const GHOST_OPACITY_KEY = "efxlve-overlay-ghost-opacity";

/** Per-widget opacity while the card sits in the click-through HUD. */
export function loadGhostOpacities(): Record<string, number> {
  try {
    const raw = localStorage.getItem(GHOST_OPACITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map: Record<string, number> = {};
    for (const [tab, value] of Object.entries(parsed)) {
      const number = Number(value);
      if (Number.isFinite(number)) map[tab] = Math.max(0.25, Math.min(1, number));
    }
    return map;
  } catch {
    return {};
  }
}

export function ghostOpacity(tab: TabId): number {
  return loadGhostOpacities()[tab] ?? 1;
}

export function setGhostOpacity(tab: TabId, value: number): void {
  const map = loadGhostOpacities();
  map[tab] = Math.max(0.25, Math.min(1, value));
  localStorage.setItem(GHOST_OPACITY_KEY, JSON.stringify(map));
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) widget.style.setProperty("--ghost-opacity", String(map[tab]));
}

/** Flips one widget's pin and repaints its header button. */
export function setWidgetPinned(tab: TabId, pinned: boolean): void {
  if (pinned) widgetPins.add(tab);
  else widgetPins.delete(tab);
  saveWidgetPins();
  applyWidgetPinState(tab);
  syncPinnedToRust();
}

export function applyWidgetPinState(tab: TabId): void {
  const pinned = isWidgetPinned(tab);
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) {
    widget.classList.toggle("is-pinned", pinned);
    widget.style.setProperty("--ghost-opacity", String(ghostOpacity(tab)));
  }
  const btn = document.querySelector<HTMLElement>(`[data-ov-widget-pin="${tab}"]`);
  if (!btn) return;
  btn.classList.toggle("is-pinned", pinned);
  btn.title = pinned ? t("overlay.widgetUnpin") : t("overlay.widgetPin");
}

/**
 * Pinned widgets that are actually open: only those survive the close as a
 * ghost HUD. Rust keeps the number so the hotkey and the close button agree
 * without a round trip at close time.
 */
export function pinnedOnScreen(): TabId[] {
  return [...widgetPins].filter((tab) => tab !== "browser" && (deps?.isWidgetOpen(tab) ?? false));
}

export function syncPinnedToRust(): void {
  void invoke("overlay_set_pinned", { count: pinnedOnScreen().length }).catch(() => undefined);
}

interface WidgetPos {
  x: number;
  y: number;
}

/** The floating bar ends at 56px; a widget header must start below it. */
const OVERLAY_SAFE_TOP = 64;
const WIDGET_MARGIN = 8;

export function getDefaultWidgetPos(tab: TabId): WidgetPos {
  const winW = typeof window !== "undefined" ? window.innerWidth || 1920 : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight || 1080 : 1080;
  const musicX = Math.max(WIDGET_MARGIN, winW - 384);
  // The three default widgets form one row on a 1280px panel: performance,
  // captures, music. Below that the captures column goes under performance
  // instead of being clipped by the music widget.
  const topRowShotsX = 24 + 350 + 16;
  const topRowFits = topRowShotsX + 340 + 16 <= musicX;
  const shotsX = topRowFits ? topRowShotsX : 24;
  const shotsY = topRowFits ? 72 : 72 + 380 + 12;
  const lowerY = Math.max(OVERLAY_SAFE_TOP, winH - 328);
  switch (tab) {
    case "perf":
      return { x: 24, y: 72 };
    case "shots":
      return { x: shotsX, y: shotsY };
    case "clip":
      // Bottom-left, on its own: it is the one widget worth leaving pinned
      // while playing, so it should not sit under the performance panel.
      return { x: 24, y: lowerY };
    case "music":
      return { x: musicX, y: 72 };
    case "audio":
      // Bottom-center: clear of the performance/music row and the clip/notes
      // corners.
      return { x: Math.max(24, Math.floor((winW - 380) / 2)), y: Math.max(OVERLAY_SAFE_TOP, winH - 460) };
    case "discord":
      return { x: Math.max(24, winW - 740), y: 72 };
    case "chat":
      return { x: Math.max(24, winW - 390), y: 72 };
    case "ach":
      return { x: Math.max(24, Math.min(380, winW - 420)), y: 72 };
    case "browser":
      return { x: Math.max(24, Math.floor((winW - 500) / 2)), y: 80 };
    case "notes":
      return { x: Math.max(24, winW - 360), y: Math.max(OVERLAY_SAFE_TOP, winH - 400) };
    case "settings":
      return { x: Math.max(24, Math.floor((winW - 440) / 2)), y: 90 };
    default:
      return { x: 24, y: 72 };
  }
}

export function loadWidgetPos(tab: TabId): WidgetPos {
  try {
    const raw = localStorage.getItem(`efxlve-ov-pos-${tab}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        // Older builds could persist a clamp performed while the hidden window
        // was 1x1. Those 8/8 (or 8/64 after the topbar guard) entries stacked
        // every widget in one corner; treat them as missing and let the tiled
        // default win.
        if (parsed.y < OVERLAY_SAFE_TOP || (parsed.x <= WIDGET_MARGIN && parsed.y <= OVERLAY_SAFE_TOP)) {
          return getDefaultWidgetPos(tab);
        }
        const winW = window.innerWidth || 1920;
        const winH = window.innerHeight || 1080;
        const size = loadWidgetSize(tab);
        const maxX = Math.max(WIDGET_MARGIN, winW - size.w - WIDGET_MARGIN);
        const maxY = Math.max(OVERLAY_SAFE_TOP, winH - size.h - WIDGET_MARGIN);
        const clampedX = Math.max(WIDGET_MARGIN, Math.min(maxX, parsed.x));
        const clampedY = Math.max(OVERLAY_SAFE_TOP, Math.min(maxY, parsed.y));
        return { x: clampedX, y: clampedY };
      }
    }
  } catch {
    // fallback
  }
  return getDefaultWidgetPos(tab);
}

export function saveWidgetPos(tab: TabId, pos: WidgetPos): void {
  localStorage.setItem(`efxlve-ov-pos-${tab}`, JSON.stringify(pos));
}

interface WidgetSizeLimits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

interface WidgetSize {
  w: number;
  h: number;
}

export function getWidgetSizeLimits(tab: TabId): WidgetSizeLimits {
  switch (tab) {
    case "perf":
      return { minW: 310, minH: 350, maxW: 600, maxH: 600 };
    case "shots":
      return { minW: 280, minH: 240, maxW: 800, maxH: 800 };
    case "clip":
      return { minW: 280, minH: 220, maxW: 520, maxH: 620 };
    case "music":
      return { minW: 260, minH: 140, maxW: 600, maxH: 800 };
    case "audio":
      return { minW: 300, minH: 260, maxW: 560, maxH: 700 };
    case "discord":
      return { minW: 280, minH: 320, maxW: 600, maxH: 900 };
    case "chat":
      return { minW: 300, minH: 320, maxW: 800, maxH: 900 };
    case "ach":
      return { minW: 280, minH: 260, maxW: 700, maxH: 800 };
    case "notes":
      return { minW: 260, minH: 220, maxW: 700, maxH: 700 };
    case "settings":
      return { minW: 360, minH: 340, maxW: 720, maxH: 850 };
    default:
      return { minW: 260, minH: 200, maxW: 800, maxH: 800 };
  }
}

export function getDefaultWidgetSize(tab: TabId): WidgetSize {
  switch (tab) {
    case "perf":
      return { w: 350, h: 380 };
    case "shots":
      // The narrow fallback places captures under performance; keep it short
      // enough to stay above the taskbar on a 1080p monitor.
      return {
        w: 340,
        h: (window.innerWidth || 1920) < 1200 && (window.innerHeight || 1080) < 920 ? 360 : 420,
      };
    case "clip":
      return { w: 320, h: 300 };
    case "music":
      return { w: 360, h: 420 };
    case "audio":
      return { w: 380, h: 440 };
    case "discord":
      return { w: 330, h: 540 };
    case "chat":
      return { w: 380, h: 540 };
    case "ach":
      return { w: 380, h: 480 };
    case "notes":
      return { w: 340, h: 360 };
    case "settings":
      return { w: 480, h: 580 };
    default:
      return { w: 340, h: 400 };
  }
}

export function loadWidgetSize(tab: TabId): WidgetSize {
  const limits = getWidgetSizeLimits(tab);
  const def = getDefaultWidgetSize(tab);
  try {
    const raw = localStorage.getItem(`efxlve-ov-size-${tab}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { w?: number; h?: number };
      if (typeof parsed.w === "number" && typeof parsed.h === "number") {
        const winW = typeof window !== "undefined" ? window.innerWidth || 1920 : 1920;
        const winH = typeof window !== "undefined" ? window.innerHeight || 1080 : 1080;
        const clampedW = Math.max(limits.minW, Math.min(Math.min(limits.maxW, winW - 16), parsed.w));
        const clampedH = Math.max(limits.minH, Math.min(Math.min(limits.maxH, winH - 60), parsed.h));
        return { w: clampedW, h: clampedH };
      }
    }
  } catch {
    // fallback
  }
  return def;
}

export function saveWidgetSize(tab: TabId, size: WidgetSize): void {
  localStorage.setItem(`efxlve-ov-size-${tab}`, JSON.stringify(size));
}

/** Toggles responsive helper classes on widget containers when resized. */
export function syncWidgetSizeClasses(tab: TabId, w: number, h: number): void {
  const el = document.getElementById(`ov-widget-${tab}`);
  if (!el) return;
  el.classList.toggle("ov-compact-h", h < 380);
  el.classList.toggle("ov-mini-h", h < 240);
  el.classList.toggle("ov-narrow-w", w < 300);
}

/** Keeps every open widget on screen when the panel changes size or monitor. */
export function clampWidgetsIntoView(): void {
  const winW = window.innerWidth || 1920;
  const winH = window.innerHeight || 1080;
  // A hidden overlay is often resized to a 1x1 helper surface. Clamping then
  // writes 8/8 over every saved position, which is exactly how all widgets
  // ended up stacked in the corner. Never persist a layout from that state.
  if (document.hidden || winW < 480 || winH < 320) return;
  for (const tab of tabList()) {
    const el = document.getElementById(`ov-widget-${tab}`);
    if (!el || el.style.display === "none") continue;
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 300;
    const maxX = Math.max(WIDGET_MARGIN, winW - width - WIDGET_MARGIN);
    const maxY = Math.max(OVERLAY_SAFE_TOP, winH - height - WIDGET_MARGIN);
    const x = Math.max(WIDGET_MARGIN, Math.min(maxX, el.offsetLeft));
    const y = Math.max(OVERLAY_SAFE_TOP, Math.min(maxY, el.offsetTop));
    if (x === el.offsetLeft && y === el.offsetTop) continue;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    saveWidgetPos(tab, { x, y });
  }
}

/** Puts every open widget back on its default tile and forgets saved places. */
export function resetWidgetLayout(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("efxlve-ov-pos-")) localStorage.removeItem(key);
  }
  for (const tab of tabList()) {
    const widget = document.getElementById(`ov-widget-${tab}`);
    if (!widget || widget.style.display === "none") continue;
    const pos = getDefaultWidgetPos(tab);
    widget.style.left = `${pos.x}px`;
    widget.style.top = `${pos.y}px`;
  }
  clampWidgetsIntoView();
}


let draggingTab: TabId | null = null;
let dragStartX = 0;
let dragStartY = 0;
let widgetStartLeft = 0;
let widgetStartTop = 0;
let draggingInitialized = false;

/** Ends a drag: saves the place and drops the grabbing state. */
export function finishWidgetDrag(): void {
  if (!draggingTab) return;
  const el = document.getElementById(`ov-widget-${draggingTab}`);
  if (el) saveWidgetPos(draggingTab, { x: el.offsetLeft, y: el.offsetTop });
  document.querySelectorAll(".ov-widget-header.is-dragging").forEach((header) => {
    header.classList.remove("is-dragging");
  });
  draggingTab = null;
}

export function initWidgetDragging(): void {
  if (draggingInitialized) return;
  draggingInitialized = true;

  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const widget = target.closest<HTMLElement>(".ov-widget");
    if (widget && widget.dataset.widgetId) {
      deps?.bringToFront(widget.dataset.widgetId);
    }

    const header = target.closest<HTMLElement>("[data-widget-drag]");
    if (!header) return;

    if (target.closest("button, input, [data-ov-toggle], [data-ov-widget-close], a")) return;

    const tabId = header.dataset.widgetDrag as TabId | undefined;
    if (!tabId) return;
    // A pinned widget keeps its place.
    if (isWidgetPinned(tabId)) return;

    const el = document.getElementById(`ov-widget-${tabId}`);
    if (!el) return;

    draggingTab = tabId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    widgetStartLeft = el.offsetLeft;
    widgetStartTop = el.offsetTop;
    header.classList.add("is-dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!draggingTab) return;
    // Released outside the window: no mouseup will arrive.
    if ((e.buttons & 1) === 0) {
      finishWidgetDrag();
      return;
    }
    const el = document.getElementById(`ov-widget-${draggingTab}`);
    if (!el) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const winW = window.innerWidth || 1920;
    const winH = window.innerHeight || 1080;
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 300;

    const newX = Math.max(WIDGET_MARGIN, Math.min(Math.max(WIDGET_MARGIN, winW - width - WIDGET_MARGIN), widgetStartLeft + dx));
    const newY = Math.max(OVERLAY_SAFE_TOP, Math.min(Math.max(OVERLAY_SAFE_TOP, winH - height - WIDGET_MARGIN), widgetStartTop + dy));

    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
  });

  window.addEventListener("mouseup", finishWidgetDrag);
}

let resizingTab: TabId | null = null;
let resizeStartX = 0;
let resizeStartY = 0;
let widgetStartW = 0;
let widgetStartH = 0;
let resizingInitialized = false;

/** Ends a resize: stores the final size and drops the resize cursor. */
export function finishWidgetResize(): void {
  if (!resizingTab) return;
  const el = document.getElementById(`ov-widget-${resizingTab}`);
  if (el) {
    saveWidgetSize(resizingTab, { w: el.offsetWidth, h: el.offsetHeight });
    syncWidgetSizeClasses(resizingTab, el.offsetWidth, el.offsetHeight);
  }
  resizingTab = null;
  document.body.style.cursor = "";
}

export function initWidgetResizing(): void {
  if (resizingInitialized) return;
  resizingInitialized = true;

  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const resizer = target.closest<HTMLElement>("[data-widget-resize]");
    if (!resizer) return;

    const tabId = resizer.dataset.widgetResize as TabId | undefined;
    if (!tabId) return;
    // A pinned widget keeps its size (its handle is hidden as well).
    if (isWidgetPinned(tabId)) return;

    const el = document.getElementById(`ov-widget-${tabId}`);
    if (!el) return;

    deps?.bringToFront(tabId);
    resizingTab = tabId;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    widgetStartW = el.offsetWidth;
    widgetStartH = el.offsetHeight;
    document.body.style.cursor = "nwse-resize";
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener("mousemove", (e) => {
    if (!resizingTab) return;
    // Released outside the window: no mouseup will arrive.
    if ((e.buttons & 1) === 0) {
      finishWidgetResize();
      return;
    }
    const el = document.getElementById(`ov-widget-${resizingTab}`);
    if (!el) return;

    const limits = getWidgetSizeLimits(resizingTab);
    const winW = window.innerWidth || 1920;
    const winH = window.innerHeight || 1080;

    const maxAllowedW = Math.min(limits.maxW, Math.max(limits.minW, winW - el.offsetLeft - 8));
    const maxAllowedH = Math.min(limits.maxH, Math.max(limits.minH, winH - el.offsetTop - 8));

    const newW = Math.max(limits.minW, Math.min(maxAllowedW, widgetStartW + (e.clientX - resizeStartX)));
    const newH = Math.max(limits.minH, Math.min(maxAllowedH, widgetStartH + (e.clientY - resizeStartY)));

    el.style.width = `${newW}px`;
    el.style.height = `${newH}px`;
    syncWidgetSizeClasses(resizingTab, newW, newH);
  });

  window.addEventListener("mouseup", finishWidgetResize);
}


/** Pins the Settings view paints as per-widget rows. */
export function pinnedWidgetTabs(): string[] {
  return [...widgetPins];
}
