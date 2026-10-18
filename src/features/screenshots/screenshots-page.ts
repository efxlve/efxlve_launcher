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
import { t, localizeMessage } from "../../i18n";
import {
  clipFrame,
  clipJoin,
  clipList,
  clipShareDiscord,
  clipThumbnail,
  clipTrim,
  epicDeleteGameScreenshot,
  epicGetAllScreenshots,
  epicOpenFolderPath,
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
import { ssDensity, ssFavorites, ssSort, ssSortItems, ssToggleFavorite, ssWebhooks } from "./ss-settings";

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

/** The editor announces a save; the page reloads so the new file shows up. */
window.addEventListener("screenshots-changed", () => {
  if (S.view !== "screenshots") return;
  loadScreenshotsPage(true);
  // A new clip is a new row in the same page, so the same signal reloads it.
  reloadClips();
});

/** Repaints the page in place after a toolbar or lightbox action. */
export function repaintScreenshotsPage(): void {
  if (S.view !== "screenshots") return;
  const host = document.getElementById("view");
  if (host) host.innerHTML = renderScreenshotsPage();
  hydrateClipThumbs();
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
        ${clipsSectionHtml()}
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
      ${clipsSectionHtml()}
    </div>`;
}

/* ---------- Game clips ---------- */

let clips: ClipItem[] = [];
let clipsLoaded = false;

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

export function pageClips(): ClipItem[] {
  return clips;
}

function clipsSectionHtml(): string {
  if (!clipsLoaded) loadClips();
  const rows = clips.length
    ? clips
        .map(
          (clip) => `
      <div class="ss-clip" data-path="${esc(clip.path)}">
        <span class="ss-clip-thumb" data-clip-thumb="${esc(clip.path)}">${icon("play", 14)}</span>
        <div class="ss-clip-main">
          <div class="ss-clip-name" title="${esc(clip.name)}">${esc(clip.name)}</div>
          <div class="ss-clip-meta">${esc(clip.dateStr)} · ${fmtBytes(clip.sizeBytes)} · ${esc(clipLength(clip.seconds))}</div>
        </div>
        <div class="ss-clip-actions">
          <button type="button" class="btn ghost small" data-act="ssp-clip-play" data-path="${esc(clip.path)}">${icon("play", 12)} ${t("ss.clipPlay")}</button>
          <button type="button" class="btn ghost small" data-act="clip-trim" data-path="${esc(clip.path)}">${icon("sliders", 12)} ${t("ss.clipTrim")}</button>
          <button type="button" class="btn ghost small" data-act="clip-share" data-path="${esc(clip.path)}" title="${esc(t("ss.clipShareTitle"))}">${icon("discord", 12)}</button>
          <button type="button" class="btn ghost small" data-act="ssp-clip-folder" data-path="${esc(clip.path)}">${icon("folder", 12)}</button>
          <button type="button" class="btn ghost danger small" data-act="ssp-clip-delete" data-path="${esc(clip.path)}">${icon("trash", 12)}</button>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="settings-row-desc">${t("ss.clipEmpty")}</div>`;
  return `
    <div class="ss-clips-head">
      <h3 class="section-title">${t("ss.clipSection")}</h3>
      ${clips.length > 1 ? `<button type="button" class="btn ghost small" data-act="clip-join">${icon("layers", 13)} ${t("ss.clipJoinTitle")}</button>` : ""}
    </div>
    <div class="list settings-group ss-clips">${rows}</div>`;
}

/* ---------- Cutting and joining clips ---------- */

/** The clip the trim dialog works on. */
let clipTrimPath: string | null = null;

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
  clipTrimPath = null;
  clipSharePath = null;
  const root = document.getElementById("ss-clip-root");
  if (root) root.innerHTML = "";
}

/** The length the two inputs currently describe, as the dialog shows it. */
export function updateClipRangeNote(): void {
  const note = document.getElementById("ss-clip-range-note");
  if (!note || !clipTrimPath) return;
  const clip = clips.find((entry) => entry.path === clipTrimPath);
  const start = Number((document.getElementById("ss-clip-start") as HTMLInputElement | null)?.value ?? "0");
  const end = Number((document.getElementById("ss-clip-end") as HTMLInputElement | null)?.value ?? "0");
  const length = Math.max(0, end - start);
  note.textContent = `${t("ss.clipTrimLength", { time: clipLength(Math.round(length)) })} · ${t("ss.clipTrimTotal", { time: clipLength(clip?.seconds ?? 0) })}`;
}

/** A row of frames across the clip, so the cut can be aimed at something. */
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

/** Opens the cut dialog: a strip, two times, and a button that copies the range
 *  into a new clip. The original is never touched. */
export async function openClipTrim(path: string): Promise<void> {
  const clip = clips.find((entry) => entry.path === path);
  if (!clip) return;
  clipTrimPath = path;
  const total = Math.max(1, clip.seconds);
  clipDialogRoot().innerHTML = `
    <div class="modal-backdrop" data-act="clip-dialog-backdrop">
      <div class="modal-box ss-clip-card" role="dialog" aria-modal="true">
        <div class="selective-header"><h2>${t("ss.clipTrimTitle")}</h2></div>
        <div class="ss-clip-dialog-name" title="${esc(clip.name)}">${esc(clip.name)}</div>
        <div class="ss-clip-strip" id="ss-clip-strip"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        <div class="ss-clip-range">
          <label>${t("ss.clipTrimStart")}
            <input type="number" id="ss-clip-start" class="input" min="0" max="${total}" step="1" value="0" />
          </label>
          <label>${t("ss.clipTrimEnd")}
            <input type="number" id="ss-clip-end" class="input" min="0" max="${total}" step="1" value="${total}" />
          </label>
        </div>
        <div class="ss-clip-range-note" id="ss-clip-range-note"></div>
        <div class="playtime-footer">
          <button class="btn ghost" data-act="clip-dialog-close">${t("common.cancel")}</button>
          <button class="btn" data-act="clip-trim-save">${t("ss.clipTrimSave")}</button>
        </div>
      </div>
    </div>`;
  updateClipRangeNote();
  const strip = document.getElementById("ss-clip-strip");
  if (strip) strip.innerHTML = await clipStripHtml(path, clip.seconds);
}

/** Opens the join dialog: pick two or more clips, they are added in this order. */
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
              <span class="ss-clip-join-meta">${esc(clip.dateStr)} · ${esc(clipLength(clip.seconds))}</span>
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

/** Runs the cut the dialog describes and adds the new clip to the list. */
export async function saveClipTrim(): Promise<void> {
  if (!clipTrimPath) return;
  const start = Number((document.getElementById("ss-clip-start") as HTMLInputElement | null)?.value ?? "0");
  const end = Number((document.getElementById("ss-clip-end") as HTMLInputElement | null)?.value ?? "0");
  try {
    const made = await clipTrim(clipTrimPath, start, end);
    closeClipDialog();
    toast(t("ss.clipSavedAs", { name: made.name }), "ok");
    reloadClips();
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
}

/** Joins the checked clips, in the order they are listed. */
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

/* ---------- Sending a clip to Discord ---------- */

/** Discord refuses a webhook upload over 8 MB. Kept in step with
 *  `DISCORD_WEBHOOK_LIMIT` on the Rust side, which is the real gate. */
const DISCORD_CLIP_LIMIT = 8 * 1024 * 1024;

/** The clip the share dialog works on. */
let clipSharePath: string | null = null;

/** What a range of a clip is worth, at the clip's own bitrate. */
function clipRangeBytes(clip: ClipItem, start: number, end: number): number {
  const total = Math.max(1, clip.seconds);
  return Math.round((clip.sizeBytes * Math.max(0, end - start)) / total);
}

/** The end time that brings a range under the webhook limit, with a margin. */
function clipFitEnd(clip: ClipItem, start: number): number {
  const perSecond = Math.max(1, clip.sizeBytes) / Math.max(1, clip.seconds);
  const fits = (DISCORD_CLIP_LIMIT * 0.95) / perSecond;
  return Math.max(start + 1, Math.min(clip.seconds, start + fits));
}

function clipShareRange(clip: ClipItem): { start: number; end: number } {
  const start = Number(
    (document.getElementById("ss-clip-share-start") as HTMLInputElement | null)?.value ?? "0",
  );
  const end = Number(
    (document.getElementById("ss-clip-share-end") as HTMLInputElement | null)?.value ?? "0",
  );
  return { start: Math.max(0, start), end: Math.min(Math.max(1, clip.seconds), end) };
}

/** The line under the range: what goes out, and whether it fits. */
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

/** Opens the send dialog: a range, what it weighs, and one button per webhook. */
export async function openClipShare(path: string): Promise<void> {
  const clip = clips.find((entry) => entry.path === path);
  if (!clip) return;
  clipSharePath = path;
  clipTrimPath = null;
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
        <div class="ss-clip-dialog-name" title="${esc(clip.name)}">${esc(clip.name)} · ${esc(fmtBytes(clip.sizeBytes))} · ${esc(clipLength(clip.seconds))}</div>
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

/** Shrinks the range so it fits the webhook limit. */
export function fitClipShareRange(): void {
  const clip = clips.find((entry) => entry.path === clipSharePath);
  if (!clip) return;
  const { start } = clipShareRange(clip);
  const end = document.getElementById("ss-clip-share-end") as HTMLInputElement | null;
  if (end) end.value = String(Math.floor(clipFitEnd(clip, start)));
  updateClipShareNote();
}

/** Sends the chosen range. The range is cut on the way out, not re-encoded. */
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
    const sent = await clipShareDiscord(
      webhook.url,
      clip.path,
      whole ? 0 : start,
      whole ? 0 : end,
      "",
    );
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

/** First frames already fetched, so a repaint does not ask again. */
const clipThumbCache = new Map<string, string>();

/** Fills the clips list with a frame of each clip, one at a time: reading a
 *  frame costs a file read, and the list is usually short. */
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
            <button class="btn ghost small" data-act="ssp-lightbox-edit" title="${t("ss.editTip")}">${icon("edit", 13)} ${t("ss.edit")}</button>
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
