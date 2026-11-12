/**
 * Stage downloads: enough to see a transfer, pause it or cancel it without
 * leaving the couch. The full queue manager stays in desktop mode.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { t } from "../../i18n";
import { stageBaseSummaries, stageGameByKey, stageHasUpdate } from "./stage-model";
import { stageCoverMarkup } from "./stage-art";
import { stageProgress, stageStoreName } from "./stage-ui";
import { sourceOfKey } from "../../core/selectors";

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
  return `<div class="stage-download-row" data-stage-dl-row="${esc(id)}">
    <span class="stage-download-icon">${icon("download", 22)}</span>
    <div class="stage-download-main">
      <div class="stage-download-head">
        <strong>${esc(title)}</strong>
        <span class="stage-download-pct tabular-nums" data-stage-dl-pct="${esc(id)}">${percent}%</span>
      </div>
      ${stageProgress(percent, paused ? "stage-progress-paused" : "", `data-stage-dl-bar="${esc(id)}"`)}
      <div class="stage-download-meta">
        <span>${esc(paused ? t("dl.statusPaused") : t("dl.statusActive"))}</span>
        ${speed ? `<span data-stage-dl-speed="${esc(id)}">${esc(speed)}</span>` : ""}
        ${eta ? `<span data-stage-dl-eta="${esc(id)}">${esc(eta)}</span>` : ""}
        ${size ? `<span class="tabular-nums" data-stage-dl-size="${esc(id)}">${esc(size)}</span>` : ""}
      </div>
    </div>
    <div class="stage-download-actions">
      ${amazon ? "" : paused
        ? `<button type="button" class="stage-btn stage-btn-ghost" data-act="dl-resume" data-id="${esc(id)}">${icon("play", 16)}<span>${esc(t("downloads.resume"))}</span></button>`
        : `<button type="button" class="stage-btn stage-btn-ghost" data-act="dl-pause" data-id="${esc(id)}">${icon("pause", 16)}<span>${esc(t("downloads.pause"))}</span></button>`}
      ${amazon ? "" : `<button type="button" class="stage-icon-btn stage-icon-danger" data-act="epic-cancel" data-id="${esc(id)}" aria-label="${esc(t("common.cancel"))}">${icon("x", 18)}</button>`}
    </div>
  </div>`;
}

function updateRow(s: ReturnType<typeof stageBaseSummaries>[number]): string {
  const store = stageStoreName(sourceOfKey(s.appName));
  const updateAct = s.appName.startsWith("amazon::")
    ? `data-act="amazon-install" data-id="${esc(s.appName.slice(8))}"`
    : s.appName.startsWith("steam::")
      ? `data-act="steam-action" data-id="${esc(s.appName.slice(7))}" data-mode="update"`
      : `data-act="epic-install" data-id="${esc(s.appName)}"`;
  return `<div class="stage-download-row stage-update-available-row" data-key="${esc(s.appName)}">
    <span class="stage-list-cover">${stageCoverMarkup(s, "stage-cover-art")}</span>
    <div class="stage-download-main">
      <div class="stage-download-head">
        <strong>${esc(s.title)}</strong>
        <span class="stage-chip is-warn">${esc(t("common.update"))}</span>
      </div>
      <div class="stage-download-meta">
        <span>${esc(store)}</span>
        ${s.installSize > 0 ? `<span class="tabular-nums">${esc(fmtBytes(s.installSize))}</span>` : ""}
      </div>
    </div>
    <div class="stage-download-actions">
      <button type="button" class="stage-btn stage-btn-primary" ${updateAct} data-gp-item data-gp-key="dl:update:run:${esc(s.appName)}" title="${esc(t("common.updateDownload"))}">
        ${icon("download", 16)}<span>${esc(t("common.update"))}</span>
      </button>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="dl:update:details:${esc(s.appName)}">
        <span>${esc(t("stage.details"))}</span>
      </button>
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
      <button type="button" class="stage-icon-btn" data-act="dl-reorder-up" data-id="${esc(id)}" ${index === 0 ? "disabled" : ""} aria-label="${esc(t("dl.moveUp"))}">${icon("chevron-up", 16)}</button>
      <button type="button" class="stage-icon-btn" data-act="dl-reorder-down" data-id="${esc(id)}" ${index === total - 1 ? "disabled" : ""} aria-label="${esc(t("dl.moveDown"))}">${icon("chevron-down", 16)}</button>
      <button type="button" class="stage-btn stage-btn-ghost" data-act="dl-reorder-now" data-id="${esc(id)}">${icon("play", 14)}<span>${esc(t("dl.downloadNow"))}</span></button>
      <button type="button" class="stage-icon-btn stage-icon-danger" data-act="dl-reorder-remove" data-id="${esc(id)}" aria-label="${esc(t("dl.removeFromQueue"))}">${icon("x", 16)}</button>
    </span>
  </div>`;
}

/** Progress-only repaint for the active transfer, without rebuilding the page. */
export function patchStageDownloads(): void {
  for (const [id, item] of S.downloads) {
    if (item.done) continue;
    const selector = CSS.escape(id);
    const percent = Math.max(0, Math.min(100, Math.round(item.progress)));
    const pct = document.querySelector<HTMLElement>(`[data-stage-dl-pct="${selector}"]`);
    if (pct) pct.textContent = `${percent}%`;
    const bar = document.querySelector<HTMLElement>(`[data-stage-dl-bar="${selector}"]`);
    if (bar) {
      bar.setAttribute("aria-valuenow", String(percent));
      const fill = bar.querySelector<HTMLElement>("span");
      if (fill) fill.style.width = `${percent}%`;
    }
    const metrics = S.activeDlMetrics && S.activeDlMetrics.id === id ? S.activeDlMetrics : null;
    if (!metrics) continue;
    const speed = metrics.speed || (metrics.speedBytes > 0 ? fmtSpeed(metrics.speedBytes) : "");
    const setText = (name: string, value: string): void => {
      const el = document.querySelector<HTMLElement>(`[data-stage-dl-${name}="${selector}"]`);
      if (el && value) el.textContent = value;
    };
    setText("speed", speed);
    setText("eta", metrics.eta || "");
    setText(
      "size",
      metrics.totalBytes > 0
        ? `${fmtBytes(metrics.downloadedBytes)} / ${fmtBytes(metrics.totalBytes)}`
        : "",
    );
  }
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

  // A title that is already transferring, queued or ignored is not offered
  // again below its own progress row.
  const busy = new Set<string>(queue);
  if (S.dlQueueStatus.active) busy.add(S.dlQueueStatus.active);
  if (S.activeDlMetrics) busy.add(S.activeDlMetrics.id);
  for (const [id, item] of S.downloads) if (!item.done) busy.add(id);
  const updates = stageBaseSummaries().filter(
    (s) => stageHasUpdate(s) && !S.ignoredUpdates.has(s.appName) && !busy.has(s.appName),
  );
  const updatesHtml = updates.length > 0
    ? `<section class="stage-updates-section">
        <div class="stage-extra-section-head"><span class="stage-kicker">${esc(t("stage.filterUpdates"))}</span><span class="stage-extra-count tabular-nums">${updates.length}</span></div>
        <div class="stage-download-list">${updates.map(updateRow).join("")}</div>
      </section>`
    : "";

  const queueHtml = queue.length > 0
    ? `<section class="stage-queue-section">
        <div class="stage-extra-section-head"><span class="stage-kicker">${esc(t("stage.queue"))}</span><span class="stage-extra-count tabular-nums">${queue.length}</span></div>
        <div class="stage-queue-list">${queue.map((id, index) => queueRow(id, index, queue.length)).join("")}</div>
      </section>`
    : "";
  const idle = rows.length === 0 && queue.length === 0;
  const idleStats = idle
    ? `<div class="stage-stat-row">
        <span class="stage-stat"><i aria-hidden="true"></i>${esc(t("downloads.emptyTitle"))}</span>
        <span class="stage-stat"><i aria-hidden="true"></i>${esc(t("stage.queue"))} <b class="tabular-nums">0</b></span>
      </div>`
    : "";
  const empty = rows.length === 0 && updates.length === 0 && queue.length === 0
    ? `<div class="stage-downloads-empty">
        <div class="stage-empty">
          <span class="stage-empty-icon">${icon("download", 42)}</span>
          <h2>${esc(t("stage.downloadsEmpty"))}</h2>
          <p>${esc(t("stage.downloadsEmptyHint"))}</p>
          <button type="button" class="stage-btn stage-btn-primary" data-stage-act="go" data-route="library" data-gp-item data-gp-key="dl:library">${esc(t("stage.navLibrary"))}</button>
        </div>
      </div>`
    : "";
  return `<div class="stage-downloads">
    <header class="stage-downloads-head">
      <div>
        <h1>${esc(t("stage.navDownloads"))}</h1>
        <span>${esc(t("stage.downloadsHint"))}</span>
        ${idleStats}
      </div>
    </header>
    ${rows.length > 0 ? `<div class="stage-download-list">${rows.join("")}</div>` : ""}
    ${updatesHtml}
    ${queueHtml}
    ${empty}
  </div>`;
}
