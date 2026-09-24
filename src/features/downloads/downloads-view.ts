/**
 * Downloads page renderer and live speed chart.
 *
 * Renders the active download card (with the speed chart), the queue, pending
 * updates and recent installs as plain list rows. It reads shared state (S)
 * and never re-renders the whole page from progress events; live values are
 * patched by id from the IPC listener.
 */

import { emptyState, icon } from "../../core/icons";
import { epicWideArt, rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { DlMetrics } from "../../core/types";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { epicPortrait, type EpicSummary } from "../../epic";
export function pushSpeedData(netBytes: number, diskBytes: number): void {
  S.speedHistory.shift();
  S.speedHistory.push(netBytes);
  S.diskHistory.shift();
  S.diskHistory.push(diskBytes);
  if (netBytes > S.peakNetSpeedBytes) {
    S.peakNetSpeedBytes = netBytes;
  }
}

/** Coalesces chart redraws to at most one per animation frame. */
let speedCanvasRaf = 0;
export function scheduleDrawSpeedCanvas(): void {
  if (speedCanvasRaf) return;
  speedCanvasRaf = requestAnimationFrame(() => {
    speedCanvasRaf = 0;
    drawSpeedCanvas();
  });
}

export function drawSpeedCanvas(): void {
  const canvas = document.getElementById("dl-speed-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || 600;
  const height = rect.height || canvas.clientHeight || 120;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  // Determine scale (max speed in bytes)
  const maxData = Math.max(...S.speedHistory, ...S.diskHistory, 1024 * 1024);
  const scaleMax = Math.max(maxData * 1.15, 1024 * 1024);

  // Draw horizontal grid lines (4 lines: 25%, 50%, 75%, 100%)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i <= 3; i++) {
    const y = height - height * (i * 0.25);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    const speedVal = scaleMax * (i * 0.25);
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.setLineDash([]);
    ctx.fillText(`${fmtBytes(speedVal)}/s`, 8, y - 4);
    ctx.setLineDash([4, 4]);
  }
  ctx.setLineDash([]);

  const len = S.speedHistory.length;
  const step = width / (len - 1);

  const drawSeries = (data: number[], strokeColor: string, fillColor: string) => {
    if (data.length < 2) return;

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < len; i++) {
      const val = data[i] ?? 0;
      const x = i * step;
      const y = height - (val / scaleMax) * (height - 12) - 6;
      points.push({ x, y: Math.max(6, Math.min(height - 6, y)) });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const mx = (p0.x + p1.x) / 2;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, (p0.y + p1.y) / 2);
    }
    const lastP = points[points.length - 1];
    ctx.lineTo(lastP.x, lastP.y);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  };

  // Colors mirror --ok (disk) and --accent (network) in tokens.css.
  drawSeries(S.diskHistory, "#2fb36d", "rgba(47, 179, 109, 0.08)");
  drawSeries(S.speedHistory, "#f2f2f2", "rgba(255, 255, 255, 0.08)");
}

/** Stops the speed chart sampler (called when it is no longer needed). */
export function stopSpeedChartTimer(): void {
  if (S.speedChartTimer !== null) {
    window.clearInterval(S.speedChartTimer);
    S.speedChartTimer = null;
  }
}

/**
 * Samples download speed once per second while it is useful (active download, or
 * the downloads page showing history) and then stops itself entirely so the
 * launcher has zero idle background load.
 */
export function startSpeedChartTimer(): void {
  if (S.speedChartTimer !== null) return;
  S.speedChartTimer = window.setInterval(() => {
    const active = !!S.activeDlMetrics && !S.activeDlMetrics.done && !S.dlQueueStatus.isPaused;
    const onDownloads = S.view === "downloads";
    const hasData = S.speedHistory.some((v) => v > 0) || S.diskHistory.some((v) => v > 0);
    if (!active && !(onDownloads && hasData)) {
      stopSpeedChartTimer();
      return;
    }
    pushSpeedData(active ? S.activeDlMetrics!.speedBytes || 0 : 0, active ? S.activeDlMetrics!.diskBytes || 0 : 0);
    if (onDownloads) drawSpeedCanvas();
  }, 1000);
}

function thumbOf(s: EpicSummary | undefined): string {
  if (!s) return `<span class="row-thumb dl-thumb-ph">${icon("gamepad-2", 16)}</span>`;
  const raw = rawOf(s.appName);
  const url = S.customCovers[s.appName] || (raw ? epicPortrait(raw) : null) || s.cover;
  return url
    ? `<img class="row-thumb" src="${esc(url)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="row-thumb dl-thumb-ph">${icon("gamepad-2", 16)}</span>`;
}

function section(title: string, count: number | null, body: string, action = ""): string {
  return `
    <section class="dl-section">
      <div class="dl-section-head"><h2 class="section-title">${title}${count !== null ? ` <span class="count">${count}</span>` : ""}</h2>${action}</div>
      <div class="list">${body}</div>
    </section>`;
}

function gameRow(s: EpicSummary | undefined, id: string, meta: string, actions: string, lead = ""): string {
  const title = esc(s?.title || id);
  return `
    <div class="row">
      ${lead}
      <div class="dl-row-open" data-act="epic-detail" data-id="${esc(id)}" title="${title}">
        ${thumbOf(s)}
        <div class="row-main"><div class="row-title">${title}</div><div class="row-meta">${meta}</div></div>
      </div>
      <div class="row-actions">${actions}</div>
    </div>`;
}

/** The currently downloading item: resolves live metrics, falling back to the progress map. */
function activeDownload(): DlMetrics | null {
  if (S.activeDlMetrics && !S.activeDlMetrics.done) return S.activeDlMetrics;
  for (const [id, d] of S.downloads) {
    if (!d.done) {
      return { id, title: d.title, progress: d.progress, done: false, speed: "—", speedBytes: 0, diskSpeed: "—", diskBytes: 0, eta: t("common.calculating"), downloadedBytes: 0, totalBytes: 0 };
    }
  }
  return null;
}

/** Installed games that are not already listed under Updates. Recent first. */
function installedGames(): EpicSummary[] {
  const recentIdx = new Map<string, number>();
  S.epicRecent.forEach((id, i) => recentIdx.set(id, i));
  const collator = S.trCollator ?? new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  return S.epicSummaries
    .filter((s) => s.installed && !(s.updateAvailable || S.availableUpdates.has(s.appName)))
    .sort((a, b) => {
      const ra = recentIdx.get(a.appName);
      const rb = recentIdx.get(b.appName);
      if (ra !== undefined || rb !== undefined) return (ra ?? 9999) - (rb ?? 9999);
      return collator.compare(a.title, b.title);
    });
}

function renderActiveCard(dl: DlMetrics): string {
  const s = S.epicSummariesMap.get(dl.id);
  const title = esc(s?.title || dl.title || dl.id);
  const art = s ? epicWideArt(s) || s.cover : null;
  const paused = S.dlQueueStatus.isPaused;
  const pct = Math.round(dl.progress);
  const metric = (label: string, id: string, value: string): string =>
    `<div class="dl-metric"><span class="dl-metric-label">${label}</span><span class="dl-metric-value" id="${id}">${value}</span></div>`;
  return `
    <section class="card dl-active">
      <div class="dl-active-art">${art ? `<img src="${esc(art)}" alt="" decoding="async" />` : ""}</div>
      <div class="dl-active-body">
        <div class="dl-active-head">
          <div class="dl-active-text">
            <div class="dl-active-title" title="${title}">${title}</div>
            <span class="chip ${paused ? "warn" : "accent"}">${paused ? t("dl.statusPaused") : t("dl.statusActive")}</span>
          </div>
          <div class="row-actions">
            ${paused
              ? `<button class="btn primary" data-act="dl-resume" data-id="${dl.id}">${icon("play", 13)} ${t("downloads.resume")}</button>`
              : `<button class="btn" data-act="dl-pause" data-id="${dl.id}">${icon("pause", 13)} ${t("downloads.pause")}</button>`}
            <button class="icon-btn" data-act="manage-game" data-id="${dl.id}" title="${t("common.manage")}">${icon("settings", 16)}</button>
            <button class="icon-btn danger" data-act="epic-cancel" data-id="${dl.id}" title="${t("common.cancel")}">${icon("x", 16)}</button>
          </div>
        </div>
        <div class="dl-active-progress">
          <div class="progress${paused ? " warn" : ""}"><span id="dl-hero-fill" style="width:${pct}%"></span></div>
          <span class="dl-progress-pct" id="dl-hero-pct">%${pct}</span>
        </div>
        <div class="dl-metrics-row">
          ${metric(t("dl.speed"), "dl-stat-speed", fmtSpeed(dl.speedBytes, S.speedInBits))}
          ${metric(t("dl.peak"), "dl-stat-peak", fmtSpeed(S.peakNetSpeedBytes, S.speedInBits))}
          ${metric(t("dl.disk"), "dl-stat-disk", fmtSpeed(dl.diskBytes, S.speedInBits))}
          ${metric(t("dl.eta"), "dl-stat-eta", localizeMessage(dl.eta) || t("dl.calculating"))}
          ${metric(t("dl.totalSize"), "dl-stat-bytes", `${fmtBytes(dl.downloadedBytes)} / ${fmtBytes(dl.totalBytes)}`)}
        </div>
        <div class="dl-chart">
          <div class="dl-chart-legend">
            <span class="dl-legend-item"><span class="dl-legend-dot net"></span>${t("dl.legendNet")} <strong id="dl-legend-net-val">${esc(fmtSpeed(dl.speedBytes, S.speedInBits))}</strong></span>
            <span class="dl-legend-item"><span class="dl-legend-dot disk"></span>${t("dl.legendDisk")} <strong id="dl-legend-disk-val">${esc(fmtSpeed(dl.diskBytes, S.speedInBits))}</strong></span>
          </div>
          <canvas id="dl-speed-canvas"></canvas>
        </div>
      </div>
    </section>`;
}

export function renderDownloads(): string {
  const active = activeDownload();
  const queueApps = S.dlQueueStatus.queue.filter((id) => !active || id !== active.id);

  const updates = S.epicSummaries.filter((s) => s.installed && (s.updateAvailable || S.availableUpdates.has(s.appName)));
  const manageBtn = (id: string): string => `<button class="icon-btn" data-act="manage-game" data-id="${id}" title="${t("common.manage")}">${icon("settings", 16)}</button>`;

  const queueRows = queueApps.map((id, idx) => {
    const s = S.epicSummariesMap.get(id);
    return gameRow(s, id, s?.installSize ? fmtBytes(s.installSize) : t("dl.queued"), `
      <button class="icon-btn" data-act="dl-reorder-up" data-id="${id}" title="${t("dl.moveUp")}" ${idx === 0 ? "disabled" : ""}>${icon("chevron-up", 16)}</button>
      <button class="icon-btn" data-act="dl-reorder-down" data-id="${id}" title="${t("dl.moveDown")}" ${idx === queueApps.length - 1 ? "disabled" : ""}>${icon("chevron-down", 16)}</button>
      <button class="btn small" data-act="dl-reorder-now" data-id="${id}">${t("dl.downloadNow")}</button>
      <button class="icon-btn danger" data-act="dl-reorder-remove" data-id="${id}" title="${t("dl.removeFromQueue")}">${icon("x", 16)}</button>`,
      `<span class="dl-order">${idx + 1}</span>`);
  }).join("");

  const updateRows = updates.map((s) => {
    const info = S.availableUpdates.get(s.appName);
    const ver = info?.latestVersion ? `${info.installedVersion ? `${esc(info.installedVersion)} → ` : ""}${esc(info.latestVersion)}` : "";
    const meta = [ver, s.installSize ? fmtBytes(s.installSize) : ""].filter(Boolean).join(" · ");
    return gameRow(s, s.appName, meta || t("drawer.updateAvailable"),
      `<button class="btn update small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} ${t("common.update")}</button>${manageBtn(s.appName)}`);
  }).join("");

  const installed = installedGames();
  const installedBytes = installed.reduce((sum, s) => sum + (s.installSize || 0), 0);
  const installedRows = installed.map((s) => {
    const action = `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("play", 12)} ${t("common.play")}</button>`;
    return gameRow(s, s.appName, fmtBytes(s.installSize || 0), action + manageBtn(s.appName));
  }).join("");

  const idle = !active && queueApps.length === 0 && updates.length === 0 && installed.length === 0
    ? emptyState("download", t("downloads.emptyTitle"), t("downloads.emptyDesc"), `<button class="btn" data-act="goto-library">${t("downloads.goLibrary")}</button>`)
    : "";

  return `
    <div class="page dl-page">
      <div class="page-head dl-head">
        <div class="page-actions">
          <button class="btn ghost" data-act="open-download-settings">${icon("settings", 14)} ${t("downloads.settingsTitle")}</button>
          <button class="btn ghost" data-act="open-storage-manager">${icon("hard-drive", 14)} ${t("storage.open")}</button>
        </div>
      </div>
      ${active ? renderActiveCard(active) : idle}
      ${queueRows ? section(t("dl.queueTitle"), queueApps.length, queueRows) : ""}
      ${updateRows ? section(t("lib.updates"), updates.length, updateRows) : ""}
      ${installedRows ? section(t("downloads.installedTitle"), installed.length, installedRows, `<span class="dl-installed-total">${fmtBytes(installedBytes)}</span>`) : ""}
    </div>`;
}

