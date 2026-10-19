/**
 * Media Studio Hub: Every capture and recording across every game.
 *
 * Unified creative workspace combining full photo studio capabilities
 * (color grading presets, adjustments, crop ratios, annotations, watermark)
 * and an interactive video clip studio (player, trimmer, frame snapshot grabber).
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { t, localizeMessage } from "../../i18n";
import {
  clipDelete,
  clipFrame,
  clipJoin,
  clipList,
  clipShareDiscord,
  clipThumbnail,
  clipTrim,
  epicDeleteGameScreenshot,
  epicGetAllScreenshots,
  epicOpenFolderPath,
  epicSaveEditedScreenshot,
  type ClipItem,
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
import { openScreenshotEditor } from "./screenshot-editor";
import { ssDensity, ssFavorites, ssSort, ssSortItems, ssToggleFavorite, ssWebhooks } from "./ss-settings";

export type StudioTab = "all" | "photos" | "clips" | "favorites";
export type PageFilter = "all" | "raw" | "compressed" | "favorites";

let shots: GameScreenshotItem[] = [];
let clips: ClipItem[] = [];
let loading = false;
let loadedOnce = false;
let clipsLoaded = false;

let studioTab: StudioTab = "all";
let filter: PageFilter = "all";
let searchQuery = "";
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

export function setStudioTab(tab: StudioTab): void {
  studioTab = tab;
}

export function getStudioTab(): StudioTab {
  return studioTab;
}

export function setSearchQuery(query: string): void {
  searchQuery = query.toLowerCase().trim();
}

export function getShotByPath(path: string): GameScreenshotItem | undefined {
  return shots.find((item) => item.file_path === path);
}

/** Filtered and sorted shots list for the page and lightbox. */
export function visiblePageShots(): GameScreenshotItem[] {
  const favorites = ssFavorites();
  const q = searchQuery;
  const filtered = shots.filter((item) => {
    if (q) {
      const matchGame = item.game_title ? item.game_title.toLowerCase().includes(q) : false;
      const matchFile = item.file_name.toLowerCase().includes(q);
      if (!matchGame && !matchFile) return false;
    }
    if (studioTab === "favorites") return favorites.has(item.file_path);
    if (filter === "raw") return !isCompressed(item);
    if (filter === "compressed") return isCompressed(item);
    return true;
  });
  return ssSortItems(filtered, (item) => item.timestamp, shotName, shotBytes);
}

/** Filtered clips list. */
export function visiblePageClips(): ClipItem[] {
  const q = searchQuery;
  return clips.filter((clip) => {
    if (!q) return true;
    return clip.name.toLowerCase().includes(q) || clip.path.toLowerCase().includes(q);
  });
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

export function loadClips(): void {
  if (!isTauri || clipsLoaded) return;
  clipsLoaded = true;
  void clipList()
    .then((items) => {
      clips = items ?? [];
      repaintScreenshotsPage();
    })
    .catch(() => undefined);
}

export function reloadClips(): void {
  clipsLoaded = false;
  loadClips();
}

window.addEventListener("screenshots-changed", () => {
  if (S.view !== "screenshots") return;
  loadScreenshotsPage(true);
  reloadClips();
});

export function repaintScreenshotsPage(): void {
  if (S.view !== "screenshots") return;
  const host = document.getElementById("view");
  if (host) host.innerHTML = renderScreenshotsPage();
  hydrateClipThumbs();
  wireSearchInput();
}

/* ---------- Markup ---------- */

function studioToolbarHtml(): string {
  const chip = (act: string, value: string, label: string, active: boolean, data: string): string =>
    `<button type="button" class="ss-chip-btn${active ? " active" : ""}" data-act="${act}" ${data}="${value}">${label}</button>`;
  const tabBtn = (id: StudioTab, label: string, iconName: Parameters<typeof icon>[0], count?: number): string => `
    <button type="button" class="ss-studio-pill${studioTab === id ? " active" : ""}" data-act="ssp-tab" data-tab="${id}">
      ${icon(iconName, 13)}
      <span>${esc(label)}</span>
      ${count !== undefined ? `<span class="ss-pill-count">${count}</span>` : ""}
    </button>`;

  const favorites = ssFavorites();
  const favCount = shots.filter((item) => favorites.has(item.file_path)).length;
  const sort = ssSort();
  const density = ssDensity();
  const selected = selection.size;

  return `
    <div class="ss-studio-bar">
      <div class="ss-studio-pills">
        ${tabBtn("all", t("ss.tabAll"), "layers", shots.length + clips.length)}
        ${tabBtn("photos", t("ss.tabPhotos"), "image", shots.length)}
        ${tabBtn("clips", t("ss.tabClips"), "video", clips.length)}
        ${tabBtn("favorites", t("ss.tabFavorites"), "star", favCount)}
      </div>

      ${
        studioTab !== "clips"
          ? `<div class="ss-studio-filters">
              ${chip("ssp-filter", "all", t("ss.filterAll"), filter === "all", "data-filter")}
              ${chip("ssp-filter", "raw", t("ss.filterRaw"), filter === "raw", "data-filter")}
              ${chip("ssp-filter", "compressed", t("ss.filterCompressed"), filter === "compressed", "data-filter")}
            </div>`
          : ""
      }

      <div class="ss-studio-bar-right">
        <div class="ss-studio-search-wrap">
          ${icon("search", 13)}
          <input type="text" id="ss-studio-search" class="ss-studio-search" placeholder="${esc(t("ss.searchPlaceholder"))}" value="${esc(searchQuery)}" />
          ${searchQuery ? `<button type="button" class="ss-search-clear" data-act="ssp-search-clear" title="${t("common.clear")}">${icon("x", 12)}</button>` : ""}
        </div>

        <span class="ss-toolbar-divider"></span>

        <div class="ss-studio-sort-group">
          ${chip("ssp-sort", "newest", t("ss.sortNewest"), sort === "newest", "data-sort")}
          ${chip("ssp-sort", "oldest", t("ss.sortOldest"), sort === "oldest", "data-sort")}
          ${chip("ssp-sort", "name", t("ss.sortName"), sort === "name", "data-sort")}
          ${chip("ssp-sort", "size", t("ss.sortSize"), sort === "size", "data-sort")}
        </div>

        ${
          studioTab !== "clips"
            ? `<span class="ss-toolbar-divider"></span>
               <div class="ss-studio-density-group">
                 ${chip("ssp-density", "s", t("ss.densitySmall"), density === "s", "data-density")}
                 ${chip("ssp-density", "m", t("ss.densityMedium"), density === "m", "data-density")}
                 ${chip("ssp-density", "l", t("ss.densityLarge"), density === "l", "data-density")}
               </div>`
            : ""
        }
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
          <div class="screenshot-overlay-center">
            <button type="button" class="ss-card-edit-btn" data-act="ssp-card-edit" data-path="${esc(item.file_path)}" title="${esc(t("ss.edit"))}">
              ${icon("camera", 13)} <span>${t("ss.edit")}</span>
            </button>
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

function videoCardHtml(clip: ClipItem): string {
  return `
    <div class="ss-video-card" data-path="${esc(clip.path)}">
      <div class="ss-video-thumb-wrap" data-act="ssp-clip-studio" data-path="${esc(clip.path)}" title="${esc(clip.name)}">
        <span class="ss-video-thumb" data-clip-thumb="${esc(clip.path)}">
          ${icon("play", 18)}
        </span>
        <div class="ss-video-overlay-badge">${clipLength(clip.seconds)}</div>
        <div class="ss-video-hover-play">
          <span class="ss-play-circle">${icon("play", 20)}</span>
          <span class="ss-play-label">${t("ss.clipPlayStudio")}</span>
        </div>
      </div>
      <div class="ss-video-info">
        <div class="ss-video-title" title="${esc(clip.name)}">${esc(clip.name)}</div>
        <div class="ss-video-meta">
          <span>${esc(clip.dateStr)}</span>
          <span>•</span>
          <span>${fmtBytes(clip.sizeBytes)}</span>
        </div>
        <div class="ss-video-actions">
          <button type="button" class="btn ghost small ss-btn-studio" data-act="ssp-clip-studio" data-path="${esc(clip.path)}">
            ${icon("sliders", 12)} ${t("ss.clipTrim")}
          </button>
          <button type="button" class="btn ghost small" data-act="clip-share" data-path="${esc(clip.path)}" title="${esc(t("ss.clipShareTitle"))}">
            ${icon("discord", 12)}
          </button>
          <button type="button" class="btn ghost small" data-act="ssp-clip-folder" data-path="${esc(clip.path)}" title="${esc(t("ss.showInFolderShort"))}">
            ${icon("folder", 12)}
          </button>
          <button type="button" class="btn ghost danger small" data-act="ssp-clip-delete" data-path="${esc(clip.path)}" title="${esc(t("common.delete"))}">
            ${icon("trash", 12)}
          </button>
        </div>
      </div>
    </div>`;
}

function clipsSectionHtml(): string {
  if (!clipsLoaded) loadClips();
  const visibleClips = visiblePageClips();

  if (visibleClips.length === 0) {
    if (studioTab !== "clips") return "";
    return `
      <div class="screenshots-empty-card" style="margin-top: 24px;">
        <div class="screenshots-empty-icon">${icon("video", 40)}</div>
        <h4 class="screenshots-empty-title">${t("ss.clipEmpty")}</h4>
        <p class="screenshots-empty-desc">${t("ss.clipDesc")}</p>
      </div>`;
  }

  return `
    <div class="ss-clips-section">
      <div class="ss-clips-head">
        <div class="ss-head-info">
          <h3 class="section-title">${icon("video", 15)} ${t("ss.tabClips")}</h3>
          <span class="screenshots-count-chip">${visibleClips.length}</span>
        </div>
        ${visibleClips.length > 1 ? `<button type="button" class="btn ghost small" data-act="clip-join">${icon("layers", 13)} ${t("ss.clipJoinTitle")}</button>` : ""}
      </div>
      <div class="ss-video-grid">${visibleClips.map((c) => videoCardHtml(c)).join("")}</div>
    </div>`;
}

const SCAN_CAP = 300;

export function renderScreenshotsPage(): string {
  if (!isTauri) {
    return `<div class="page screenshots-page"><div class="info-box">${icon("info", 14)}<span>${t("task.desktopOnly")}</span></div></div>`;
  }
  if (!loadedOnce) loadScreenshotsPage();
  if (!clipsLoaded) loadClips();

  const visibleShots = visiblePageShots();
  const visibleClips = visiblePageClips();
  const favorites = ssFavorites();
  const totalBytes =
    shots.reduce((sum, item) => sum + shotBytes(item), 0) +
    clips.reduce((sum, c) => sum + c.sizeBytes, 0);

  const header = `
    <div class="ss-page-head">
      <div class="ss-page-info">
        <h2 class="ss-page-title">${icon("clapperboard", 20)} <span>${t("ss.studio")}</span></h2>
        <span class="screenshots-count-chip">${t("ss.statsSummary", { photos: String(shots.length), clips: String(clips.length), size: fmtBytes(totalBytes) })}</span>
        ${favorites.size > 0 ? `<span class="screenshots-count-chip ss-fav-chip">${icon("star", 11)} ${favorites.size}</span>` : ""}
      </div>
      <div class="ss-page-actions">
        <button type="button" class="btn ghost small${selectMode ? " active" : ""}" data-act="ssp-select">
          ${icon("check", 12)} ${t("ss.selectMode")}
        </button>
        <button type="button" class="btn ghost small" data-act="ssp-refresh">${icon("refresh", 13)} ${t("task.refresh")}</button>
        <button type="button" class="btn ghost small" data-act="ss-open-dir">${icon("folder", 13)} ${t("ss.openFolder")}</button>
      </div>
    </div>`;

  if (shots.length === 0 && clips.length === 0) {
    return `
      <div class="page screenshots-page">
        ${header}
        ${studioToolbarHtml()}
        <div class="screenshots-empty-card">
          <div class="screenshots-empty-icon">${icon("clapperboard", 44)}</div>
          <h4 class="screenshots-empty-title">${t("ss.allMediaEmpty")}</h4>
          <p class="screenshots-empty-desc">${t("ss.allMediaEmptyDesc", { hotkey: `<strong>${esc(S.screenshotHotkeyName)}</strong>` })}</p>
        </div>
      </div>`;
  }

  let content = "";
  if (studioTab === "clips") {
    content = clipsSectionHtml();
  } else if (studioTab === "photos") {
    content = `
      ${
        visibleShots.length === 0
          ? `<div class="screenshots-empty-card"><p class="screenshots-empty-desc">${t("ss.filterEmpty")}</p></div>`
          : `<div class="screenshots-grid ss-density-${ssDensity()}">${visibleShots.map((item, index) => cardHtml(item, index)).join("")}</div>`
      }`;
  } else if (studioTab === "favorites") {
    const favShots = visibleShots.filter((item) => favorites.has(item.file_path));
    content = `
      ${
        favShots.length === 0
          ? `<div class="screenshots-empty-card"><p class="screenshots-empty-desc">${t("ss.filterEmpty")}</p></div>`
          : `<div class="screenshots-grid ss-density-${ssDensity()}">${favShots.map((item, index) => cardHtml(item, index)).join("")}</div>`
      }`;
  } else {
    // "all" tab
    content = `
      ${clips.length > 0 ? clipsSectionHtml() : ""}
      ${
        visibleShots.length === 0
          ? `<div class="screenshots-empty-card"><p class="screenshots-empty-desc">${t("ss.filterEmpty")}</p></div>`
          : `<div class="screenshots-grid ss-density-${ssDensity()}">${visibleShots.map((item, index) => cardHtml(item, index)).join("")}</div>`
      }`;
  }

  return `
    <div class="page screenshots-page">
      ${header}
      ${studioToolbarHtml()}
      ${content}
      ${
        shots.length >= SCAN_CAP
          ? `<p class="page-sub ss-cap-note">${icon("info", 13)} ${t("ss.capNote", { count: String(SCAN_CAP) })}</p>`
          : ""
      }
    </div>`;
}

function wireSearchInput(): void {
  const input = document.getElementById("ss-studio-search") as HTMLInputElement | null;
  if (!input) return;
  let timer: number | null = null;
  input.addEventListener("input", () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setSearchQuery(input.value);
      repaintScreenshotsPage();
      const nextInput = document.getElementById("ss-studio-search") as HTMLInputElement | null;
      if (nextInput) {
        nextInput.focus();
        nextInput.selectionStart = nextInput.selectionEnd = nextInput.value.length;
      }
    }, 120);
  });
}

/* ---------- Clip Studio Player & Trimmer Modal ---------- */

let studioClipPath: string | null = null;
let studioVideoEl: HTMLVideoElement | null = null;

function clipDialogRoot(): HTMLElement {
  let root = document.getElementById("ss-clip-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ss-clip-root";
    document.body.appendChild(root);
  }
  return root;
}

export function closeClipDialog(): void {
  studioClipPath = null;
  studioVideoEl = null;
  clipSharePath = null;
  const root = document.getElementById("ss-clip-root");
  if (root) root.innerHTML = "";
}

export function updateClipRangeNote(): void {
  const note = document.getElementById("ss-clip-range-note");
  if (!note || !studioClipPath) return;
  const clip = clips.find((entry) => entry.path === studioClipPath);
  const start = Number((document.getElementById("ss-clip-start") as HTMLInputElement | null)?.value ?? "0");
  const end = Number((document.getElementById("ss-clip-end") as HTMLInputElement | null)?.value ?? "0");
  const length = Math.max(0, end - start);
  const total = clip?.seconds ?? 0;
  const estBytes = clip ? Math.round((clip.sizeBytes * length) / Math.max(1, total)) : 0;
  note.textContent = `${t("ss.clipTrimLength", { time: clipLength(Math.round(length)) })} • ${fmtBytes(estBytes)} / ${t("ss.clipTrimTotal", { time: clipLength(total) })}`;
}

async function clipStripHtml(path: string, seconds: number): Promise<string> {
  const count = 8;
  const cells: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = seconds > 0 ? (seconds * (i + 0.5)) / count : 0;
    let src: string | null = null;
    try {
      src = await clipFrame(path, at);
    } catch {
      src = null;
    }
    cells.push(src ? `<img src="${src}" alt="" />` : `<span></span>`);
  }
  return cells.join("");
}

export async function openClipStudio(path: string): Promise<void> {
  const clip = clips.find((entry) => entry.path === path);
  if (!clip) return;
  studioClipPath = path;
  const total = Math.max(1, clip.seconds);
  const videoSrc = convertFileSrc(path);

  clipDialogRoot().innerHTML = `
    <div class="modal-backdrop ss-clip-backdrop" data-act="clip-dialog-backdrop">
      <div class="modal-box ss-clip-studio-modal" role="dialog" aria-modal="true">
        <div class="ss-clip-studio-head">
          <div class="ss-studio-head-title">
            ${icon("clapperboard", 16)}
            <span>${t("ss.clipStudioTitle")}</span>
          </div>
          <div class="ss-clip-studio-name" title="${esc(clip.name)}">${esc(clip.name)} • ${fmtBytes(clip.sizeBytes)}</div>
          <button type="button" class="btn ghost small" data-act="clip-dialog-close" title="${t("common.close")} (ESC)">${icon("x", 14)}</button>
        </div>

        <div class="ss-clip-stage">
          <video id="ss-studio-video" class="ss-studio-video" src="${esc(videoSrc)}" playsinline preload="auto"></video>
          <div class="ss-video-play-overlay" data-act="clip-toggle-play">${icon("play", 36)}</div>
        </div>

        <div class="ss-clip-controls-bar">
          <button type="button" class="btn ghost small ss-play-btn" data-act="clip-toggle-play">${icon("play", 14)}</button>
          <span class="ss-timecode" id="ss-clip-timecode">0:00 / ${clipLength(clip.seconds)}</span>
          <input type="range" id="ss-clip-scrubber" class="ss-clip-scrubber" min="0" max="${total}" step="0.05" value="0" />
          <button type="button" class="btn ghost small ss-frame-grab-btn" data-act="clip-frame-grab" title="${esc(t("ss.clipCaptureFrame"))}">
            ${icon("camera", 13)} ${t("ss.clipCaptureFrame")}
          </button>
          <select id="ss-clip-speed" class="ss-clip-speed-select" data-act="clip-speed-change">
            <option value="0.5">0.5x</option>
            <option value="1" selected>1.0x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2.0x</option>
          </select>
        </div>

        <div class="ss-clip-trim-box">
          <div class="ss-trim-strip-label">
            <span>${icon("sliders", 12)} ${t("ss.clipTrimTitle")}</span>
            <div class="ss-trim-quick-btns">
              <button type="button" class="btn ghost small" data-act="clip-set-in">${icon("arrow-right", 11)} ${t("ss.clipSetIn")}</button>
              <button type="button" class="btn ghost small" data-act="clip-set-out">${t("ss.clipSetOut")} ${icon("arrow-left", 11)}</button>
            </div>
          </div>
          <div class="ss-clip-strip" id="ss-clip-strip">
            <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
          </div>
          <div class="ss-clip-range">
            <label>${t("ss.clipTrimStart")}
              <input type="number" id="ss-clip-start" class="input" min="0" max="${total}" step="0.5" value="0" />
            </label>
            <label>${t("ss.clipTrimEnd")}
              <input type="number" id="ss-clip-end" class="input" min="0" max="${total}" step="0.5" value="${total}" />
            </label>
          </div>
          <div class="ss-clip-range-note" id="ss-clip-range-note"></div>
        </div>

        <div class="playtime-footer ss-clip-footer">
          <button type="button" class="btn ghost small" data-act="clip-open-external" data-path="${esc(clip.path)}">
            ${icon("external", 12)} ${t("ss.clipOpenExternal")}
          </button>
          <button type="button" class="btn ghost small" data-act="clip-share" data-path="${esc(clip.path)}">
            ${icon("discord", 12)} ${t("ss.clipShareTitle")}
          </button>
          <span style="flex:1"></span>
          <button class="btn ghost" data-act="clip-dialog-close">${t("common.cancel")}</button>
          <button class="btn primary" data-act="clip-trim-save">${icon("check", 13)} ${t("ss.clipTrimSave")}</button>
        </div>
      </div>
    </div>`;

  studioVideoEl = document.getElementById("ss-studio-video") as HTMLVideoElement | null;
  if (studioVideoEl) {
    const v = studioVideoEl;
    const playBtn = document.querySelector<HTMLElement>(".ss-play-btn");
    const playOverlay = document.querySelector<HTMLElement>(".ss-video-play-overlay");
    const timecode = document.getElementById("ss-clip-timecode");
    const scrubber = document.getElementById("ss-clip-scrubber") as HTMLInputElement | null;

    v.addEventListener("timeupdate", () => {
      if (timecode) timecode.textContent = `${clipLength(v.currentTime)} / ${clipLength(clip.seconds)}`;
      if (scrubber && !scrubber.matches(":active")) scrubber.value = String(v.currentTime);
    });

    v.addEventListener("play", () => {
      if (playBtn) playBtn.innerHTML = `${icon("pause", 14)}`;
      if (playOverlay) playOverlay.classList.add("hidden");
    });

    v.addEventListener("pause", () => {
      if (playBtn) playBtn.innerHTML = `${icon("play", 14)}`;
      if (playOverlay) playOverlay.classList.remove("hidden");
    });

    v.addEventListener("ended", () => {
      if (playBtn) playBtn.innerHTML = `${icon("play", 14)}`;
      if (playOverlay) playOverlay.classList.remove("hidden");
    });

    if (scrubber) {
      scrubber.addEventListener("input", () => {
        v.currentTime = Number(scrubber.value);
      });
    }

    v.addEventListener("error", () => {
      // Fallback: extract frame and display poster
      void clipFrame(path, 0.5).then((frame) => {
        if (frame && v.parentElement) {
          const img = document.createElement("img");
          img.src = frame;
          img.className = "ss-studio-video-fallback";
          v.replaceWith(img);
        }
      });
    });
  }

  updateClipRangeNote();
  const startInput = document.getElementById("ss-clip-start");
  const endInput = document.getElementById("ss-clip-end");
  startInput?.addEventListener("input", updateClipRangeNote);
  endInput?.addEventListener("input", updateClipRangeNote);

  const strip = document.getElementById("ss-clip-strip");
  if (strip) strip.innerHTML = await clipStripHtml(path, clip.seconds);
}

export async function openClipTrim(path: string): Promise<void> {
  return openClipStudio(path);
}

export function toggleClipPlayback(): void {
  if (!studioVideoEl) return;
  if (studioVideoEl.paused) void studioVideoEl.play();
  else studioVideoEl.pause();
}

export function setClipTrimIn(): void {
  const current = studioVideoEl ? Math.floor(studioVideoEl.currentTime * 10) / 10 : 0;
  const input = document.getElementById("ss-clip-start") as HTMLInputElement | null;
  if (input) {
    input.value = String(current);
    updateClipRangeNote();
  }
}

export function setClipTrimOut(): void {
  const current = studioVideoEl ? Math.ceil(studioVideoEl.currentTime * 10) / 10 : 0;
  const input = document.getElementById("ss-clip-end") as HTMLInputElement | null;
  if (input) {
    input.value = String(current);
    updateClipRangeNote();
  }
}

export async function grabClipFrame(): Promise<void> {
  if (!studioClipPath) return;
  try {
    let dataUrl: string | null = null;
    if (studioVideoEl && studioVideoEl.videoWidth > 0) {
      const c = document.createElement("canvas");
      c.width = studioVideoEl.videoWidth;
      c.height = studioVideoEl.videoHeight;
      const context = c.getContext("2d");
      if (context) {
        context.drawImage(studioVideoEl, 0, 0, c.width, c.height);
        dataUrl = c.toDataURL("image/png");
      }
    }
    if (!dataUrl) {
      const at = studioVideoEl ? studioVideoEl.currentTime : 0.5;
      dataUrl = await clipFrame(studioClipPath, at);
    }
    if (dataUrl) {
      const destName = studioClipPath.replace(/\.[^.]+$/, `_snap_${Date.now()}.png`);
      await epicSaveEditedScreenshot(destName, dataUrl, false);
      toast(t("ss.clipFrameSaved"), "ok");
      window.dispatchEvent(new CustomEvent("screenshots-changed"));
    }
  } catch (e) {
    toast(String(e), "err");
  }
}

export function openClipJoin(): void {
  if (clips.length < 2) {
    toast(t("ss.joinNeedsTwo"), "err");
    return;
  }
  clipDialogRoot().innerHTML = `
    <div class="modal-backdrop" data-act="clip-dialog-backdrop">
      <div class="modal-box ss-clip-card" role="dialog" aria-modal="true">
        <div class="selective-header"><h2>${t("ss.clipJoinTitle")}</h2></div>
        <div class="ss-clip-join-list">
          ${clips
            .map(
              (clip) => `
            <label class="ss-clip-join-row">
              <input type="checkbox" data-act="clip-join-pick" data-path="${esc(clip.path)}" />
              <span class="ss-clip-join-name" title="${esc(clip.name)}">${esc(clip.name)}</span>
              <span class="ss-clip-join-meta">${esc(clip.dateStr)} • ${esc(clipLength(clip.seconds))}</span>
            </label>`,
            )
            .join("")}
        </div>
        <div class="ss-clip-range-note">${t("ss.clipJoinHint")}</div>
        <div class="playtime-footer">
          <button class="btn ghost" data-act="clip-dialog-close">${t("common.cancel")}</button>
          <button class="btn" data-act="clip-join-save">${t("ss.clipJoinTitle")}</button>
        </div>
      </div>
    </div>`;
}

export async function saveClipTrim(): Promise<void> {
  if (!studioClipPath) return;
  const start = Number((document.getElementById("ss-clip-start") as HTMLInputElement | null)?.value ?? "0");
  const end = Number((document.getElementById("ss-clip-end") as HTMLInputElement | null)?.value ?? "0");
  try {
    const made = await clipTrim(studioClipPath, start, end);
    closeClipDialog();
    toast(t("ss.clipSavedAs", { name: made.name }), "ok");
    reloadClips();
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
}

export async function saveClipJoin(): Promise<void> {
  const picked = [...document.querySelectorAll<HTMLInputElement>("[data-act='clip-join-pick']")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.path ?? "")
    .filter(Boolean);
  if (picked.length < 2) {
    toast(t("ss.joinNeedsTwo"), "err");
    return;
  }
  try {
    const made = await clipJoin(picked);
    closeClipDialog();
    toast(t("ss.clipSavedAs", { name: made.name }), "ok");
    reloadClips();
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
}

/* ---------- Discord Clip Share ---------- */

const DISCORD_CLIP_LIMIT = 8 * 1024 * 1024;
let clipSharePath: string | null = null;

function clipRangeBytes(clip: ClipItem, start: number, end: number): number {
  const total = Math.max(1, clip.seconds);
  return Math.round((clip.sizeBytes * Math.max(0, end - start)) / total);
}

function clipFitEnd(clip: ClipItem, start: number): number {
  const perSecond = Math.max(1, clip.sizeBytes) / Math.max(1, clip.seconds);
  const fits = (DISCORD_CLIP_LIMIT * 0.95) / perSecond;
  return Math.max(start + 1, Math.min(clip.seconds, start + fits));
}

function clipShareRange(clip: ClipItem): { start: number; end: number } {
  const start = Number((document.getElementById("ss-clip-share-start") as HTMLInputElement | null)?.value ?? "0");
  const end = Number((document.getElementById("ss-clip-share-end") as HTMLInputElement | null)?.value ?? "0");
  return { start: Math.max(0, start), end: Math.min(Math.max(1, clip.seconds), end) };
}

export function updateClipShareNote(): void {
  const note = document.getElementById("ss-clip-share-note");
  if (!note || !clipSharePath) return;
  const clip = clips.find((entry) => entry.path === clipSharePath);
  if (!clip) return;
  const { start, end } = clipShareRange(clip);
  const bytes = clipRangeBytes(clip, start, end);
  const size = fmtBytes(bytes);
  note.textContent =
    bytes > DISCORD_CLIP_LIMIT
      ? t("ss.clipShareTooLarge", { size })
      : t("ss.clipShareWillSend", { time: clipLength(Math.round(end - start)), size });
  note.classList.toggle("is-over", bytes > DISCORD_CLIP_LIMIT);
}

export async function openClipShare(path: string): Promise<void> {
  const clip = clips.find((entry) => entry.path === path);
  if (!clip) return;
  clipSharePath = path;
  const total = Math.max(1, clip.seconds);
  const webhooks = ssWebhooks();
  const buttons = webhooks.length
    ? webhooks
        .map(
          (hook) => `
        <button class="ss-share-btn" data-act="clip-share-send" data-webhook-id="${esc(hook.id)}">
          <div class="ss-share-btn-icon">${icon("discord", 18)}</div>
          <div class="ss-share-btn-text">
            <span class="ss-btn-main">${esc(hook.name)}</span>
            <span class="ss-btn-hint">${t("ss.shareDiscordHint")}</span>
          </div>
        </button>`,
        )
        .join("")
    : `
      <button class="ss-share-btn" data-act="clip-share-send">
        <div class="ss-share-btn-icon">${icon("discord", 18)}</div>
        <div class="ss-share-btn-text">
          <span class="ss-btn-main">${t("ss.shareDiscord")}</span>
          <span class="ss-btn-hint">${t("ss.shareDiscordSetup")}</span>
        </div>
      </button>`;

  clipDialogRoot().innerHTML = `
    <div class="modal-backdrop" data-act="clip-dialog-backdrop">
      <div class="modal-box ss-clip-card" role="dialog" aria-modal="true">
        <div class="selective-header"><h2>${t("ss.clipShareTitle")}</h2></div>
        <div class="ss-clip-dialog-name" title="${esc(clip.name)}">${esc(clip.name)} • ${esc(fmtBytes(clip.sizeBytes))} • ${esc(clipLength(clip.seconds))}</div>
        <div class="ss-clip-strip" id="ss-clip-share-strip"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        <div class="ss-clip-range">
          <label>${t("ss.clipTrimStart")}
            <input type="number" id="ss-clip-share-start" class="input" min="0" max="${total}" step="1" value="0" />
          </label>
          <label>${t("ss.clipTrimEnd")}
            <input type="number" id="ss-clip-share-end" class="input" min="0" max="${total}" step="1" value="${total}" />
          </label>
        </div>
        <div class="ss-clip-range-note" id="ss-clip-share-note"></div>
        <div class="ss-clip-share-list">${buttons}</div>
        <div class="playtime-footer">
          <button class="btn ghost" data-act="clip-dialog-close">${t("common.cancel")}</button>
          <button class="btn ghost" data-act="clip-share-fit">${t("ss.clipShareFit")}</button>
        </div>
      </div>
    </div>`;
  updateClipShareNote();
  const strip = document.getElementById("ss-clip-share-strip");
  if (strip) strip.innerHTML = await clipStripHtml(path, clip.seconds);
}

export function fitClipShareRange(): void {
  const clip = clips.find((entry) => entry.path === clipSharePath);
  if (!clip) return;
  const { start } = clipShareRange(clip);
  const end = document.getElementById("ss-clip-share-end") as HTMLInputElement | null;
  if (end) end.value = String(Math.floor(clipFitEnd(clip, start)));
  updateClipShareNote();
}

export async function sendClipShare(webhookId: string): Promise<void> {
  const clip = clips.find((entry) => entry.path === clipSharePath);
  if (!clip) return;
  const webhook = ssWebhooks().find((hook) => hook.id === webhookId) ?? ssWebhooks()[0];
  if (!webhook) {
    toast(t("ss.shareDiscordSetup"), "err");
    return;
  }
  const { start, end } = clipShareRange(clip);
  const whole = start <= 0 && end >= clip.seconds;
  try {
    const sent = await clipShareDiscord(webhook.url, clip.path, whole ? 0 : start, whole ? 0 : end, "");
    closeClipDialog();
    toast(t("ss.clipShareSent", { size: fmtBytes(sent) }), "ok");
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
}

function clipLength(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}s`;
}

const clipThumbCache = new Map<string, string>();

function hydrateClipThumbs(): void {
  queueMicrotask(() => {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-clip-thumb]")];
    if (slots.length === 0) return;
    void (async () => {
      for (const slot of slots) {
        const path = slot.dataset.clipThumb;
        if (!path || slot.classList.contains("has-frame")) continue;
        let src = clipThumbCache.get(path);
        if (src === undefined) {
          try {
            src = (await clipThumbnail(path)) ?? "";
          } catch {
            src = "";
          }
          clipThumbCache.set(path, src);
        }
        if (src) {
          slot.innerHTML = `<img src="${src}" alt="" />`;
          slot.classList.add("has-frame");
        }
      }
    })();
  });
}

export function dropClip(path: string): void {
  clips = clips.filter((clip) => clip.path !== path);
  repaintScreenshotsPage();
}

export function openClipFolder(path: string): void {
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  void epicOpenFolderPath(dir).catch(() => undefined);
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
            <button class="btn ghost small" data-act="ssp-lightbox-edit" title="${t("ss.editTip")}">${icon("camera", 13)} ${t("ss.edit")}</button>
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

export function pageLightboxShot(): GameScreenshotItem | null {
  return currentLightboxShot();
}

/* ---------- Actions used by the handlers ---------- */

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

export function togglePageFavorite(filePath: string): boolean {
  const favorite = ssToggleFavorite(filePath);
  if (pageLightboxOpen()) {
    const shot = currentLightboxShot();
    if (shot) openPageLightbox(visiblePageShots().indexOf(shot));
  }
  repaintScreenshotsPage();
  return favorite;
}

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

export { openShareModal, compressScreenshotItem, openScreenshotEditor };
