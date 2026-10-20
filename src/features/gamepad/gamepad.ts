/**
 * Game Controller Polling & Launcher Navigation.
 *
 * Provides smooth, natural controller navigation for the entire launcher,
 * with spatial 2D D-pad/stick movement, quick actions (Play, Back, Favorite,
 * Filter tabs), and Fullscreen Mode toggling.
 */

import { isSteamDeckDevice } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import type { ControllerKind } from "../../core/types";
import { controllerSupportStatus } from "../../epic";
import { pushNotification } from "../notifications/notifications";
import { setFullscreenMode, toggleFullscreenMode } from "./fullscreen-mode";
import { closeAllModals } from "../../core/render";
import { toggleFav } from "../../core/game-view";
import { openPalette } from "../palette/palette";
import { setView } from "../store/store-view";

const STICK_DEADZONE = 0.42;
const REPEAT_FIRST_MS = 260;
const REPEAT_NEXT_MS = 85;
const IDLE_POLL_MS = 80;

const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_SELECT = 8;
const BTN_START = 9;
const BTN_UP = 12;
const BTN_DOWN = 13;
const BTN_LEFT = 14;
const BTN_RIGHT = 15;
const BTN_GUIDE = 16;

/** Detects the controller family from the Gamepad API id string. */
export function controllerKind(id: string): ControllerKind {
  const s = id.toLowerCase();
  if (s.includes("dualsense") || s.includes("dualshock") || s.includes("playstation") || s.includes("054c")) return "playstation";
  if (
    s.includes("steam deck") ||
    s.includes("steamdeck") ||
    s.includes("neptune") ||
    s.includes("steam virtual gamepad") ||
    s.includes("28de")
  ) return "steamdeck";
  if (s.includes("xbox") || s.includes("xinput") || s.includes("045e")) return "xbox";
  if (s.includes("switch") || s.includes("nintendo") || s.includes("057e")) return "switch";
  if (isSteamDeckDevice()) return "steamdeck";
  return "generic";
}

/** Face-button glyph: PlayStation pads get their geometric shapes instead of A/B/X/Y. */
function faceGlyph(kind: ControllerKind, btn: "a" | "b" | "x" | "y"): string {
  if (kind === "playstation") {
    const shapes = { a: "x", b: "circle", x: "square", y: "triangle" } as const;
    return `<span class="gp-glyph btn-${btn}">${icon(shapes[btn], 11)}</span>`;
  }
  return `<span class="gp-glyph btn-${btn}">${btn.toUpperCase()}</span>`;
}

/** Shoulder glyphs: L1/R1 on PlayStation and Steam Deck, LB/RB on Xbox. */
function bumperGlyphs(kind: ControllerKind): string {
  const [l, r] = kind === "xbox" || kind === "generic" ? ["LB", "RB"] : ["L1", "R1"];
  return `<span class="gp-glyph btn-bumper">${l}</span><span class="gp-glyph btn-bumper">${r}</span>`;
}

function hudItem(glyphs: string, label: string): string {
  return `<div class="gp-hud-item">${glyphs} <span>${label}</span></div>`;
}

let bridgeProbed = false;
let bridgeAvailable = false;

async function notifyPlaystationBridge(): Promise<void> {
  if (S.gamepadKind !== "playstation") return;
  if (!bridgeProbed) {
    bridgeProbed = true;
    try {
      const status = await controllerSupportStatus();
      bridgeAvailable = status.viEmBus || status.steam;
    } catch {
      /* Ignored */
    }
  }
  if (bridgeAvailable) return;
  pushNotification({
    kind: "info",
    title: t("controller.bridgeNotifTitle", { name: S.gamepadName }),
    body: t("controller.bridgeNotifBody"),
    action: "controller-open-settings",
  });
}

export function ensureGamepadHud(): HTMLElement {
  if (!S.gamepadHudEl) {
    S.gamepadHudEl = document.getElementById("gamepad-hud-bar");
    if (!S.gamepadHudEl) {
      S.gamepadHudEl = document.createElement("div");
      S.gamepadHudEl.id = "gamepad-hud-bar";
      S.gamepadHudEl.className = "gamepad-hud-bar hidden";
      document.body.appendChild(S.gamepadHudEl);
    }
  }
  return S.gamepadHudEl;
}

let lastHudKey = "";

export function updateGamepadHud(active = true): void {
  const hud = ensureGamepadHud();
  if (!active || !S.gamepadPolling) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  const kind = S.gamepadKind;
  const hudKey = `${S.isFullscreen ? "f" : "w"}|${S.view}|${S.appLanguage}|${kind}`;
  if (hudKey === lastHudKey) return;
  lastHudKey = hudKey;

  const dpad = `<span class="gp-glyph btn-dpad">D-Pad</span>`;

  hud.innerHTML = [
    hudItem(faceGlyph(kind, "a"), t("common.play") + " / " + t("gamepad.select")),
    hudItem(faceGlyph(kind, "b"), t("common.back")),
    hudItem(faceGlyph(kind, "x"), t("gamepad.favorite")),
    hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
    hudItem(`<span class="gp-glyph">Menu</span>`, S.isFullscreen ? t("fullscreen.exit") : t("fullscreen.mode")),
    hudItem(dpad, t("gamepad.navigate")),
  ].join("");
}

/* ========================================================================= */
/*  Spatial 2D Focus Engine                                                  */
/* ========================================================================= */

let currentFocusedEl: HTMLElement | null = null;

export function initGamepadFocus(): void {
  const candidates = getNavigableElements();
  if (candidates.length > 0) {
    setFocus(candidates[0]);
  }
}

function getNavigableElements(): HTMLElement[] {
  // 1. Modals or popups take absolute priority
  const modal = document.querySelector<HTMLElement>(".modal:not(.hidden), .confirm-dialog:not(.hidden), #modal-root > div");
  if (modal && modal.offsetParent !== null) {
    return Array.from(modal.querySelectorAll<HTMLElement>("button:not([disabled]), [role='button'], input:not([disabled]), a[href]"))
      .filter((el) => el.offsetParent !== null);
  }

  // 2. Game drawer if visible
  const drawer = document.querySelector<HTMLElement>(".game-drawer:not(.hidden), #game-detail-drawer:not(.hidden)");
  if (drawer && drawer.offsetParent !== null) {
    return Array.from(drawer.querySelectorAll<HTMLElement>(".nav-back-btn, #btn-play, #btn-install, [data-act], button:not([disabled]), [role='button']"))
      .filter((el) => el.offsetParent !== null);
  }

  // 3. Library cards
  if (S.view === "library") {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".pcard, .lrow"))
      .filter((el) => el.offsetParent !== null);
    if (cards.length > 0) return cards;
  }

  // 4. Default interactive elements
  return Array.from(document.querySelectorAll<HTMLElement>(".lib-tab, .sidebar-item, .pcard, .lrow, button:not([disabled]), [role='button']"))
    .filter((el) => el.offsetParent !== null && !el.classList.contains("hidden"));
}

function setFocus(el: HTMLElement | null): void {
  if (currentFocusedEl === el) return;
  if (currentFocusedEl) {
    currentFocusedEl.classList.remove("gp-focused");
  }
  currentFocusedEl = el;
  if (currentFocusedEl) {
    currentFocusedEl.classList.add("gp-focused");
    currentFocusedEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

function moveGamepadFocus(dir: "up" | "down" | "left" | "right"): void {
  const candidates = getNavigableElements();
  if (candidates.length === 0) return;

  if (!currentFocusedEl || !document.contains(currentFocusedEl) || currentFocusedEl.offsetParent === null) {
    setFocus(candidates[0]);
    return;
  }

  const curRect = currentFocusedEl.getBoundingClientRect();
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 };

  let bestEl: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === currentFocusedEl) continue;
    const r = el.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    const dx = c.x - curCenter.x;
    const dy = c.y - curCenter.y;

    let isMatch = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    if (dir === "left") {
      isMatch = dx < -10;
      primaryDist = -dx;
      secondaryDist = Math.abs(dy);
    } else if (dir === "right") {
      isMatch = dx > 10;
      primaryDist = dx;
      secondaryDist = Math.abs(dy);
    } else if (dir === "up") {
      isMatch = dy < -10;
      primaryDist = -dy;
      secondaryDist = Math.abs(dx);
    } else if (dir === "down") {
      isMatch = dy > 10;
      primaryDist = dy;
      secondaryDist = Math.abs(dx);
    }

    if (!isMatch) continue;

    // Weight secondary distance higher to favor elements strictly in that direction
    const score = primaryDist + secondaryDist * 2.2;
    if (score < bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  if (bestEl) {
    setFocus(bestEl);
  }
}

function activateFocused(): void {
  if (!currentFocusedEl) {
    initGamepadFocus();
    return;
  }
  currentFocusedEl.click();
}

function backAction(): void {
  // 1. Close modal if open
  const modal = document.querySelector<HTMLElement>(".modal:not(.hidden), .confirm-dialog:not(.hidden)");
  if (modal) {
    closeAllModals();
    return;
  }

  // 2. Close game detail drawer
  const drawer = document.querySelector<HTMLElement>(".game-drawer:not(.hidden), #game-detail-drawer:not(.hidden)");
  if (drawer) {
    const backBtn = drawer.querySelector<HTMLElement>(".nav-back-btn, [data-act='close-detail']");
    if (backBtn) backBtn.click();
    else setView("library");
    return;
  }

  // 3. Return to library if in another view
  if (S.view !== "library") {
    setView("library");
    return;
  }

  // 4. In library and fullscreen -> exit fullscreen
  if (S.isFullscreen) {
    void setFullscreenMode(false);
  }
}

function quickFavoriteAction(): void {
  if (!currentFocusedEl) return;
  const appName = currentFocusedEl.dataset.id || currentFocusedEl.dataset.libItem || currentFocusedEl.dataset.app;
  if (appName) {
    toggleFav(appName);
    toast(t("gamepad.favorite"), "ok");
  }
}

function switchFilterTab(forward: boolean): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".lib-tab")).filter((t) => t.offsetParent !== null);
  if (tabs.length === 0) return;

  const activeIdx = tabs.findIndex((t) => t.classList.contains("active"));
  let nextIdx = forward ? activeIdx + 1 : activeIdx - 1;
  if (nextIdx >= tabs.length) nextIdx = 0;
  if (nextIdx < 0) nextIdx = tabs.length - 1;

  tabs[nextIdx].click();
  // Refocus first card after tab switch
  setTimeout(() => {
    initGamepadFocus();
  }, 100);
}

/* ========================================================================= */
/*  Controller Polling Loop                                                  */
/* ========================================================================= */

let prevButtons = 0;
let repeatTimer = 0;
let repeatDir: "up" | "down" | "left" | "right" | null = null;
let lastMoveTime = 0;

function justPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0 && (prevButtons & (1 << btn)) === 0;
}

function isPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0;
}

function gamepadLoop(): void {
  if (!S.gamepadPolling) return;

  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp: Gamepad | null = null;
  for (let i = 0; i < gamepads.length; i++) {
    const g = gamepads[i];
    if (g && g.connected) {
      gp = g;
      break;
    }
  }

  if (!gp) {
    setTimeout(gamepadLoop, IDLE_POLL_MS);
    return;
  }

  let mask = 0;
  for (let i = 0; i < gp.buttons.length && i < 32; i++) {
    if (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) {
      mask |= 1 << i;
    }
  }

  // Stick navigation
  const lx = gp.axes[0] ?? 0;
  const ly = gp.axes[1] ?? 0;

  if (lx < -STICK_DEADZONE) mask |= 1 << BTN_LEFT;
  else if (lx > STICK_DEADZONE) mask |= 1 << BTN_RIGHT;

  if (ly < -STICK_DEADZONE) mask |= 1 << BTN_UP;
  else if (ly > STICK_DEADZONE) mask |= 1 << BTN_DOWN;

  const now = performance.now();

  // Directional movement with repeating
  let activeDir: "up" | "down" | "left" | "right" | null = null;
  if (isPressed(mask, BTN_UP)) activeDir = "up";
  else if (isPressed(mask, BTN_DOWN)) activeDir = "down";
  else if (isPressed(mask, BTN_LEFT)) activeDir = "left";
  else if (isPressed(mask, BTN_RIGHT)) activeDir = "right";

  if (activeDir) {
    if (activeDir !== repeatDir) {
      repeatDir = activeDir;
      lastMoveTime = now;
      moveGamepadFocus(activeDir);
    } else {
      const elapsed = now - lastMoveTime;
      if (elapsed > REPEAT_FIRST_MS) {
        moveGamepadFocus(activeDir);
        lastMoveTime = now - (REPEAT_FIRST_MS - REPEAT_NEXT_MS);
      }
    }
  } else {
    repeatDir = null;
  }

  // Button actions
  if (justPressed(mask, BTN_A)) {
    activateFocused();
  }
  if (justPressed(mask, BTN_B)) {
    backAction();
  }
  if (justPressed(mask, BTN_X)) {
    quickFavoriteAction();
  }
  if (justPressed(mask, BTN_Y)) {
    openPalette();
  }
  if (justPressed(mask, BTN_LB)) {
    switchFilterTab(false);
  }
  if (justPressed(mask, BTN_RB)) {
    switchFilterTab(true);
  }
  if (justPressed(mask, BTN_START) || justPressed(mask, BTN_GUIDE)) {
    void toggleFullscreenMode();
  }
  if (justPressed(mask, BTN_SELECT)) {
    openPalette();
  }

  prevButtons = mask;
  requestAnimationFrame(gamepadLoop);
}

function bindPad(gp: Gamepad): void {
  const name = gp.id.split("(")[0].trim();
  S.gamepadName = name;
  S.gamepadKind = controllerKind(gp.id);
  if (S.gamepadKind === "steamdeck") document.documentElement.classList.add("is-steam-deck");
}

export function initGamepadSupport(): void {
  window.addEventListener("gamepadconnected", (e) => {
    bindPad(e.gamepad);
    toast(t("gamepad.connected", { name: S.gamepadName }), "ok");
    void notifyPlaystationBridge();
    lastHudKey = "";

    // Auto-enter Fullscreen Mode if enabled
    if (S.fullscreenAutoEnter) {
      void setFullscreenMode(true);
    }

    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      requestAnimationFrame(gamepadLoop);
    }
  });

  window.addEventListener("gamepaddisconnected", () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const hasAny = Array.from(gamepads).some((g) => g !== null && g.connected);
    if (!hasAny) {
      S.gamepadPolling = false;
      updateGamepadHud(false);
      setFocus(null);
    }
  });

  // Mouse movement hides focus outline and hud temporarily
  window.addEventListener("mousemove", () => {
    if (currentFocusedEl) {
      setFocus(null);
    }
  });
}
