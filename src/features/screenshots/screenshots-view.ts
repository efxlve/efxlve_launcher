import { summaryOf } from "../../core/selectors";
/**
 * In-game screenshot gallery, lightbox, sharing and compression.
 *
 * Loads screenshots for a game, renders the drawer gallery, opens the
 * full-screen lightbox and the share sheet, and converts PNG captures to
 * AVIF/WebP/JPEG. State lives in S; DOM targets are queried per call.
 */

import { modalRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, formatScreenshotDate } from "../../core/utils";
import { t } from "../../i18n";

import {
  epicGetGameScreenshots,
  epicGetScreenshotFullData,
  epicReplaceScreenshotWithCompressed,
  epicSaveScreenshotPreview,
  type EpicSummary,
  type GameScreenshotItem,
} from "../../epic";
import { steamGetGameScreenshots, steamGetScreenshotFullData } from "../../steam";
import { sideCard } from "../drawer/side-widgets";
import { ssDensity, ssFavorites, ssSort, ssSortItems, ssWebhooks } from "./ss-settings";

/* --- Game page gallery: the toolbar's own view state ---------------------- */
type GalleryFilter = "all" | "raw" | "compressed" | "favorites";
let galleryFilter: GalleryFilter = "all";
let gallerySelectMode = false;
let galleryBatchDeleteArmed = false;
const gallerySelection = new Set<string>();

export function setGalleryFilter(filter: GalleryFilter): void {
  galleryFilter = filter;
}

export function setGallerySelectMode(on: boolean): void {
  gallerySelectMode = on;
  if (!on) gallerySelection.clear();
}

export function toggleGallerySelection(filePath: string): void {
  if (gallerySelection.has(filePath)) gallerySelection.delete(filePath);
  else gallerySelection.add(filePath);
  galleryBatchDeleteArmed = false;
}

export function clearGallerySelection(): void {
  gallerySelection.clear();
  galleryBatchDeleteArmed = false;
}

/** Batch delete asks once: the button's first click arms it. */
export function isBatchDeleteArmed(): boolean {
  return galleryBatchDeleteArmed;
}

export function setBatchDeleteArmed(on: boolean): void {
  galleryBatchDeleteArmed = on;
}

/** The selected rows, newest first, ready for a batch action. */
export function gallerySelectedItems(): { appName: string; item: GameScreenshotItem }[] {
  const appName = S.currentModalAppName ?? "";
  const list = S.loadedScreenshots.get(appName) || [];
  return list.filter((item) => gallerySelection.has(item.file_path)).map((item) => ({ appName, item }));
}

/** Repaints the game page's Screenshots tab in place after a toolbar action. */
export function repaintDrawerShots(): void {
  const appName = S.currentModalAppName;
  if (!appName || S.activeDrawerTab !== "screenshots") return;
  const contentEl = document.getElementById("drawer-tab-content");
  const summary = summaryOf(appName);
  if (contentEl && summary) contentEl.innerHTML = renderDrawerScreenshots(summary);
}

/** Steam keeps its screenshots in the client's own folder: gallery is read-only. */
function isSteamApp(appName: string): boolean {
  return appName.startsWith("steam::");
}

/** Gallery owner whose client keeps the files (read-only in this launcher). */
type GalleryOwner = "steam" | "ubisoft";

function galleryOwner(appName: string): GalleryOwner | null {
  if (isSteamApp(appName)) return "steam";
  if (appName.startsWith("ubisoft::")) return "ubisoft";
  return null;
}

function ownerBadge(owner: GalleryOwner): string {
  return owner === "steam" ? "STEAM" : "UBISOFT";
}

function ownerReadOnlyTip(owner: GalleryOwner): string {
  return t(owner === "steam" ? "ss.steamReadOnly" : "ss.ubiReadOnly");
}

/**
 * Full-resolution data URLs are only meaningful while a viewer asks for them:
 * one original is already megabytes. The listing ships small previews; the
 * lightbox, share sheet and compressor pull the original on demand and the
 * cache is freed with the gallery.
 */
export function fullShotSrc(item: GameScreenshotItem): string {
  return S.screenshotFullSrc.get(item.file_path) || item.full_data_url || shotPreviewSrc(item);
}

/** Grid thumbnail: the listing's preview, or one the WebView generated. */
export function shotPreviewSrc(item: GameScreenshotItem): string {
  return item.data_url || S.screenshotPreviewSrc.get(item.file_path) || "";
}

/**
 * Grid/strap thumbnail markup. An empty preview means the backend could not
 * read the format (GDI+ has no AVIF/WebP decoder); the placeholder carries the
 * path so `hydrateShotPreviews` can build one from the original.
 */
export function shotThumbHtml(item: GameScreenshotItem): string {
  const src = shotPreviewSrc(item);
  if (src) return `<img src="${src}" alt="${esc(item.file_name)}" loading="lazy" />`;
  return `<div class="shot-thumb-pending" data-shot-preview="${esc(item.file_path)}">${icon("image", 18)}</div>`;
}

const fullShotRequests = new Map<string, Promise<string | null>>();

/** Fetches one original, sharing the in-flight request between consumers. */
function requestFullShotData(appName: string, item: GameScreenshotItem): Promise<string | null> {
  const inFlight = fullShotRequests.get(item.file_path);
  if (inFlight) return inFlight;

  const request = (isSteamApp(appName)
    ? steamGetScreenshotFullData(appName.slice(7), item.file_path)
    : epicGetScreenshotFullData(item.file_path)
  )
    .then((data) => data || null)
    .catch(() => null)
    .finally(() => fullShotRequests.delete(item.file_path));

  fullShotRequests.set(item.file_path, request);
  return request;
}

/** Loads one original and caches it while its gallery stays open. */
export function ensureFullShot(appName: string, item: GameScreenshotItem): Promise<string | null> {
  const cached = S.screenshotFullSrc.get(item.file_path);
  if (cached) return Promise.resolve(cached);
  return requestFullShotData(appName, item).then((data) => {
    if (!data) return null;
    // The gallery may have closed while the original was loading; caching then
    // would leave the file in memory with nothing showing it.
    if (S.loadedScreenshots.has(appName)) S.screenshotFullSrc.set(item.file_path, data);
    return data;
  });
}

/** Drops one file's original after it is deleted or rewritten by compression. */
export function forgetFullShot(filePath: string): void {
  S.screenshotFullSrc.delete(filePath);
}

/** Frees a game's gallery and its originals with the consumer that showed it. */
export function forgetGameScreenshots(appName: string): void {
  for (const item of S.loadedScreenshots.get(appName) || []) {
    S.screenshotFullSrc.delete(item.file_path);
    S.screenshotPreviewSrc.delete(item.file_path);
  }
  S.loadedScreenshots.delete(appName);
}

const shotPreviewJobs = new Map<string, Promise<void>>();

/** Finds the loaded item behind a placeholder's path. */
function findShotByPath(filePath: string): { appName: string; item: GameScreenshotItem } | null {
  for (const [appName, items] of S.loadedScreenshots) {
    const item = items.find((x) => x.file_path === filePath);
    if (item) return { appName, item };
  }
  return null;
}

/**
 * Builds a grid preview inside the WebView for files the backend cannot read
 * (GDI+ has no AVIF/WebP decoder) and asks the backend to cache it, so the next
 * listing serves it like any other thumbnail. Jobs run one at a time: each
 * holds a full-size original only while it is scaled down.
 */
function generateShotPreview(appName: string, item: GameScreenshotItem): Promise<void> {
  const existing = shotPreviewJobs.get(item.file_path);
  if (existing) return existing;

  const job = (async () => {
    try {
      const full = await requestFullShotData(appName, item);
      if (!full) return;
      const img = new Image();
      img.src = full;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Image could not be decoded"));
      });

      const width = img.naturalWidth || img.width || 480;
      const height = img.naturalHeight || img.height || 270;
      const scale = Math.min(1, 480 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      if (!dataUrl.startsWith("data:image/jpeg")) return;
      S.screenshotPreviewSrc.set(item.file_path, dataUrl);
      patchShotPreviewDom(item.file_path, dataUrl);
      void epicSaveScreenshotPreview(item.file_path, dataUrl).catch(() => {});
    } catch {
      // The placeholder stays; the lightbox still opens the original.
    } finally {
      shotPreviewJobs.delete(item.file_path);
    }
  })();

  shotPreviewJobs.set(item.file_path, job);
  return job;
}

function patchShotPreviewDom(filePath: string, dataUrl: string): void {
  const selector = `[data-shot-preview="${CSS.escape(filePath)}"]`;
  document.querySelectorAll<HTMLElement>(selector).forEach((host) => {
    host.outerHTML = `<img src="${dataUrl}" alt="" loading="lazy" />`;
  });
}

/**
 * Fills in the previews of every placeholder on screen, one at a time. Called
 * after a render; the microtask waits for the markup to reach the document.
 */
export function hydrateShotPreviews(): void {
  queueMicrotask(() => {
    const hosts = [...document.querySelectorAll<HTMLElement>("[data-shot-preview]")];
    if (hosts.length === 0) return;
    void (async () => {
      for (const host of hosts) {
        const filePath = host.dataset.shotPreview;
        if (!filePath || S.screenshotPreviewSrc.has(filePath)) continue;
        const found = findShotByPath(filePath);
        if (!found) continue;
        await generateShotPreview(found.appName, found.item);
      }
    })();
  });
}

/** Sidebar bento gallery of the player's own captures on the overview. Hidden when empty. */
export function renderMomentsStrip(appName: string): string {
  const items = S.loadedScreenshots.get(appName) || [];
  // Still on its way: hold the widget's place. It used to render an empty div, so
  // the blocks under it jumped down the moment the pictures arrived.
  if (items.length === 0 && S.loadingScreenshotsFor === appName) {
    const tiles = Array.from({ length: 4 }, () => `<div class="gp-moment is-pending"></div>`).join("");
    return sideCard(
      appName,
      "moments",
      t("drawer.moments"),
      "camera",
      `<div class="gp-moments-grid count-4">${tiles}</div>`,
      { idAttr: "gp-moments", extraClass: "gp-moments-card" },
    );
  }
  if (items.length === 0) return `<div id="gp-moments" class="gp-side-card gp-moments-card is-empty"></div>`;
  const shown = items.slice(0, 4);
  const extraCount = Math.max(0, items.length - shown.length);
  const thumbs = shown
    .map((item, idx) => {
      const moreOverlay =
        idx === shown.length - 1 && extraCount > 0
          ? `<span class="gp-moment-more num">+${extraCount}</span>`
          : "";
      return `
    <button type="button" class="gp-moment" data-act="open-screenshot-lightbox" data-id="${esc(appName)}" data-idx="${idx}" aria-label="${esc(item.file_name)}">
      ${shotThumbHtml(item)}
      ${moreOverlay}
    </button>`;
    })
    .join("");
  hydrateShotPreviews();
  const actionHtml = `<button type="button" class="gp-widget-action" data-act="drawer-tab" data-tab="screenshots" data-id="${esc(appName)}">${t("drawer.momentsAll")}</button>`;
  return sideCard(
    appName,
    "moments",
    t("drawer.moments"),
    "camera",
    `<div class="gp-moments-grid count-${shown.length}">${thumbs}</div>`,
    {
      idAttr: "gp-moments",
      extraClass: "gp-moments-card",
      metaHtml: `<span class="gp-widget-meta num">${items.length}</span>`,
      actionHtml,
    },
  );
}

export function fetchAndRenderScreenshots(appName: string, title: string, force = false): void {
  if (!force && S.loadedScreenshots.has(appName)) return;
  S.loadingScreenshotsFor = appName;
  const request = isSteamApp(appName)
    ? steamGetGameScreenshots(appName.slice(7))
    : epicGetGameScreenshots(appName, title);
  request
    .then((items) => {
      // A newer request for another game wins; a response landing after its
      // consumer closed is dropped instead of holding the gallery in memory.
      if (S.loadingScreenshotsFor !== appName) return;
      S.loadingScreenshotsFor = null;
      const consumerOpen = S.currentModalAppName === appName || S.tvDetailAppName === appName;
      if (!consumerOpen) return;
      S.loadedScreenshots.set(appName, items);
      if (S.currentModalAppName === appName) {
        const badgeEl = modalRoot.querySelector('.drawer-tab[data-tab="screenshots"] .drawer-tab-badge');
        const tabBtn = modalRoot.querySelector('.drawer-tab[data-tab="screenshots"]');
        if (items.length > 0) {
          if (badgeEl) {
            badgeEl.textContent = `(${items.length})`;
          } else if (tabBtn) {
            tabBtn.insertAdjacentHTML("beforeend", ` <span class="drawer-tab-badge">(${items.length})</span>`);
          }
        } else if (badgeEl) {
          badgeEl.remove();
        }

        if (S.activeDrawerTab === "screenshots") {
          const contentEl = document.getElementById("drawer-tab-content");
          if (contentEl) {
            const curSummary = summaryOf(appName);
            if (curSummary) contentEl.innerHTML = renderDrawerScreenshots(curSummary);
          }
        } else if (S.activeDrawerTab === "overview") {
          const moments = document.getElementById("gp-moments");
          if (moments) moments.outerHTML = renderMomentsStrip(appName);
        }
      }
    })
    .catch(() => {
      // Only the request that owns the marker clears it: a failure for another
      // game must not drop the response of the game still loading.
      if (S.loadingScreenshotsFor === appName) S.loadingScreenshotsFor = null;
    });
}

export function playScreenshotShutterSound(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // 1. Shutter click (mechanical shutter start).
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(900, now);
    osc1.frequency.exponentialRampToValueAtTime(100, now + 0.04);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.045);

    // 2. Shutter close (mechanical snap).
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(1500, now + 0.035);
    osc2.frequency.exponentialRampToValueAtTime(180, now + 0.08);
    gain2.gain.setValueAtTime(0.2, now + 0.035);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.035);
    osc2.stop(now + 0.085);
  } catch {
    // Audio blocked: fail silently.
  }
}

export async function copyScreenshotImageToClipboard(item: GameScreenshotItem, appName = ""): Promise<boolean> {
  try {
    // The clipboard wants the original, never the grid preview.
    const fullSrc =
      (appName ? await ensureFullShot(appName, item) : null) ||
      item.full_data_url ||
      item.data_url;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = fullSrc;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("Image could not be loaded"));
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("PNG blob could not be created");

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);

    toast(t("ss.copied"), "ok");
    return true;
  } catch (err) {
    console.warn("Image could not be copied:", err);
    try {
      await navigator.clipboard.writeText(item.file_path);
      toast(t("ss.pathCopied", { file: item.file_name }), "ok");
      return true;
    } catch {
      toast(t("ss.copyFailed"), "err");
      return false;
    }
  }
}

export async function compressImageToBlob(
  dataUrl: string,
  format: "avif" | "webp" | "jpg",
  quality: number = 0.85
): Promise<{ base64: string; ext: string; bytes: number }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = dataUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Image could not be loaded"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0);

  let mimeType = format === "avif" ? "image/avif" : format === "webp" ? "image/webp" : "image/jpeg";
  let targetExt = format === "jpg" ? "jpg" : format;
  if (format === "avif") {
    try {
      const test = canvas.toDataURL("image/avif");
      if (!test.startsWith("data:image/avif")) {
        mimeType = "image/webp";
        targetExt = "webp";
      }
    } catch {
      mimeType = "image/webp";
      targetExt = "webp";
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality);
  });

  if (!blob) throw new Error("Image compression failed");

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked so a multi-megabyte frame does not build one giant intermediate string.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);

  return { base64, ext: targetExt, bytes: blob.size };
}

let compressChain: Promise<void> = Promise.resolve();

export async function compressScreenshotItem(
  appName: string,
  item: GameScreenshotItem,
  format: "avif" | "webp" | "jpg" = S.screenshotCompressionFormat,
  quality: number = S.screenshotCompressionQuality,
  silent = false
): Promise<GameScreenshotItem | null> {
  const run = compressChain.then(() => compressScreenshotNow(appName, item, format, quality, silent));
  compressChain = run.then(() => undefined, () => undefined);
  return run;
}

async function compressScreenshotNow(
  appName: string,
  item: GameScreenshotItem,
  format: "avif" | "webp" | "jpg",
  quality: number,
  silent: boolean,
): Promise<GameScreenshotItem | null> {
  try {
    // Compress the original, never the grid preview: replacing the file with a
    // downscaled version would silently destroy it.
    const source = await ensureFullShot(appName, item);
    if (!source) throw new Error(t("ss.fileNotFound"));
    const { base64, ext, bytes } = await compressImageToBlob(source, format, quality);
    const updated = await epicReplaceScreenshotWithCompressed(item.file_path, base64, ext);
    // The file changed on disk: its cached original no longer matches.
    forgetFullShot(item.file_path);

    const list = S.loadedScreenshots.get(appName) || [];
    const idx = list.findIndex((x) => x.file_path === item.file_path || x.id === item.id);
    if (idx !== -1) {
      list[idx] = updated;
    } else {
      list.unshift(updated);
    }
    S.loadedScreenshots.set(appName, [...list]);

    if (S.activeLightboxScreenshot && S.activeLightboxScreenshot.appName === appName) {
      openScreenshotLightbox(appName, S.activeLightboxScreenshot.index);
    }

    if (S.currentModalAppName === appName && S.activeDrawerTab === "screenshots") {
      const contentEl = document.getElementById("drawer-tab-content");
      const curSummary = summaryOf(appName);
      if (contentEl && curSummary) {
        contentEl.innerHTML = renderDrawerScreenshots(curSummary);
      }
    }

    if (!silent) {
      const oldSize = item.size_str;
      const newSize = updated.size_str;
      const savedPercent = item.size_bytes > 0 ? Math.round((1 - bytes / item.size_bytes) * 100) : 0;
      toast(t("ss.compressedOne", { old: oldSize, new: newSize, pct: savedPercent > 0 ? savedPercent : 0 }), "ok");
    }
    return updated;
  } catch (err) {
    if (!silent) toast(t("ss.compressFailed", { msg: String(err) }), "err");
    return null;
  }
}

export function openShareModal(appName: string, item: GameScreenshotItem): void {
  S.activeShareScreenshot = { appName, item };
  // Warm the original: "copy image" hands the clipboard the full-size file.
  void ensureFullShot(appName, item);
  let shareRoot = document.getElementById("share-modal-root");
  if (!shareRoot) {
    shareRoot = document.createElement("div");
    shareRoot.id = "share-modal-root";
    document.body.appendChild(shareRoot);
  }
  const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
  const readOnly = galleryOwner(appName) !== null;
  // One button per saved webhook; with none, the button explains the setup.
  const webhooks = ssWebhooks();
  const discordButtons = webhooks.length
    ? webhooks
        .map(
          (hook) => `
          <button class="ss-share-btn" data-act="do-share-discord" data-webhook-id="${esc(hook.id)}">
            <div class="ss-share-btn-icon">${icon("discord", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${esc(hook.name)}</span>
              <span class="ss-btn-hint">${t("ss.shareDiscordHint")}</span>
            </div>
          </button>`,
        )
        .join("")
    : `
          <button class="ss-share-btn" data-act="do-share-discord">
            <div class="ss-share-btn-icon">${icon("discord", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.shareDiscord")}</span>
              <span class="ss-btn-hint">${t("ss.shareDiscordSetup")}</span>
            </div>
          </button>`;
  shareRoot.innerHTML = `
    <div class="ss-share-backdrop" data-act="close-share-modal">
      <div class="ss-share-card" role="dialog" aria-modal="true">
        <div class="ss-share-head">
          <div class="ss-share-preview-thumb">
            ${shotThumbHtml(item)}
          </div>
          <div class="ss-share-meta">
            <h3 class="ss-share-title">${t("ss.shareTitle")}</h3>
            <span class="ss-share-sub">${esc(item.file_name)}</span>
            <div class="ss-share-chips">
              <span class="ss-share-chip">${esc(item.size_str)}</span>
              <span class="ss-share-chip ${isAvifOrWebp ? "format" : ""}">${isAvifOrWebp ? t("ss.compressedChip") : t("ss.rawPng")}</span>
            </div>
          </div>
          <button class="ss-share-close" data-act="close-share-modal" title="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="ss-share-actions">
          ${discordButtons}

          <button class="ss-share-btn" data-act="do-share-x">
            <div class="ss-share-btn-icon">${icon("twitter", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.shareX")}</span>
              <span class="ss-btn-hint">${t("ss.shareXHint")}</span>
            </div>
          </button>

          <button class="ss-share-btn" data-act="do-share-reddit">
            <div class="ss-share-btn-icon">${icon("globe", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.shareReddit")}</span>
              <span class="ss-btn-hint">${t("ss.shareRedditHint")}</span>
            </div>
          </button>

          <button class="ss-share-btn primary" data-act="do-copy-image">
            <div class="ss-share-btn-icon">${icon("copy", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.copyImage")}</span>
              <span class="ss-btn-hint">${t("ss.copyHint")}</span>
            </div>
            <span class="ss-badge-recommended">${t("ss.recommended")}</span>
          </button>

          <button class="ss-share-btn" data-act="do-copy-path">
            <div class="ss-share-btn-icon">${icon("link", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.copyPath")}</span>
              <span class="ss-btn-hint" title="${esc(item.file_path)}">${esc(item.file_path)}</span>
            </div>
          </button>

          <button class="ss-share-btn" data-act="do-open-folder">
            <div class="ss-share-btn-icon">${icon("folder", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">${t("ss.showInFolder")}</span>
              <span class="ss-btn-hint">${t("ss.showInFolderHint")}</span>
            </div>
          </button>

          ${!isAvifOrWebp && !readOnly ? `
            <button class="ss-share-btn" data-act="do-compress-from-share">
              <div class="ss-share-btn-icon">${icon("minimize-2", 18)}</div>
              <div class="ss-share-btn-text">
                <span class="ss-btn-main">${t("ss.compressImage")}</span>
                <span class="ss-btn-hint">${t("ss.compressHint")}</span>
              </div>
            </button>
          ` : ""}

          ${typeof navigator.share === "function" ? `
            <button class="ss-share-btn" data-act="do-native-share">
              <div class="ss-share-btn-icon">${icon("share-2", 18)}</div>
              <div class="ss-share-btn-text">
                <span class="ss-btn-main">${t("ss.winShare")}</span>
                <span class="ss-btn-hint">${t("ss.winShareHint")}</span>
              </div>
            </button>
          ` : ""}
        </div>
      </div>
    </div>
  `;
}

export function closeShareModal(): void {
  S.activeShareScreenshot = null;
  const shareRoot = document.getElementById("share-modal-root");
  if (shareRoot) shareRoot.innerHTML = "";
}

export function renderDrawerScreenshots(s: EpicSummary): string {
  const screenshots = S.loadedScreenshots.get(s.appName) || [];
  const isLoading = S.loadingScreenshotsFor === s.appName;

  if (isLoading && screenshots.length === 0) {
    return `
      <div class="screenshots-tab-container">
        <div class="screenshots-loading-box">
          <span class="hltb-spinner" style="width:28px;height:28px;border-width:3px"></span>
          <span>${t("ss.scanning")}</span>
        </div>
      </div>
    `;
  }

  const hasUncompressed = screenshots.some(item => !item.file_name.endsWith(".avif") && !item.file_name.endsWith(".webp"));
  const owner = galleryOwner(s.appName);
  const readOnly = owner !== null;

  const captureOff = (S.epicSettingsCache?.screenshot_disabled_games ?? []).includes(s.appName);
  const headerHtml = `
    <div class="screenshots-gallery-head">
      <div class="screenshots-head-info">
        <h3 class="screenshots-title">${icon("image", 15)} <span>${t("ss.title")}</span></h3>
        <span class="screenshots-count-chip">${t("ss.photoCount", { count: screenshots.length })}</span>
      </div>
      <div class="screenshots-head-actions">
        <button class="btn ghost small ${captureOff ? "active" : ""}" data-act="toggle-game-capture" data-id="${s.appName}" title="${t("ss.gameCaptureTip")}">
          ${icon(captureOff ? "eye-off" : "camera", 13)} ${captureOff ? t("ss.gameCaptureOff") : t("ss.gameCaptureOn")}
        </button>
        ${screenshots.length > 0 && hasUncompressed && !readOnly ? `
          <button class="btn ghost small" data-act="compress-all-screenshots" data-id="${s.appName}" title="${t("ss.compressAllTip")}">
            ${icon("minimize-2", 13)} ${t("ss.compressAll")}
          </button>
        ` : ""}
        ${screenshots.length > 0 ? `
        <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}" title="${t("ss.openFolderTip")}">
          ${icon("folder", 13)} ${t("ss.openFolder")}
        </button>` : ""}
      </div>
    </div>
  `;

  if (screenshots.length === 0) {
    return `
      <div class="screenshots-tab-container">
        ${headerHtml}
        <div class="screenshots-empty-card">
          <div class="screenshots-empty-icon">${icon("image", 44)}</div>
          <h4 class="screenshots-empty-title">${t("ss.emptyTitle")}</h4>
          <p class="screenshots-empty-desc">
            ${owner === "steam" ? t("ss.steamEmptyDesc") : owner === "ubisoft" ? t("ss.ubiEmptyDesc") : t("ss.emptyDesc", { hotkey: `<strong>${esc(S.screenshotHotkeyName)}</strong>` })}
          </p>
          <button type="button" class="btn ghost small screenshots-empty-settings" data-view="settings" data-settings-section="screenshots">
            ${icon("settings", 13)} ${t("ss.openSettings")}
          </button>
        </div>
      </div>
    `;
  }

  // The gallery view: the shared defaults (sort/density) plus the toolbar's
  // own filter and selection state.
  const favorites = ssFavorites();
  const indexed = screenshots.map((item, idx) => ({ item, idx }));
  const sorted = ssSortItems(
    indexed,
    (entry) => entry.item.timestamp,
    (entry) => entry.item.file_name,
    (entry) => entry.item.size_bytes || 0,
  );
  const visible = sorted.filter(({ item }) => {
    const compressed = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
    if (galleryFilter === "raw") return !compressed;
    if (galleryFilter === "compressed") return compressed;
    if (galleryFilter === "favorites") return favorites.has(item.file_path);
    return true;
  });
  const selectedCount = gallerySelection.size;
  const density = ssDensity();
  const sort = ssSort();

  const chip = (act: string, value: string, label: string, active: boolean, data: string): string =>
    `<button type="button" class="ss-chip-btn${active ? " active" : ""}" data-act="${act}" ${data}="${value}">${label}</button>`;

  const toolbar = `
    <div class="ss-toolbar">
      <div class="ss-toolbar-left">
        ${chip("ssg-filter", "all", t("ss.filterAll"), galleryFilter === "all", "data-filter")}
        ${chip("ssg-filter", "raw", t("ss.filterRaw"), galleryFilter === "raw", "data-filter")}
        ${chip("ssg-filter", "compressed", t("ss.filterCompressed"), galleryFilter === "compressed", "data-filter")}
        ${chip("ssg-filter", "favorites", t("ss.filterFavorites"), galleryFilter === "favorites", "data-filter")}
      </div>
      <div class="ss-toolbar-right">
        ${chip("ssg-sort", "newest", t("ss.sortNewest"), sort === "newest", "data-sort")}
        ${chip("ssg-sort", "oldest", t("ss.sortOldest"), sort === "oldest", "data-sort")}
        ${chip("ssg-sort", "name", t("ss.sortName"), sort === "name", "data-sort")}
        ${chip("ssg-sort", "size", t("ss.sortSize"), sort === "size", "data-sort")}
        <span class="ss-toolbar-divider"></span>
        ${chip("ssg-density", "s", t("ss.densitySmall"), density === "s", "data-density")}
        ${chip("ssg-density", "m", t("ss.densityMedium"), density === "m", "data-density")}
        ${chip("ssg-density", "l", t("ss.densityLarge"), density === "l", "data-density")}
        <span class="ss-toolbar-divider"></span>
        <button type="button" class="btn ghost small${gallerySelectMode ? " active" : ""}" data-act="ssg-select">
          ${icon("check", 12)} ${t("ss.selectMode")}
        </button>
      </div>
    </div>
    ${
      gallerySelectMode
        ? `<div class="ss-batch-bar">
            <span class="ss-batch-count">${t("ss.selectedCount", { count: String(selectedCount) })}</span>
            <button type="button" class="btn ghost small" data-act="ssg-batch-copy" ${selectedCount === 0 ? "disabled" : ""}>${icon("clipboard", 12)} ${t("ss.copyPaths")}</button>
            ${readOnly ? "" : `<button type="button" class="btn ghost small" data-act="ssg-batch-compress" ${selectedCount === 0 ? "disabled" : ""}>${icon("minimize-2", 12)} ${t("ss.compress")}</button>`}
            ${readOnly ? "" : `<button type="button" class="btn ${galleryBatchDeleteArmed ? "danger" : "ghost danger"} small" data-act="ssg-batch-delete" ${selectedCount === 0 ? "disabled" : ""}>${icon("trash", 12)} ${galleryBatchDeleteArmed ? t("ss.batchDeleteConfirm") : t("common.delete")}</button>`}
            <button type="button" class="btn ghost small" data-act="ssg-batch-clear" ${selectedCount === 0 ? "disabled" : ""}>${t("ss.clearSelection")}</button>
          </div>`
        : ""
    }`;

  const cardsHtml = visible
    .map(
      ({ item, idx }) => {
        const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
        const isFavorite = favorites.has(item.file_path);
        const isSelected = gallerySelection.has(item.file_path);
        const cardAction = gallerySelectMode ? "ssg-toggle-select" : "open-screenshot-lightbox";
        return `
    <div class="screenshot-card${isSelected ? " is-selected" : ""}${gallerySelectMode ? " is-selecting" : ""}" data-act="${cardAction}" data-id="${s.appName}" data-idx="${idx}" data-path="${esc(item.file_path)}" tabindex="0" title="${esc(item.file_name)}">
      <div class="screenshot-thumb-wrap">
        ${shotThumbHtml(item)}
        ${gallerySelectMode ? `<span class="ss-select-box">${isSelected ? icon("check", 12) : ""}</span>` : ""}
        <div class="screenshot-overlay">
          <div class="screenshot-overlay-top">
            <span class="ss-chip date">${esc(formatScreenshotDate(item.timestamp, item.date_str))}</span>
            <span class="ss-chip size">${esc(item.size_str)}</span>
          </div>
          <div class="screenshot-overlay-bottom">
            <span class="ss-view-btn">${icon("eye", 12)} ${t("ss.zoom")}</span>
            <button class="ss-share-btn" data-act="share-screenshot" data-id="${s.appName}" data-idx="${idx}" title="${t("ss.shareTip")}">
              ${icon("share-2", 12)} ${t("ss.share")}
            </button>
            ${readOnly && owner
              ? `<span class="ss-compressed-tag" title="${esc(ownerReadOnlyTip(owner))}">${ownerBadge(owner)}</span>`
              : !isAvifOrWebp
                ? `
              <button class="ss-compress-btn" data-act="compress-screenshot" data-id="${s.appName}" data-idx="${idx}" title="${t("ss.compressTip")}">
                ${icon("minimize-2", 12)}
              </button>
            `
                : `
              <span class="ss-compressed-tag" title="${t("ss.compressedFormatTip")}">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            ${readOnly ? "" : `
            <button class="ss-delete-btn" data-act="delete-screenshot" data-id="${s.appName}" data-path="${esc(item.file_path)}" title="${t("common.delete")}">
              ${icon("trash", 12)}
            </button>`}
          </div>
        </div>
        <button class="ss-fav-btn${isFavorite ? " is-favorite" : ""}" data-act="ssg-favorite" data-path="${esc(item.file_path)}" title="${isFavorite ? t("ss.unfavorite") : t("ss.favorite")}">
          ${icon("star", 13)}
        </button>
      </div>
      <div class="screenshot-info-strip">
        <span class="ss-name" title="${esc(item.file_name)}">${esc(item.file_name)}</span>
        <span class="ss-date">${esc(formatScreenshotDate(item.timestamp, item.date_str))}</span>
      </div>
    </div>
  `;
      }
    )
    .join("");

  hydrateShotPreviews();
  return `
    <div class="screenshots-tab-container">
      ${headerHtml}
      ${toolbar}
      ${
        visible.length === 0
          ? `<div class="screenshots-empty-card"><p class="screenshots-empty-desc">${t("ss.filterEmpty")}</p></div>`
          : `<div class="screenshots-grid ss-density-${density}">${cardsHtml}</div>`
      }
    </div>
  `;
}

export function renderScreenshotLightbox(appName: string, index: number): string {
  const list = S.loadedScreenshots.get(appName) || [];
  const item = list[index];
  if (!item) return "";

  const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
  const owner = galleryOwner(appName);
  const readOnly = owner !== null;
  const fullSrc = fullShotSrc(item);

  return `
    <div class="screenshot-lightbox-overlay" data-act="close-screenshot-lightbox-backdrop">
      <div class="screenshot-lightbox-box">
        <div class="lightbox-topbar">
          <div class="lightbox-info">
            <span class="lightbox-filename">${esc(item.file_name)}</span>
            <span class="lightbox-meta">${esc(formatScreenshotDate(item.timestamp, item.date_str))} • ${esc(item.size_str)}</span>
          </div>
          <div class="lightbox-tools">
            <button class="btn ghost small" data-act="edit-screenshot" data-id="${appName}" data-idx="${index}" title="${t("ss.editTip")}">
              ${icon("edit", 13)} ${t("ss.edit")}
            </button>
            <button class="btn ghost small" data-act="share-screenshot" data-id="${appName}" data-idx="${index}" title="${t("ss.shareTip2")}">
              ${icon("share-2", 13)} ${t("ss.share")}
            </button>
            ${readOnly && owner
              ? `<span class="lightbox-badge-avif" title="${esc(ownerReadOnlyTip(owner))}">${ownerBadge(owner)}</span>`
              : !isAvifOrWebp
                ? `
              <button class="btn ghost small" data-act="compress-screenshot" data-id="${appName}" data-idx="${index}" title="${t("ss.compressTip2")}">
                ${icon("minimize-2", 13)} ${t("ss.compress")}
              </button>
            `
                : `
              <span class="lightbox-badge-avif">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${appName}" title="${t("ss.showInFolder")}">
              ${icon("folder", 12)} ${t("ss.showInFolderShort")}
            </button>
            ${readOnly ? "" : `
            <button class="btn ghost danger small" data-act="delete-screenshot" data-id="${appName}" data-path="${esc(item.file_path)}" data-lightbox="true" title="${t("ss.deleteTip")}">
              ${icon("trash", 12)} ${t("common.delete")}
            </button>`}
            <button class="btn ghost small" data-act="close-screenshot-lightbox" title="${t("common.close")} (ESC)">
              ${icon("x", 14)}
            </button>
          </div>
        </div>

        <div class="lightbox-stage">
          ${
            list.length > 1
              ? `
            <button class="lightbox-arrow prev" data-act="lightbox-nav" data-dir="prev" title="${t("ss.prevTip")}">
              ${icon("chevron-left", 22)}
            </button>
          `
              : ""
          }

          <div class="lightbox-img-container">
            ${
              fullSrc
                ? `<img src="${fullSrc}" alt="${esc(item.file_name)}" />`
                : `<div class="shot-loading-box"><span class="hltb-spinner" style="width:34px;height:34px;border-width:3px"></span></div>`
            }
          </div>

          ${
            list.length > 1
              ? `
            <button class="lightbox-arrow next" data-act="lightbox-nav" data-dir="next" title="${t("ss.nextTip")}">
              ${icon("chevron-right", 22)}
            </button>
          `
              : ""
          }
        </div>

        <div class="lightbox-counter-bar">
          <span>${index + 1} / ${list.length}</span>
        </div>
      </div>
    </div>
  `;
}

export function openScreenshotLightbox(appName: string, index: number): void {
  S.activeLightboxScreenshot = { appName, index };
  let lbRoot = document.getElementById("lightbox-root");
  if (!lbRoot) {
    lbRoot = document.createElement("div");
    lbRoot.id = "lightbox-root";
    document.body.appendChild(lbRoot);
  }
  lbRoot.innerHTML = renderScreenshotLightbox(appName, index);

  // The stage opens on the grid preview; the original swaps in when it lands.
  const item = (S.loadedScreenshots.get(appName) || [])[index];
  if (item && !S.screenshotFullSrc.has(item.file_path)) {
    void ensureFullShot(appName, item).then((data) => {
      const active = S.activeLightboxScreenshot;
      if (!data || !active || active.appName !== appName || active.index !== index) return;
      const root = document.getElementById("lightbox-root");
      if (root) root.innerHTML = renderScreenshotLightbox(appName, index);
    });
  }
}

export function closeScreenshotLightbox(): void {
  S.activeLightboxScreenshot = null;
  const lbRoot = document.getElementById("lightbox-root");
  if (lbRoot) {
    lbRoot.innerHTML = "";
  }
}

type PendingScreenshotDelete = { appName: string; filePath: string; lightbox: boolean };

let pendingScreenshotDelete: PendingScreenshotDelete | null = null;

/** In-app confirm. `window.confirm` is the browser's own dialog. */
export function openScreenshotDeleteConfirm(appName: string, filePath: string, lightbox: boolean): void {
  pendingScreenshotDelete = { appName, filePath, lightbox };
  let root = document.getElementById("ss-delete-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ss-delete-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="modal-backdrop ss-delete-backdrop" data-act="ss-delete-backdrop">
      <div class="modal-box ss-delete-card" role="dialog" aria-modal="true">
        <div class="selective-header">
          <h2>${t("ss.deleteTip")}</h2>
        </div>
        <p class="ss-delete-copy">${t("ss.deleteConfirm")}</p>
        <div class="playtime-footer">
          <button class="btn ghost" data-act="ss-delete-cancel">${t("common.cancel")}</button>
          <button class="btn danger" data-act="ss-delete-confirm">${t("common.delete")}</button>
        </div>
      </div>
    </div>
  `;
}

export function closeScreenshotDeleteConfirm(): void {
  pendingScreenshotDelete = null;
  document.getElementById("ss-delete-root")?.remove();
}

export function takePendingScreenshotDelete(): PendingScreenshotDelete | null {
  const pending = pendingScreenshotDelete;
  pendingScreenshotDelete = null;
  document.getElementById("ss-delete-root")?.remove();
  return pending;
}

type PendingScreenshotMove = { targetDir: string | null; count: number; bytes: number };

let pendingScreenshotMove: PendingScreenshotMove | null = null;

/**
 * In-app confirm shown when the screenshots folder changes while files exist.
 * `window.confirm` is the browser's own dialog, so the launcher asks here.
 */
export function openScreenshotMoveConfirm(targetDir: string | null, count: number, bytes: number): void {
  pendingScreenshotMove = { targetDir, count, bytes };
  let root = document.getElementById("ss-move-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ss-move-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="modal-backdrop ss-move-backdrop" data-act="ss-move-backdrop">
      <div class="modal-box ss-move-card" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="selective-header">
          <h2>${t("ss.moveTitle")}</h2>
        </div>
        <p class="ss-move-copy">${t("ss.moveBody", { count, size: fmtBytes(bytes) })}</p>
        <div class="playtime-footer">
          <button class="btn ghost" data-act="ss-move-cancel">${t("common.cancel")}</button>
          <button class="btn ghost" data-act="ss-move-keep">${t("ss.moveKeep")}</button>
          <button class="btn primary" data-act="ss-move-confirm">${t("ss.moveConfirm")}</button>
        </div>
      </div>
    </div>
  `;
}

export function closeScreenshotMoveConfirm(): void {
  pendingScreenshotMove = null;
  document.getElementById("ss-move-root")?.remove();
}

export function takePendingScreenshotMove(): PendingScreenshotMove | null {
  const pending = pendingScreenshotMove;
  pendingScreenshotMove = null;
  document.getElementById("ss-move-root")?.remove();
  return pending;
}

export function navigateScreenshotLightbox(dir: "prev" | "next"): void {
  if (!S.activeLightboxScreenshot) return;
  const list = S.loadedScreenshots.get(S.activeLightboxScreenshot.appName) || [];
  if (list.length <= 1) return;
  let nextIdx = S.activeLightboxScreenshot.index + (dir === "prev" ? -1 : 1);
  if (nextIdx < 0) nextIdx = list.length - 1;
  if (nextIdx >= list.length) nextIdx = 0;
  openScreenshotLightbox(S.activeLightboxScreenshot.appName, nextIdx);
}

