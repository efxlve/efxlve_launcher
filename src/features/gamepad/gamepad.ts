/**
 * Game controller (gamepad) polling, HUD and navigation.
 *
 * Polls the Gamepad API only while a controller is connected (80ms when idle).
 * Face buttons fire on the edge so holding A cannot launch a game twice.
 * D-pad / sticks repeat after an initial delay. State lives in S.
 */

import { MORE_CARD_CHUNK, isSteamDeckDevice } from "../../core/constants";
import { closeModal } from "../../core/dom";
import { toggleFav } from "../../core/game-view";
import { icon } from "../../core/icons";
import { openEpicModal, render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import type { ControllerKind, DrawerTab } from "../../core/types";
import { controllerSupportStatus } from "../../epic";
import { pushNotification } from "../notifications/notifications";
import {
  epicCardPortrait,
  epicVisibleSummaries,
} from "../library/library-view";
import { closePalette, isPaletteOpen, openPalette } from "../palette/palette";
import { closeScreenshotLightbox, navigateScreenshotLightbox } from "../screenshots/screenshots-view";
import {
  isTvProfileOpen,
  markDeckChrome,
  onControllerConnected,
  toggleTvMode,
  tvActivate,
  tvBack,
  tvCloseProfile,
  tvDetailOpen,
  tvFavorite,
  tvMove,
  tvNeighbor,
  tvOpenDetails,
  tvOpenProfile,
  tvRowJump,
  tvSkip,
} from "./tv-mode";
import { embeddedStoreHeld, setView, syncStoreViewSize } from "../store/store-view";
import { tvPanel } from "./tv-panels";
import { openTvKeyboard, tvKeyboardOpen } from "./tv-keyboard";

const STICK_DEADZONE = 0.42;
const TRIGGER_DEADZONE = 0.55;
const REPEAT_FIRST_MS = 280;
const REPEAT_NEXT_MS = 90;
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
const BTN_L4 = 17;
const BTN_R4 = 18;

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

function menuGlyph(kind: ControllerKind): string {
  const label = kind === "playstation" ? "Options" : kind === "steamdeck" ? "Menu" : "Start";
  return `<span class="gp-glyph btn-start">${label}</span>`;
}

function hudItem(glyphs: string, label: string): string {
  return `<div class="gp-hud-item">${glyphs} <span>${label}</span></div>`;
}

let bridgeProbed = false;
let bridgeAvailable = false;

/**
 * Steam Input style hint: PlayStation pads speak DirectInput, so games that only
 * read XInput ignore them unless an XInput bridge (ViGEmBus / Steam) is present.
 * The registry probe runs at most once per session and never blocks the UI.
 */
async function notifyPlaystationBridge(): Promise<void> {
  if (S.gamepadKind !== "playstation") return;
  if (!bridgeProbed) {
    bridgeProbed = true;
    try {
      const status = await controllerSupportStatus();
      bridgeAvailable = status.viEmBus || status.steam;
    } catch {
      // Keep the pessimistic default; the Settings card offers a manual check.
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
    if (embeddedStoreHeld()) requestAnimationFrame(() => syncStoreViewSize());
    return;
  }

  hud.classList.remove("hidden");
  hud.classList.remove("dimmed");

  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim()) && Boolean(S.currentModalAppName);

  const hudKey = `${modalOpen ? "modal" : S.view}|${tvKeyboardOpen() ? "k" : isTvProfileOpen() ? "p" : tvDetailOpen() ? "d" : tvPanel() ?? "h"}|${S.appLanguage}|${S.gamepadKind}`;
  if (hudKey === lastHudKey) return;
  lastHudKey = hudKey;

  const kind = S.gamepadKind;
  const dpad = `<span class="gp-glyph btn-dpad">D-Pad</span>`;

  if (modalOpen) {
    hud.innerHTML = [
      hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
      hudItem(faceGlyph(kind, "b"), t("common.back")),
      hudItem(faceGlyph(kind, "x"), t("gamepad.favorite")),
      hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
      hudItem(dpad, t("gamepad.navigate")),
    ].join("");
  } else if (S.view === "tv") {
    if (tvKeyboardOpen()) {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
        hudItem(faceGlyph(kind, "b"), t("common.back")),
        hudItem(dpad, t("gamepad.navigate")),
      ].join("");
    } else if (isTvProfileOpen()) {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
        hudItem(faceGlyph(kind, "b"), t("common.back")),
        hudItem(faceGlyph(kind, "x"), t("tv.hudDetails")),
        hudItem(bumperGlyphs(kind), t("tv.hudShelves")),
        hudItem(dpad, t("gamepad.navigate")),
      ].join("");
    } else if (tvDetailOpen()) {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "a"), t("common.play")),
        hudItem(faceGlyph(kind, "b"), t("common.back")),
        hudItem(faceGlyph(kind, "y"), t("gamepad.favorite")),
        hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
      ].join("");
    } else if (tvPanel() === "stores") {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "b"), t("common.back")),
        hudItem(bumperGlyphs(kind), t("nav.store")),
        hudItem(dpad, t("gamepad.navigate")),
      ].join("");
    } else if (tvPanel() === "downloads") {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
        hudItem(faceGlyph(kind, "b"), t("common.back")),
        hudItem(dpad, t("gamepad.navigate")),
      ].join("");
    } else {
      hud.innerHTML = [
        hudItem(faceGlyph(kind, "a"), t("tv.hudPlay")),
        hudItem(faceGlyph(kind, "x"), t("tv.hudDetails")),
        hudItem(faceGlyph(kind, "y"), t("common.search")),
        hudItem(bumperGlyphs(kind), t("tv.hudCategories")),
        hudItem(dpad, t("gamepad.navigate")),
      ].join("");
    }
  } else if (S.view === "profile") {
    hud.innerHTML = [
      hudItem(faceGlyph(kind, "a"), t("gamepad.inspectTrophies")),
      hudItem(faceGlyph(kind, "x"), t("profile.refresh")),
      hudItem(faceGlyph(kind, "y"), t("common.search")),
      hudItem(menuGlyph(kind), t("tv.open")),
      hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
      hudItem(dpad, t("gamepad.navigate")),
    ].join("");
  } else {
    hud.innerHTML = [
      hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
      hudItem(faceGlyph(kind, "x"), t("gamepad.favorite")),
      hudItem(faceGlyph(kind, "y"), t("common.search")),
      hudItem(menuGlyph(kind), t("tv.open")),
      hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
      hudItem(dpad, t("gamepad.navigate")),
    ].join("");
  }
  if (embeddedStoreHeld()) requestAnimationFrame(() => syncStoreViewSize());
}

function bindPad(gp: Gamepad): void {
  const name = gp.id.split("(")[0].trim();
  S.gamepadName = name;
  S.gamepadKind = controllerKind(gp.id);
  if (S.gamepadKind === "steamdeck") document.documentElement.classList.add("is-steam-deck");
}

export function initGamepadSupport(): void {
  markDeckChrome();
  document.addEventListener("efxlve-hud", () => {
    lastHudKey = "";
    updateGamepadHud(S.gamepadPolling);
  });

  window.addEventListener("gamepadconnected", (e) => {
    bindPad(e.gamepad);
    if (!onControllerConnected(S.gamepadName)) toast(t("gamepad.connected", { name: S.gamepadName }), "ok");
    void notifyPlaystationBridge();
    lastHudKey = "";
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
    }
  });

  window.addEventListener("mousemove", () => {
    if (S.gamepadHudEl && !S.gamepadHudEl.classList.contains("hidden")) {
      S.gamepadHudEl.classList.add("dimmed");
    }
  }, { passive: true });

  setTimeout(() => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const first = Array.from(gamepads).find((g) => g !== null && g.connected);
    if (first) {
      bindPad(first);
      if (!S.gamepadPolling) {
        S.gamepadPolling = true;
        updateGamepadHud(true);
        requestAnimationFrame(gamepadLoop);
      }
      if (S.tvAutoEnter) void onControllerConnected(S.gamepadName);
    }
  }, 1000);
}

function axisPast(v: number, dz: number): boolean {
  return Math.abs(v) > dz;
}

function gamepadHasActivity(gp: Gamepad): boolean {
  for (const b of gp.buttons) {
    if (b.pressed || b.value > TRIGGER_DEADZONE) return true;
  }
  return axisPast(gp.axes[0] ?? 0, STICK_DEADZONE)
    || axisPast(gp.axes[1] ?? 0, STICK_DEADZONE)
    || axisPast(gp.axes[2] ?? 0, STICK_DEADZONE)
    || axisPast(gp.axes[3] ?? 0, STICK_DEADZONE);
}

function scheduleGamepadLoop(idle: boolean): void {
  if (!S.gamepadPolling) return;
  if (idle) {
    window.setTimeout(() => {
      if (S.gamepadPolling) requestAnimationFrame(gamepadLoop);
    }, IDLE_POLL_MS);
    return;
  }
  requestAnimationFrame(gamepadLoop);
}

let prevButtons = 0;
let holdKey = "";
let holdLast = 0;
let holdCount = 0;

function buttonBit(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  if (!b) return false;
  return b.pressed || b.value > TRIGGER_DEADZONE;
}

function justPressed(mask: number, i: number): boolean {
  const bit = 1 << i;
  return (mask & bit) !== 0 && (prevButtons & bit) === 0;
}

function currentMask(gp: Gamepad): number {
  let mask = 0;
  const n = Math.min(gp.buttons.length, 24);
  for (let i = 0; i < n; i++) {
    if (buttonBit(gp, i)) mask |= 1 << i;
  }
  return mask;
}

function consumeHold(key: string, now: number): boolean {
  if (!key) {
    holdKey = "";
    holdCount = 0;
    return false;
  }
  if (holdKey !== key) {
    holdKey = key;
    holdLast = now;
    holdCount = 1;
    return true;
  }
  const wait = holdCount === 1 ? REPEAT_FIRST_MS : REPEAT_NEXT_MS;
  if (now - holdLast >= wait) {
    holdLast = now;
    holdCount++;
    return true;
  }
  return false;
}

function focusedAppName(): string | null {
  if (S.currentModalAppName) return S.currentModalAppName;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  const host = el.closest<HTMLElement>("[data-id]");
  return host?.dataset.id || el.dataset.id || null;
}

export function gamepadLoop(): void {
  if (!S.gamepadPolling) return;

  const now = performance.now();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find((g) => g !== null && g.connected);
  if (!gp) {
    prevButtons = 0;
    scheduleGamepadLoop(true);
    return;
  }

  const idle = !gamepadHasActivity(gp);
  if (idle) {
    holdKey = "";
    holdCount = 0;
    prevButtons = 0;
    scheduleGamepadLoop(true);
    return;
  }

  const mask = currentMask(gp);
  const axes = gp.axes;
  const up = buttonBit(gp, BTN_UP) || (axes[1] ?? 0) < -STICK_DEADZONE || (axes[3] ?? 0) < -STICK_DEADZONE;
  const down = buttonBit(gp, BTN_DOWN) || (axes[1] ?? 0) > STICK_DEADZONE || (axes[3] ?? 0) > STICK_DEADZONE;
  const left = buttonBit(gp, BTN_LEFT) || (axes[0] ?? 0) < -STICK_DEADZONE || (axes[2] ?? 0) < -STICK_DEADZONE;
  const right = buttonBit(gp, BTN_RIGHT) || (axes[0] ?? 0) > STICK_DEADZONE || (axes[2] ?? 0) > STICK_DEADZONE;
  const dir = up ? "up" : down ? "down" : left ? "left" : right ? "right" : "";

  if (S.gamepadHudEl) S.gamepadHudEl.classList.remove("dimmed");

  if (justPressed(mask, BTN_START) || justPressed(mask, BTN_GUIDE)) {
    if (S.view === "tv") {
      // In TV Mode: Start opens Game Hub for focused game, never exits to desktop!
      if (!tvDetailOpen() && !tvKeyboardOpen() && !isTvProfileOpen() && !tvPanel()) {
        tvOpenDetails();
      }
      prevButtons = mask;
      scheduleGamepadLoop(false);
      return;
    }
    toggleTvMode();
    lastHudKey = "";
    updateGamepadHud(true);
    prevButtons = mask;
    scheduleGamepadLoop(false);
    return;
  }

  if (justPressed(mask, BTN_SELECT)) {
    if (S.view === "tv") {
      if (isTvProfileOpen()) tvCloseProfile();
      else tvOpenProfile();
      lastHudKey = "";
      updateGamepadHud(true);
      prevButtons = mask;
      scheduleGamepadLoop(false);
      return;
    }
    if (isPaletteOpen()) closePalette();
    else openPalette();
    prevButtons = mask;
    scheduleGamepadLoop(false);
    return;
  }

  if (isPaletteOpen()) {
    if (justPressed(mask, BTN_B)) closePalette();
    prevButtons = mask;
    scheduleGamepadLoop(false);
    return;
  }

  if (S.view === "tv") {
    if (justPressed(mask, BTN_B)) tvBack();
    else if (justPressed(mask, BTN_A)) tvActivate();
    else if (justPressed(mask, BTN_X) || justPressed(mask, BTN_R4)) {
      if (isTvProfileOpen()) tvActivate();
      else if (tvDetailOpen()) tvActivate();
      else tvOpenDetails();
    }
    else if (justPressed(mask, BTN_Y) || justPressed(mask, BTN_L4)) {
      if (isTvProfileOpen()) tvCloseProfile();
      else if (tvDetailOpen()) tvFavorite();
      else openTvKeyboard();
    }
    else if ((isTvProfileOpen() || tvDetailOpen()) && (buttonBit(gp, BTN_LB) || buttonBit(gp, BTN_RB))) {
      if (consumeHold(buttonBit(gp, BTN_RB) ? "n+" : "n-", now)) tvNeighbor(buttonBit(gp, BTN_RB) ? 1 : -1);
    } else if (buttonBit(gp, BTN_LT) || buttonBit(gp, BTN_RT)) {
      if (consumeHold(buttonBit(gp, BTN_RT) ? "skip+" : "skip-", now)) tvSkip(buttonBit(gp, BTN_RT) ? 1 : -1);
    } else if (buttonBit(gp, BTN_LB) || buttonBit(gp, BTN_RB)) {
      if (consumeHold(buttonBit(gp, BTN_RB) ? "row+" : "row-", now)) tvRowJump(buttonBit(gp, BTN_RB) ? 1 : -1);
    } else if (dir) {
      if (consumeHold(`d:${dir}`, now)) tvMove(dir as "up" | "down" | "left" | "right");
    } else {
      holdKey = "";
      holdCount = 0;
    }
    prevButtons = mask;
    scheduleGamepadLoop(false);
    return;
  }

  if (justPressed(mask, BTN_B)) {
    if (S.activeLightboxScreenshot) closeScreenshotLightbox();
    else if (S.currentModalAppName) closeModal();
    else if (S.view === "store") {
      setView(S.lastNonStoreView);
      render();
    }
  } else if (justPressed(mask, BTN_A)) {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.click === "function") active.click();
  } else if (justPressed(mask, BTN_LB) || justPressed(mask, BTN_RB)) {
    handleGamepadTabSwitch(justPressed(mask, BTN_RB) ? 1 : -1);
  } else if (justPressed(mask, BTN_Y)) {
    const searchInput = (document.getElementById("ach-search-input") || document.getElementById("search")) as HTMLInputElement | null;
    searchInput?.focus();
  } else if (justPressed(mask, BTN_X) || justPressed(mask, BTN_L4)) {
    const id = focusedAppName();
    if (id) toggleFav(id);
  } else if (justPressed(mask, BTN_R4)) {
    const id = focusedAppName();
    if (id) openEpicModal(id);
  } else if (S.activeLightboxScreenshot && (left || right)) {
    if (consumeHold(left ? "ss-prev" : "ss-next", now)) navigateScreenshotLightbox(left ? "prev" : "next");
  } else if (dir) {
    if (consumeHold(`d:${dir}`, now)) handleGamepadDirectionalMove(dir as "up" | "down" | "left" | "right");
  } else {
    holdKey = "";
    holdCount = 0;
  }

  prevButtons = mask;
  scheduleGamepadLoop(false);
}

function libraryGridColumns(grid: HTMLElement): number {
  const card = grid.querySelector<HTMLElement>(":scope > .pcard");
  if (!card) return 1;
  const gap = 20;
  const w = card.offsetWidth;
  if (w <= 0) return 1;
  return Math.max(1, Math.round((grid.clientWidth + gap) / (w + gap)));
}

function moveLibraryGridFocus(dir: "up" | "down" | "left" | "right"): boolean {
  const grid = document.querySelector<HTMLElement>(".pgrid");
  if (!grid) return false;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .pcard"));
  if (cards.length === 0) return false;

  const current = document.activeElement as HTMLElement | null;
  const onCard = current && current.classList.contains("pcard") && grid.contains(current);
  const filters = Array.from(document.querySelectorAll<HTMLElement>(".lib-filter, .lib-sort-btn, .lib-search input, .lib-refresh-btn"));

  if (!onCard) {
    if (dir === "down" || dir === "right") {
      cards[0].focus();
      cards[0].scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    }
    return false;
  }

  const idx = cards.indexOf(current);
  if (idx < 0) return false;
  const cols = libraryGridColumns(grid);
  let next = idx;
  if (dir === "left") next = idx - 1;
  else if (dir === "right") next = idx + 1;
  else if (dir === "up") next = idx - cols;
  else next = idx + cols;

  if (dir === "up" && next < 0) {
    const lastFilter = filters[filters.length - 1];
    if (lastFilter) {
      lastFilter.focus();
      return true;
    }
    return true;
  }
  if (next < 0 || next >= cards.length) return true;
  cards[next].focus();
  cards[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export function handleGamepadDirectionalMove(dir: "up" | "down" | "left" | "right"): void {
  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim());
  const scope: HTMLElement = modalOpen
    ? document.getElementById("modal-root")!
    : (document.getElementById("view") || document.body);

  if (S.view === "library" && !modalOpen) {
    if (moveLibraryGridFocus(dir)) {
      if (dir === "down") {
        const sentinel = document.getElementById("lib-scroll-sentinel");
        if (sentinel) {
          const visible = epicVisibleSummaries();
          if (S.renderedCardCount < visible.length) {
            const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
            S.renderedCardCount += nextSlice.length;
            sentinel.insertAdjacentHTML("beforebegin", nextSlice.map((s) => epicCardPortrait(s)).join(""));
            if (S.renderedCardCount >= visible.length) {
              sentinel.remove();
              S.libScrollObserver?.disconnect();
              S.libScrollObserver = null;
            }
          }
        }
      }
      return;
    }
    const chrome = Array.from(
      document.querySelectorAll<HTMLElement>(".lib-filter, .lib-sort-btn, .lib-search input, .lib-refresh-btn"),
    ).filter((el) => el.offsetParent !== null);
    if (chrome.length > 0) {
      const current = document.activeElement as HTMLElement | null;
      const idx = current ? chrome.indexOf(current) : -1;
      const next = dir === "left" || dir === "up"
        ? (idx <= 0 ? chrome.length - 1 : idx - 1)
        : (idx < 0 || idx >= chrome.length - 1 ? 0 : idx + 1);
      chrome[next].focus();
      return;
    }
  }

  const selector = 'button:not([disabled]):not(.iconbtn), .pcard, [tabindex="0"], a[href], input:not([disabled]), select:not([disabled])';
  const focusables = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    return el.offsetParent !== null;
  });

  if (focusables.length === 0) return;

  const current = document.activeElement as HTMLElement | null;
  if (!current || !scope.contains(current) || current === document.body) {
    const primaryBtn = scope.querySelector<HTMLElement>(".btn.play, .btn.primary, .pcard");
    if (primaryBtn) {
      primaryBtn.focus();
    } else {
      focusables[0].focus();
    }
    return;
  }

  const curRect = current.getBoundingClientRect();
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 };

  let bestCandidate: HTMLElement | null = null;
  let minDistance = Infinity;

  for (const el of focusables) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    const dx = center.x - curCenter.x;
    const dy = center.y - curCenter.y;

    if (dir === "up" && dy >= -4) continue;
    if (dir === "down" && dy <= 4) continue;
    if (dir === "left" && dx >= -4) continue;
    if (dir === "right" && dx <= 4) continue;

    let dist = 0;
    if (dir === "up" || dir === "down") {
      dist = Math.abs(dy) + Math.abs(dx) * 1.8;
    } else {
      dist = Math.abs(dx) + Math.abs(dy) * 1.8;
    }

    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = el;
    }
  }

  if (bestCandidate) {
    bestCandidate.focus();
    bestCandidate.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/** LB/RB: cycles Store, Library and Downloads. */
export function cycleTopView(step: number): void {
  const order = [
    '[data-act="open-store"]',
    '[data-view="library"]',
    '[data-view="downloads"]',
  ];
  const current = S.view === "store" ? 0 : S.view === "downloads" ? 2 : 1;
  const next = (current + step + order.length) % order.length;
  document.querySelector<HTMLElement>(`#sidebar ${order[next]}`)?.click();
}

export function handleGamepadTabSwitch(step: number): void {
  if (S.currentModalAppName) {
    const tabs: DrawerTab[] = ["overview", "achievements", "dlcs", "screenshots", "specs"];

    const curIdx = tabs.indexOf(S.activeDrawerTab);
    const nextIdx = (curIdx + step + tabs.length) % tabs.length;
    S.activeDrawerTab = tabs[nextIdx];
    openEpicModal(S.currentModalAppName, false, true);
  } else {
    cycleTopView(step);
  }
  updateGamepadHud(S.gamepadPolling);
}
