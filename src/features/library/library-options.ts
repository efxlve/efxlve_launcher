/**
 * Optional library display preferences: cover captions, grid density and
 * page-by-page browsing.
 *
 * Captions and pagination are opt-in from Settings so the default quiet cover
 * wall stays untouched. Cover density is also available from the library's
 * View menu, where the grid itself is the live preview.
 */

import {
  COVER_SIZE_KEY,
  COVER_SIZE_TARGET,
  COVER_SIZE_VALUES,
  COVER_TITLES_KEY,
  LIB_PAGINATION_KEY,
  LIST_DENSITY_KEY,
  LIST_DENSITY_VALUES,
  type CoverSize,
  type ListDensity,
} from "../../core/constants";
import { viewEl } from "../../core/dom";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Persist the "title under cover" preference. */
export function setCoverTitlesEnabled(on: boolean): void {
  S.showCoverTitles = on;
  localStorage.setItem(COVER_TITLES_KEY, String(on));
}

/** Toggle pagination. The page always restarts at 1 when the mode changes. */
export function setLibraryPaginationEnabled(on: boolean): void {
  S.libPagination = on;
  S.libPage = 1;
  localStorage.setItem(LIB_PAGINATION_KEY, String(on));
}

const COVER_SIZE_LABEL_KEYS: Record<CoverSize, string> = {
  auto: "lib.coverSizeAuto",
  compact: "lib.coverSizeCompact",
  standard: "lib.coverSizeStandard",
  large: "lib.coverSizeLarge",
  xl: "lib.coverSizeXl",
};

/** Localized preset name. */
export function coverSizeLabel(size: CoverSize): string {
  return t(COVER_SIZE_LABEL_KEYS[size]);
}

/** Accepts a stored or select value; anything unknown becomes Auto. */
export function normalizeCoverSize(value: unknown): CoverSize {
  return COVER_SIZE_VALUES.includes(value as CoverSize) ? (value as CoverSize) : "auto";
}

/**
 * Applies a density to the mounted grid without rebuilding the library. CSS
 * chooses the column count from the target width, so the scroll position and
 * the progressive chunk stay where they are.
 */
export function applyCoverSize(): void {
  const grid = document.querySelector<HTMLElement>("#lib-results .pgrid");
  if (grid) grid.dataset.coverSize = S.coverSize;
  syncDensityMenu();
}

/** Persist the chosen density and repaint the open menu in place. */
export function setCoverSize(value: unknown): void {
  const size = normalizeCoverSize(value);
  if (size === S.coverSize) {
    syncDensityMenu();
    return;
  }
  S.coverSize = size;
  localStorage.setItem(COVER_SIZE_KEY, size);
  applyCoverSize();
}

const LIST_DENSITY_LABEL_KEYS: Record<ListDensity, string> = {
  compact: "lib.coverSizeCompact",
  standard: "lib.coverSizeStandard",
  large: "lib.coverSizeLarge",
};

/** Localized list density name. The grid presets share the same three names. */
export function listDensityLabel(density: ListDensity): string {
  return t(LIST_DENSITY_LABEL_KEYS[density]);
}

/** Accepts a stored or select value; anything unknown becomes Standard. */
export function normalizeListDensity(value: unknown): ListDensity {
  return LIST_DENSITY_VALUES.includes(value as ListDensity) ? (value as ListDensity) : "standard";
}

/** Applies a list density to the mounted rows without rebuilding the library. */
export function applyListDensity(): void {
  const list = document.querySelector<HTMLElement>("#lib-results .lib-list");
  if (list) list.dataset.listDensity = S.listDensity;
  syncDensityMenu();
}

/** Persist the chosen list density and repaint the open menu in place. */
export function setListDensity(value: unknown): void {
  const density = normalizeListDensity(value);
  if (density === S.listDensity) {
    syncDensityMenu();
    return;
  }
  S.listDensity = density;
  localStorage.setItem(LIST_DENSITY_KEY, density);
  applyListDensity();
}

function coverGap(grid: HTMLElement | null): number {
  if (!grid) return 16;
  const gap = parseFloat(getComputedStyle(grid).columnGap);
  return Number.isFinite(gap) && gap > 0 ? gap : 16;
}

/**
 * Covers that fit on one row for a preset. Auto mirrors the CSS breakpoints;
 * the manual presets use the same target-width formula as the grid.
 */
function coverSizeColumns(
  size: CoverSize,
  host: HTMLElement | null,
  grid: HTMLElement | null,
): number {
  const width = host?.clientWidth ?? 0;
  if (width <= 0) return 0;
  if (size === "auto") {
    if (width > 1160) return 6;
    if (width > 960) return 5;
    if (width > 740) return 4;
    if (width > 520) return 3;
    return 2;
  }
  const gap = coverGap(grid);
  const target = S.showCaseCovers ? Math.max(190, COVER_SIZE_TARGET[size]) : COVER_SIZE_TARGET[size];
  return Math.max(1, Math.floor((width + gap) / (target + gap)));
}

/** Fills the per-preset counts and moves the check without re-rendering. */
export function syncCoverSizeMenu(): void {
  const menu = document.getElementById("cover-size-menu");
  if (!menu) return;
  const host = document.getElementById("lib-results");
  const grid = document.querySelector<HTMLElement>("#lib-results .pgrid");
  for (const size of COVER_SIZE_VALUES) {
    const count = coverSizeColumns(size, host, grid);
    const countEl = menu.querySelector<HTMLElement>(`[data-cover-count="${size}"]`);
    if (countEl) {
      countEl.textContent = count > 0 ? t("lib.coverSizePerRow", { count }) : "";
    }
    const option = menu.querySelector<HTMLElement>(
      `[data-act="cover-size-set"][data-size="${size}"]`,
    );
    if (!option) continue;
    const selected = size === S.coverSize;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
    const check = option.querySelector<HTMLElement>(".cover-size-check");
    if (check) check.innerHTML = selected ? icon("check", 13) : "";
  }
}

/** Moves the check in the list-density menu without re-rendering the rows. */
function syncListDensityMenu(): void {
  const menu = document.getElementById("cover-size-menu");
  if (!menu) return;
  for (const density of LIST_DENSITY_VALUES) {
    const option = menu.querySelector<HTMLElement>(
      `[data-act="list-density-set"][data-density="${density}"]`,
    );
    if (!option) continue;
    const selected = density === S.listDensity;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
    const check = option.querySelector<HTMLElement>(".cover-size-check");
    if (check) check.innerHTML = selected ? icon("check", 13) : "";
  }
}

/** The open menu follows the active view: covers in grid, rows in list. */
export function syncDensityMenu(): void {
  if (S.epicViewMode === "list") syncListDensityMenu();
  else syncCoverSizeMenu();
}

/**
 * Rebuilds the trigger and menu for the active view mode. Switching between
 * grid and list patches only the results, so the density control must follow
 * without a full page render.
 */
export function syncDensityControl(): void {
  const container = document.querySelector<HTMLElement>(".cover-size-container");
  if (!container) return;
  const label = S.epicViewMode === "list" ? t("lib.listDensity") : t("lib.coverSize");
  const btn = container.querySelector<HTMLElement>('[data-act="toggle-cover-size"]');
  if (btn) {
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-expanded", String(S.isCoverSizeOpen));
  }
  const oldMenu = container.querySelector("#cover-size-menu");
  if (oldMenu) {
    oldMenu.outerHTML = S.epicViewMode === "list" ? listDensityMenuHtml() : coverSizeMenuHtml();
  }
}

/** Tiny density swatch: more, smaller squares mean smaller covers. */
function coverSizeSwatch(size: CoverSize): string {
  const shape: Record<CoverSize, [number, number]> = {
    auto: [2, 2],
    compact: [4, 4],
    standard: [3, 3],
    large: [3, 2],
    xl: [2, 2],
  };
  const [cols, rows] = shape[size];
  return `<span class="cover-size-swatch" data-size="${size}" style="--sw:${cols};--sh:${rows}" aria-hidden="true">${"<i></i>".repeat(cols * rows)}</span>`;
}

/** The density menu. Names stay; the live row count disambiguates at a glance. */
export function coverSizeMenuHtml(): string {
  const host = document.getElementById("lib-results");
  const grid = document.querySelector<HTMLElement>("#lib-results .pgrid");
  const options = COVER_SIZE_VALUES.map((size) => {
    const selected = size === S.coverSize;
    const count = coverSizeColumns(size, host, grid);
    const countText = count > 0 ? t("lib.coverSizePerRow", { count }) : "";
    return `<button type="button" class="cover-size-option${selected ? " selected" : ""}" data-act="cover-size-set" data-size="${size}" role="menuitemradio" aria-checked="${selected}">
      ${coverSizeSwatch(size)}
      <span class="cover-size-name">${esc(coverSizeLabel(size))}${size === "auto" ? `<small>${esc(t("lib.coverSizeAutoDesc"))}</small>` : ""}</span>
      <span class="cover-size-count tabular-nums" data-cover-count="${size}">${esc(countText)}</span>
      <span class="cover-size-check" aria-hidden="true">${selected ? icon("check", 13) : ""}</span>
    </button>`;
  }).join("");
  return `<div id="cover-size-menu" class="cover-size-menu${S.isCoverSizeOpen ? " show" : ""}" role="menu" aria-label="${esc(t("lib.coverSize"))}">
    <div class="cover-size-head">${esc(t("lib.coverSize"))}</div>
    ${options}
  </div>`;
}

/** Row-line swatch: more, thinner lines mean tighter rows. */
function listDensitySwatch(density: ListDensity): string {
  const lines = density === "compact" ? 5 : density === "large" ? 3 : 4;
  return `<span class="list-density-swatch" data-density="${density}" aria-hidden="true">${"<i></i>".repeat(lines)}</span>`;
}

/** The list-view counterpart of the cover-density menu. */
export function listDensityMenuHtml(): string {
  const options = LIST_DENSITY_VALUES.map((density) => {
    const selected = density === S.listDensity;
    return `<button type="button" class="cover-size-option${selected ? " selected" : ""}" data-act="list-density-set" data-density="${density}" role="menuitemradio" aria-checked="${selected}">
      ${listDensitySwatch(density)}
      <span class="cover-size-name">${esc(listDensityLabel(density))}</span>
      <span class="cover-size-check" aria-hidden="true">${selected ? icon("check", 13) : ""}</span>
    </button>`;
  }).join("");
  return `<div id="cover-size-menu" class="cover-size-menu${S.isCoverSizeOpen ? " show" : ""}" role="menu" aria-label="${esc(t("lib.listDensity"))}">
    <div class="cover-size-head">${esc(t("lib.listDensity"))}</div>
    ${options}
  </div>`;
}

/** Settings mirror of the same preference. */
export function coverSizeSelectHtml(): string {
  return `<select class="settings-select" data-act="set-cover-size" aria-label="${esc(t("lib.coverSize"))}">
    ${COVER_SIZE_VALUES.map((size) => `<option value="${size}"${S.coverSize === size ? " selected" : ""}>${esc(coverSizeLabel(size))}</option>`).join("")}
  </select>`;
}

/** Settings mirror of the list density. */
export function listDensitySelectHtml(): string {
  return `<select class="settings-select" data-act="set-list-density" aria-label="${esc(t("lib.listDensity"))}">
    ${LIST_DENSITY_VALUES.map((density) => `<option value="${density}"${S.listDensity === density ? " selected" : ""}>${esc(listDensityLabel(density))}</option>`).join("")}
  </select>`;
}

/**
 * Jump to a page. The target is clamped by the renderer against the current
 * result set, so an out-of-range value can never render an empty page.
 */
export function goToLibraryPage(page: number): void {
  const next = Math.max(1, Math.floor(page));
  if (next === S.libPage) return;
  S.libPage = next;
  viewEl.scrollTop = 0;
  render();
}

/** Move one page forward/backward (rounded by the renderer at the bounds). */
export function stepLibraryPage(delta: number): void {
  goToLibraryPage(S.libPage + delta);
}

/**
 * Click delegation for the new library controls. Returns true when the action
 * was handled so the caller can stop routing it.
 */
export function handleLibraryOptionAction(act: string | undefined, el: HTMLElement): boolean {
  switch (act) {
    case "toggle-cover-titles":
      setCoverTitlesEnabled(!S.showCoverTitles);
      render();
      return true;
    case "toggle-lib-pagination":
      setLibraryPaginationEnabled(!S.libPagination);
      render();
      return true;
    case "cover-size-set":
      setCoverSize(el.dataset.size);
      return true;
    case "list-density-set":
      setListDensity(el.dataset.density);
      return true;
    case "lib-page": {
      const page = Number(el.dataset.page);
      if (page > 0) goToLibraryPage(page);
      return true;
    }
    case "lib-page-prev":
      stepLibraryPage(-1);
      return true;
    case "lib-page-next":
      stepLibraryPage(1);
      return true;
    default:
      return false;
  }
}
