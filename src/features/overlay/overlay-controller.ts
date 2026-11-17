/**
 * Overlay controller and keyboard navigation: the focus ring, D-pad/stick
 * polling, tab cycling and the B/Esc back path.
 *
 * One-way dependency: the page configures tab queries through
 * configureController; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { esc } from "../../core/utils";
import { icon } from "../../core/icons";
import { t } from "../../i18n";
import { clearAchievementDetail, hasAchievementDetail } from "./overlay-achievements";
import { hideLightbox, lightboxIsOpen, stepLightbox } from "./overlay-screenshots";

type TabId = string;

let gamepadRaf: number | null = null;
let gamepadWakeTimer: number | null = null;

interface ControllerDeps {
  isWidgetOpen: (tab: string) => boolean;
  visibleTabs: () => { id: string; icon: Parameters<typeof icon>[0]; key: string }[];
  activeTab: () => string;
  setTab: (tab: string) => void;
  ghostMode: () => boolean;
  recentMenuOpen: () => boolean;
}

let deps: ControllerDeps | null = null;

export function configureController(next: ControllerDeps): void {
  deps = next;
}

function pageIsWidgetOpen(tab: string): boolean {
  return deps?.isWidgetOpen(tab) ?? false;
}

function pageVisibleTabs(): { id: string; icon: Parameters<typeof icon>[0]; key: string }[] {
  return deps?.visibleTabs() ?? [];
}

function pageActiveTab(): string {
  return deps?.activeTab() ?? "home";
}

function pageGhostMode(): boolean {
  return deps?.ghostMode() ?? false;
}

export function onMouseActivity(): void {
  document.body.classList.remove("ov-using-gamepad");
  removeGamepadFocus();
}

/* ---------- Controller & Keyboard Navigation ---------- */

export type Dir = "up" | "down" | "left" | "right";

let focusedEl: HTMLElement | null = null;
let prevButtons: boolean[] = [];
let navRepeatAt = 0;
let lastDir: Dir | null = null;
/** Input is ignored briefly after open so the button that opened the panel
 *  (Guide / Start+Back, still held) cannot close it on the first frame. */
let gamepadSuppressUntil = 0;

export function removeGamepadFocus(): void {
  document.querySelectorAll(".ov-controller-focus").forEach((el) => {
    el.classList.remove("ov-controller-focus");
  });
  focusedEl = null;
}

/** True while a text box owns the keyboard (arrow keys must move the caret). */
export function isTextEntryFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "button", "submit"].includes(el.type);
  }
  return el.isContentEditable;
}

function isRenderable(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 && rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function getFocusableElements(): HTMLElement[] {
  const items: HTMLElement[] = [];
  const push = (el: Element | null) => {
    const node = el as HTMLElement | null;
    if (!node || items.includes(node) || !isRenderable(node)) return;
    items.push(node);
  };

  // A modal lightbox owns the ring: nothing behind it may be activated unseen.
  if (lightboxIsOpen()) {
    document.querySelectorAll("#ov-lightbox button").forEach(push);
    return items;
  }

  push(document.getElementById("ov-topbar-game-hub-btn"));
  document.querySelectorAll(".ov-topbar-btn").forEach(push);
  // The quick-launch popover sits outside the widgets; without this the pad can
  // open it but never reach a card.
  if (deps?.recentMenuOpen()) {
    document.querySelectorAll("#ov-recent-dropdown .ov-quick-card").forEach(push);
  }

  document.querySelectorAll<HTMLElement>(".ov-widget").forEach((w) => {
    if (w.style.display !== "none") {
      w.querySelectorAll<HTMLElement>(
        "button, [data-ov-preview], [data-nav-row], .ov-card[data-nav-target], textarea, input, select",
      ).forEach((el) => {
        // Toggle switches hide their checkbox: the ring belongs on the label.
        if (el instanceof HTMLInputElement && el.type === "checkbox") {
          push(el.closest(".switch") ?? el);
        } else {
          push(el);
        }
      });
    }
  });

  return items;
}

export function focusElement(el: HTMLElement | null): void {
  removeGamepadFocus();
  if (!el || !isRenderable(el)) return;
  focusedEl = el;
  el.classList.add("ov-controller-focus");
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function dockTabButton(tab: TabId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.ov-topbar-btn[data-ov-widget-toggle="${tab}"]`);
}

export function focusDefault(): void {
  // A modal lightbox owns the ring: default to one of its own buttons.
  if (lightboxIsOpen()) {
    focusElement(getFocusableElements()[0] ?? null);
    return;
  }
  focusElement(dockTabButton(pageActiveTab()) ?? getFocusableElements()[0] ?? null);
}

export function ensureFocus(): void {
  if (focusedEl && focusedEl.isConnected) return;
  focusDefault();
}

/** Moves the ring to the nearest element in the pressed direction (2D map). */
export function moveFocus(dir: Dir): void {
  ensureFocus();
  const items = getFocusableElements();
  if (items.length === 0) return;
  if (!focusedEl || !items.includes(focusedEl)) {
    focusDefault();
    return;
  }

  const cur = focusedEl.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of items) {
    if (el === focusedEl) continue;
    const rect = el.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - cx;
    const dy = rect.top + rect.height / 2 - cy;
    const inDir =
      dir === "left" ? dx < -6 :
      dir === "right" ? dx > 6 :
      dir === "up" ? dy < -6 :
      dy > 6;
    if (!inDir) continue;
    const horizontal = dir === "left" || dir === "right";
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + cross * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) focusElement(best);
}

export function adjustRange(input: HTMLInputElement, step: number): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const next = Math.min(max, Math.max(min, Number(input.value) + step));
  if (next === Number(input.value)) return;
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Left/right or A on a select cycles its enabled options. */
export function adjustSelect(select: HTMLSelectElement, step: number): void {
  const options = Array.from(select.options).filter((option) => !option.disabled);
  if (options.length < 2) return;
  const current = Math.max(0, options.indexOf(select.options[select.selectedIndex]));
  const next = (current + step + options.length) % options.length;
  select.selectedIndex = Array.from(select.options).indexOf(options[next]);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function activateFocused(): void {
  // A lightbox is modal: the ring must live inside it, never on a control the
  // user cannot see behind the image.
  if (lightboxIsOpen() && (!focusedEl || !document.getElementById("ov-lightbox")?.contains(focusedEl))) {
    focusDefault();
    return;
  }
  ensureFocus();
  const el = focusedEl;
  if (!el || !el.isConnected) return;
  if (el instanceof HTMLInputElement && el.type === "range") return;
  if (el.classList.contains("switch")) {
    el.querySelector<HTMLInputElement>("input")?.click();
    return;
  }
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text")) {
    el.focus();
    return;
  }
  if (el instanceof HTMLSelectElement) {
    adjustSelect(el, 1);
    return;
  }
  const switchesTab = el.matches("[data-nav-target], [data-ov-tab], [data-ov-widget-toggle]");
  el.click();
  // A card or chevron that switched tabs hides the old view: the ring moves
  // to the new active dock button right away.
  window.setTimeout(() => {
    if (switchesTab || !focusedEl || !focusedEl.isConnected) focusElement(dockTabButton(pageActiveTab()));
  }, 0);
}

export function cycleTab(delta: number): void {
  const tabs = pageVisibleTabs();
  if (tabs.length === 0) return;
  const found = tabs.findIndex((tab) => tab.id === pageActiveTab());
  // `pageActiveTab()` can be a settings/chat view that is not in the dock: start at
  // the first tab for RB, the last one for LB, instead of index -1 maths.
  const currentIdx = found >= 0 ? found : delta > 0 ? -1 : 0;
  const nextIdx = (currentIdx + delta + tabs.length) % tabs.length;
  deps?.setTab(tabs[nextIdx].id);
  focusElement(dockTabButton(tabs[nextIdx].id));
}

/** Rebuilds the topbar widgets when page visibility changed. */
export function refreshDock(): void {
  const host = document.getElementById("ov-topbar-widgets");
  if (!host) return;
  const tabs = pageVisibleTabs();
  host.innerHTML = tabs.map((tab) => `
    <button class="ov-topbar-btn ${pageIsWidgetOpen(tab.id) ? "active" : ""}" data-ov-widget-toggle="${tab.id}" title="${esc(t(tab.key))}">
      ${icon(tab.icon, 15)}
      <span class="ov-topbar-btn-label">${esc(t(tab.key))}</span>
    </button>
  `).join("");
  document.querySelector<HTMLElement>(".ov-topbar-settings-btn")?.classList.toggle("active", pageIsWidgetOpen("settings"));
}

/** B / Esc: close the lightbox, leave the text box, then close. */
export function goBack(): void {
  if (lightboxIsOpen()) {
    hideLightbox();
    return;
  }
  if (hasAchievementDetail() && pageIsWidgetOpen("ach")) {
    clearAchievementDetail();
    return;
  }
  if (isTextEntryFocused()) {
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  void invoke("overlay_hide");
}

export function scheduleGamepadFrame(): void {
  if (gamepadWakeTimer !== null) {
    window.clearTimeout(gamepadWakeTimer);
    gamepadWakeTimer = null;
  }
  if (gamepadRaf === null && !document.hidden && !pageGhostMode()) {
    gamepadRaf = requestAnimationFrame(pollGamepadLoop);
  }
}

/** No pad connected: check again shortly instead of waking the GPU at 60 Hz. */
export function scheduleGamepadWake(): void {
  if (gamepadRaf !== null || gamepadWakeTimer !== null) return;
  gamepadWakeTimer = window.setTimeout(() => {
    gamepadWakeTimer = null;
    scheduleGamepadFrame();
  }, 250);
}

export function pollGamepadLoop(): void {
  gamepadRaf = null;
  if (document.hidden || pageGhostMode()) return;

  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = gamepads.find((p) => p && p.connected);

  const topbarPadEl = document.getElementById("ov-topbar-gamepad");

  if (!pad) {
    if (topbarPadEl && topbarPadEl.style.display !== "none") {
      topbarPadEl.style.display = "none";
    }
    prevButtons = [];
    scheduleGamepadWake();
    return;
  }

  if (topbarPadEl && topbarPadEl.style.display === "none") {
    topbarPadEl.style.display = "inline-flex";
  }

  const buttons = pad.buttons.map((b) => b.pressed);

  // Swallow input right after the panel opened: the shortcut that opened it
  // (Guide, Start+Back) is usually still held on the first frames.
  if (performance.now() < gamepadSuppressUntil) {
    prevButtons = buttons;
    scheduleGamepadFrame();
    return;
  }

  // A focused text box owns the pad too: replying must not be interrupted by a
  // drifting stick or a stray button press.
  if (isTextEntryFocused()) {
    prevButtons = buttons;
    scheduleGamepadFrame();
    return;
  }

  const isEdge = (idx: number): boolean => Boolean(buttons[idx] && !prevButtons[idx]);
  let anyInput = false;

  // A (0): Select / Activate
  if (isEdge(0)) {
    anyInput = true;
    activateFocused();
  }

  // B (1): Back / Close
  if (isEdge(1)) {
    anyInput = true;
    goBack();
  }

  // LB (4) / RB (5): tabs, or previous/next screenshot in the lightbox.
  if (isEdge(4)) {
    anyInput = true;
    if (lightboxIsOpen()) stepLightbox(-1);
    else cycleTab(-1);
  }

  if (isEdge(5)) {
    anyInput = true;
    if (lightboxIsOpen()) stepLightbox(1);
    else cycleTab(1);
  }

  // Start (9) or Guide (16): close the overlay.
  if (isEdge(9) || isEdge(16)) {
    anyInput = true;
    void invoke("overlay_hide");
  }

  // Directional: D-pad or left stick.
  const dpadUp = buttons[12];
  const dpadDown = buttons[13];
  const dpadLeft = buttons[14];
  const dpadRight = buttons[15];
  const axisY = pad.axes[1] || 0;
  const axisX = pad.axes[0] || 0;

  let dir: Dir | null = null;
  if (dpadUp || axisY < -0.45) dir = "up";
  else if (dpadDown || axisY > 0.45) dir = "down";
  else if (dpadLeft || axisX < -0.45) dir = "left";
  else if (dpadRight || axisX > 0.45) dir = "right";

  const now = performance.now();
  if (dir) {
    anyInput = true;
    if (dir !== lastDir || now - navRepeatAt > 170) {
      lastDir = dir;
      navRepeatAt = now;
      if (focusedEl instanceof HTMLInputElement && focusedEl.type === "range" && (dir === "left" || dir === "right")) {
        adjustRange(focusedEl, dir === "right" ? 4 : -4);
      } else if (focusedEl instanceof HTMLSelectElement && (dir === "left" || dir === "right")) {
        adjustSelect(focusedEl, dir === "right" ? 1 : -1);
      } else {
        moveFocus(dir);
      }
    }
  } else {
    lastDir = null;
  }

  if (anyInput) {
    document.body.classList.add("ov-using-gamepad");
    ensureFocus();
  }

  prevButtons = buttons;
  scheduleGamepadFrame();
}


/** The focused control, for the page's keyboard handler. */
export function focusedElement(): HTMLElement | null {
  return focusedEl;
}

/** Arrow keys on a slider: one step without leaving the control. */
export function adjustFocusedRange(step: number): void {
  if (focusedEl instanceof HTMLInputElement && focusedEl.type === "range") {
    adjustRange(focusedEl, step);
  }
}

/** A fresh panel session starts with no ring and no held buttons. */
export function resetControllerSession(): void {
  focusedEl = null;
  prevButtons = [];
  lastDir = null;
  navRepeatAt = 0;
}

/** The opening shortcut is still held: ignore the pad for a moment. */
export function suppressGamepadInput(): void {
  gamepadSuppressUntil = performance.now() + 450;
}

export function stopGamepadPolling(): void {
  if (gamepadRaf !== null) {
    cancelAnimationFrame(gamepadRaf);
    gamepadRaf = null;
  }
  if (gamepadWakeTimer !== null) {
    window.clearTimeout(gamepadWakeTimer);
    gamepadWakeTimer = null;
  }
  prevButtons = [];
}
