/**
 * Game Controller Polling & Launcher Navigation.
 *
 * Provides smooth, natural controller navigation for the entire launcher,
 * with spatial 2D D-pad/stick movement, quick actions (Play, Back, Favorite,
 * Filter tabs) and the Full Screen shell.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isSteamDeckDevice, isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import type { ControllerKind } from "../../core/types";
import { controllerConnectedPads, controllerSupportStatus, type ConnectedController } from "../../epic";
import { closeNotifPanel, pushNotification } from "../notifications/notifications";
import { setFullscreenMode, toggleFullscreenMode } from "./fullscreen-mode";
import { closeAllModals } from "../../core/render";
import { toggleFav } from "../../core/game-view";
import { closePalette, isPaletteOpen, openPalette } from "../palette/palette";
import { setView } from "../store/store-view";
import { currentFocusedEl, getNavigableElements, initGamepadFocus, isVisibleEl, lastFocusedKey, moveGamepadFocus, refreshGamepadFocus, setFocus, topOverlay, visibleIn } from "./focus-engine";
import { libraryFiltersFavorites, refreshLibraryResultsInPlace } from "../library/library-view";
export { initGamepadFocus, moveGamepadFocus, refreshGamepadFocus, setGamepadFocus } from "./focus-engine";
import { isCouchControlsOpen, isCouchMenuOpen, couchBack, openCouchMenu, refreshCouchBar } from "./couch-shell";
import { isControllerKeyboardOpen, openControllerKeyboard, closeControllerKeyboard, controllerKeyboardPress, syncControllerKeyboard, controllerKeyboardRecentlyClosed } from "./on-screen-keyboard";
import { faceGlyph, bumperGlyphs, triggerGlyphs, systemGlyph, hudItem } from "./pad-hints";
import { stepCouchPage } from "./couch-pages";
import { isTextEntryTarget } from "./text-entry";
import { PadNotices, type PadNotice } from "./pad-notices";
import { PadDirectionInput, type PadDirectionSample } from "./pad-direction";

const IDLE_POLL_MS = 80;
/** Idle poll for a connected pad: fast enough to catch a tap, slow enough not
 *  to drive a frame every refresh. */
const IDLE_PAD_POLL_MS = 40;
/** How long the active pad can sit idle before input on another slot takes over. */
const PAD_SWITCH_IDLE_MS = 400;

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
  if (
    !active ||
    !S.gamepadPolling ||
    isCouchMenuOpen() ||
    isCouchControlsOpen() ||
    isControllerKeyboardOpen() ||
    (S.isFullscreen && !S.fullscreenHints)
  ) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  const kind = S.gamepadKind;
  const hudKey = `${S.isFullscreen ? "f" : "w"}|${S.fullscreenModeEnabled ? "on" : "off"}|${S.view}|${S.appLanguage}|${kind}|${S.fullscreenSwapAB ? "swap" : ""}|${S.fullscreenHints ? "hints" : ""}`;
  if (hudKey === lastHudKey) return;
  lastHudKey = hudKey;

  const confirm = faceGlyph(kind, S.fullscreenSwapAB && S.isFullscreen ? "b" : "a");
  const back = faceGlyph(kind, S.fullscreenSwapAB && S.isFullscreen ? "a" : "b");
  const items = [
    hudItem(confirm, t("gamepad.select")),
    hudItem(back, t("common.back")),
    hudItem(faceGlyph(kind, "x"), t("gamepad.favorite")),
    hudItem(faceGlyph(kind, "y"), t("palette.searchGames")),
    hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
  ];
  if (S.isFullscreen) {
    items.push(hudItem(triggerGlyphs(kind), t("couch.pages")));
    items.push(hudItem(systemGlyph("Menu"), t("couch.menuButton")));
  } else if (S.fullscreenModeEnabled) {
    items.push(hudItem(systemGlyph("Menu"), t("fullscreen.mode")));
  }
  items.push(hudItem(systemGlyph("D-Pad"), t("gamepad.navigate")));
  hud.innerHTML = items.join("");
}

function activateFocused(): void {
  const candidates = getNavigableElements();
  if (candidates.length === 0) return;
  // Never click a control that a newly opened dialog has covered; the first
  // press gives the ring to the dialog instead.
  if (!currentFocusedEl || !candidates.includes(currentFocusedEl)) {
    setFocus(candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
    return;
  }
  const target = currentFocusedEl;
  target.click();
  // Selecting a text field is how a couch player types: the field keeps DOM
  // focus and the on-screen keyboard becomes the active pad scope.
  if (S.isFullscreen && S.fullscreenKeyboard && isTextEntryTarget(target)) {
    openControllerKeyboard(target);
  }
}

/** Public keyboard entry: activate whatever currently owns the ring. */
export function activateGamepadFocus(): void {
  activateFocused();
}

function backAction(): void {
  // 0. The on-screen keyboard, controller map and couch menu stack above the
  // page; Back closes the top one only.
  if (couchBack()) return;

  // 1. The palette and the filter slide-over are not part of closeAllModals.
  if (isPaletteOpen()) {
    closePalette();
    return;
  }
  const filterPanel = document.querySelector<HTMLElement>(".lib-filter-panel");
  if (filterPanel && isVisibleEl(filterPanel)) {
    filterPanel.querySelector<HTMLElement>("[data-act='lib-filter-close']")?.click();
    return;
  }

  // 2. Close any other popup or the game page.
  const overlay = topOverlay();
  if (overlay) {
    if (overlay.matches(".notif-panel")) {
      closeNotifPanel();
      return;
    }
    // A confirm/choice over the game page must answer No, not close the page
    // that opened it.
    const cancel = overlay.querySelector<HTMLElement>(
      "[data-act='confirm-cancel'], [data-act='choice-cancel']",
    );
    if (cancel) {
      cancel.click();
      return;
    }
    closeAllModals();
    // A few dialogs own their close action rather than living in a root that
    // closeAllModals clears (theme designer, feedback).
    if (overlay.isConnected) {
      overlay
        .querySelector<HTMLElement>(
          "[data-act='td-cancel'], [data-act='feedback-close'], [data-act='theme-import-close'], .modal-head .win-close",
        )
        ?.click();
    }
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
    // The card leaves a favorites-only grid; a stale focus ring would point at
    // the node that just disappeared.
    if (libraryFiltersFavorites()) {
      refreshLibraryResultsInPlace();
      refreshGamepadFocus();
    }
    toast(t("gamepad.favorite"), "ok");
  }
}

function switchFilterTab(forward: boolean): void {
  // A dialog owns its own tabs. LB/RB must never click a filter behind it.
  const overlay = topOverlay();
  let tabs: HTMLElement[] = [];
  if (overlay) {
    tabs = visibleIn(overlay, "[role='tab'], .tab, .drawer-tab");
  } else if (S.view === "library") {
    // The library's tabs are `.lib-filter` buttons (data-act="quick-tab").
    tabs = Array.from(
      document.querySelectorAll<HTMLElement>(".lib-filters .lib-filter[data-act='quick-tab']"),
    ).filter(isVisibleEl);
  } else {
    // Profile, changelog and the other pages keep their strip for the pad.
    const strip = currentFocusedEl?.closest<HTMLElement>("[role='tablist'], .tabs");
    if (!strip) return;
    tabs = visibleIn(strip, "[role='tab'], .tab");
  }
  if (tabs.length < 2) return;

  const activeIdx = tabs.findIndex((t) => t.classList.contains("active") || t.getAttribute("aria-selected") === "true");
  let nextIdx = (activeIdx >= 0 ? activeIdx : 0) + (forward ? 1 : -1);
  if (nextIdx >= tabs.length) nextIdx = 0;
  if (nextIdx < 0) nextIdx = tabs.length - 1;

  const next = tabs[nextIdx];
  next.click();
  // Keep the ring on the tab that was chosen instead of throwing it at the
  // first card: the next Down press should enter the refreshed content.
  window.setTimeout(() => {
    if (next.isConnected) setFocus(next);
    else refreshGamepadFocus();
  }, 80);
}

/** LT/RT walk the five pages the couch top bar offers. */
function cycleCouchPage(direction: -1 | 1): void {
  if (topOverlay()) return;
  const next = stepCouchPage(S.view, direction);
  const selector = next === "store"
    ? "#couch-bar [data-couch-store]"
    : `#couch-bar [data-couch-view="${next}"]`;
  const button = document.querySelector<HTMLElement>(selector);
  if (!button) return;
  button.click();
  if (button.isConnected) setFocus(button);
}

/* ========================================================================= */
/*  Controller Polling Loop                                                  */
/* ========================================================================= */

let prevButtons = 0;
let activePadIndex: number | null = null;
let lastActivePadInputAt = 0;
const padDirection = new PadDirectionInput();

/** One scheduled poll at a time. A focus change restarts the loop instead of
 *  leaving a second timer to race it. */
let pollTimer = 0;
let pollRaf = 0;

function clearPoll(): void {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
  if (pollRaf) {
    cancelAnimationFrame(pollRaf);
    pollRaf = 0;
  }
}

function schedulePoll(delay: number): void {
  clearPoll();
  if (!S.gamepadPolling) return;
  if (delay <= 0) pollRaf = window.requestAnimationFrame(gamepadLoop);
  else pollTimer = window.setTimeout(gamepadLoop, delay);
}

/**
 * Window activation, not only document focus: an embedded store/Spotify child
 * webview holds document focus while the launcher is still the active window,
 * and another application must never leave the launcher holding the pad.
 */
let windowFocused = !isTauri;

/**
 * The pad belongs to the game whenever the launcher is not the foreground
 * window. WebView2 can keep delivering snapshots to a background window, and a
 * press there used to reach whatever the launcher had focused, including the
 * Stop button of a running game.
 */
function launcherOwnsController(): boolean {
  return !document.hidden && (windowFocused || document.hasFocus());
}

// A game already open when the launcher boots is not a fresh transition: the
// user just opened the window and expects the pad to work.
let gameWasRunning = S.runningGames.size > 0;
let padArmed = true;

/**
 * A game that starts while the launcher is still focused must not let the same
 * pad presses reach the control that replaced Play with Stop. Re-arm only when
 * the launcher itself gains focus again.
 */
function refreshPadArming(): void {
  const running = S.runningGames.size > 0;
  if (running && !gameWasRunning) padArmed = false;
  if (!running) padArmed = true;
  gameWasRunning = running;
}

/** The launcher is in front again: re-arm and ignore anything already held. */
function launcherGainedFocus(): void {
  padArmed = true;
  const gp = activeGamepad(performance.now());
  prevButtons = gp ? padButtonsMask(gp) : 0;
  if (gp) padDirection.syncHeld(padSample(gp, prevButtons), performance.now());
  else padDirection.reset();
  schedulePoll(0);
  // A pad plugged in or removed while the launcher was behind another window
  // is announced now, when the notice can actually be seen.
  void refreshConnectedControllers();
}

function launcherLostFocus(): void {
  prevButtons = 0;
  padDirection.reset();
  // A background rAF loop stops, so keep the slow timer alive: it is how a
  // game that starts while the launcher is behind is noticed and disarmed
  // before the window is focused again.
  schedulePoll(IDLE_POLL_MS);
}

/** Button bitmask (`0..31`) from the Gamepad API snapshot. */
function padButtonsMask(gp: Gamepad): number {
  let mask = 0;
  for (let i = 0; i < gp.buttons.length && i < 32; i++) {
    if (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) {
      mask |= 1 << i;
    }
  }
  return mask;
}

function padSample(gp: Gamepad, mask: number): PadDirectionSample {
  return {
    up: isPressed(mask, BTN_UP),
    down: isPressed(mask, BTN_DOWN),
    left: isPressed(mask, BTN_LEFT),
    right: isPressed(mask, BTN_RIGHT),
    lx: gp.axes[0] ?? 0,
    ly: gp.axes[1] ?? 0,
  };
}

function padHasInput(gp: Gamepad): boolean {
  if (padButtonsMask(gp) !== 0) return true;
  return Math.abs(gp.axes[0] ?? 0) >= 0.5 || Math.abs(gp.axes[1] ?? 0) >= 0.5;
}

/**
 * Picks the active connected gamepad. Keeping one slot pinned for at least
 * `PAD_SWITCH_IDLE_MS` stops a mirrored virtual pad (ViGEmBus) from stealing
 * the trail of a button release and causing a duplicate step.
 */
function activeGamepad(now: number): Gamepad | null {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const connected: Gamepad[] = [];
  for (let i = 0; i < gamepads.length; i++) {
    const g = gamepads[i];
    if (g && g.connected) connected.push(g);
  }
  if (connected.length === 0) {
    activePadIndex = null;
    return null;
  }

  const current = activePadIndex !== null
    ? connected.find((g) => g.index === activePadIndex) ?? null
    : null;
  if (current) {
    if (padHasInput(current)) {
      lastActivePadInputAt = now;
      return current;
    }
    if (now - lastActivePadInputAt >= PAD_SWITCH_IDLE_MS) {
      const other = connected.find((g) => g.index !== current.index && padHasInput(g));
      if (other) {
        activePadIndex = other.index;
        lastActivePadInputAt = now;
        prevButtons = 0;
        padDirection.reset();
        lastHudKey = "";
        bindPad(other);
        updateGamepadHud(true);
        refreshCouchBar();
        return other;
      }
    }
    return current;
  }

  const picked = connected.find(padHasInput) ?? connected[0];
  activePadIndex = picked.index;
  if (padHasInput(picked)) lastActivePadInputAt = now;
  prevButtons = 0;
  padDirection.reset();
  return picked;
}

function justPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0 && (prevButtons & (1 << btn)) === 0;
}

function isPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0;
}

/** Last time the pad produced an edge; the keyboard auto-open uses this. */
let lastPadInputAt = 0;

function markPadInput(): void {
  lastPadInputAt = performance.now();
  document.documentElement.classList.add("pad-input");
}

function padWasLastInput(maxAge = 1500): boolean {
  return performance.now() - lastPadInputAt < maxAge;
}

/** A short pulse for couch navigation. */
function pulse(gp: Gamepad, kind: "move" | "select" | "back"): void {
  if (!S.isFullscreen || !S.fullscreenHaptics) return;
  const actuator = (gp as Gamepad & {
    vibrationActuator?: {
      playEffect?: (
        type: string,
        params: { duration: number; strongMagnitude: number; weakMagnitude: number },
      ) => Promise<unknown>;
    };
  }).vibrationActuator;
  if (!actuator?.playEffect) return;
  const effect = {
    move: { duration: 8, strongMagnitude: 0.05, weakMagnitude: 0.02 },
    select: { duration: 18, strongMagnitude: 0.16, weakMagnitude: 0.08 },
    back: { duration: 14, strongMagnitude: 0.12, weakMagnitude: 0.06 },
  }[kind];
  void actuator.playEffect("dual-rumble", effect).catch(() => undefined);
}

/** Right stick scroll: move the focused pane, not the ring. */
function scrollFocusedPane(amount: number): void {
  let node: HTMLElement | null = currentFocusedEl;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
      node.scrollTop += amount;
      return;
    }
    node = node.parentElement;
  }
  const view = document.getElementById("view");
  if (view) view.scrollTop += amount;
}

function gamepadLoop(): void {
  pollTimer = 0;
  pollRaf = 0;
  if (!S.gamepadPolling) return;

  refreshPadArming();
  if (!launcherOwnsController()) {
    // Forget every held button: the press that brings the launcher forward
    // must not count as a fresh press on the focused control.
    prevButtons = 0;
    padDirection.reset();
    // Stay on a slow check in case the window regains focus without a blur/
    // focus pair (first boot with the window already behind another app).
    schedulePoll(IDLE_POLL_MS);
    return;
  }

  const now = performance.now();
  const gp = activeGamepad(now);
  if (!gp) {
    prevButtons = 0;
    padDirection.reset();
    schedulePoll(IDLE_POLL_MS);
    return;
  }

  const mask = padButtonsMask(gp);
  const sample = padSample(gp, mask);

  if (!padArmed) {
    // Keep the snapshot current without acting on it, so the first press after
    // the launcher is focused again is a real edge.
    prevButtons = mask;
    padDirection.syncHeld(sample, now);
    schedulePoll(mask === 0 && !padHasInput(gp) ? IDLE_PAD_POLL_MS : 0);
    return;
  }

  // A text field can vanish with its dialog while the keyboard is open.
  syncControllerKeyboard();
  const dirResult = padDirection.update(sample, now);
  if (mask !== 0 || dirResult.activeDir !== null) {
    lastActivePadInputAt = now;
    markPadInput();
  }

  // A/B swap belongs to the couch shell.
  const couchSwap = S.isFullscreen && S.fullscreenSwapAB;
  const confirmButton = couchSwap ? BTN_B : BTN_A;
  const backButton = couchSwap ? BTN_A : BTN_B;

  // The classic shell keeps the ring where it is while the right stick scrolls
  // a long settings page or an open dialog; the pad has no wheel.
  const ry = gp.axes[3] ?? 0;
  if (S.isFullscreen && !dirResult.activeDir && Math.abs(ry) > 0.3) {
    scrollFocusedPane(Math.round(ry * 22));
  }

  if (dirResult.step) {
    moveGamepadFocus(dirResult.step);
    if (dirResult.isInitial) pulse(gp, "move");
  }

  const idle = mask === 0 && dirResult.activeDir === null;

  // The on-screen keyboard is its own input mode: A types, B closes it, and
  // X/Y/LB/RB keep the hands on the pad while typing.
  if (isControllerKeyboardOpen()) {
    if (justPressed(mask, confirmButton)) {
      activateFocused();
      pulse(gp, "select");
    }
    if (justPressed(mask, backButton)) {
      closeControllerKeyboard();
      pulse(gp, "back");
    }
    if (justPressed(mask, BTN_X)) controllerKeyboardPress("backspace");
    if (justPressed(mask, BTN_Y)) controllerKeyboardPress("space");
    if (justPressed(mask, BTN_LB)) controllerKeyboardPress("shift");
    if (justPressed(mask, BTN_RB)) controllerKeyboardPress("layout");
    if (justPressed(mask, BTN_START)) controllerKeyboardPress("done");
    prevButtons = mask;
    schedulePoll(idle ? IDLE_PAD_POLL_MS : 0);
    return;
  }

  // A couch sheet owns the pad while it is open. X/Y/LB/RB must not reach the
  // page behind the menu.
  if (isCouchMenuOpen() || isCouchControlsOpen()) {
    if (justPressed(mask, confirmButton)) {
      activateFocused();
      pulse(gp, "select");
    }
    if (justPressed(mask, backButton) || justPressed(mask, BTN_START)) {
      backAction();
      pulse(gp, "back");
    }
    prevButtons = mask;
    schedulePoll(idle ? IDLE_PAD_POLL_MS : 0);
    return;
  }

  // Button actions
  if (justPressed(mask, confirmButton)) {
    activateFocused();
    pulse(gp, "select");
  }
  if (justPressed(mask, backButton)) {
    backAction();
    pulse(gp, "back");
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
  if (justPressed(mask, BTN_LT) && S.isFullscreen) {
    cycleCouchPage(-1);
  }
  if (justPressed(mask, BTN_RT) && S.isFullscreen) {
    cycleCouchPage(1);
  }
  // Menu opens the couch menu in Full Screen Mode, and enters the mode from
  // the desktop.
  if (justPressed(mask, BTN_START)) {
    if (S.isFullscreen) openCouchMenu();
    else if (S.fullscreenModeEnabled) void toggleFullscreenMode();
  }
  // Guide stays as a second home key for pads whose Menu button is awkward to
  // reach; in the couch shell it is the same menu key.
  if (justPressed(mask, BTN_GUIDE)) {
    if (S.isFullscreen) openCouchMenu();
    else if (S.fullscreenModeEnabled) void toggleFullscreenMode();
  }
  if (justPressed(mask, BTN_SELECT)) {
    openPalette();
  }

  prevButtons = mask;
  // An idle pad does not need a frame every 16 ms: while nothing is held the
  // loop wakes on a timer and goes back to rAF on the first press. 40 ms still
  // samples a human tap, and a connected pad no longer keeps the compositor
  // rendering at the display's refresh rate for the whole session.
  schedulePoll(idle ? IDLE_PAD_POLL_MS : 0);
}

function bindPad(gp: Gamepad): void {
  const name = gp.id.split("(")[0].trim();
  S.gamepadName = name;
  S.gamepadKind = controllerKind(gp.id);
  if (S.gamepadKind === "steamdeck") document.documentElement.classList.add("is-steam-deck");
  const batteryState = (gp as Gamepad & { battery?: { level?: number } }).battery;
  S.gamepadBattery = batteryState && Number.isFinite(batteryState.level) ? (batteryState.level ?? null) : null;
}

/** How often the HID pad list is read while the launcher is in front. */
const CONTROLLER_WATCH_MS = 15000;

const padNotices = new PadNotices();

function showPadNotice(notice: PadNotice | null): void {
  if (!notice) return;
  const key = notice.connected ? "gamepad.connected" : "gamepad.disconnected";
  toast(t(key, { name: notice.name }), notice.connected ? "ok" : "");
}

/**
 * Reads the HID pad list and announces what changed.
 *
 * Chromium keeps a connected pad out of the Gamepad API until one of its
 * buttons is pressed, so the browser events alone cannot announce a pad that
 * was just plugged in. The first snapshot only seeds the watch, and the list is
 * also what Settings > Controller shows.
 */
export async function refreshConnectedControllers(force = false): Promise<void> {
  if (!isTauri) return;
  let pads: ConnectedController[];
  try {
    pads = await controllerConnectedPads(force);
  } catch {
    return;
  }
  const changed = JSON.stringify(pads) !== JSON.stringify(S.connectedControllers);
  S.connectedControllers = pads;
  if (changed) window.dispatchEvent(new Event("controller-list-changed"));
  const named = pads.map((pad) => (pad.name ? pad : { ...pad, name: t("controller.kindGeneric") }));
  for (const notice of padNotices.updateNative(named)) showPadNotice(notice);
}

export function initGamepadSupport(): void {
  window.addEventListener("gamepadconnected", (e) => {
    const kind = controllerKind(e.gamepad.id);
    // Keep the physical pad's glyphs if another pad (like the ViGEm virtual
    // Xbox controller) connects while the primary pad is already bound.
    if (activePadIndex === null || e.gamepad.index === activePadIndex) {
      activePadIndex = e.gamepad.index;
      bindPad(e.gamepad);
    }
    const native = S.connectedControllers.find((pad) => pad.kind === kind);
    showPadNotice(padNotices.webConnected(kind, native?.name || e.gamepad.id.split("(")[0].trim() || t("controller.kindGeneric")));
    void notifyPlaystationBridge();
    lastHudKey = "";

    // A pad that reconnects mid-session must never pull the launcher in front
    // of a running game.
    if (
      S.runningGames.size === 0 &&
      launcherOwnsController() &&
      S.fullscreenAutoEnter &&
      S.fullscreenModeEnabled
    ) {
      void setFullscreenMode(true);
    }

    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      schedulePoll(0);
    }
    refreshCouchBar();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    showPadNotice(padNotices.webDisconnected(controllerKind(e.gamepad.id)));
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const remaining = Array.from(gamepads).find((g): g is Gamepad => Boolean(g && g.connected));
    if (e.gamepad.index === activePadIndex) {
      activePadIndex = remaining ? remaining.index : null;
      prevButtons = 0;
      padDirection.reset();
      if (remaining) {
        lastHudKey = "";
        bindPad(remaining);
        updateGamepadHud(true);
        refreshCouchBar();
      }
    }
    if (!remaining) {
      activePadIndex = null;
      S.gamepadPolling = false;
      S.gamepadBattery = null;
      closeControllerKeyboard();
      updateGamepadHud(false);
      setFocus(null);
      refreshCouchBar();
      document.documentElement.classList.remove("pad-input");
    }
  });

  // A popup can open from a mouse click or a dialog can mount above the page.
  // Move the ring into the new scope (and back to the page when it closes)
  // instead of leaving it on a control the overlay now covers. With a pad
  // connected but no ring yet (the page was opened with the mouse), give the
  // new scope its primary action so the game page is usable from the couch.
  let scopeRaf = 0;
  const onScopeChange = (): void => {
    if (scopeRaf) return;
    scopeRaf = requestAnimationFrame(() => {
      scopeRaf = 0;
      if (!S.gamepadPolling) return;
      if (currentFocusedEl || lastFocusedKey) refreshGamepadFocus();
      else if (topOverlay()) initGamepadFocus();
      updateGamepadHud(S.gamepadPolling);
      // A field that the page or a dialog focused by itself becomes typeable
      // when the pad was the last input device. A mouse click stays a mouse
      // interaction and does not throw a keyboard over the page.
      if (
        S.isFullscreen &&
        S.fullscreenKeyboard &&
        !isControllerKeyboardOpen() &&
        !controllerKeyboardRecentlyClosed() &&
        padWasLastInput() &&
        isTextEntryTarget(document.activeElement)
      ) {
        openControllerKeyboard(document.activeElement);
      }
    });
  };
  // Sidebar repaints must not hand a ring to a mouse user; they only keep an
  // existing ring on the same entry.
  let sidebarRaf = 0;
  const onSidebarChange = (): void => {
    if (sidebarRaf) return;
    sidebarRaf = requestAnimationFrame(() => {
      sidebarRaf = 0;
      if (currentFocusedEl || lastFocusedKey) refreshGamepadFocus();
    });
  };
  const sidebarRoot = document.getElementById("sidebar");
  if (sidebarRoot) {
    new MutationObserver(onSidebarChange).observe(sidebarRoot, { childList: true, subtree: true });
  }
  for (const id of [
    "modal-root",
    "palette-root",
    "lib-filter-root",
    "confirm-root",
    "install-root",
    "selective-root",
    "notif-root",
    "manage-root",
    "collection-root",
    "storage-root",
    "theme-modal-root",
    "options-root",
    "playtime-root",
    "cover-modal-root",
    "move-modal-root",
    "hide-games-root",
    "hide-achievements-root",
    "share-modal-root",
    "custom-game-root",
    "sort-name-root",
    "rename-game-root",
    "changelog-root",
    "feedback-root",
    "couch-root",
  ]) {
    const root = document.getElementById(id);
    if (root) new MutationObserver(onScopeChange).observe(root, { childList: true, subtree: true });
  }

  // A pad that was already connected when the window opened does not always
  // emit `gamepadconnected` until its first button press. Probe once so the
  // HUD and auto-entry see it.
  const existing = (navigator.getGamepads ? navigator.getGamepads() : [])
    .find((pad): pad is Gamepad => Boolean(pad && pad.connected));
  if (existing) {
    activePadIndex = existing.index;
    bindPad(existing);
    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      schedulePoll(0);
    }
    refreshCouchBar();
  }

  // Connect/disconnect notices come from the HID list: the Gamepad API hides a
  // freshly plugged pad until its first button press. The poll runs only while
  // the launcher is in front, and the list also feeds Settings > Controller.
  void refreshConnectedControllers();
  window.setInterval(() => {
    if (launcherOwnsController()) void refreshConnectedControllers();
  }, CONTROLLER_WATCH_MS);

  // Only the foreground launcher may consume the pad. A blur that happens mid
  // press must also drop the held mask, or the next focus would look like a
  // release and the following press could click a stale control.
  window.addEventListener("focus", launcherGainedFocus);
  window.addEventListener("blur", launcherLostFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) launcherLostFocus();
    else launcherGainedFocus();
  });

  // A child webview (store, Spotify, Discord) can blur the main document while
  // the launcher window is still the active window. Track the window itself so
  // the pad keeps working there, but not while another application is in front.
  if (isTauri) {
    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((focused) => {
        windowFocused = focused;
      })
      .catch(() => {
        /* DOM focus events still gate the pad. */
      });
    void win
      .onFocusChanged(({ payload: focused }) => {
        windowFocused = focused;
        if (focused) launcherGainedFocus();
        else launcherLostFocus();
      })
      .catch(() => {
        /* Older hosts have no window focus events; DOM focus stays in charge. */
      });
  }

  // Mouse movement hides the controller ring. A full-screen living-room setup
  // still deserves a small jitter guard: bumping the desk must not make the
  // ring vanish under a player who is using the pad.
  let lastMouseX = -1;
  let lastMouseY = -1;
  window.addEventListener("mousemove", (event) => {
    const threshold = S.isFullscreen ? 6 : 4;
    if (lastMouseX >= 0 && Math.hypot(event.clientX - lastMouseX, event.clientY - lastMouseY) < threshold) return;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    document.documentElement.classList.remove("pad-input");
    if (currentFocusedEl) {
      setFocus(null);
    }
  }, { passive: true });
  // A click attempt always brings the pointer back, even if the mouse barely
  // moved after the pad hid it.
  window.addEventListener("pointerdown", () => {
    document.documentElement.classList.remove("pad-input");
  }, { capture: true, passive: true });
  window.addEventListener("keydown", () => {
    document.documentElement.classList.remove("pad-input");
  }, { passive: true });

  // Keyboard layout changes replace the key row; put the ring back on the
  // toggle key instead of letting the next press start at the first letter.
  window.addEventListener("controller-keyboard-focus", (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (!key) return;
    const el = document.querySelector<HTMLElement>(`#couch-root [data-gp-key="${CSS.escape(key)}"]`);
    if (el) setFocus(el);
  });
  // Opening the keyboard is a scope change like a menu. Focus it explicitly:
  // the first A press must type the first letter, not spend itself giving the
  // new key grid a ring.
  window.addEventListener("controller-keyboard-open", () => {
    window.requestAnimationFrame(() => {
      if (isControllerKeyboardOpen()) initGamepadFocus();
    });
  });
  window.addEventListener("controller-keyboard-close", () => {
    window.requestAnimationFrame(() => refreshGamepadFocus());
  });
}
