/**
 * Game Controller Polling & Launcher Navigation.
 *
 * Provides smooth, natural controller navigation for the entire launcher,
 * with spatial 2D D-pad/stick movement, quick actions (Play, Back, Favorite,
 * Filter tabs), and the Stage shell.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isSteamDeckDevice, isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import type { ControllerKind } from "../../core/types";
import { controllerSupportStatus } from "../../epic";
import { psShapeFor, psShapeSvg } from "../../core/controller-glyphs";
import { closeNotifPanel, pushNotification } from "../notifications/notifications";
import { setFullscreenMode, toggleFullscreenMode } from "./fullscreen-mode";
import { closeAllModals } from "../../core/render";
import { toggleFav } from "../../core/game-view";
import { closePalette, isPaletteOpen, openPalette } from "../palette/palette";
import { setView } from "../store/store-view";
import { stageBridge } from "./stage-bridge";
import {
  enterStage,
  stageControllerBattery,
  stageControllerConnected,
  stageControllerDisconnected,
  toggleStage,
} from "../stage/stage-state";

/** Deadzone per player choice: tight, normal, loose. */
const STICK_DEADZONES = [0.3, 0.42, 0.55] as const;
const STICK_DEADZONE = STICK_DEADZONES[1];
const REPEAT_FIRST_MS = 260;
const REPEAT_NEXT_MS = 85;
const IDLE_POLL_MS = 80;
/** Idle poll for a connected pad: fast enough to catch a tap, slow enough not
 *  to drive a frame every refresh. */
const IDLE_PAD_POLL_MS = 40;

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
    return `<span class="gp-glyph gp-face ps-${psShapeFor(btn)}">${psShapeSvg(btn)}</span>`;
  }
  return `<span class="gp-glyph gp-face gp-${btn}">${btn.toUpperCase()}</span>`;
}

/** Shoulder glyphs: L1/R1 on PlayStation and Steam Deck, LB/RB on Xbox. */
function bumperGlyphs(kind: ControllerKind): string {
  const [l, r] = kind === "xbox" || kind === "generic" ? ["LB", "RB"] : ["L1", "R1"];
  return `<span class="gp-glyph gp-bumper">${l}</span><span class="gp-glyph gp-bumper">${r}</span>`;
}

function systemGlyph(label: string): string {
  return `<span class="gp-glyph gp-system">${label}</span>`;
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
  if (!active || !S.gamepadPolling || S.stage.active) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  const kind = S.gamepadKind;
  const hudKey = `${S.isFullscreen ? "f" : "w"}|${S.fullscreenModeEnabled ? "on" : "off"}|${S.stage.enabled ? "stage" : ""}|${S.view}|${S.appLanguage}|${kind}`;
  if (hudKey === lastHudKey) return;
  lastHudKey = hudKey;

  const items = [
    hudItem(faceGlyph(kind, "a"), t("gamepad.select")),
    hudItem(faceGlyph(kind, "b"), t("common.back")),
    hudItem(faceGlyph(kind, "x"), t("gamepad.favorite")),
    hudItem(bumperGlyphs(kind), t("gamepad.tabs")),
  ];
  // Stage is the couch shell now: Menu opens it instead of the old Full
  // Screen Mode. The fallback keeps the hint honest when Stage is disabled.
  if (S.stage.enabled) {
    items.push(hudItem(systemGlyph("Menu"), t("stage.title")));
  } else if (S.fullscreenModeEnabled) {
    items.push(hudItem(systemGlyph("Menu"), S.isFullscreen ? t("fullscreen.exit") : t("fullscreen.mode")));
  }
  items.push(hudItem(systemGlyph("D-Pad"), t("gamepad.navigate")));
  hud.innerHTML = items.join("");
}

/* ========================================================================= */
/*  Spatial 2D Focus Engine                                                  */
/* ========================================================================= */

let currentFocusedEl: HTMLElement | null = null;
let lastFocusedKey = "";

/** Stable identity of a control across a re-render. */
function focusKeyOf(el: HTMLElement): string {
  if (el.dataset.gpKey) return `gp:${el.dataset.gpKey}`;
  if (el.matches(".switch")) {
    const input = el.querySelector<HTMLInputElement>("input[data-act]");
    if (input?.dataset.act) return `switch:${input.dataset.act}:${input.dataset.store || ""}`;
  }
  if (el.dataset.id) {
    // The same game appears as a grid card, a list row and a sidebar entry;
    // their keys must not collide or a repaint would jump between them.
    const kind = el.classList.contains("sb-game")
      ? "side"
      : el.classList.contains("pcard")
        ? "card"
        : el.classList.contains("lrow")
          ? "row"
          : "id";
    return `${kind}:${el.dataset.id}:${el.dataset.act || ""}`;
  }
  if (el.dataset.libItem) return `lib:${el.dataset.libItem}`;
  if (el.dataset.view) return `view:${el.dataset.view}`;
  if (el.id) return `el:${el.id}`;
  if (el.dataset.act) {
    const variant = [
      el.dataset.tab,
      el.dataset.val,
      el.dataset.page,
      el.dataset.group,
      el.dataset.value,
      el.dataset.filter,
      el.dataset.sort,
      el.dataset.key,
    ].filter(Boolean).join(":");
    return `act:${el.dataset.act}:${variant}`;
  }
  return "";
}

function isVisibleEl(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.classList.contains("hidden");
}

function visibleIn(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isVisibleEl);
}

/**
 * The topmost popup, in stacking order. A single `querySelector` on a comma
 * list would return document order instead, so the game page behind a confirm
 * could win the focus scope.
 */
function topOverlay(): HTMLElement | null {
  const selectors = [
    "#confirm-root > *",
    "#install-root > *",
    "#selective-root > *",
    "#manage-root > *",
    "#options-root > *",
    "#theme-modal-root > *",
    "#playtime-root > *",
    "#cover-modal-root > *",
    "#move-modal-root > *",
    "#hide-games-root > *",
    "#hide-achievements-root > *",
    "#share-modal-root > *",
    "#custom-game-root > *",
    "#sort-name-root > *",
    "#changelog-root > *",
    "#feedback-root > *",
    "#collection-root > *",
    "#storage-root > *",
    "#palette-root .palette",
    ".lib-filter-panel",
    "#notif-root .notif-panel",
    "#modal-root > *",
    ".modal:not(.hidden)",
  ];
  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && isVisibleEl(el)) return el;
  }
  return null;
}

export function initGamepadFocus(): void {
  const candidates = getNavigableElements();
  if (candidates.length === 0) return;
  setFocus(candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
}

function getNavigableElements(): HTMLElement[] {
  // 1. A popup or the game page owns the pad while it is open.
  const overlay = topOverlay();
  if (overlay) {
    if (overlay.matches(".palette")) {
      return visibleIn(overlay, ".palette-item");
    }
    if (overlay.matches(".lib-filter-panel")) {
      const rows = visibleIn(
        overlay,
        ".lib-facet-row, button:not([disabled]), [role='checkbox'], [role='menuitemcheckbox'], input:not([disabled])",
      );
      const firstFacet = rows.find((el) => el.classList.contains("lib-facet-row"));
      return firstFacet ? [firstFacet, ...rows.filter((el) => el !== firstFacet)] : rows;
    }
    const controls = visibleIn(
      overlay,
      "button:not([disabled]), [role='button'], input:not([disabled]), select:not([disabled]), a[href]",
    );
    // The game page opens on its main action, not on the Back button. A Stop
    // button is deliberately left out: a running session should not sit under
    // the first A press.
    const primary = overlay.querySelector<HTMLElement>(
      ".gp-actions .btn.play:not([disabled]), .gp-actions .btn.install:not([disabled]), .gp-actions .btn.update:not([disabled]), .choice-option:not([disabled])",
    );
    if (primary && controls.includes(primary)) {
      return [primary, ...controls.filter((el) => el !== primary)];
    }
    return controls;
  }

  // 2. Stage owns its own focus scope. This must run before the library branch:
  // the desktop view stays in the DOM (hidden) while Stage is open.
  if (S.stage.active) {
    const stageRoot = document.getElementById("stage-root");
    if (stageRoot) return visibleIn(stageRoot, "[data-gp-item]");
  }

  // 3. The standalone game drawer, when it is not hosted in #modal-root.
  const drawer = document.querySelector<HTMLElement>(".game-drawer:not(.hidden), #game-detail-drawer:not(.hidden)");
  if (drawer && isVisibleEl(drawer)) {
    return visibleIn(drawer, ".nav-back-btn, #btn-play, #btn-install, [data-act], button:not([disabled]), [role='button']");
  }

  // The sidebar, page header and every page-level control. Cards used to be the
  // only library candidates, which left the filters, search and sidebar
  // unreachable with a controller.
  const chromeSelector =
    ".sb-account, .sb-notif, .sb-item, .sb-game, #sb-toggle, " +
    "#page-header button:not([disabled]), " +
    "#view button:not([disabled]), #view [role='button'], #view a[href], #view .switch";
  const withoutCardInternals = (el: HTMLElement): boolean =>
    !el.closest(".pcard, .lrow, #totop, .win-controls");

  // 4. Library: cards are the default stop, the surrounding chrome stays
  // reachable. Listing the cards first also makes the first D-pad press start
  // on the grid instead of the account button.
  if (S.view === "library") {
    const cards = visibleIn(document, ".pcard, .lrow");
    const chrome = visibleIn(document, chromeSelector).filter(
      (el) => withoutCardInternals(el) && !cards.includes(el),
    );
    return [...cards, ...chrome];
  }

  // 5. Every other desktop page.
  return visibleIn(document, chromeSelector).filter(withoutCardInternals);
}

function setFocus(el: HTMLElement | null): void {
  if (currentFocusedEl === el) return;
  if (currentFocusedEl) {
    currentFocusedEl.classList.remove("gp-focused");
    if (S.stage.active) currentFocusedEl.blur();
  }
  currentFocusedEl = el;
  lastFocusedKey = el ? focusKeyOf(el) : "";
  if (currentFocusedEl) {
    const reduceMotion =
      document.documentElement.classList.contains("reduce-effects") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrollBehavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
    currentFocusedEl.classList.add("gp-focused");
    if (S.stage.active) {
      // Keep real DOM focus in sync so screen readers and the inspect tools
      // follow the same element. The visual ring is still ours.
      try {
        currentFocusedEl.focus({ preventScroll: true });
      } catch {
        /* A detached node can reject focus; the next render replaces it. */
      }
      window.dispatchEvent(
        new CustomEvent("stage:focus", { detail: { key: stageControlKey(currentFocusedEl) } }),
      );
      // Stage scrolls with the ring, not after it: a held D-pad repeats every
      // 38 ms, and restarting a smooth scroll at that rate leaves the focused
      // card off screen and the container sliding on after the stick stops.
      currentFocusedEl.scrollIntoView({
        block: "nearest",
        inline: currentFocusedEl.closest("[data-gp-row]") ? "center" : "nearest",
        behavior: "auto",
      });
    } else {
      currentFocusedEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior });
    }
  }
}

/** Public entry used by Stage's renderer and pointer hover. */
export function setGamepadFocus(el: HTMLElement | null): void {
  setFocus(el);
}

/**
 * Stable key for a Stage control. An authored `data-gp-key` wins; a button the
 * markup did not key (download pause, queue actions) still gets one derived
 * from its action, so a repaint can put the ring back where the player left it.
 */
export function stageControlKey(el: HTMLElement): string {
  if (el.dataset.gpKey) return el.dataset.gpKey;
  if (el.dataset.act) {
    const subject = el.dataset.id || el.dataset.mode || el.dataset.key || el.dataset.route || "";
    return `ctl:${el.dataset.act}:${subject}`;
  }
  return el.id ? `ctl:#${el.id}` : "";
}

/**
 * Restore the ring after a render. The element itself is often replaced, so
 * its stable key is what survives; a mouse user (no ring, no key) is left
 * alone instead of being handed a focus outline on every repaint.
 */
export function refreshGamepadFocus(): void {
  if (!currentFocusedEl && !lastFocusedKey) return;
  // Stage puts the ring on shell chrome the pad does not traverse (the
  // status-line bell, the Menu pill). A desktop panel repainting behind the
  // shell must not drag it back into the page.
  if (S.stage.active && currentFocusedEl?.isConnected && isVisibleEl(currentFocusedEl)) return;
  const candidates = getNavigableElements();
  if (candidates.length === 0) {
    setFocus(null);
    return;
  }
  if (currentFocusedEl && candidates.includes(currentFocusedEl)) return;
  const match = lastFocusedKey
    ? candidates.find((el) => focusKeyOf(el) === lastFocusedKey)
    : undefined;
  setFocus(match ?? candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
}

type FocusRegion = "sidebar" | "header" | "content";

function focusRegionOf(el: HTMLElement): FocusRegion | null {
  if (el.closest("#sidebar")) return "sidebar";
  if (el.closest("#page-header")) return "header";
  if (el.closest("#content")) return "content";
  return null;
}

/** Cross-region order for one direction: the first region with a hit wins. */
function regionOrder(from: FocusRegion, dir: "up" | "down" | "left" | "right"): FocusRegion[] {
  if (from === "sidebar") {
    // Right enters the page; stay inside the sidebar for vertical movement.
    return dir === "right" ? ["content", "header"] : ["sidebar"];
  }
  if (from === "header") {
    if (dir === "down") return ["content", "header"];
    if (dir === "up") return ["header"];
    return ["header", "content"];
  }
  // Content: horizontal movement stays in the grid; only a left edge step
  // reaches the sidebar. Up may climb to the filter row and then the header.
  if (dir === "left") return ["content", "sidebar"];
  if (dir === "up") return ["content", "header"];
  return ["content"];
}

export function moveGamepadFocus(dir: "up" | "down" | "left" | "right"): void {
  // The collection tool is a horizontal picker: left/right cycles the picker
  // instead of stepping to the neighbouring toolbar buttons.
  if (
    S.stage.active &&
    S.stage.route === "library" &&
    currentFocusedEl?.dataset.gpKey === "tool:collection" &&
    (dir === "left" || dir === "right")
  ) {
    stageBridge()?.cycleCollection?.(dir === "right" ? "next" : "prev");
    return;
  }
  if (S.stage.active && S.stage.stillIndex !== null) {
    const bridge = stageBridge();
    if (dir === "left") {
      bridge?.button("lb");
      return;
    }
    if (dir === "right") {
      bridge?.button("rb");
      return;
    }
    if (dir === "up" || dir === "down") {
      bridge?.back();
      return;
    }
  }
  const candidates = getNavigableElements();
  if (candidates.length === 0) return;

  // Opening a dialog, the palette or a game page changes the scope. The first
  // press should put the ring inside it instead of moving from a hidden card.
  // With no ring at all (mouse user, fresh boot) the same press also moves one
  // step, so the D-pad never feels dead on its first tap.
  if (!currentFocusedEl || !candidates.includes(currentFocusedEl)) {
    const hadRing = currentFocusedEl !== null;
    const preferred = candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0];
    setFocus(preferred);
    if (hadRing) return;
  }

  const origin = currentFocusedEl;
  if (!origin) return;
  const curRect = origin.getBoundingClientRect();
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 };
  // Scale directional thresholds with the focused control so transformed
  // cards in the same shelf row cannot capture an up/down move.
  const moveX = Math.max(12, curRect.width * 0.35);
  const moveY = Math.max(12, curRect.height * 0.35);
  const curRow = origin.closest("[data-gp-row]");

  // Settings panels read top to bottom. The generic scan weighs a horizontal
  // gap 8x, so a right-aligned control loses to a full-width row two rows
  // below. Inside a Stage settings panel, vertical movement goes to the
  // nearest control by row and x only breaks a tie.
  const settingsPanel = origin.closest<HTMLElement>(".stage-settings-panel");
  if (S.stage.active && settingsPanel && (dir === "up" || dir === "down")) {
    let best: HTMLElement | null = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (const el of candidates) {
      if (el === origin || el.closest(".stage-settings-panel") !== settingsPanel) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const dy = r.top + r.height / 2 - curCenter.y;
      if (dir === "down" ? dy <= moveY : dy >= -moveY) continue;
      const dist = Math.abs(dy);
      const dx = Math.abs(r.left + r.width / 2 - curCenter.x);
      if (dist < bestDy - 2 || (Math.abs(dist - bestDy) <= 2 && dx < bestDx)) {
        best = el;
        bestDy = dist;
        bestDx = dx;
      }
    }
    if (best) {
      setFocus(best);
      return;
    }
    // Nothing above this control: return to the tab that owns the panel, not
    // the tab that happens to sit closest horizontally.
    if (dir === "up") {
      const activeTab = document.querySelector<HTMLElement>(".stage-settings-tab.active");
      if (activeTab && isVisibleEl(activeTab)) {
        setFocus(activeTab);
        return;
      }
    }
  }
  // Down from the settings tabs enters the active panel at its first control;
  // the full-width row below would otherwise win and skip the card button.
  if (S.stage.active && dir === "down" && origin.closest(".stage-settings-tabs")) {
    const first = document.querySelector<HTMLElement>(".stage-settings-panel [data-gp-item]");
    if (first && isVisibleEl(first)) {
      setFocus(first);
      return;
    }
  }

  // The desktop shell has three regions. Moving inside one is a geometry
  // contest; crossing to another is a deliberate step. Without this, the
  // nearest neighbour of a card's right side is often a top-bar button.
  const fromRegion = focusRegionOf(origin);
  const scan = (elements: HTMLElement[]): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of elements) {
      if (el === origin) continue;
      if ((dir === "up" || dir === "down") && curRow && curRow === el.closest("[data-gp-row]")) continue;
      const r = el.getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const dx = c.x - curCenter.x;
      const dy = c.y - curCenter.y;

      let primary = 0;
      let cross = 0;
      let gap = 0;
      if (dir === "left") {
        if (dx >= -1) continue;
        primary = -dx;
        cross = Math.abs(dy);
        gap = Math.max(0, Math.max(curRect.top, r.top) - Math.min(curRect.bottom, r.bottom));
      } else if (dir === "right") {
        if (dx <= 1) continue;
        primary = dx;
        cross = Math.abs(dy);
        gap = Math.max(0, Math.max(curRect.top, r.top) - Math.min(curRect.bottom, r.bottom));
      } else if (dir === "up") {
        if (dy >= -moveY) continue;
        primary = -dy;
        cross = Math.abs(dx);
        gap = Math.max(0, Math.max(curRect.left, r.left) - Math.min(curRect.right, r.right));
      } else {
        if (dy <= moveY) continue;
        primary = dy;
        cross = Math.abs(dx);
        gap = Math.max(0, Math.max(curRect.left, r.left) - Math.min(curRect.right, r.right));
      }

      // A control in the same row/column beats a diagonal neighbour: the gap
      // penalty is what keeps a six-column grid from zig-zagging.
      const score = primary + gap * 8 + cross * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  };

  // Stage Home is a console home screen with distinct horizontal tiers:
  // Ribbon (Level 1) -> Hero Actions (Level 2) -> Activity Shelf (Level 3).
  // Stepping between tiers is deliberate so moving down from a card doesn't
  // skip the Play button to a card far below.
  if (S.stage.active && S.stage.route === "home") {
    const inRibbon = Boolean(origin.closest(".stage-home-ribbon"));
    const inHero = Boolean(origin.closest("#stage-home-hero"));
    const inHub = Boolean(origin.closest("#stage-home-activities"));

    if (inRibbon) {
      if (dir === "down") {
        const primary = document.querySelector<HTMLElement>("#stage-home-hero [data-gp-key='primary']")
          ?? document.querySelector<HTMLElement>("#stage-home-hero [data-gp-item]");
        if (primary && isVisibleEl(primary)) {
          setFocus(primary);
          return;
        }
      } else if (dir === "left" || dir === "right") {
        const ribbonCandidates = candidates.filter((el) => el.closest(".stage-home-ribbon"));
        const best = scan(ribbonCandidates);
        if (best) {
          setFocus(best);
          return;
        }
      }
    } else if (inHero) {
      if (dir === "up") {
        const heroKey = S.stage.homeHeroKey;
        let target: HTMLElement | null = null;
        if (heroKey) {
          target = document.querySelector<HTMLElement>(`[data-gp-key="game:${CSS.escape(heroKey)}"]`);
        }
        if (!target || !isVisibleEl(target)) {
          target = document.querySelector<HTMLElement>(".stage-home-ribbon [data-gp-item]");
        }
        if (target && isVisibleEl(target)) {
          setFocus(target);
          return;
        }
      } else if (dir === "down") {
        const act = document.querySelector<HTMLElement>("#stage-home-activities [data-gp-key='act:resume']")
          ?? document.querySelector<HTMLElement>("#stage-home-activities [data-gp-item]");
        if (act && isVisibleEl(act)) {
          setFocus(act);
          return;
        }
      }
    } else if (inHub) {
      if (dir === "up") {
        const hubCandidates = candidates.filter((el) => el.closest("#stage-home-activities"));
        const bestHubAbove = scan(hubCandidates);
        if (bestHubAbove && bestHubAbove.getBoundingClientRect().bottom < curRect.top) {
          setFocus(bestHubAbove);
          return;
        }
        const primary = document.querySelector<HTMLElement>("#stage-home-hero [data-gp-key='primary']")
          ?? document.querySelector<HTMLElement>("#stage-home-hero [data-gp-item]");
        if (primary && isVisibleEl(primary)) {
          setFocus(primary);
          return;
        }
      }
    }
  }

  let bestEl: HTMLElement | null = null;
  // The power sheet's cards are a vertical stack; left/right has no neighbour.
  if (S.stage.active && origin.closest(".stage-power-grid") && (dir === "left" || dir === "right")) {
    stageBridge()?.bump?.(dir);
    return;
  }
  // The Discord friend grid wraps into rows whose last row can start in
  // another column. Vertical movement goes by row, left/right stays inside.
  const friendsList = origin.closest<HTMLElement>(".stage-discord-friends-list");
  if (S.stage.active && friendsList) {
    const cards = candidates.filter((el) => el.closest(".stage-discord-friends-list") === friendsList);
    if (dir === "left" || dir === "right") {
      const best = scan(cards);
      if (best) {
        setFocus(best);
        return;
      }
      stageBridge()?.bump?.(dir);
      return;
    }
    let best: HTMLElement | null = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (const el of cards) {
      if (el === origin) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const dy = r.top + r.height / 2 - curCenter.y;
      if (dir === "down" ? dy <= moveY : dy >= -moveY) continue;
      const dist = Math.abs(dy);
      const dx = Math.abs(r.left + r.width / 2 - curCenter.x);
      if (dist < bestDy - 2 || (Math.abs(dist - bestDy) <= 2 && dx < bestDx)) {
        best = el;
        bestDy = dist;
        bestDx = dx;
      }
    }
    if (best) {
      setFocus(best);
      return;
    }
    // No card further in that direction; fall through so Down reaches the
    // open-client action and Up reaches the call controls.
  }
  // A data-gp-row is a horizontal shelf or tab strip: left/right stays inside
  // it and bumps at the edge instead of jumping to the next shelf.
  if (S.stage.active && curRow && (dir === "left" || dir === "right")) {
    const rowCandidates = candidates.filter((el) => el.closest("[data-gp-row]") === curRow);
    const best = scan(rowCandidates);
    if (best) {
      setFocus(best);
      return;
    }
    stageBridge()?.bump?.(dir);
    return;
  }
  // A test strip is one row of paired actions; left/right stays inside it even
  // when a volume pill above sits closer horizontally.
  const testStrip = origin.closest(".stage-settings-test");
  if (S.stage.active && testStrip && (dir === "left" || dir === "right")) {
    const stripCandidates = candidates.filter((el) => el.closest(".stage-settings-test") === testStrip);
    const best = scan(stripCandidates);
    if (best) {
      setFocus(best);
      return;
    }
    stageBridge()?.bump?.(dir);
    return;
  }
  if (fromRegion) {
    for (const region of regionOrder(fromRegion, dir)) {
      bestEl = scan(candidates.filter((el) => focusRegionOf(el) === region));
      if (bestEl) break;
    }
  } else {
    bestEl = scan(candidates);
  }

  if (bestEl) {
    setFocus(bestEl);
  } else if (S.stage.active) {
    stageBridge()?.bump?.(dir);
  }
}

function activateFocused(): void {
  // Stage's attract mode owns the first press; the bridge reports whether it
  // swallowed it. Desktop mode has no bridge, so this is a no-op there.
  if (S.stage.active && stageBridge()?.wake?.()) return;
  const candidates = getNavigableElements();
  if (candidates.length === 0) return;
  // Never click a control that a newly opened dialog has covered; the first
  // press gives the ring to the dialog instead.
  if (!currentFocusedEl || !candidates.includes(currentFocusedEl)) {
    setFocus(candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
    return;
  }
  currentFocusedEl.click();
}

/** Public keyboard/Stage entry: activate whatever currently owns the ring. */
export function activateGamepadFocus(): void {
  activateFocused();
}

function backAction(): void {
  // Attract mode uses the first Back press to wake, not to leave the screen.
  if (S.stage.active && stageBridge()?.wake?.()) return;

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

  if (S.stage.active) {
    stageBridge()?.back();
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
  // The library's tabs are `.lib-filter` buttons (data-act="quick-tab"); the
  // old `.lib-tab` selector matched nothing, so LB/RB did nothing.
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>(".lib-filters .lib-filter[data-act='quick-tab']"),
  ).filter(isVisibleEl);
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
let repeatHoldStartTime = 0;
let lastRsLeapTime = 0;

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
  prevButtons = heldPadMask();
  repeatDir = null;
  schedulePoll(0);
}

function launcherLostFocus(): void {
  prevButtons = 0;
  repeatDir = null;
  // A background rAF loop stops, so keep the slow timer alive: it is how a
  // game that starts while the launcher is behind is noticed and disarmed
  // before the window is focused again.
  schedulePoll(IDLE_POLL_MS);
}

/** Buttons and stick directions as one bitmask. */
function padMask(gp: Gamepad): number {
  let mask = 0;
  for (let i = 0; i < gp.buttons.length && i < 32; i++) {
    if (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) {
      mask |= 1 << i;
    }
  }

  // Read per sample: a change in Stage settings must apply on the next poll.
  const deadzone = STICK_DEADZONES[S.stage.stickSensitivity] ?? STICK_DEADZONE;
  const lx = gp.axes[0] ?? 0;
  const ly = gp.axes[1] ?? 0;

  if (lx < -deadzone) mask |= 1 << BTN_LEFT;
  else if (lx > deadzone) mask |= 1 << BTN_RIGHT;

  if (ly < -deadzone) mask |= 1 << BTN_UP;
  else if (ly > deadzone) mask |= 1 << BTN_DOWN;

  return mask;
}

/** The mask a pad already held at this instant; 0 when none is connected. */
function heldPadMask(): number {
  const pad = (navigator.getGamepads ? navigator.getGamepads() : [])
    .find((p): p is Gamepad => Boolean(p && p.connected));
  return pad ? padMask(pad) : 0;
}

function justPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0 && (prevButtons & (1 << btn)) === 0;
}

function isPressed(mask: number, btn: number): boolean {
  return (mask & (1 << btn)) !== 0;
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
    repeatDir = null;
    // Stay on a slow check in case the window regains focus without a blur/
    // focus pair (first boot with the window already behind another app).
    schedulePoll(IDLE_POLL_MS);
    return;
  }

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
    schedulePoll(IDLE_POLL_MS);
    return;
  }

  const mask = padMask(gp);

  if (!padArmed) {
    // Keep the snapshot current without acting on it, so the first press after
    // the launcher is focused again is a real edge.
    prevButtons = mask;
    repeatDir = null;
    schedulePoll(mask === 0 ? IDLE_PAD_POLL_MS : 0);
    return;
  }

  const now = performance.now();

  // Directional movement with repeating
  let activeDir: "up" | "down" | "left" | "right" | null = null;
  if (isPressed(mask, BTN_UP)) activeDir = "up";
  else if (isPressed(mask, BTN_DOWN)) activeDir = "down";
  else if (isPressed(mask, BTN_LEFT)) activeDir = "left";
  else if (isPressed(mask, BTN_RIGHT)) activeDir = "right";

  // Right stick vertical flick walks one step at a time. Four moves in one
  // frame skipped the side stage and stacked four hero swaps into a single
  // stutter.
  const ry = gp.axes[3] ?? 0;
  if (S.stage.active && S.stage.stillIndex === null && !activeDir && Math.abs(ry) > 0.68) {
    if (now - lastRsLeapTime > 220) {
      lastRsLeapTime = now;
      if (!stageBridge()?.wake?.()) moveGamepadFocus(ry > 0 ? "down" : "up");
    }
  }

  if (activeDir) {
    if (S.stage.active) {
      window.dispatchEvent(new CustomEvent("stage-input-mode", { detail: { mode: "gamepad" } }));
      // The first direction press dismisses the boot mark or the attract
      // screen; it must not also move the ring behind the overlay.
      if (stageBridge()?.wake?.()) {
        prevButtons = mask;
        repeatDir = null;
        schedulePoll(mask === 0 ? IDLE_PAD_POLL_MS : 0);
        return;
      }
    }
    if (activeDir !== repeatDir) {
      repeatDir = activeDir;
      repeatHoldStartTime = now;
      lastMoveTime = now;
      moveGamepadFocus(activeDir);
    } else {
      const elapsed = now - lastMoveTime;
      const totalHeld = now - repeatHoldStartTime;
      const currentInterval = totalHeld > 1400 ? 38 : totalHeld > 600 ? 58 : REPEAT_NEXT_MS;
      if (elapsed >= currentInterval) {
        moveGamepadFocus(activeDir);
        lastMoveTime = now;
      }
    }
  } else {
    repeatDir = null;
  }

  // Button actions
  if (justPressed(mask, BTN_A)) {
    if (S.stage.active) {
      window.dispatchEvent(new CustomEvent("stage-input-mode", { detail: { mode: "gamepad" } }));
    }
    activateFocused();
  }
  if (justPressed(mask, BTN_B)) {
    if (S.stage.active) {
      window.dispatchEvent(new CustomEvent("stage-input-mode", { detail: { mode: "gamepad" } }));
    }
    backAction();
  }
  if (S.stage.active) {
    const bridge = stageBridge();
    if (justPressed(mask, BTN_X)) bridge?.button("x");
    if (justPressed(mask, BTN_Y)) bridge?.button("y");
    if (justPressed(mask, BTN_LB)) bridge?.button("lb");
    if (justPressed(mask, BTN_RB)) bridge?.button("rb");
    if (justPressed(mask, BTN_LT)) bridge?.button("lt");
    if (justPressed(mask, BTN_RT)) bridge?.button("rt");
    if (justPressed(mask, BTN_START)) bridge?.button("start");
    // The guide/PS button is the console's control-centre key.
    if (justPressed(mask, BTN_GUIDE)) bridge?.button("start");
    if (justPressed(mask, BTN_SELECT)) bridge?.button("select");
    prevButtons = mask;
    schedulePoll(mask === 0 ? IDLE_PAD_POLL_MS : 0);
    return;
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
  // Menu is the console key now: it opens Stage, the couch shell, and falls
  // back to Full Screen Mode only when Stage is switched off.
  if (justPressed(mask, BTN_START)) {
    if (S.stage.enabled) void toggleStage();
    else if (S.fullscreenModeEnabled) void toggleFullscreenMode();
  }
  // Guide stays as a second home key for pads whose Menu button is awkward to
  // reach; the HUD no longer advertises the duplicate.
  if (justPressed(mask, BTN_GUIDE)) {
    if (S.stage.enabled) void enterStage();
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
  schedulePoll(mask === 0 ? IDLE_PAD_POLL_MS : 0);
}

function bindPad(gp: Gamepad): void {
  const name = gp.id.split("(")[0].trim();
  S.gamepadName = name;
  S.gamepadKind = controllerKind(gp.id);
  if (S.gamepadKind === "steamdeck") document.documentElement.classList.add("is-steam-deck");
  const batteryState = (gp as Gamepad & { battery?: { level?: number } }).battery;
  const battery = batteryState && Number.isFinite(batteryState.level) ? (batteryState.level ?? null) : null;
  stageControllerBattery(battery);
  stageControllerConnected(
    name,
    S.gamepadKind,
    battery,
    // Stage is a launcher takeover: never open it over a running game or
    // while another application is in front.
    S.runningGames.size === 0 && launcherOwnsController(),
  );
}

export function initGamepadSupport(): void {
  window.addEventListener("gamepadconnected", (e) => {
    bindPad(e.gamepad);
    toast(t("gamepad.connected", { name: S.gamepadName }), "ok");
    void notifyPlaystationBridge();
    lastHudKey = "";

    // Auto-enter the classic full screen mode only when Stage did not already
    // take over the window. A pad that reconnects mid-session must never pull
    // the launcher in front of a running game.
    if (
      !S.stage.active &&
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
  });

  window.addEventListener("gamepaddisconnected", () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const hasAny = Array.from(gamepads).some((g) => g !== null && g.connected);
    if (!hasAny) {
      S.gamepadPolling = false;
      stageControllerDisconnected();
      if (S.stage.active) toast(t("stage.controllerDisconnected"), "");
      updateGamepadHud(false);
      setFocus(null);
    }
  });

  // A dialog that opens over Stage must take the ring immediately, not after
  // the next D-pad press. Only the open/close transition moves focus; progress
  // text inside the dialog must not steal it while the user navigates.
  const modalPresent = (): boolean =>
    Boolean(document.querySelector(
      ".modal:not(.hidden), .selective-overlay, .confirm-dialog:not(.hidden), #install-root > div",
    ));
  let modalWasPresent = modalPresent();
  const onModalRootChange = (): void => {
    if (!S.stage.active) {
      modalWasPresent = modalPresent();
      return;
    }
    const present = modalPresent();
    if (present === modalWasPresent) return;
    modalWasPresent = present;
    window.requestAnimationFrame(() => initGamepadFocus());
  };
  for (const id of ["modal-root", "selective-root", "confirm-root", "install-root"]) {
    const root = document.getElementById(id);
    if (root) new MutationObserver(onModalRootChange).observe(root, { childList: true });
  }

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
    "changelog-root",
    "feedback-root",
  ]) {
    const root = document.getElementById(id);
    if (root) new MutationObserver(onScopeChange).observe(root, { childList: true, subtree: true });
  }

  // A pad that was already connected when the window opened does not always
  // emit `gamepadconnected` until its first button press. Probe once so the
  // HUD and Stage auto-entry see it.
  const existing = (navigator.getGamepads ? navigator.getGamepads() : [])
    .find((pad): pad is Gamepad => Boolean(pad && pad.connected));
  if (existing) {
    bindPad(existing);
    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      schedulePoll(0);
    }
  }

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

  // Mouse movement hides focus outline and hud temporarily. Stage keeps its
  // ring: pointer hover moves the ring instead of clearing it.
  window.addEventListener("mousemove", () => {
    if (S.stage.active) return;
    if (currentFocusedEl) {
      setFocus(null);
    }
  });

  // A mode change invalidates the held-button mask; otherwise the first press
  // inside Stage can look like a release.
  window.addEventListener("stage-mode", () => {
    prevButtons = 0;
    repeatDir = null;
    setFocus(null);
  });
}
