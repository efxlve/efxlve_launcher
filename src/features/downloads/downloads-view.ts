/**
 * Downloads page renderer and live speed chart.
 *
 * Renders the PS5 downloads hub (active hero, stat tiles, settings panel and
 * queue) and paints the canvas speed graph. It reads shared state (S) and
 * never re-renders the whole page from progress events.
 */

import { icon } from "../../core/icons";
import { epicWideArt } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
export function pushSpeedData(netBytes: number, diskBytes: number): void {
  S.speedHistory.shift();
  S.speedHistory.push(netBytes);
  S.diskHistory.shift();
  S.diskHistory.push(diskBytes);
  if (netBytes > S.peakNetSpeedBytes) {
    S.peakNetSpeedBytes = netBytes;
  }
}

export function drawSpeedCanvas(): void {
  const canvas = document.getElementById("dl-speed-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || 600;
  const height = rect.height || canvas.clientHeight || 140;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  // Background subtle gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, "#0e1014");
  bgGrad.addColorStop(1, "#090a0d");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

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

  const drawSeries = (
    data: number[],
    strokeColor: string,
    glowColor: string,
    gradStart: string,
  ) => {
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

    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const areaGrad = ctx.createLinearGradient(0, 0, 0, height);
    areaGrad.addColorStop(0, gradStart);
    areaGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = areaGrad;
    ctx.fill();
  };

  // Disk speed (green)
  drawSeries(S.diskHistory, "#00d26a", "rgba(0, 210, 106, 0.4)", "rgba(0, 210, 106, 0.12)");

  // Network speed (cyan)
  drawSeries(S.speedHistory, "#00e5ff", "rgba(0, 229, 255, 0.5)", "rgba(0, 229, 255, 0.18)");
}

export function startSpeedChartTimer(): void {
  if (S.speedChartTimer !== null) return;
  S.speedChartTimer = window.setInterval(() => {
    if (S.activeDlMetrics && !S.activeDlMetrics.done && !S.dlQueueStatus.isPaused) {
      pushSpeedData(S.activeDlMetrics.speedBytes || 0, S.activeDlMetrics.diskBytes || 0);
      if (S.view === "downloads") drawSpeedCanvas();
    } else if (S.speedHistory.some((v) => v > 0) || S.diskHistory.some((v) => v > 0)) {
      pushSpeedData(0, 0);
      if (S.view === "downloads") drawSpeedCanvas();
    }
  }, 1000);
}

export function renderDownloads(): string {
  let activeDl = S.activeDlMetrics && !S.activeDlMetrics.done ? S.activeDlMetrics : null;
  if (!activeDl) {
    const activeFromMap = [...S.downloads.entries()].find(([_, d]) => !d.done);
    if (activeFromMap) {
      activeDl = {
        id: activeFromMap[0],
        title: activeFromMap[1].title,
        progress: activeFromMap[1].progress,
        done: false,
        speed: "—",
        speedBytes: 0,
        diskSpeed: "—",
        diskBytes: 0,
        eta: "Hesaplanıyor…",
        downloadedBytes: 0,
        totalBytes: 0,
      };
    }
  }

  const activeSummary = activeDl ? S.epicSummaries.find((s) => s.appName === activeDl?.id) : null;
  const activeCover = activeSummary?.cover || "";
  const activeWide = activeSummary ? (epicWideArt(activeSummary) || activeCover) : "";
  const activeTitle = activeSummary?.title || activeDl?.title || activeDl?.id || "";

  const completedEntries = [...S.downloads.entries()].filter(([_, d]) => d.done);
  const queueApps = S.dlQueueStatus.queue.filter((appId) => !activeDl || appId !== activeDl.id);

  // Active Hero markup
  let heroMarkup = "";
  if (activeDl) {
    const isPaused = S.dlQueueStatus.isPaused;
    const pct = Math.round(activeDl.progress);
    heroMarkup = `
      <div class="dl-active-hero">
        ${activeWide ? `<img class="dl-hero-bg" src="${esc(activeWide)}" alt="" />` : ""}
        <div class="dl-hero-content">
          <div class="dl-hero-top">
            <div class="dl-hero-game-info">
              ${activeCover ? `<img class="dl-hero-thumb" src="${esc(activeCover)}" alt="${esc(activeTitle)}" />` : `<div class="dl-hero-thumb"></div>`}
              <div class="dl-hero-details">
                <div class="dl-hero-title">${esc(activeTitle)}</div>
                <div class="dl-hero-badges">
                  ${
                    isPaused
                      ? `<span class="dl-status-tag paused">${icon("pause", 11)} ${t("dl.statusPaused")}</span>`
                      : `<span class="dl-status-tag active">${icon("zap", 11)} ${t("dl.statusActive")}</span>`
                  }
                </div>
              </div>
            </div>
            <div class="dl-hero-actions">
              ${
                isPaused
                  ? `<button class="btn primary small" data-act="dl-resume" data-id="${activeDl.id}">
                      ${icon("play", 13)} ${t("downloads.resume")}
                    </button>`
                  : `<button class="btn ghost small" data-act="dl-pause" data-id="${activeDl.id}">
                      ${icon("pause", 13)} ${t("downloads.pause")}
                    </button>`
              }
              <button class="btn ghost small" data-act="manage-game" data-id="${activeDl.id}">
                ${icon("settings", 13)} ${t("common.manage")}
              </button>
              <button class="btn danger small" data-act="epic-cancel" data-id="${activeDl.id}">
                ${t("common.cancel")}
              </button>
            </div>
          </div>

          <!-- İlerleme Çubuğu -->
          <div class="dl-hero-progress-section">
            <div class="dl-progress-meta-row">
              <span class="dl-progress-pct" id="dl-hero-pct">%${pct}</span>
              <span id="dl-stat-bytes">${fmtBytes(activeDl.downloadedBytes)} / ${fmtBytes(activeDl.totalBytes)}</span>
            </div>
            <div class="dl-hero-track">
              <div class="dl-hero-fill" id="dl-hero-fill" style="width:${pct}%"></div>
            </div>
          </div>

          <!-- Canlı Metrik Kutuları -->
          <div class="dl-stat-tiles-grid">
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box speed">${icon("download", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">${t("dl.speed")}</div>
                <div class="dl-stat-value highlight-cyan" id="dl-stat-speed">${activeDl.speed || "0 B/s"}</div>
                <div class="dl-stat-sub">${t("dl.speedSub")}</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box disk">${icon("hard-drive", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">${t("dl.disk")}</div>
                <div class="dl-stat-value highlight-green" id="dl-stat-disk">${activeDl.diskSpeed || "0 B/s"}</div>
                <div class="dl-stat-sub">${t("dl.diskSub")}</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box eta">${icon("clock", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">${t("dl.eta")}</div>
                <div class="dl-stat-value" id="dl-stat-eta">${activeDl.eta || t("dl.calculating")}</div>
                <div class="dl-stat-sub">${t("dl.etaSub")}</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box size">${icon("layers", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">${t("dl.totalSize")}</div>
                <div class="dl-stat-value">${fmtBytes(activeDl.totalBytes)}</div>
                <div class="dl-stat-sub">${t("dl.sizeSub")}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (queueApps.length === 0 && completedEntries.length === 0) {
    heroMarkup = `
      <div class="dl-active-hero" style="text-align:center;padding:48px 24px;align-items:center;">
        <div style="color:var(--muted);margin-bottom:12px;">${icon("download", 38)}</div>
        <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:6px;">${t("downloads.emptyTitle")}</div>
        <div class="muted" style="margin-bottom:20px;max-width:420px;font-size:13px;line-height:1.5;">
          ${t("downloads.emptyDesc")}
        </div>
        <div>
          <button class="btn primary" data-act="goto-library">${t("downloads.goLibrary")}</button>
        </div>
      </div>
    `;
  }

  // Steam-style Speed Chart
  const netLegendVal = activeDl?.speed || (S.speedHistory[S.speedHistory.length - 1] > 0 ? `${fmtBytes(S.speedHistory[S.speedHistory.length - 1])}/s` : "0 B/s");
  const diskLegendVal = activeDl?.diskSpeed || (S.diskHistory[S.diskHistory.length - 1] > 0 ? `${fmtBytes(S.diskHistory[S.diskHistory.length - 1])}/s` : "0 B/s");

  const chartMarkup = `
    <div class="dl-chart-card">
      <div class="dl-chart-head">
        <div class="dl-chart-title">
          ${icon("zap", 16)} ${t("dl.chartTitle")}
        </div>
        <div class="dl-chart-legend">
          <div class="dl-legend-item">
            <span class="dl-legend-dot net"></span>
            <span>${t("dl.legendNet")}: <strong id="dl-legend-net-val" style="color:#00e5ff">${esc(netLegendVal)}</strong></span>
          </div>
          <div class="dl-legend-item">
            <span class="dl-legend-dot disk"></span>
            <span>${t("dl.legendDisk")}: <strong id="dl-legend-disk-val" style="color:#00d26a">${esc(diskLegendVal)}</strong></span>
          </div>
        </div>
      </div>
      <div class="dl-canvas-container">
        <canvas id="dl-speed-canvas"></canvas>
      </div>
    </div>
  `;

  // Queue Markup
  let queueItemsMarkup = "";
  if (queueApps.length > 0) {
    queueItemsMarkup = queueApps.map((appId, idx) => {
      const s = S.epicSummaries.find((x) => x.appName === appId);
      const title = s?.title || appId;
      const cover = s?.cover || "";
      const sizeStr = s?.installSize ? `${t("dl.sizeLabel")}: ${fmtBytes(s.installSize)}` : t("dl.queued");
      const isFirst = idx === 0;
      const isLast = idx === queueApps.length - 1;
      return `
        <div class="dl-queue-row">
          <div class="dl-queue-left">
            <div class="dl-queue-order-badge">#${idx + 1}</div>
            ${cover ? `<img class="dl-queue-thumb" src="${esc(cover)}" alt="${esc(title)}" />` : `<div class="dl-queue-thumb"></div>`}
            <div class="dl-queue-info">
              <div class="dl-queue-name">${esc(title)}</div>
              <div class="dl-queue-meta">${esc(sizeStr)}</div>
            </div>
          </div>
          <div class="dl-queue-right">
            <button class="dl-reorder-btn" data-act="dl-reorder-up" data-id="${appId}" title="${t("dl.moveUp")}" ${isFirst ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-up", 14)}
            </button>
            <button class="dl-reorder-btn" data-act="dl-reorder-down" data-id="${appId}" title="${t("dl.moveDown")}" ${isLast ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-down", 14)}
            </button>
            <button class="btn primary small" data-act="dl-reorder-now" data-id="${appId}" title="${t("dl.downloadNow")}">
              ${icon("play", 11)} ${t("dl.downloadNow")}
            </button>
            <button class="dl-reorder-btn" data-act="dl-reorder-remove" data-id="${appId}" title="${t("dl.removeFromQueue")}">
              ${icon("x", 14)}
            </button>
          </div>
        </div>
      `;
    }).join("");
  } else {
    queueItemsMarkup = `<div class="muted" style="padding: 16px; background: #14161a; border-radius: 12px; border: 1px solid rgba(255,255,255,0.04); text-align: center; font-size: 13px;">${t("downloads.queueEmpty")}</div>`;
  }

  const queueSection = `
    <div class="dl-section-title">
      <span>${t("dl.queueTitle")} (${queueApps.length})</span>
    </div>
    <div class="dl-queue-container">
      ${queueItemsMarkup}
    </div>
  `;

  // Completed items
  let completedSection = "";
  if (completedEntries.length > 0) {
    const items = completedEntries.map(([appId, d]) => {
      const s = S.epicSummaries.find((x) => x.appName === appId);
      const cover = s?.cover || "";
      return `
        <div class="dl-queue-row" style="border-left: 3px solid #00d26a;">
          <div class="dl-queue-left">
            <div class="dl-queue-order-badge" style="color:#00d26a">${icon("check", 12)}</div>
            ${cover ? `<img class="dl-queue-thumb" src="${esc(cover)}" alt="${esc(d.title)}" />` : `<div class="dl-queue-thumb"></div>`}
            <div class="dl-queue-info">
              <div class="dl-queue-name">${esc(d.title)}</div>
              <div class="dl-queue-meta" style="color:#00d26a">${t("dl.completedReady")}</div>
            </div>
          </div>
          <div class="dl-queue-right">
            <button class="btn primary small" data-act="play" data-id="${appId}">
              ${icon("play", 12)} ${t("common.play")}
            </button>
            <button class="btn ghost small" data-act="manage-game" data-id="${appId}">
              ${icon("settings", 12)} ${t("common.manage")}
            </button>
          </div>
        </div>
      `;
    }).join("");

    completedSection = `
      <div class="dl-section-title" style="margin-top: 24px;">
        <span>${t("dl.recentCompleted")} (${completedEntries.length})</span>
      </div>
      <div class="dl-queue-container">
        ${items}
      </div>
    `;
  }

  const settingsPanel = `
    <div class="dl-settings-panel">
      <div class="dl-settings-head">
        <div class="dl-settings-title">${icon("settings", 16)} ${t("downloads.settingsTitle")}</div>
        <span class="dl-settings-hint">${t("downloads.settingsHint")}</span>
      </div>
      <div class="dl-settings-grid">
        <div class="dl-settings-field">
          <div class="dl-settings-label">${t("downloads.netProfile")}</div>
          <div class="net-profile-pills">
            <button class="net-profile-btn ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">
              ${icon("zap", 13)} ${t("downloads.profileMax")}
            </button>
            <button class="net-profile-btn ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">
              ${icon("shield-check", 13)} ${t("downloads.profileBalanced")}
            </button>
            <button class="net-profile-btn ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">
              ${icon("clock", 13)} ${t("downloads.profileLow")}
            </button>
          </div>
        </div>
        <div class="dl-settings-field">
          <div class="dl-settings-label">${t("downloads.installDir")}</div>
          <div class="dl-settings-dir-row">
            <input id="dl-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
            <button class="ps5-btn-icon" data-act="dl-pick-install-dir" title="${t("downloads.pickFolder")}">${icon("folder", 15)}</button>
            <button class="ps5-btn primary" data-act="dl-save-install-dir">${t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const headerAction = activeDl
    ? S.dlQueueStatus.isPaused
      ? `<button class="ps5-btn primary" data-act="dl-resume" data-id="${activeDl.id}">${icon("play", 14)} ${t("downloads.resume")}</button>`
      : `<button class="ps5-btn secondary" data-act="dl-pause" data-id="${activeDl.id}">${icon("pause", 14)} ${t("downloads.pause")}</button>`
    : "";

  return `
    <div class="ps5-page ps5-downloads-page">
      <header class="ps5-page-header">
        <div class="ps5-header-main">
          <div class="ps5-header-kicker">${icon("download", 14)} <span>${t("downloads.kicker")}</span></div>
          <h1 class="ps5-header-title">${t("downloads.title")}</h1>
          <p class="ps5-header-subtitle">${t("downloads.subtitle")}</p>
        </div>
        <div class="ps5-header-actions">${headerAction}</div>
      </header>
      <main class="ps5-page-body">
        <div class="dl-hub">
          ${heroMarkup}
          ${chartMarkup}
          ${settingsPanel}
          ${queueSection}
          ${completedSection}
        </div>
      </main>
    </div>
  `;
}
