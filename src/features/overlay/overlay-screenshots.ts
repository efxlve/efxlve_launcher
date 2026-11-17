/**
 * Overlay Screenshots view and lightbox: the gallery, per-game filters,
 * favorites, sorting and the modal preview.
 *
 * One-way dependency: the page configures context/widget queries through
 * configureScreenshots; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { SS_SORT_KEY } from "../../core/constants";
import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { ssDensity, ssFavorites, ssSort, ssSortItems } from "../screenshots/ss-settings";

export interface ScreenshotItem {
  file_path: string;
  file_name: string;
  date_str: string;
  data_url: string;
  game_title?: string;
  /** Present on the wire; the overlay sorts and sizes with them. */
  timestamp?: number;
  size_bytes?: number;
}

interface ScreenshotContext {
  appName: string;
  title: string;
}

interface ScreenshotDeps {
  context: () => ScreenshotContext;
  launcherMode: () => boolean;
  viewEl: () => HTMLElement | null;
  renderHome: () => void;
  splitKey: (key: string) => { store: string; id: string };
}

let deps: ScreenshotDeps | null = null;

export function configureScreenshots(next: ScreenshotDeps): void {
  deps = next;
}

function D(): ScreenshotDeps {
  if (!deps) throw new Error("overlay screenshots rendered before configuration");
  return deps;
}

let cachedScreenshots: ScreenshotItem[] = [];
let selectedGameFilters = new Set<string>();
let filterPopoverOpen = false;
let overlayShotsFavoritesOnly = false;
let shotsLoadGeneration = 0;
let lightboxIndex = -1;

function emptyBlockHtml(iconName: IconName, title: string, desc = ""): string {
  return `
    <div class="ov-empty-block">
      <div class="ov-empty-icon">${icon(iconName, 24)}</div>
      <div class="ov-empty-title">${esc(title)}</div>
      ${desc ? `<div class="ov-empty-desc">${esc(desc)}</div>` : ""}
    </div>`;
}

/** The game a capture belongs to; untitled files share the "Other" bucket. */
function shotGameLabel(item: ScreenshotItem): string {
  return item.game_title?.trim() || t("overlay.otherGame");
}

/* 4. Full Screenshots View */
function getVisibleScreenshots(): ScreenshotItem[] {
  const favorites = ssFavorites();
  let items = cachedScreenshots;
  if (selectedGameFilters.size > 0) {
    items = items.filter((item) => selectedGameFilters.has(shotGameLabel(item).toLowerCase()));
  }
  if (overlayShotsFavoritesOnly) {
    items = items.filter((item) => favorites.has(item.file_path));
  }
  return ssSortItems(
    items,
    (item) => item.timestamp ?? 0,
    (item) => item.file_name,
    (item) => item.size_bytes ?? 0,
  );
}

export async function loadScreenshots(force = false): Promise<void> {
  const el = D().viewEl();
  if (!el) return;
  if (cachedScreenshots.length === 0 || force) {
    const generation = ++shotsLoadGeneration;
    el.innerHTML = `<div class="ov-empty">${esc(t("common.calculating"))}</div>`;
    let loaded: ScreenshotItem[] = [];
    if (D().launcherMode()) {
      try {
        loaded = await invoke<ScreenshotItem[]>("epic_get_all_screenshots");
      } catch {
        loaded = [];
      }
    } else {
      const { store, id } = D().splitKey(D().context().appName);
      if (store === "steam") {
        try {
          loaded = await invoke<ScreenshotItem[]>("steam_get_game_screenshots", { appId: id });
        } catch {
          loaded = [];
        }
      } else if (store === "game") {
        loaded = [];
      } else {
        try {
          loaded = await invoke<ScreenshotItem[]>("epic_get_game_screenshots", {
            appName: D().context().appName,
            title: D().context().title,
          });
        } catch {
          loaded = [];
        }
      }
    }
    // The game can change while the disk scan runs; a stale list must not land
    // under the new title.
    if (generation !== shotsLoadGeneration) return;
    cachedScreenshots = loaded;
  }

  // Build game counts map
  const gameCounts = new Map<string, number>();
  for (const item of cachedScreenshots) {
    const g = shotGameLabel(item);
    gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
  }

  // Prune deleted/obsolete filters
  if (selectedGameFilters.size > 0) {
    const validKeys = new Set(Array.from(gameCounts.keys()).map((k) => k.toLowerCase()));
    for (const key of Array.from(selectedGameFilters)) {
      if (!validKeys.has(key)) {
        selectedGameFilters.delete(key);
      }
    }
  }

  const activeFilterCount = selectedGameFilters.size;
  const visibleShots = getVisibleScreenshots();

  const titleText = D().launcherMode()
    ? esc(t("overlay.tabScreenshots"))
    : (D().context().title ? `${esc(D().context().title)} — ${esc(t("overlay.tabScreenshots"))}` : esc(t("overlay.tabScreenshots")));

  const filterBtnHtml = gameCounts.size > 1 ? `
    <div class="ov-shots-filter-wrapper">
      <button
        class="btn ghost small ov-shots-filter-btn ${activeFilterCount > 0 ? "active" : ""}"
        data-ov="shots-filter-toggle"
        type="button"
        title="${esc(t("overlay.shotsGameFilter"))}"
      >
        ${icon("sliders", 13)}
        <span>${esc(t("overlay.shotsFilter"))}</span>
        ${activeFilterCount > 0 ? `<span class="ov-shots-filter-active-count">${activeFilterCount}</span>` : ""}
        ${icon("chevron-down", 11)}
      </button>
      <div class="ov-shots-filter-popover ${filterPopoverOpen ? "open" : ""}" id="ov-shots-filter-popover">
        <div class="ov-shots-filter-popover-header">
          <span class="ov-shots-filter-popover-title">${esc(t("overlay.shotsGameFilter"))}</span>
          ${activeFilterCount > 0 ? `
            <button class="btn ghost tiny ov-shots-filter-clear-btn" data-ov="shots-filter-clear" type="button">
              ${esc(t("overlay.shotsClear"))}
            </button>
          ` : ""}
        </div>
        <div class="ov-shots-filter-popover-list">
          <div class="ov-shots-filter-row" data-ov-filter-game="all">
            <div class="ov-shots-filter-checkbox ${selectedGameFilters.size === 0 ? "checked" : ""}">
              ${selectedGameFilters.size === 0 ? icon("check", 12) : ""}
            </div>
            <span class="ov-shots-filter-label">${esc(t("overlay.shotsAll"))}</span>
            <span class="ov-shots-filter-row-count">${cachedScreenshots.length}</span>
          </div>
          <div class="ov-shots-filter-popover-divider"></div>
          ${Array.from(gameCounts.entries()).map(([game, count]) => {
            const isChecked = selectedGameFilters.has(game.toLowerCase());
            return `
              <div class="ov-shots-filter-row" data-ov-filter-game="${esc(game)}">
                <div class="ov-shots-filter-checkbox ${isChecked ? "checked" : ""}">
                  ${isChecked ? icon("check", 12) : ""}
                </div>
                <span class="ov-shots-filter-label" title="${esc(game)}">${esc(game)}</span>
                <span class="ov-shots-filter-row-count">${count}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </div>` : "";

  el.innerHTML = `
    <div class="ov-page-title" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        ${icon("camera", 20)}
        <span>${titleText}</span>
        <span class="ov-shots-count-pill" title="${esc(t("overlay.shotsCount", { count: String(visibleShots.length) }))}">${visibleShots.length}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${filterBtnHtml}
        <button class="btn ghost small ${overlayShotsFavoritesOnly ? "active" : ""}" data-ov="shots-fav-filter" title="${esc(t("ss.filterFavorites"))}">
          ${icon("star", 14)}
        </button>
        <button class="btn ghost small" data-ov="shots-sort-cycle" title="${esc(t("ss.sortTitle"))}">
          ${icon("list", 14)} <span>${esc(overlaySortLabel())}</span>
        </button>
        <button class="btn ghost small" data-ov="shots-folder" title="${esc(t("overlay.openFolder"))}">
          ${icon("folder", 14)} <span>${esc(t("overlay.openFolder"))}</span>
        </button>
      </div>
    </div>
    ${visibleShots.length === 0 ? emptyBlockHtml("camera", t("overlay.noShots"), t("overlay.captureHint")) : `
      <div class="ov-shots-grid" style="grid-template-columns:repeat(auto-fill, minmax(${overlayDensityPx()}px, 1fr));gap:12px">
        ${visibleShots.map((item) => {
          const tooltip = item.game_title ? `${item.game_title} • ${item.date_str}` : item.date_str;
          const isFavorite = ssFavorites().has(item.file_path);
          return `
            <div class="ov-shot-item" data-ov-preview="${esc(item.data_url)}" title="${esc(tooltip)}">
              <img src="${esc(item.data_url)}" alt="" loading="lazy" />
              ${item.game_title ? `<div class="ov-shot-badge">${esc(item.game_title)}</div>` : ""}
              <button class="ov-shot-fav${isFavorite ? " is-favorite" : ""}" data-ov="ov-shot-favorite" data-path="${esc(item.file_path)}" title="${esc(isFavorite ? t("ss.unfavorite") : t("ss.favorite"))}">
                ${icon("star", 12)}
              </button>
            </div>`;
        }).join("")}
      </div>`}`;
  D().renderHome();
}

/** The overlay's sort button label (the shared order). */
function overlaySortLabel(): string {
  switch (ssSort()) {
    case "oldest": return t("ss.sortOldest");
    case "name": return t("ss.sortName");
    case "size": return t("ss.sortSize");
    default: return t("ss.sortNewest");
  }
}

/** The overlay's grid minimum width per density step. */
function overlayDensityPx(): number {
  switch (ssDensity()) {
    case "s": return 140;
    case "l": return 320;
    default: return 220;
  }
}


/* ---------- Screenshot Lightbox ---------- */

export function lightboxIsOpen(): boolean {
  const box = document.getElementById("ov-lightbox");
  return !!box && box.style.display !== "none";
}

export function showLightbox(src: string): void {
  const box = document.getElementById("ov-lightbox");
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  const counter = document.getElementById("ov-lightbox-counter");
  if (!box || !img) return;
  const items = getVisibleScreenshots();
  lightboxIndex = items.findIndex((item) => item.data_url === src);
  img.src = src;
  if (counter) {
    if (lightboxIndex >= 0 && items.length > 1) {
      const g = items[lightboxIndex].game_title ? `${items[lightboxIndex].game_title} • ` : "";
      counter.textContent = `${g}${lightboxIndex + 1} / ${items.length}`;
    } else {
      counter.textContent = items[lightboxIndex]?.game_title || "";
    }
  }
  box.style.display = "grid";
}

/** Steps through the screenshots while the lightbox is open (LB/RB, arrows). */
export function stepLightbox(delta: number): void {
  const items = getVisibleScreenshots();
  if (lightboxIndex < 0 || items.length === 0) return;
  lightboxIndex = (lightboxIndex + delta + items.length) % items.length;
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  const counter = document.getElementById("ov-lightbox-counter");
  if (img) img.src = items[lightboxIndex].data_url;
  if (counter) {
    const g = items[lightboxIndex].game_title ? `${items[lightboxIndex].game_title} • ` : "";
    counter.textContent = `${g}${lightboxIndex + 1} / ${items.length}`;
  }
}

export function hideLightbox(): void {
  const box = document.getElementById("ov-lightbox");
  if (box) box.style.display = "none";
  lightboxIndex = -1;
}

/** The Home dashboard paints a few of the same captures. */
export function screenshotItems(): ScreenshotItem[] {
  return cachedScreenshots;
}

/** A new panel session starts from a clean gallery and filter state. */
export function resetScreenshotsSession(): void {
  cachedScreenshots = [];
  selectedGameFilters.clear();
  filterPopoverOpen = false;
  overlayShotsFavoritesOnly = false;
  shotsLoadGeneration += 1;
  hideLightbox();
}

export function isShotFilterPopoverOpen(): boolean {
  return filterPopoverOpen;
}

export function closeShotFilterPopover(): void {
  filterPopoverOpen = false;
  document.getElementById("ov-shots-filter-popover")?.classList.remove("open");
}

export function toggleShotFilterPopover(): void {
  filterPopoverOpen = !filterPopoverOpen;
  document.getElementById("ov-shots-filter-popover")?.classList.toggle("open", filterPopoverOpen);
}

export function toggleShotGameFilter(game: string): void {
  if (game === "all") {
    selectedGameFilters.clear();
  } else {
    const lower = game.toLowerCase();
    if (selectedGameFilters.has(lower)) selectedGameFilters.delete(lower);
    else selectedGameFilters.add(lower);
  }
  void loadScreenshots();
}

export function clearShotFilters(): void {
  selectedGameFilters.clear();
  void loadScreenshots();
}

export function toggleShotsFavoritesOnly(): void {
  overlayShotsFavoritesOnly = !overlayShotsFavoritesOnly;
  void loadScreenshots();
}

export function cycleShotSort(): void {
  const order = ssSort();
  const next = order === "newest" ? "oldest" : order === "oldest" ? "name" : order === "name" ? "size" : "newest";
  localStorage.setItem(SS_SORT_KEY, next);
  void loadScreenshots();
}

