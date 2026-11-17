/**
 * Store icon picker for user-added storefronts.
 *
 * The choice lives in the store's localStorage record (`CustomStore.icon`):
 * a line glyph, an uploaded image, or the site's own favicon. The picker is a
 * modal because the settings row has no room for a preview.
 */

import { icon } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { STORE_ICON_GLYPHS, MAX_STORE_ICON_CHARS, customStore, setCustomStoreIcon, storeMark } from "./store-view";

const MODAL_ID = "store-icon-modal";
const UPLOAD_LIMIT = 4 * 1024 * 1024;
const ICON_SIZE = 64;
/** Stores whose site icon was already tried this session; a failed probe is not re-run. */
const siteProbed = new Set<string>();

function iconCandidates(origin: string): string[] {
  return [
    `${origin}/favicon.png`,
    `${origin}/favicon.ico`,
    `${origin}/apple-touch-icon.png`,
    `${origin}/apple-touch-icon-precomposed.png`,
  ];
}

function modalStoreId(): string {
  return document.getElementById(MODAL_ID)?.dataset.store ?? "";
}

function modalStillShows(id: string): boolean {
  return document.getElementById(MODAL_ID)?.dataset.store === id;
}

function applyStoreIconTo(id: string, value: string): void {
  if (!setCustomStoreIcon(id, value)) return;
  closeStoreIconPicker();
  toast(t("settings.storeIconSaved"), "ok");
}

/**
 * Silently adopts the store's own favicon when a new store is added (or an
 * older one still has no icon). A failed probe keeps the letter mark.
 */
export async function suggestStoreSiteIcon(id: string): Promise<void> {
  if (siteProbed.has(id)) return;
  siteProbed.add(id);
  const store = customStore(id);
  if (!store || store.icon) return;
  let origin = "";
  try {
    origin = new URL(store.url).origin;
  } catch {
    return;
  }
  for (const url of iconCandidates(origin)) {
    if (!(await loadsAsImage(url))) continue;
    const current = customStore(id);
    if (current && !current.icon) setCustomStoreIcon(id, url);
    return;
  }
}

export function closeStoreIconPicker(): void {
  document.getElementById(MODAL_ID)?.remove();
}

export function openStoreIconPicker(id: string): void {
  const store = customStore(id);
  if (!store) return;
  closeStoreIconPicker();
  const current = store.icon;
  const letter = (Array.from(store.name.trim())[0] ?? "").toUpperCase();
  const letterChoice = `
    <button type="button" class="store-icon-choice ${current ? "" : "active"}" data-act="store-icon-letter" title="${t("settings.storeIconLetter")}">
      <span class="store-icon-choice-letter">${esc(letter)}</span>
    </button>`;
  const glyphs = STORE_ICON_GLYPHS.map((name) => `
    <button type="button" class="store-icon-choice ${current === `lucide:${name}` ? "active" : ""}" data-act="store-icon-glyph" data-icon="lucide:${name}" aria-label="${name}">
      ${icon(name, 22)}
    </button>`).join("");

  const html = `
    <div id="${MODAL_ID}" class="modal-backdrop fadeIn" data-act="store-icon-backdrop" data-store="${esc(id)}" style="z-index:1050;">
      <div class="modal-box store-icon-modal" role="dialog" aria-modal="true" aria-label="${t("settings.storeIconTitle")}">
        <div class="panel-avatar-modal-header">
          <div class="panel-avatar-modal-title">
            ${icon("image", 16)}
            <h3>${t("settings.storeIconTitle")}</h3>
          </div>
          <button class="modal-close-btn" data-act="store-icon-close" title="${t("common.close")}" aria-label="${t("common.close")}">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="panel-avatar-modal-body store-icon-body">
          <div class="store-icon-preview">${storeMark(id, 56, "store-icon-preview-mark")}</div>
          <p class="store-icon-hint">${t("settings.storeIconHint", { name: esc(store.name) })}</p>
        </div>
        <div class="store-icon-grid">${letterChoice}${glyphs}</div>
        <div class="store-icon-actions">
          <button type="button" class="btn ghost small" data-act="store-icon-site">${icon("globe", 14)} ${t("settings.storeIconSite")}</button>
          <button type="button" class="btn ghost small" data-act="store-icon-upload">${icon("upload", 14)} ${t("settings.storeIconUpload")}</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
}

/** Saves the chosen value, closes the picker and repaints the settings page. */
export function applyStoreIcon(value: string): void {
  const id = modalStoreId();
  if (id) applyStoreIconTo(id, value);
}

/** Probes the favicon paths a storefront usually publishes and uses the first one. */
export async function useStoreSiteIcon(): Promise<void> {
  const id = modalStoreId();
  const store = customStore(id);
  if (!store) return;
  let origin = "";
  try {
    origin = new URL(store.url).origin;
  } catch {
    return;
  }
  const button = document.querySelector<HTMLButtonElement>(`#${MODAL_ID} [data-act="store-icon-site"]`);
  const label = button?.innerHTML ?? "";
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner" style="width:12px;height:12px;"></span> ${t("settings.storeIconSite")}`;
  }
  try {
    for (const url of iconCandidates(origin)) {
      if (await loadsAsImage(url)) {
        // The picker may have closed or moved to another store while the
        // request was in flight; only apply the answer to its own row.
        if (modalStillShows(id)) applyStoreIconTo(id, url);
        return;
      }
    }
    if (modalStillShows(id)) toast(t("settings.storeIconSiteMissing"), "err");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

/** Opens the file dialog and turns the picked image into a 64px store mark. */
export function pickStoreIconFile(): void {
  const id = modalStoreId();
  if (!id) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon";
  input.style.display = "none";
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > UPLOAD_LIMIT) {
      toast(t("settings.storeIconBadFile"), "err");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void toStoreIcon(String(reader.result ?? "")).then((data) => {
        if (!data) {
          toast(t("settings.storeIconBadFile"), "err");
          return;
        }
        if (modalStillShows(id)) applyStoreIconTo(id, data);
      });
    };
    reader.onerror = () => toast(t("settings.storeIconBadFile"), "err");
    reader.readAsDataURL(file);
  };
  document.body.appendChild(input);
  input.click();
  window.setTimeout(() => input.remove(), 30000);
}

function loadsAsImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
    window.setTimeout(() => {
      if (settled) return;
      img.removeAttribute("src");
      finish(false);
    }, 4000);
  });
}

function toStoreIcon(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!dataUrl.startsWith("data:image/")) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx || !img.naturalWidth || !img.naturalHeight) {
        resolve(null);
        return;
      }
      const scale = Math.min(ICON_SIZE / img.naturalWidth, ICON_SIZE / img.naturalHeight);
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, Math.round((ICON_SIZE - width) / 2), Math.round((ICON_SIZE - height) / 2), width, height);
      try {
        const webp = canvas.toDataURL("image/webp", 0.9);
        const out = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
        resolve(out.length <= MAX_STORE_ICON_CHARS ? out : null);
      } catch {
        // A cross-origin or externally-linked SVG taints the canvas.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
