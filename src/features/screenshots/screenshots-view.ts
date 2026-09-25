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
import { esc, formatScreenshotDate } from "../../core/utils";
import { t } from "../../i18n";

import {
  epicGetGameScreenshots,
  epicReplaceScreenshotWithCompressed,
  type EpicSummary,
  type GameScreenshotItem,
} from "../../epic";
import { renderOverviewMediaSpotlight } from "../drawer/drawer-widgets";
export function fetchAndRenderScreenshots(appName: string, title: string, force = false): void {
  if (!force && S.loadedScreenshots.has(appName)) return;
  S.loadingScreenshotsFor = appName;
  epicGetGameScreenshots(appName, title)
    .then((items) => {
      S.loadedScreenshots.set(appName, items);
      S.loadingScreenshotsFor = null;
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
            const curSummary = S.epicSummaries.find((x) => x.appName === appName);
            if (curSummary) contentEl.innerHTML = renderDrawerScreenshots(curSummary);
          }
        } else if (S.activeDrawerTab === "overview") {
          const mediaContainer = document.getElementById("overview-media-container");
          if (mediaContainer) {
            const curSummary = S.epicSummaries.find((x) => x.appName === appName);
            if (curSummary) mediaContainer.innerHTML = renderOverviewMediaSpotlight(curSummary);
          }
        }
      }
    })
    .catch(() => {
      S.loadingScreenshotsFor = null;
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

export async function copyScreenshotImageToClipboard(item: GameScreenshotItem): Promise<boolean> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = item.data_url;
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
    const { base64, ext, bytes } = await compressImageToBlob(item.data_url, format, quality);
    const updated = await epicReplaceScreenshotWithCompressed(item.file_path, base64, ext);

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
      const curSummary = S.epicSummaries.find((x) => x.appName === appName);
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
  let shareRoot = document.getElementById("share-modal-root");
  if (!shareRoot) {
    shareRoot = document.createElement("div");
    shareRoot.id = "share-modal-root";
    document.body.appendChild(shareRoot);
  }
  const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
  shareRoot.innerHTML = `
    <div class="ss-share-backdrop" data-act="close-share-modal">
      <div class="ss-share-card" role="dialog" aria-modal="true">
        <div class="ss-share-head">
          <div class="ss-share-preview-thumb">
            <img src="${item.data_url}" alt="${esc(item.file_name)}" />
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

          ${!isAvifOrWebp ? `
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

  const headerHtml = `
    <div class="screenshots-gallery-head">
      <div class="screenshots-head-info">
        <h3 class="screenshots-title">${icon("image", 15)} <span>${t("ss.title")}</span></h3>
        <span class="screenshots-count-chip">${t("ss.photoCount", { count: screenshots.length })}</span>
      </div>
      ${screenshots.length === 0 ? "" : `<div class="screenshots-head-actions">
        ${hasUncompressed ? `
          <button class="btn ghost small" data-act="compress-all-screenshots" data-id="${s.appName}" title="${t("ss.compressAllTip")}">
            ${icon("minimize-2", 13)} ${t("ss.compressAll")}
          </button>
        ` : ""}
        <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}" title="${t("ss.openFolderTip")}">
          ${icon("folder", 13)} ${t("ss.openFolder")}
        </button>
      </div>`}
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
            ${t("ss.emptyDesc", { hotkey: `<strong>${esc(S.screenshotHotkeyName)}</strong>` })}
          </p>
        </div>
      </div>
    `;
  }

  const cardsHtml = screenshots
    .map(
      (item, idx) => {
        const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");
        return `
    <div class="screenshot-card" data-act="open-screenshot-lightbox" data-id="${s.appName}" data-idx="${idx}" tabindex="0" title="${esc(item.file_name)}">
      <div class="screenshot-thumb-wrap">
        <img src="${item.data_url}" alt="${esc(item.file_name)}" loading="lazy" />
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
            ${!isAvifOrWebp ? `
              <button class="ss-compress-btn" data-act="compress-screenshot" data-id="${s.appName}" data-idx="${idx}" title="${t("ss.compressTip")}">
                ${icon("minimize-2", 12)}
              </button>
            ` : `
              <span class="ss-compressed-tag" title="${t("ss.compressedFormatTip")}">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            <button class="ss-delete-btn" data-act="delete-screenshot" data-id="${s.appName}" data-path="${esc(item.file_path)}" title="${t("common.delete")}">
              ${icon("trash", 12)}
            </button>
          </div>
        </div>
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

  return `
    <div class="screenshots-tab-container">
      ${headerHtml}
      <div class="screenshots-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}

export function renderScreenshotLightbox(appName: string, index: number): string {
  const list = S.loadedScreenshots.get(appName) || [];
  const item = list[index];
  if (!item) return "";

  const isAvifOrWebp = item.file_name.endsWith(".avif") || item.file_name.endsWith(".webp");

  return `
    <div class="screenshot-lightbox-overlay" data-act="close-screenshot-lightbox-backdrop">
      <div class="screenshot-lightbox-box">
        <div class="lightbox-topbar">
          <div class="lightbox-info">
            <span class="lightbox-filename">${esc(item.file_name)}</span>
            <span class="lightbox-meta">${esc(formatScreenshotDate(item.timestamp, item.date_str))} • ${esc(item.size_str)}</span>
          </div>
          <div class="lightbox-tools">
            <button class="btn ghost small" data-act="share-screenshot" data-id="${appName}" data-idx="${index}" title="${t("ss.shareTip2")}">
              ${icon("share-2", 13)} ${t("ss.share")}
            </button>
            ${!isAvifOrWebp ? `
              <button class="btn ghost small" data-act="compress-screenshot" data-id="${appName}" data-idx="${index}" title="${t("ss.compressTip2")}">
                ${icon("minimize-2", 13)} ${t("ss.compress")}
              </button>
            ` : `
              <span class="lightbox-badge-avif">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${appName}" title="${t("ss.showInFolder")}">
              ${icon("folder", 12)} ${t("ss.showInFolderShort")}
            </button>
            <button class="btn ghost danger small" data-act="delete-screenshot" data-id="${appName}" data-path="${esc(item.file_path)}" data-lightbox="true" title="${t("ss.deleteTip")}">
              ${icon("trash", 12)} ${t("common.delete")}
            </button>
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
            <img src="${item.data_url}" alt="${esc(item.file_name)}" />
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

export function navigateScreenshotLightbox(dir: "prev" | "next"): void {
  if (!S.activeLightboxScreenshot) return;
  const list = S.loadedScreenshots.get(S.activeLightboxScreenshot.appName) || [];
  if (list.length <= 1) return;
  let nextIdx = S.activeLightboxScreenshot.index + (dir === "prev" ? -1 : 1);
  if (nextIdx < 0) nextIdx = list.length - 1;
  if (nextIdx >= list.length) nextIdx = 0;
  openScreenshotLightbox(S.activeLightboxScreenshot.appName, nextIdx);
}

