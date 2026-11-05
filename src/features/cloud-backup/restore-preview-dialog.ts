/**
 * Restore preview: the files a cloud archive will write over the current save
 * folder. The backend has already downloaded the archive to a temp file; this
 * dialog only decides whether the one-use token is spent.
 */

import { confirmRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";

/**
 * The fields both restore paths share: a local backup directory and a
 * downloaded cloud archive describe the same thing here.
 */
export interface RestorePreviewView {
  formattedDate: string;
  totalBytes: number;
  fileCount: number;
  files: Array<{ path: string; size: number }>;
  savePath: string;
  /** Only local previews know this; a cloud preview leaves it undefined. */
  sameContent?: boolean;
  /** True when the local backup failed its checksum verification. */
  damaged?: boolean;
}

let pending: ((answer: boolean) => void) | null = null;
let layer: HTMLElement | null = null;

/** Small files must not read "0 MB" in the preview list. */
function fmtPreviewSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return fmtBytes(bytes);
}

function closeLayer(): void {
  layer?.remove();
  layer = null;
}

/** Opens the preview; true restores, false cancels the pending token. */
export function askRestorePreview(preview: RestorePreviewView): Promise<boolean> {
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(false);
  }
  closeLayer();

  const shown = preview.files.slice(0, 100);
  const hidden = Math.max(0, preview.fileCount - shown.length);
  const rows = shown
    .map(
      (file) => `<li><span class="restore-preview-path" title="${esc(file.path)}">${esc(file.path)}</span><span class="restore-preview-size tabular-nums">${fmtPreviewSize(file.size)}</span></li>`,
    )
    .join("");
  const el = document.createElement("div");
  el.className = "confirm-layer";
  el.innerHTML = `
    <div class="modal-backdrop" data-act="restore-preview-cancel">
      <div class="modal restore-preview-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <h3 class="modal-title">${esc(t("cloud.previewTitle"))}</h3>
          <button type="button" class="manage-head-close" data-act="restore-preview-cancel" title="${esc(t("common.cancel"))}">${icon("x", 16)}</button>
        </div>
        <p class="confirm-body">${esc(
          t("cloud.previewSummary", {
            date: preview.formattedDate || "—",
            size: fmtPreviewSize(preview.totalBytes),
            count: String(preview.fileCount),
          }),
        )}</p>
        <div class="restore-preview-target">${icon("folder", 13)}<span>${esc(preview.savePath || t("cloud.previewTargetUnknown"))}</span></div>
        <div class="restore-preview-files-head">${esc(t("cloud.previewFiles"))}<span class="count tabular-nums">${preview.fileCount}</span></div>
        <ul class="restore-preview-files">${rows || `<li><span>${esc(t("cloud.previewEmpty"))}</span></li>`}</ul>
        ${hidden > 0 ? `<div class="restore-preview-more">${esc(t("cloud.previewMore", { n: String(hidden) }))}</div>` : ""}
        ${preview.damaged ? `<p class="restore-preview-damaged">${icon("alert-triangle", 12)}<span>${esc(t("backup.damaged"))}</span></p>` : ""}
        ${preview.sameContent && !preview.damaged ? `<p class="restore-preview-same">${icon("check-circle", 12)}<span>${esc(t("backup.previewSame"))}</span></p>` : ""}
        <p class="restore-preview-note">${icon("info", 12)}<span>${esc(t("cloud.previewNote"))}</span></p>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="restore-preview-cancel">${esc(t("common.cancel"))}</button>
          <button type="button" class="btn primary" data-act="restore-preview-confirm"${preview.sameContent || preview.damaged ? " disabled" : ""}>${icon("download", 13)} ${esc(t("cloud.previewRestore"))}</button>
        </div>
      </div>
    </div>`;
  confirmRoot.appendChild(el);
  layer = el;
  el.querySelector<HTMLButtonElement>('[data-act="restore-preview-cancel"]')?.focus();
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** Answers the open preview; the click router lands here. */
export function answerRestorePreview(restore: boolean): void {
  const resolve = pending;
  pending = null;
  closeLayer();
  resolve?.(restore);
}

/** Cancels the preview; true when there was one (Escape handling). */
export function cancelRestorePreview(): boolean {
  if (!pending) return false;
  answerRestorePreview(false);
  return true;
}
