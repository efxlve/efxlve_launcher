/**
 * Stage downloads: enough to see a transfer, pause it or cancel it without
 * leaving the couch. The full queue manager stays in desktop mode.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { t } from "../../i18n";
import { stageGameByKey } from "./stage-model";
import { stageProgress } from "./stage-ui";

function downloadRow(id: string, title: string, progress: number): string {
  const metrics = S.activeDlMetrics && S.activeDlMetrics.id === id ? S.activeDlMetrics : null;
  const amazon = id.startsWith("amazon::");
  const paused = !amazon && (id.startsWith("gog::") ? S.gogDlPaused : S.dlQueueStatus.isPaused);
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  const speed = metrics?.speed || (metrics ? fmtSpeed(metrics.speedBytes) : "");
  const eta = metrics?.eta || "";
  const size = metrics && metrics.totalBytes > 0
    ? `${fmtBytes(metrics.downloadedBytes)} / ${fmtBytes(metrics.totalBytes)}`
    : "";
  return `<div class="stage-download-row">
    <span class="stage-download-icon">${icon("download", 22)}</span>
    <div class="stage-download-main">
      <div class="stage-download-head">
        <strong>${esc(title)}</strong>
        <span class="stage-download-pct tabular-nums">${percent}%</span>
      </div>
      ${stageProgress(percent, paused ? "stage-progress-paused" : "")}
      <div class="stage-download-meta">
        <span>${esc(paused ? t("dl.statusPaused") : t("dl.statusActive"))}</span>
        ${speed ? `<span>${esc(speed)}</span>` : ""}
        ${eta ? `<span>${esc(eta)}</span>` : ""}
        ${size ? `<span class="tabular-nums">${esc(size)}</span>` : ""}
      </div>
    </div>
    <div class="stage-download-actions">
      ${amazon ? "" : paused
        ? `<button type="button" class="stage-btn stage-btn-ghost" data-act="dl-resume" data-id="${esc(id)}">${icon("play", 16)}<span>${esc(t("downloads.resume"))}</span></button>`
        : `<button type="button" class="stage-btn stage-btn-ghost" data-act="dl-pause" data-id="${esc(id)}">${icon("pause", 16)}<span>${esc(t("downloads.pause"))}</span></button>`}
      ${amazon ? "" : `<button type="button" class="stage-icon-btn stage-icon-danger" data-act="epic-cancel" data-id="${esc(id)}" aria-label="${esc(t("common.cancel"))}" title="${esc(t("common.cancel"))}">${icon("x", 18)}</button>`}
    </div>
  </div>`;
}

function queueRow(id: string, index: number, total: number): string {
  const summary = stageGameByKey(id);
  return `<div class="stage-queue-row">
    <span class="stage-queue-index tabular-nums">${index + 1}</span>
    <span class="stage-queue-copy">
      <strong>${esc(summary?.title || id)}</strong>
      <small>${esc(t("stage.queueWaiting"))}</small>
    </span>
    <span class="stage-queue-actions">
      <button type="button" class="stage-icon-btn" data-act="dl-reorder-up" data-id="${esc(id)}" ${index === 0 ? "disabled" : ""} aria-label="${esc(t("dl.moveUp"))}" title="${esc(t("dl.moveUp"))}">${icon("chevron-up", 16)}</button>
      <button type="button" class="stage-icon-btn" data-act="dl-reorder-down" data-id="${esc(id)}" ${index === total - 1 ? "disabled" : ""} aria-label="${esc(t("dl.moveDown"))}" title="${esc(t("dl.moveDown"))}">${icon("chevron-down", 16)}</button>
      <button type="button" class="stage-btn stage-btn-ghost" data-act="dl-reorder-now" data-id="${esc(id)}">${icon("play", 14)}<span>${esc(t("dl.downloadNow"))}</span></button>
      <button type="button" class="stage-icon-btn stage-icon-danger" data-act="dl-reorder-remove" data-id="${esc(id)}" aria-label="${esc(t("dl.removeFromQueue"))}" title="${esc(t("dl.removeFromQueue"))}">${icon("x", 16)}</button>
    </span>
  </div>`;
}

export function renderStageDownloads(): string {
  const rows: string[] = [];
  const queue = S.dlQueueStatus.queue.filter((id) => id !== S.dlQueueStatus.active);
  const queueSet = new Set(queue);
  for (const [id, item] of S.downloads) {
    if (item.done || queueSet.has(id)) continue;
    rows.push(downloadRow(id, item.title || id, item.progress));
  }
  if (rows.length === 0 && S.activeDlMetrics && !S.activeDlMetrics.done) {
    rows.push(downloadRow(S.activeDlMetrics.id, S.activeDlMetrics.title, S.activeDlMetrics.progress));
  }
  const queueHtml = queue.length > 0
    ? `<section class="stage-queue-section">
        <div class="stage-extra-section-head"><span class="stage-kicker">${esc(t("stage.queue"))}</span><span class="stage-extra-count tabular-nums">${queue.length}</span></div>
        <div class="stage-queue-list">${queue.map((id, index) => queueRow(id, index, queue.length)).join("")}</div>
      </section>`
    : "";
  return `<div class="stage-downloads">
    <header class="stage-downloads-head">
      <div>
        <h1>${esc(t("stage.navDownloads"))}</h1>
        <span>${esc(t("stage.downloadsHint"))}</span>
      </div>
      <button type="button" class="stage-tool" data-stage-act="desktop" data-gp-item data-gp-key="dl:desktop">${icon("external", 16)}<span>${esc(t("stage.openDesktop"))}</span></button>
    </header>
    ${rows.length > 0
      ? `<div class="stage-download-list">${rows.join("")}</div>`
      : `<div class="stage-empty">
          <span class="stage-empty-icon">${icon("download", 42)}</span>
          <h2>${esc(t("stage.downloadsEmpty"))}</h2>
          <p>${esc(t("stage.downloadsEmptyHint"))}</p>
          <button type="button" class="stage-btn stage-btn-primary" data-stage-act="go" data-route="library" data-gp-item data-gp-key="dl:library">${esc(t("stage.navLibrary"))}</button>
        </div>`}
    ${queueHtml}
  </div>`;
}
