/**
 * Spatial focus engine for the controller.
 *
 * Kept apart from the polling loop: the poller only translates pad edges into
 * calls, while this module owns the ring, the focus scopes, the remembered
 * control per page/dialog and the geometric neighbour search.
 */

import { S } from "../../core/state";
import { stageBridge } from "./stage-bridge";

/* ========================================================================= */
/*  Spatial 2D Focus Engine                                                  */
/* ========================================================================= */

export let currentFocusedEl: HTMLElement | null = null;
export let lastFocusedKey = "";
/** Last control per page or dialog, so leaving and returning lands where it did. */
const focusMemory = new Map<string, string>();
let lastScopeKey = "";

function focusScopeKey(): string {
  if (S.stage.active) return `stage:${S.stage.route}`;
  const overlay = topOverlay();
  if (overlay) {
    const id = overlay.id || overlay.className.split(/\s+/)[0] || "overlay";
    return `o:${id}`;
  }
  if (S.currentModalAppName) return `game:${S.currentModalAppName}`;
  return `v:${S.view}`;
}

function rememberFocus(): void {
  if (!currentFocusedEl || !lastFocusedKey) return;
  focusMemory.set(lastScopeKey || focusScopeKey(), lastFocusedKey);
}

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

export function isVisibleEl(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.classList.contains("hidden");
}

export function visibleIn(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isVisibleEl);
}

/**
 * The topmost popup, in stacking order. A single `querySelector` on a comma
 * list would return document order instead, so the game page behind a confirm
 * could win the focus scope.
 */
export function topOverlay(): HTMLElement | null {
  const selectors = [
    // The on-screen keyboard sits above the palette and any dialog: the field
    // that opened it keeps focus underneath, but the pad belongs to the keys.
    "#couch-root .couch-keyboard-layer",
    "#couch-root .couch-controls-layer",
    "#couch-root .couch-menu-layer",
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
  const scope = focusScopeKey();
  if (scope !== lastScopeKey) {
    rememberFocus();
    lastScopeKey = scope;
  }
  const remembered = focusMemory.get(scope);
  const restored = remembered ? candidates.find((el) => focusKeyOf(el) === remembered) : undefined;
  setFocus(restored ?? candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
}

export function getNavigableElements(): HTMLElement[] {
  // 1. A popup or the game page owns the pad while it is open.
  const overlay = topOverlay();
  if (overlay) {
    if (overlay.matches(".couch-keyboard-layer")) {
      return visibleIn(overlay, ".couch-key, .couch-keyboard-close");
    }
    if (overlay.matches(".couch-menu-layer")) {
      return visibleIn(
        overlay,
        ".couch-menu-item, .couch-sheet-head button, .couch-sheet-foot button",
      );
    }
    if (overlay.matches(".couch-controls-layer")) {
      return visibleIn(overlay, "button:not([disabled]):not(.couch-backdrop)");
    }
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
    "#couch-bar [data-gp-item], " +
    ".sb-account, .sb-notif, .sb-item, .sb-game, #sb-toggle, " +
    "#page-header button:not([disabled]), " +
    "#view button:not([disabled]), #view [role='button'], #view a[href], #view .switch, " +
    "#view input:not([type='hidden']):not([disabled]), " +
    "#view select:not([disabled]), #view textarea:not([disabled])";
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

export function setFocus(el: HTMLElement | null): void {
  if (currentFocusedEl === el) return;
  if (currentFocusedEl && lastFocusedKey) {
    focusMemory.set(lastScopeKey || focusScopeKey(), lastFocusedKey);
  }
  if (currentFocusedEl) {
    currentFocusedEl.classList.remove("gp-focused");
    if (S.stage.active) currentFocusedEl.blur();
  }
  currentFocusedEl = el;
  lastFocusedKey = el ? focusKeyOf(el) : "";
  if (!lastScopeKey) lastScopeKey = focusScopeKey();
  if (lastFocusedKey) focusMemory.set(lastScopeKey, lastFocusedKey);
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
  // A page or dialog change restores that scope's own last control. This is
  // what makes closing a confirm return to the button that opened it and
  // returning to a page resume where the player left it.
  const scope = focusScopeKey();
  if (scope !== lastScopeKey) {
    rememberFocus();
    lastScopeKey = scope;
    const remembered = focusMemory.get(scope);
    const restored = remembered
      ? candidates.find((el) => focusKeyOf(el) === remembered)
      : undefined;
    setFocus(restored ?? candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
    return;
  }
  if (currentFocusedEl && candidates.includes(currentFocusedEl)) return;
  const match = lastFocusedKey
    ? candidates.find((el) => focusKeyOf(el) === lastFocusedKey)
    : undefined;
  setFocus(match ?? candidates.find((el) => el.hasAttribute("data-gp-default")) ?? candidates[0]);
}

type FocusRegion = "bar" | "sidebar" | "header" | "content";

function focusRegionOf(el: HTMLElement): FocusRegion | null {
  if (el.closest("#couch-bar")) return "bar";
  if (el.closest("#sidebar")) return "sidebar";
  if (el.closest("#page-header")) return "header";
  if (el.closest("#content")) return "content";
  return null;
}

/** Cross-region order for one direction: the first region with a hit wins. */
function regionOrder(from: FocusRegion, dir: "up" | "down" | "left" | "right"): FocusRegion[] {
  if (from === "bar") {
    // Down enters the page; the bar itself keeps horizontal movement.
    return dir === "down" ? ["content", "header"] : ["bar"];
  }
  if (from === "sidebar") {
    // Right enters the page; stay inside the sidebar for vertical movement.
    return dir === "right" ? ["content", "header"] : ["sidebar"];
  }
  if (from === "header") {
    // Up from the page header reaches the couch bar; Down enters the page.
    if (dir === "down") return ["content", "header"];
    if (dir === "up") return ["bar", "header"];
    return ["header", "content"];
  }
  // Content: horizontal movement stays in the grid; only a left edge step
  // reaches the sidebar. Up may climb to the filter row, the header and then
  // the couch bar.
  if (dir === "left") return ["content", "sidebar"];
  if (dir === "up") return ["content", "header", "bar"];
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

  // A focused select or range is a horizontal control: left/right changes its
  // value instead of stepping to a neighbour. Without this a pad could reach
  // Settings but never change a sort, theme or volume.
  if (dir === "left" || dir === "right") {
    if (origin instanceof HTMLSelectElement) {
      const step = dir === "right" ? 1 : -1;
      const next = Math.min(origin.options.length - 1, Math.max(0, origin.selectedIndex + step));
      if (next !== origin.selectedIndex) {
        origin.selectedIndex = next;
        origin.dispatchEvent(new Event("change", { bubbles: true }));
        origin.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (origin instanceof HTMLInputElement && origin.type === "range") {
      const step = (Number(origin.step) || 1) * (dir === "right" ? 1 : -1);
      const min = origin.min === "" ? 0 : Number(origin.min);
      const max = origin.max === "" ? 100 : Number(origin.max);
      const next = Math.min(max, Math.max(min, (Number(origin.value) || 0) + step));
      if (next !== Number(origin.value)) {
        origin.value = String(next);
        origin.dispatchEvent(new Event("input", { bubbles: true }));
        origin.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
  }
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
  // The same contract for the programme tabs: Down enters the tab body at its
  // first control, not the still or card that happens to sit under the tab.
  if (S.stage.active && dir === "down" && origin.closest(".stage-program-tabs")) {
    const first = document.querySelector<HTMLElement>(".stage-program-content [data-gp-item]");
    if (first && isVisibleEl(first)) {
      setFocus(first);
      return;
    }
  }
  // Up from the first control in a programme tab returns to the owning tab,
  // not to the leftmost tab that happens to be closer horizontally.
  if (S.stage.active && dir === "up" && origin.closest(".stage-program-content")) {
    const first = document.querySelector<HTMLElement>(".stage-program-content [data-gp-item]");
    if (first === origin) {
      const activeTab = document.querySelector<HTMLElement>(".stage-program-tab.active");
      if (activeTab && isVisibleEl(activeTab)) {
        setFocus(activeTab);
        return;
      }
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
  // The quick-menu grid: Left/Right walks the tile rows only. The resume
  // banner is a full-width row above them, and its centre sits close enough to
  // the middle tiles that the generic scan would climb into it.
  const dockItem = origin.closest<HTMLElement>(".stage-dock-items .stage-dock-item:not(.stage-dock-resume)");
  if (S.stage.active && dockItem && (dir === "left" || dir === "right")) {
    const tiles = candidates.filter(
      (el) => el.closest(".stage-dock-items") && !el.closest(".stage-dock-resume"),
    );
    const best = scan(tiles);
    if (best) {
      setFocus(best);
      return;
    }
    stageBridge()?.bump?.(dir);
    return;
  }
  // The resume banner spans the whole dock. Down enters the tile
  // grid at its first cell instead of the column that happens to sit under the
  // banner's centre; Left/Right bump because the banner is a row of its own.
  if (S.stage.active && dir === "down" && origin.closest(".stage-dock-resume")) {
    const firstDock = document.querySelector<HTMLElement>('.stage-dock-items [data-gp-key="dock:home"]');
    if (firstDock && isVisibleEl(firstDock)) {
      setFocus(firstDock);
      return;
    }
  }
  // The library tools wrap; left/right walks the tool set and bumps at the end
  // instead of jumping to the topbar or the side stage.
  const libraryTools = origin.closest<HTMLElement>(".stage-library-tools");
  if (S.stage.active && libraryTools && (dir === "left" || dir === "right")) {
    const tools = candidates.filter((el) => el.closest(".stage-library-tools") === libraryTools);
    const best = scan(tools);
    if (best) {
      setFocus(best);
      return;
    }
    stageBridge()?.bump?.(dir);
    return;
  }
  // Extras action groups are chips in a wrapping row: left/right stays in the
  // group instead of jumping to a still above or the manage sheet below.
  const extraActions = origin.closest<HTMLElement>(".stage-extra-actions");
  if (S.stage.active && extraActions && (dir === "left" || dir === "right")) {
    const actions = candidates.filter((el) => el.closest(".stage-extra-actions") === extraActions);
    const best = scan(actions);
    if (best) {
      setFocus(best);
      return;
    }
    stageBridge()?.bump?.(dir);
    return;
  }
  // The header is two stacked rows: filters above tools. The generic scan
  // weighs horizontal distance so heavily that Down from a right-hand filter
  // would jump past the tool row into the side stage.
  const filterTabs = origin.closest<HTMLElement>(".stage-filter-tabs");
  const nearestByX = (selector: string): HTMLElement | null => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
    let best: HTMLElement | null = null;
    let bestDx = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const dx = Math.abs(r.left + r.width / 2 - curCenter.x);
      if (dx < bestDx) {
        best = el;
        bestDx = dx;
      }
    }
    return best;
  };
  if (S.stage.active && dir === "down" && filterTabs) {
    const tool = nearestByX(".stage-library-tools [data-gp-item]");
    if (tool) {
      setFocus(tool);
      return;
    }
  }
  if (S.stage.active && dir === "up" && libraryTools) {
    const filter = nearestByX(".stage-filter-tabs [data-gp-item]");
    if (filter) {
      setFocus(filter);
      return;
    }
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
