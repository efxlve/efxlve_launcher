/**
 * Stage downloads: enough to see a transfer, pause it or cancel it without
 * leaving the couch. The full queue manager stays in desktop mode.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { t } from "../../i18n";
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

export function renderStageDownloads(): string {
  const rows: string[] = [];
  for (const [id, item] of S.downloads) {
    if (item.done) continue;
    rows.push(downloadRow(id, item.title || id, item.progress));
  }
  if (rows.length === 0 && S.activeDlMetrics && !S.activeDlMetrics.done) {
    rows.push(downloadRow(S.activeDlMetrics.id, S.activeDlMetrics.title, S.activeDlMetrics.progress));
  }
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
  </div>`;
}
