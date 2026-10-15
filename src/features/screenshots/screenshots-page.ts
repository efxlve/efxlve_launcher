/**
 * The Screenshots page: every capture, across every game.
 *
 * The game page's tab shows one game's shots; this page is the library-wide
 * view — same shared defaults (sort, density, favorites) plus its own filter,
 * selection and lightbox. The sidebar entry is opt-in (Settings → Screenshots),
 * like Notes.
 *
 * Editing, sharing and the recorder all hang off this page, so the lightbox
 * here is the place where those actions live.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import {
  epicDeleteGameScreenshot,
  epicGetAllScreenshots,
  epicOpenFolderPath,
  type GameScreenshotItem,
} from "../../epic";
import {
  compressScreenshotItem,
  ensureFullShot,
  forgetFullShot,
  openShareModal,
  shotPreviewSrc,
  shotThumbHtml,
} from "./screenshots-view";
import { ssDensity, ssFavorites, ssSort, ssSortItems, ssToggleFavorite } from "./ss-settings";

type PageFilter = "all" | "favorites" | "raw" | "compressed";

let shots: GameScreenshotItem[] = [];
let loading = false;
let loadedOnce = false;
let filter: PageFilter = "all";
let selectMode = false;
let batchDeleteArmed = false;
const selection = new Set<string>();
/** The open lightbox: an index into the filtered list. */
let lightboxIndex: number | null = null;

const shotBytes = (item: GameScreenshotItem): number => item.size_bytes || 0;
const shotName = (item: GameScreenshotItem): string => item.file_name;

function isCompressed(item: GameScreenshotItem): boolean {
  return item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
}

/** The filtered, sorted list the page draws and the lightbox walks. */
export function visiblePageShots(): GameScreenshotItem[] {
  const favorites = ssFavorites();
  const filtered = shots.filter((item) => {
    if (filter === "favorites") return favorites.has(item.file_path);
    if (filter === "raw") return !isCompressed(item);
    if (filter === "compressed") return isCompressed(item);
    return true;
  });
  return ssSortItems(filtered, (item) => item.timestamp, shotName, shotBytes);
}

export function loadScreenshotsPage(force = false): void {
  if (!isTauri) return;
  if (loading || (loadedOnce && !force)) return;
  loading = true;
  void epicGetAllScreenshots()
    .then((items) => {
      shots = items ?? [];
      loadedOnce = true;
      S.libraryDataRev++;
      repaintScreenshotsPage();
    })
    .catch(() => {
      shots = [];
      repaintScreenshotsPage();
    })
    .finally(() => {
      loading = false;
    });
}

/** Repaints the page in place after a toolbar or lightbox action. */
export function repaintScreenshotsPage(): void {
  if (S.view !== "screenshots") return;
  const host = document.getElementById("view");
  if (host) host.innerHTML = renderScreenshotsPage();
}

/* ---------- Markup ---------- */

function toolbarHtml(): string {
  const chip = (act: string, value: string, label: string, active: boolean, data: string): string =>
    `<button type="button" class="ss-chip-btn${active ? " active" : ""}" data-act="${act}" ${data}="${value}">${label}</button>`;
  const sort = ssSort();
  const density = ssDensity();
  const selected = selection.size;
  const favorites = ssFavorites();
  const counts = {
    all: shots.length,
    favorites: shots.filter((item) => favorites.has(item.file_path)).length,
    raw: shots.filter((item) => !isCompressed(item)).length,
    compressed: shots.filter(isCompressed).length,
  };
  return `
    <div class="ss-toolbar">
      <div class="ss-toolbar-left">
        ${chip("ssp-filter", "all", `${t("ss.filterAll")} <span class="ss-chip-count">${counts.all}</span>`, filter === "all", "data-filter")}
        ${chip("ssp-filter", "favorites", `${t("ss.filterFavorites")} <span class="ss-chip-count">${counts.favorites}</span>`, filter === "favorites", "data-filter")}
        ${chip("ssp-filter", "raw", t("ss.filterRaw"), filter === "raw", "data-filter")}
        ${chip("ssp-filter", "compressed", t("ss.filterCompressed"), filter === "compressed", "data-filter")}
      </div>
      <div class="ss-toolbar-right">
        ${chip("ssp-sort", "newest", t("ss.sortNewest"), sort === "newest", "data-sort")}
        ${chip("ssp-sort", "oldest", t("ss.sortOldest"), sort === "oldest", "data-sort")}
        ${chip("ssp-sort", "name", t("ss.sortName"), sort === "name", "data-sort")}
        ${chip("ssp-sort", "size", t("ss.sortSize"), sort === "size", "data-sort")}
        <span class="ss-toolbar-divider"></span>
        ${chip("ssp-density", "s", t("ss.densitySmall"), density === "s", "data-density")}
        ${chip("ssp-density", "m", t("ss.densityMedium"), density === "m", "data-density")}
        ${chip("ssp-density", "l", t("ss.densityLarge"), density === "l", "data-density")}
        <span class="ss-toolbar-divider"></span>
        <button type="button" class="btn ghost small${selectMode ? " active" : ""}" data-act="ssp-select">
          ${icon("check", 12)} ${t("ss.selectMode")}
        </button>
      </div>
    </div>
    ${
      selectMode
        ? `<div class="ss-batch-bar">
            <span class="ss-batch-count">${t("ss.selectedCount", { count: String(selected) })}</span>
            <button type="button" class="btn ghost small" data-act="ssp-batch-copy" ${selected === 0 ? "disabled" : ""}>${icon("clipboard", 12)} ${t("ss.copyPaths")}</button>
            <button type="button" class="btn ghost small" data-act="ssp-batch-compress" ${selected === 0 ? "disabled" : ""}>${icon("minimize-2", 12)} ${t("ss.compress")}</button>
            <button type="button" class="btn ${batchDeleteArmed ? "danger" : "ghost danger"} small" data-act="ssp-batch-delete" ${selected === 0 ? "disabled" : ""}>${icon("trash", 12)} ${batchDeleteArmed ? t("ss.batchDeleteConfirm") : t("common.delete")}</button>
            <button type="button" class="btn ghost small" data-act="ssp-batch-clear" ${selected === 0 ? "disabled" : ""}>${t("ss.clearSelection")}</button>
          </div>`
        : ""
    }`;
}

function cardHtml(item: GameScreenshotItem, index: number): string {
  const isFavorite = ssFavorites().has(item.file_path);
  const selected = selection.has(item.file_path);
  const action = selectMode ? "ssp-toggle-select" : "ssp-open";
  return `
    <div class="screenshot-card${selected ? " is-selected" : ""}${selectMode ? " is-selecting" : ""}" data-act="${action}" data-index="${index}" data-path="${esc(item.file_path)}" tabindex="0" title="${esc(item.file_name)}">
      <div class="screenshot-thumb-wrap">
        ${shotThumbHtml(item)}
        ${selectMode ? `<span class="ss-select-box">${selected ? icon("check", 12) : ""}</span>` : ""}
        <div class="screenshot-overlay">
          <div class="screenshot-overlay-top">
            <span class="ss-chip date">${esc(item.date_str)}</span>
            <span class="ss-chip size">${esc(item.size_str)}</span>
          </div>
          <div class="screenshot-overlay-bottom">
            <span class="ss-view-btn">${icon("eye", 12)} ${t("ss.zoom")}</span>
            ${item.game_title ? `<span class="ss-game-chip">${esc(item.game_title)}</span>` : ""}
          </div>
        </div>
        <button class="ss-fav-btn${isFavorite ? " is-favorite" : ""}" data-act="ssp-favorite" data-path="${esc(item.file_path)}" title="${esc(isFavorite ? t("ss.unfavorite") : t("ss.favorite"))}">
          ${icon("star", 13)}
        </button>
      </div>
      <div class="screenshot-info-strip">
        <span class="ss-name" title="${esc(item.file_name)}">${esc(item.file_name)}</span>
        <span class="ss-date">${esc(item.game_title || "")}</span>
      </div>
    </div>`;
}

export function renderScreenshotsPage(): string {
  if (!isTauri) {
    return `<div class="page screenshots-page"><div class="info-box">${icon("info", 14)}<span>${t("task.desktopOnly")}</span></div></div>`;
  }
  if (!loadedOnce) loadScreenshotsPage();
  const visible = visiblePageShots();
  const favorites = ssFavorites();
  const totalBytes = shots.reduce((sum, item) => sum + shotBytes(item), 0);
  const header = `
    <div class="ss-page-head">
      <div class="ss-page-info">
        <h2 class="ss-page-title">${icon("image", 18)} <span>${t("ss.title")}</span></h2>
        <span class="screenshots-count-chip">${t("ss.photoCount", { count: String(shots.length) })}</span>
        <span class="screenshots-count-chip">${fmtBytes(totalBytes)}</span>
        ${favorites.size > 0 ? `<span class="screenshots-count-chip ss-fav-chip">${icon("star", 11)} ${favorites.size}</span>` : ""}
      </div>
      <div class="ss-page-actions">
        <button type="button" class="btn ghost small" data-act="ssp-refresh">${icon("refresh", 13)} ${t("task.refresh")}</button>
        <button type="button" class="btn ghost small" data-act="ss-open-dir">${icon("folder", 13)} ${t("ss.openFolder")}</button>
      </div>
    </div>`;

  if (shots.length === 0) {
    return `
      <div class="page screenshots-page">
        ${header}
        <div class="screenshots-empty-card">
          <div class="screenshots-empty-icon">${icon("image", 44)}</div>
          <h4 class="screenshots-empty-title">${t("ss.emptyTitle")}</h4>
          <p class="screenshots-empty-desc">${t("ss.emptyDesc", { hotkey: `<strong>${esc(S.screenshotHotkeyName)}</strong>` })}</p>
        </div>
      </div>`;
  }

  return `
    <div class="page screenshots-page">
      ${header}
      ${toolbarHtml()}
      ${
        visible.length === 0
          ? `<div class="screenshots-empty-card"><p class="screenshots-empty-desc">${t("ss.filterEmpty")}</p></div>`
          : `<div class="screenshots-grid ss-density-${ssDensity()}">${visible.map((item, index) => cardHtml(item, index)).join("")}</div>`
      }
    </div>`;
}

/* ---------- Lightbox ---------- */

function currentLightboxShot(): GameScreenshotItem | null {
  if (lightboxIndex === null) return null;
  return visiblePageShots()[lightboxIndex] ?? null;
}

export function closePageLightbox(): void {
  lightboxIndex = null;
  document.getElementById("ssp-lightbox-root")?.remove();
}

export function pageLightboxOpen(): boolean {
  return lightboxIndex !== null;
}

/** Opens the full-screen viewer on the filtered list; the original loads when
 * it lands, the grid preview shows until then. */
export function openPageLightbox(index: number): void {
  const visible = visiblePageShots();
  const item = visible[index];
  if (!item) return;
  lightboxIndex = index;
  let root = document.getElementById("ssp-lightbox-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ssp-lightbox-root";
    document.body.appendChild(root);
  }
  const isFavorite = ssFavorites().has(item.file_path);
  root.innerHTML = `
    <div class="screenshot-lightbox-overlay" data-act="ssp-lightbox-backdrop">
      <div class="screenshot-lightbox-box">
        <div class="lightbox-topbar">
          <div class="lightbox-info">
            <span class="lightbox-filename">${esc(item.game_title || item.file_name)}</span>
            <span class="lightbox-meta">${esc(item.file_name)} • ${esc(item.date_str)} • ${esc(item.size_str)}</span>
          </div>
          <div class="lightbox-tools">
            <button class="btn ghost small" data-act="ssp-lightbox-favorite">${icon("star", 13)} ${esc(isFavorite ? t("ss.unfavorite") : t("ss.favorite"))}</button>
            <button class="btn ghost small" data-act="ssp-lightbox-share" title="${t("ss.shareTip2")}">${icon("share-2", 13)} ${t("ss.share")}</button>
            <button class="btn ghost small" data-act="ssp-lightbox-copy" title="${t("ss.copyTip")}">${icon("copy", 13)} ${t("ss.copy")}</button>
            ${isCompressed(item) ? `<span class="lightbox-badge-avif">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>` : `<button class="btn ghost small" data-act="ssp-lightbox-compress" title="${t("ss.compressTip2")}">${icon("minimize-2", 13)} ${t("ss.compress")}</button>`}
            <button class="btn ghost small" data-act="ssp-lightbox-folder" title="${t("ss.showInFolder")}">${icon("folder", 12)} ${t("ss.showInFolderShort")}</button>
            <button class="btn ghost danger small" data-act="ssp-lightbox-delete" title="${t("ss.deleteTip")}">${icon("trash", 12)} ${t("common.delete")}</button>
            <button class="btn ghost small" data-act="ssp-lightbox-close" title="${t("common.close")} (ESC)">${icon("x", 14)}</button>
          </div>
        </div>
        <div class="lightbox-stage">
          ${index > 0 ? `<button class="lightbox-arrow prev" data-act="ssp-lightbox-prev" title="${t("ss.prevTip")}">${icon("chevron-left", 22)}</button>` : ""}
          <div class="lightbox-img-container">
            <img src="${esc(shotPreviewSrc(item))}" alt="${esc(item.file_name)}" draggable="false" />
          </div>
          ${index < visible.length - 1 ? `<button class="lightbox-arrow next" data-act="ssp-lightbox-next" title="${t("ss.nextTip")}">${icon("chevron-right", 22)}</button>` : ""}
        </div>
        <div class="lightbox-counter-bar"><span>${index + 1} / ${visible.length}</span></div>
      </div>
    </div>`;
  void ensureFullShot("", item).then((src) => {
    const img = document.querySelector<HTMLImageElement>("#ssp-lightbox-root .lightbox-img-container img");
    if (src && img && lightboxIndex !== null) img.src = src;
  });
}

export function navigatePageLightbox(step: number): void {
  if (lightboxIndex === null) return;
  const next = lightboxIndex + step;
  const visible = visiblePageShots();
  if (next < 0 || next >= visible.length) return;
  openPageLightbox(next);
}

/** The shot the lightbox (or the page) currently points at. */
export function pageLightboxShot(): GameScreenshotItem | null {
  return currentLightboxShot();
}

/* ---------- Actions used by the handler ---------- */

export function setPageFilter(next: PageFilter): void {
  filter = next;
}

export function setPageSelectMode(on: boolean): void {
  selectMode = on;
  if (!on) {
    selection.clear();
    batchDeleteArmed = false;
  }
}

export function togglePageSelection(filePath: string): void {
  if (selection.has(filePath)) selection.delete(filePath);
  else selection.add(filePath);
  batchDeleteArmed = false;
}

export function clearPageSelection(): void {
  selection.clear();
  batchDeleteArmed = false;
}

export function isPageBatchDeleteArmed(): boolean {
  return batchDeleteArmed;
}

export function setPageBatchDeleteArmed(on: boolean): void {
  batchDeleteArmed = on;
}

export function selectedPageShots(): GameScreenshotItem[] {
  return shots.filter((item) => selection.has(item.file_path));
}

/** Flips one favorite and repaints whatever is on screen. */
export function togglePageFavorite(filePath: string): boolean {
  const favorite = ssToggleFavorite(filePath);
  if (pageLightboxOpen()) {
    const shot = currentLightboxShot();
    if (shot) openPageLightbox(visiblePageShots().indexOf(shot));
  }
  repaintScreenshotsPage();
  return favorite;
}

/** Removes one file from the list (after a delete) and closes the lightbox. */
export function dropPageShot(filePath: string): void {
  shots = shots.filter((item) => item.file_path !== filePath);
  selection.delete(filePath);
  forgetFullShot(filePath);
  closePageLightbox();
  repaintScreenshotsPage();
}

export async function deletePageShot(item: GameScreenshotItem): Promise<boolean> {
  try {
    const ok = await epicDeleteGameScreenshot(item.file_path);
    if (ok) dropPageShot(item.file_path);
    return ok;
  } catch {
    return false;
  }
}

export function openPageShotFolder(item: GameScreenshotItem): void {
  const dir = item.file_path.replace(/[\\/][^\\/]+$/, "");
  void epicOpenFolderPath(dir).catch(() => toast(item.file_path, ""));
}

export { openShareModal, compressScreenshotItem };
