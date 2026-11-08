/**
 * Transparent game-page logo layout, presets, persistence and live hero drag.
 *
 * Coordinates `x` and `y` live in `[0, 100]` and pair with self-relative
 * translation `translate(-x%, -y%)`, so `(50, 50)` is exact center, `(3.5, 72)`
 * sits cleanly above the bottom-left metadata line, and the logo never clips
 * outside `.gp-hero` at any aspect ratio or window width.
 */

import { CUSTOM_LOGO_LAYOUTS_KEY, CUSTOM_LOGO_SIZES_KEY } from "../../core/constants";
import { repaintGameHero } from "../../core/render";
import { storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { CustomLogoLayout, CustomLogoSize, LogoAnchor } from "../../core/types";

export const LOGO_SCALE_MIN = 0.4;
export const LOGO_SCALE_MAX = 1.8;

export const LOGO_ANCHOR_COORDS: Record<Exclude<LogoAnchor, "custom">, { x: number; y: number }> = {
  "bottom-left": { x: 3.5, y: 72 },
  "bottom-center": { x: 50, y: 82 },
  "bottom-right": { x: 96.5, y: 82 },
  center: { x: 50, y: 50 },
  "top-left": { x: 3.5, y: 16 },
  "top-center": { x: 50, y: 14 },
};

export const LOGO_ANCHOR_ORDER: Exclude<LogoAnchor, "custom">[] = [
  "top-left",
  "top-center",
  "center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function legacyScale(appName: string): number {
  const legacy: CustomLogoSize | undefined = S.customLogoSizes[appName];
  if (legacy === "small") return 0.75;
  if (legacy === "large") return 1.3;
  return 1;
}

function persistLogoLayouts(): void {
  try {
    if (Object.keys(S.customLogoLayouts).length === 0) {
      localStorage.removeItem(CUSTOM_LOGO_LAYOUTS_KEY);
    } else {
      localStorage.setItem(CUSTOM_LOGO_LAYOUTS_KEY, JSON.stringify(S.customLogoLayouts));
    }
  } catch {
    // Quota or private mode leaves in-memory state intact.
  }
}

/** Custom transparent logo URL for `appName` (or a merged store sibling). */
export function customLogoOf(appName: string, title?: string): string {
  const direct = S.customLogos[appName]?.trim();
  if (direct) return direct;
  if (!S.separateCopies) {
    const resolvedTitle = title ?? summaryOf(appName)?.title ?? "";
    if (resolvedTitle) {
      for (const key of storeKeysForTitle(resolvedTitle)) {
        const sibling = S.customLogos[key]?.trim();
        if (sibling) return sibling;
      }
    }
  }
  return "";
}

/** Layout for `appName` (falling back to sibling copy or bottom-left 100%). */
export function getLogoLayout(appName: string, title?: string): CustomLogoLayout {
  let stored = S.customLogoLayouts[appName];
  if (!stored && !S.separateCopies) {
    const resolvedTitle = title ?? summaryOf(appName)?.title ?? "";
    if (resolvedTitle) {
      for (const key of storeKeysForTitle(resolvedTitle)) {
        if (S.customLogoLayouts[key]) {
          stored = S.customLogoLayouts[key];
          break;
        }
      }
    }
  }
  if (stored) {
    return {
      anchor: stored.anchor || "bottom-left",
      x: clamp(stored.x, 2, 98),
      y: clamp(stored.y, 4, 94),
      scale: clamp(stored.scale, LOGO_SCALE_MIN, LOGO_SCALE_MAX),
    };
  }
  return {
    anchor: "bottom-left",
    x: LOGO_ANCHOR_COORDS["bottom-left"].x,
    y: LOGO_ANCHOR_COORDS["bottom-left"].y,
    scale: legacyScale(appName),
  };
}

/** Inline CSS custom properties driving `.gp-hero-logo-layer`. */
export function logoStyleVars(layout: CustomLogoLayout): string {
  const x = round1(clamp(layout.x, 2, 98));
  const y = round1(clamp(layout.y, 4, 94));
  const scale = round2(clamp(layout.scale, LOGO_SCALE_MIN, LOGO_SCALE_MAX));
  return `--logo-x:${x};--logo-y:${y};--logo-scale:${scale};`;
}

function syncLayoutToSiblingKeys(appName: string, layout: CustomLogoLayout): void {
  if (S.separateCopies) return;
  const title = summaryOf(appName)?.title;
  if (!title) return;
  for (const key of storeKeysForTitle(title)) {
    S.customLogoLayouts[key] = layout;
  }
}

function applyLogoVarsInPlace(appName: string, layout: CustomLogoLayout): void {
  const openApp = S.currentModalAppName;
  const isMatch =
    openApp === appName ||
    (!S.separateCopies &&
      Boolean(openApp) &&
      Boolean(summaryOf(openApp!)) &&
      storeKeysForTitle(summaryOf(openApp!)!.title).includes(appName));
  if (isMatch) {
    const layer = document.querySelector<HTMLElement>(".gp-hero-logo-layer");
    if (layer) {
      layer.style.setProperty("--logo-x", String(round1(layout.x)));
      layer.style.setProperty("--logo-y", String(round1(layout.y)));
      layer.style.setProperty("--logo-scale", String(round2(layout.scale)));
    }
    const hudScale = document.getElementById("gp-logo-adjust-scale") as HTMLInputElement | null;
    if (hudScale) hudScale.value = String(Math.round(layout.scale * 100));
    const hudPct = document.getElementById("gp-logo-adjust-pct");
    if (hudPct) hudPct.textContent = `${Math.round(layout.scale * 100)}%`;
  }
  document.querySelectorAll<HTMLElement>("[data-logo-anchor-btn]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.anchor === layout.anchor);
  });
}

export function setLogoAnchor(appName: string, anchor: Exclude<LogoAnchor, "custom">): CustomLogoLayout {
  const coords = LOGO_ANCHOR_COORDS[anchor] ?? LOGO_ANCHOR_COORDS["bottom-left"];
  const prev = getLogoLayout(appName);
  const next: CustomLogoLayout = {
    anchor,
    x: coords.x,
    y: coords.y,
    scale: prev.scale,
  };
  S.customLogoLayouts[appName] = next;
  syncLayoutToSiblingKeys(appName, next);
  persistLogoLayouts();
  applyLogoVarsInPlace(appName, next);
  return next;
}

export function setLogoScale(appName: string, scale: number): CustomLogoLayout {
  const prev = getLogoLayout(appName);
  const next: CustomLogoLayout = {
    ...prev,
    scale: round2(clamp(scale, LOGO_SCALE_MIN, LOGO_SCALE_MAX)),
  };
  S.customLogoLayouts[appName] = next;
  syncLayoutToSiblingKeys(appName, next);
  persistLogoLayouts();
  applyLogoVarsInPlace(appName, next);
  return next;
}

export function setLogoCustomPosition(appName: string, x: number, y: number): CustomLogoLayout {
  const prev = getLogoLayout(appName);
  const next: CustomLogoLayout = {
    anchor: "custom",
    x: round1(clamp(x, 2, 98)),
    y: round1(clamp(y, 4, 94)),
    scale: prev.scale,
  };
  S.customLogoLayouts[appName] = next;
  syncLayoutToSiblingKeys(appName, next);
  persistLogoLayouts();
  applyLogoVarsInPlace(appName, next);
  return next;
}

export function resetLogoLayout(appName: string): void {
  delete S.customLogoLayouts[appName];
  delete S.customLogoSizes[appName];
  if (!S.separateCopies) {
    const title = summaryOf(appName)?.title;
    if (title) {
      for (const key of storeKeysForTitle(title)) {
        delete S.customLogoLayouts[key];
        delete S.customLogoSizes[key];
      }
    }
  }
  persistLogoLayouts();
  try {
    localStorage.setItem(CUSTOM_LOGO_SIZES_KEY, JSON.stringify(S.customLogoSizes));
  } catch {
    // Ignore storage errors.
  }
  repaintGameHero(appName);
}

export function startLogoHeroAdjust(appName: string): void {
  if (!appName || !customLogoOf(appName)) return;
  S.isAdjustingLogo = true;
  repaintGameHero(appName);
}

export function stopLogoHeroAdjust(appName?: string): void {
  if (!S.isAdjustingLogo) return;
  S.isAdjustingLogo = false;
  const target = appName || S.currentModalAppName;
  if (target) repaintGameHero(target);
}

let dragWired = false;

/**
 * Global pointer & wheel handler for interactive logo dragging on `.gp-hero`
 * while `S.isAdjustingLogo` is active. Registered once at module load.
 */
export function initLogoHeroDrag(): void {
  if (dragWired) return;
  dragWired = true;

  let activePointerId: number | null = null;
  let dragApp = "";
  let startClientX = 0;
  let startClientY = 0;
  let startX = 0;
  let startY = 0;
  let spanW = 1;
  let spanH = 1;

  document.addEventListener("pointerdown", (ev) => {
    if (!S.isAdjustingLogo || ev.button !== 0) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // Ignore clicks on toolbar controls / buttons inside the hero.
    if (target.closest(".gp-logo-adjust-bar, .gp-hero-top, button, input, a")) return;
    const hero = target.closest<HTMLElement>(".gp-hero.is-adjusting-logo");
    if (!hero || !S.currentModalAppName) return;
    const layer = hero.querySelector<HTMLElement>(".gp-hero-logo-layer");
    if (!layer) return;

    ev.preventDefault();
    dragApp = S.currentModalAppName;
    const layout = getLogoLayout(dragApp);
    const heroRect = hero.getBoundingClientRect();
    const logoRect = layer.getBoundingClientRect();

    // If user clicked outside the logo box on the hero canvas, jump-center gently
    // only when clicking far from the logo; clicking the logo itself drags 1:1.
    const clickedLogo = Boolean(target.closest(".gp-hero-logo-layer"));
    if (!clickedLogo && heroRect.width > 0 && heroRect.height > 0) {
      const relX = ((ev.clientX - heroRect.left) / heroRect.width) * 100;
      const relY = ((ev.clientY - heroRect.top) / heroRect.height) * 100;
      const jumped = setLogoCustomPosition(dragApp, relX, relY);
      startX = jumped.x;
      startY = jumped.y;
    } else {
      startX = layout.x;
      startY = layout.y;
    }

    activePointerId = ev.pointerId;
    startClientX = ev.clientX;
    startClientY = ev.clientY;
    spanW = Math.max(80, heroRect.width - logoRect.width);
    spanH = Math.max(60, heroRect.height - logoRect.height);
    layer.classList.add("is-dragging");
    try {
      hero.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic pointer events may not support capture.
    }
  });

  document.addEventListener("pointermove", (ev) => {
    if (activePointerId === null || ev.pointerId !== activePointerId || !dragApp) return;
    const dxPct = ((ev.clientX - startClientX) / spanW) * 100;
    const dyPct = ((ev.clientY - startClientY) / spanH) * 100;
    setLogoCustomPosition(dragApp, startX + dxPct, startY + dyPct);
  });

  const endDrag = (ev: PointerEvent): void => {
    if (activePointerId === null || ev.pointerId !== activePointerId) return;
    activePointerId = null;
    dragApp = "";
    document.querySelector(".gp-hero-logo-layer.is-dragging")?.classList.remove("is-dragging");
  };

  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // Mouse wheel over `.gp-hero.is-adjusting-logo` scales the logo smoothly.
  document.addEventListener(
    "wheel",
    (ev) => {
      if (!S.isAdjustingLogo || !S.currentModalAppName) return;
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(".gp-hero.is-adjusting-logo")) return;
      ev.preventDefault();
      const layout = getLogoLayout(S.currentModalAppName);
      const step = ev.deltaY < 0 ? 0.05 : -0.05;
      setLogoScale(S.currentModalAppName, layout.scale + step);
    },
    { passive: false },
  );
}
