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

    // 1. Deklanşör Tıklaması (Mekanik Shutter Başlangıcı)
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

    // 2. Deklanşör Kapanışı (Mechanical Snap)
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
    // Ses engellendiyse sessizce geç
  }
}

export async function copyScreenshotImageToClipboard(item: GameScreenshotItem): Promise<boolean> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = item.data_url;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("Görsel yüklenemedi"));
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context alınamadı");
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("PNG Blob oluşturulamadı");

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);

    toast("Görsel panoya kopyalandı.", "ok");
    return true;
  } catch (err) {
    console.warn("Görsel kopyalanamadı:", err);
    try {
      await navigator.clipboard.writeText(item.file_path);
      toast("Dosya yolu panoya kopyalandı: " + item.file_name, "ok");
      return true;
    } catch {
      toast("Panoya kopyalama başarısız oldu", "err");
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
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context 2D alınamadı");
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

  if (!blob) throw new Error("Görsel sıkıştırma başarısız oldu");

  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return { base64, ext: targetExt, bytes: blob.size };
}

export async function compressScreenshotItem(
  appName: string,
  item: GameScreenshotItem,
  format: "avif" | "webp" | "jpg" = S.screenshotCompressionFormat,
  quality: number = S.screenshotCompressionQuality,
  silent = false
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
          <button class="ss-share-close" data-act="close-share-modal" title="Kapat">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="ss-share-actions">
          <button class="ss-share-btn primary" data-act="do-copy-image">
            <div class="ss-share-btn-icon" style="color:#60a5fa">${icon("copy", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">Görseli Panoya Kopyala</span>
              <span class="ss-btn-hint">Discord, WhatsApp veya sohbete Ctrl+V ile anında yapıştırın</span>
            </div>
            <span class="ss-badge-recommended">Önerilen</span>
          </button>

          <button class="ss-share-btn" data-act="do-copy-path">
            <div class="ss-share-btn-icon" style="color:#a78bfa">${icon("link", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">Dosya Yolunu Kopyala</span>
              <span class="ss-btn-hint" title="${esc(item.file_path)}">${esc(item.file_path)}</span>
            </div>
          </button>

          <button class="ss-share-btn" data-act="do-open-folder">
            <div class="ss-share-btn-icon" style="color:#fbbf24">${icon("folder", 18)}</div>
            <div class="ss-share-btn-text">
              <span class="ss-btn-main">Klasörde Göster</span>
              <span class="ss-btn-hint">Windows Dosya Gezgini'nde aç</span>
            </div>
          </button>

          ${!isAvifOrWebp ? `
            <button class="ss-share-btn" data-act="do-compress-from-share">
              <div class="ss-share-btn-icon" style="color:#34d399">${icon("minimize-2", 18)}</div>
              <div class="ss-share-btn-text">
                <span class="ss-btn-main">Görseli Sıkıştır (AVIF/WebP)</span>
                <span class="ss-btn-hint">Dosya boyutunu %70-85 oranında küçülterek paylaşımı hızlandırın</span>
              </div>
            </button>
          ` : ""}

          ${typeof navigator.share === "function" ? `
            <button class="ss-share-btn" data-act="do-native-share">
              <div class="ss-share-btn-icon" style="color:#f472b6">${icon("share-2", 18)}</div>
              <div class="ss-share-btn-text">
                <span class="ss-btn-main">Windows Paylaşım Menüsü</span>
                <span class="ss-btn-hint">Yakındakilerle Paylaş, E-posta vb.</span>
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
          <span>Ekran görüntüleri taranıyor…</span>
        </div>
      </div>
    `;
  }

  const hasUncompressed = screenshots.some(item => !item.file_name.endsWith(".avif") && !item.file_name.endsWith(".webp"));

  const headerHtml = `
    <div class="screenshots-gallery-head">
      <div class="screenshots-head-info">
        <h3 class="screenshots-title">${icon("image", 15)} <span>Oyun Ekran Görüntüleri</span></h3>
        <span class="screenshots-count-chip">${screenshots.length} Fotoğraf</span>
      </div>
      <div class="screenshots-head-actions">
        <button class="btn primary small" data-act="capture-screenshot" data-id="${s.appName}" data-title="${esc(s.title)}" title="Hemen ekran görüntüsü al">
          ${icon("camera", 13)} Ekran Görüntüsü Al
        </button>
        ${hasUncompressed ? `
          <button class="btn ghost small" data-act="compress-all-screenshots" data-id="${s.appName}" title="Tüm ham PNG ekran görüntülerini sıkıştırıp disk alanı kazanın">
            ${icon("minimize-2", 13)} Tümünü Sıkıştır
          </button>
        ` : ""}
        <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}" title="Klasörü Explorer'da Aç">
          ${icon("folder", 13)} Klasörü Aç
        </button>
      </div>
    </div>
  `;

  if (screenshots.length === 0) {
    return `
      <div class="screenshots-tab-container">
        ${headerHtml}
        <div class="screenshots-empty-card">
          <div class="screenshots-empty-icon">${icon("image", 44)}</div>
          <h4 class="screenshots-empty-title">Henüz Ekran Görüntüsü Yok</h4>
          <p class="screenshots-empty-desc">
            Oyun oynarken <strong>${esc(S.screenshotHotkeyName)}</strong> veya <strong>Win + Alt + PrtScn</strong> tuşlarına basarak ekran görüntüsü yakalayabilirsiniz. Alınan görüntüler otomatik olarak burada toplanır.
          </p>
          <div class="screenshots-empty-actions">
            <button class="btn primary" data-act="capture-screenshot" data-id="${s.appName}" data-title="${esc(s.title)}">
              ${icon("camera", 14)} Hemen Ekran Görüntüsü Al
            </button>
            <button class="btn ghost" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}">
              ${icon("folder", 14)} Ekran Görüntüleri Klasörünü Aç
            </button>
          </div>
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
            <span class="ss-view-btn">${icon("eye", 12)} Büyüt</span>
            <button class="ss-share-btn" data-act="share-screenshot" data-id="${s.appName}" data-idx="${idx}" title="Paylaş / Panoya Kopyala">
              ${icon("share-2", 12)} Paylaş
            </button>
            ${!isAvifOrWebp ? `
              <button class="ss-compress-btn" data-act="compress-screenshot" data-id="${s.appName}" data-idx="${idx}" title="Bu Görseli Sıkıştır (AVIF/WebP)">
                ${icon("minimize-2", 12)}
              </button>
            ` : `
              <span class="ss-compressed-tag" title="Sıkıştırılmış format">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            <button class="ss-delete-btn" data-act="delete-screenshot" data-id="${s.appName}" data-path="${esc(item.file_path)}" title="Sil">
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
            <button class="btn ghost small" data-act="share-screenshot" data-id="${appName}" data-idx="${index}" title="Görseli Paylaş (Panoya Kopyala / Paylaşım Menüsü)">
              ${icon("share-2", 13)} Paylaş
            </button>
            ${!isAvifOrWebp ? `
              <button class="btn ghost small" data-act="compress-screenshot" data-id="${appName}" data-idx="${index}" title="Görseli Sıkıştır (%70-85 Boyut Tasarrufu)">
                ${icon("minimize-2", 13)} Sıkıştır
              </button>
            ` : `
              <span class="lightbox-badge-avif">${item.file_name.endsWith(".avif") ? "AVIF" : "WebP"}</span>
            `}
            <button class="btn ghost small" data-act="open-screenshots-folder" data-id="${appName}" title="Klasörde Göster">
              ${icon("folder", 12)} Klasörde Aç
            </button>
            <button class="btn ghost danger small" data-act="delete-screenshot" data-id="${appName}" data-path="${esc(item.file_path)}" data-lightbox="true" title="Ekran görüntüsünü sil">
              ${icon("trash", 12)} Sil
            </button>
            <button class="btn ghost small" data-act="close-screenshot-lightbox" title="Kapat (ESC)">
              ${icon("x", 14)}
            </button>
          </div>
        </div>

        <div class="lightbox-stage">
          ${
            list.length > 1
              ? `
            <button class="lightbox-arrow prev" data-act="lightbox-nav" data-dir="prev" title="Önceki (Sol Ok)">
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
            <button class="lightbox-arrow next" data-act="lightbox-nav" data-dir="next" title="Sonraki (Sağ Ok)">
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

export function navigateScreenshotLightbox(dir: "prev" | "next"): void {
  if (!S.activeLightboxScreenshot) return;
  const list = S.loadedScreenshots.get(S.activeLightboxScreenshot.appName) || [];
  if (list.length <= 1) return;
  let nextIdx = S.activeLightboxScreenshot.index + (dir === "prev" ? -1 : 1);
  if (nextIdx < 0) nextIdx = list.length - 1;
  if (nextIdx >= list.length) nextIdx = 0;
  openScreenshotLightbox(S.activeLightboxScreenshot.appName, nextIdx);
}

