/**
 * Spatial focus engine for the controller.
 *
 * Kept apart from the polling loop: the poller only translates pad edges into
 * calls, while this module owns the ring, the focus scopes, the remembered
 * control per page/dialog and the geometric neighbour search.
 */

import { S } from "../../core/state";

/* ========================================================================= */
/*  Spatial 2D Focus Engine                                                  */
/* ========================================================================= */

export let currentFocusedEl: HTMLElement | null = null;
export let lastFocusedKey = "";
/** Last control per page or dialog, so leaving and returning lands where it did. */
const focusMemory = new Map<string, string>();
let lastScopeKey = "";

function focusScopeKey(): string {
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
  if (el.classList.contains("hidden")) return false;
  // A visually hidden checkbox inside a switch reports a 0×0 box. It is not a
  // useful focus stop; the switch label around it is. One rect read is enough.
  const box = el.getBoundingClientRect();
  return box.width >= 2 || box.height >= 2;
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
      "button:not([disabled]), [role='button'], input:not([disabled]), select:not([disabled]), a[href], .switch, [data-act]",
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

  // 2. The standalone game drawer, when it is not hosted in #modal-root.
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
    "#view button:not([disabled]), #view [role='button'], #view a[href], #view .switch, #view [data-act], " +
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
    currentFocusedEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior });
  }
}

/** Public entry used by pointer hover. */
export function setGamepadFocus(el: HTMLElement | null): void {
  setFocus(el);
}

/**
 * Restore the ring after a render. The element itself is often replaced, so
 * its stable key is what survives; a mouse user (no ring, no key) is left
 * alone instead of being handed a focus outline on every repaint.
 */
export function refreshGamepadFocus(): void {
  if (!currentFocusedEl && !lastFocusedKey) return;
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
  // Scale the directional threshold with the focused control so transformed
  // cards in the same row cannot capture an up/down move.
  const moveY = Math.max(12, curRect.height * 0.35);

  // The desktop shell has three regions. Moving inside one is a geometry
  // contest; crossing to another is a deliberate step. Without this, the
  // nearest neighbour of a card's right side is often a top-bar button.
  const fromRegion = focusRegionOf(origin);
  const scan = (elements: HTMLElement[]): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of elements) {
      if (el === origin) continue;
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

  let bestEl: HTMLElement | null = null;
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
  }
}
