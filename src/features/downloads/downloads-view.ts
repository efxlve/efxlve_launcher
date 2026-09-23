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
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { getRecentInstalls } from "../../core/recent";
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
        eta: t("common.calculating"),
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

  // Recently installed & updated games (clean 6-item list, prioritizing latest installs and updates)
  const recentInstalled: EpicSummary[] = [];
  {
    const seen = new Set<string>();
    const trackedInstalls = getRecentInstalls();
    // 1. First prioritize games recorded as recently installed or updated
    for (const id of trackedInstalls) {
      const s = S.epicSummariesMap.get(id);
      if (s?.installed && !seen.has(id)) {
        seen.add(id);
        recentInstalled.push(s);
      }
      if (recentInstalled.length >= 6) break;
    }
    // 2. Then fill remaining slots from recently played games
    if (recentInstalled.length < 6) {
      for (const id of S.epicRecent) {
        const s = S.epicSummariesMap.get(id);
        if (s?.installed && !seen.has(id)) {
          seen.add(id);
          recentInstalled.push(s);
        }
        if (recentInstalled.length >= 6) break;
      }
    }
    // 3. Finally fill from installed library games
    if (recentInstalled.length < 6) {
      for (const s of S.epicSummaries) {
        if (s.installed && !seen.has(s.appName)) {
          seen.add(s.appName);
          recentInstalled.push(s);
          if (recentInstalled.length >= 6) break;
        }
      }
    }
  }

  // Active download card OR Apple minimalist idle state
  let heroMarkup = "";
  if (activeDl) {
    const isPaused = S.dlQueueStatus.isPaused;
    const pct = Math.round(activeDl.progress);
    heroMarkup = `
      <div class="dl-active-card">
        ${activeWide ? `<img class="dl-active-bg" src="${esc(activeWide)}" alt="" />` : ""}
        <div class="dl-active-inner">
          <div class="dl-active-head">
            ${activeCover ? `<img class="dl-active-thumb" src="${esc(activeCover)}" alt="${esc(activeTitle)}" />` : `<div class="dl-active-thumb"></div>`}
            <div class="dl-active-text">
              <div class="dl-active-title" title="${esc(activeTitle)}">${esc(activeTitle)}</div>
              ${
                isPaused
                  ? `<span class="dl-status-tag paused">${icon("pause", 11)} ${t("dl.statusPaused")}</span>`
                  : `<span class="dl-status-tag active">${icon("zap", 11)} ${t("dl.statusActive")}</span>`
              }
            </div>
            <div class="dl-active-actions">
              ${
                isPaused
                  ? `<button class="apple-pill-btn primary" data-act="dl-resume" data-id="${activeDl.id}">${icon("play", 12)} ${t("downloads.resume")}</button>`
                  : `<button class="apple-pill-btn secondary" data-act="dl-pause" data-id="${activeDl.id}">${icon("pause", 12)} ${t("downloads.pause")}</button>`
              }
              <button class="apple-icon-btn" data-act="manage-game" data-id="${activeDl.id}" title="${t("common.manage")}">${icon("settings", 13)}</button>
              <button class="apple-icon-btn danger" data-act="epic-cancel" data-id="${activeDl.id}" title="${t("common.cancel")}">${icon("x", 13)}</button>
            </div>
          </div>
          <div class="dl-active-progress">
            <div class="dl-progress-track"><div class="dl-progress-fill" id="dl-hero-fill" style="width:${pct}%"></div></div>
            <span class="dl-progress-pct" id="dl-hero-pct">%${pct}</span>
          </div>
          <div class="dl-metrics-row">
            <div class="dl-metric"><span class="dl-metric-label">${t("dl.speed")}</span><span class="dl-metric-value accent" id="dl-stat-speed">${fmtSpeed(activeDl.speedBytes, S.speedInBits)}</span></div>
            <div class="dl-metric"><span class="dl-metric-label">${t("dl.peak")}</span><span class="dl-metric-value accent" id="dl-stat-peak">${fmtSpeed(S.peakNetSpeedBytes, S.speedInBits)}</span></div>
            <div class="dl-metric"><span class="dl-metric-label">${t("dl.disk")}</span><span class="dl-metric-value green" id="dl-stat-disk">${fmtSpeed(activeDl.diskBytes, S.speedInBits)}</span></div>
            <div class="dl-metric"><span class="dl-metric-label">${t("dl.eta")}</span><span class="dl-metric-value" id="dl-stat-eta">${localizeMessage(activeDl.eta) || t("dl.calculating")}</span></div>
            <div class="dl-metric"><span class="dl-metric-label">${t("dl.totalSize")}</span><span class="dl-metric-value" id="dl-stat-bytes">${fmtBytes(activeDl.downloadedBytes)} / ${fmtBytes(activeDl.totalBytes)}</span></div>
          </div>
        </div>
      </div>
    `;
  } else {
    // Pure Apple Minimalist Idle State
    heroMarkup = `
      <div class="apple-idle-hero">
        <div class="apple-idle-icon-wrap">
          ${icon("download", 28)}
        </div>
        <h2 class="apple-idle-title">${t("downloads.emptyTitle")}</h2>
        <p class="apple-idle-desc">${t("downloads.emptyDesc")}</p>
        <button class="apple-btn-primary" data-act="goto-library">
          ${icon("layout-grid", 14)}
          <span>${t("downloads.goLibrary")}</span>
        </button>
      </div>
    `;
  }

  // Steam-style Speed Chart
  const lastNet = S.speedHistory[S.speedHistory.length - 1] || 0;
  const lastDisk = S.diskHistory[S.diskHistory.length - 1] || 0;
  const netLegendVal = fmtSpeed(activeDl?.speedBytes || lastNet, S.speedInBits);
  const diskLegendVal = fmtSpeed(activeDl?.diskBytes || lastDisk, S.speedInBits);

  // The chart is only useful while an active download is running; hide completely when idle/finished.
  const hasChartData = !!activeDl;
  const chartMarkup = hasChartData
    ? `
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
  `
    : "";

  // Available updates section (e.g. installed games with new version ready)
  let updatesSection = "";
  const gamesWithUpdates = S.epicSummaries.filter(
    (s) => s.installed && (s.updateAvailable || S.availableUpdates.has(s.appName))
  );
  if (gamesWithUpdates.length > 0) {
    const items = gamesWithUpdates
      .map((s) => {
        const cover = s.cover || "";
        const updateInfo = S.availableUpdates.get(s.appName);
        const verStr = updateInfo?.latestVersion
          ? `${updateInfo.installedVersion ? updateInfo.installedVersion + " → " : ""}${updateInfo.latestVersion}`
          : "";
        return `
          <div class="apple-list-row">
            <div class="apple-row-left clickable" data-act="epic-detail" data-id="${s.appName}" title="${esc(s.title)}">
              ${cover ? `<img class="apple-row-thumb" src="${esc(cover)}" alt="" loading="lazy" />` : `<div class="apple-row-thumb-fallback">${icon("gamepad-2", 16)}</div>`}
              <div class="apple-row-info">
                <div class="apple-row-title" title="${esc(s.title)}">${esc(s.title)}</div>
                <div class="apple-row-meta">
                  <span class="apple-update-tag">${icon("refresh", 11)} ${t("drawer.updateAvailable")}</span>
                  ${verStr ? `<span class="apple-row-dot" aria-hidden="true">•</span><span class="apple-update-ver">${esc(verStr)}</span>` : ""}
                  ${s.installSize ? `<span class="apple-row-dot" aria-hidden="true">•</span><span>${fmtBytes(s.installSize)}</span>` : ""}
                </div>
              </div>
            </div>
            <div class="apple-row-right">
              <button class="apple-pill-btn update" data-act="epic-install" data-id="${s.appName}">
                ${icon("download", 12)}
                <span>${t("common.update")}</span>
              </button>
              <button class="apple-icon-btn" data-act="manage-game" data-id="${s.appName}" title="${t("common.manage")}">
                ${icon("settings", 13)}
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    updatesSection = `
      <div class="apple-section">
        <div class="apple-section-header">
          <span class="apple-section-title">${t("lib.updates")} (${gamesWithUpdates.length})</span>
        </div>
        <div class="apple-grouped-list">
          ${items}
        </div>
      </div>
    `;
  }

  // Queue markup
  let queueSection = "";
  if (queueApps.length > 0) {
    const items = queueApps.map((appId, idx) => {
      const s = S.epicSummaries.find((x) => x.appName === appId);
      const title = s?.title || appId;
      const cover = s?.cover || "";
      const sizeStr = s?.installSize ? fmtBytes(s.installSize) : t("dl.queued");
      const isFirst = idx === 0;
      const isLast = idx === queueApps.length - 1;
      return `
        <div class="apple-list-row">
          <div class="apple-row-left">
            <span class="apple-row-order">#${idx + 1}</span>
            ${cover ? `<img class="apple-row-thumb" src="${esc(cover)}" alt="" />` : `<div class="apple-row-thumb-fallback">${icon("gamepad-2", 16)}</div>`}
            <div class="apple-row-info">
              <div class="apple-row-title">${esc(title)}</div>
              <div class="apple-row-meta">${esc(sizeStr)}</div>
            </div>
          </div>
          <div class="apple-row-right">
            <button class="apple-icon-btn" data-act="dl-reorder-up" data-id="${appId}" title="${t("dl.moveUp")}" ${isFirst ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-up", 13)}
            </button>
            <button class="apple-icon-btn" data-act="dl-reorder-down" data-id="${appId}" title="${t("dl.moveDown")}" ${isLast ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-down", 13)}
            </button>
            <button class="apple-pill-btn primary" data-act="dl-reorder-now" data-id="${appId}">
              ${icon("play", 11)} ${t("dl.downloadNow")}
            </button>
            <button class="apple-icon-btn danger" data-act="dl-reorder-remove" data-id="${appId}" title="${t("dl.removeFromQueue")}">
              ${icon("x", 13)}
            </button>
          </div>
        </div>
      `;
    }).join("");

    queueSection = `
      <div class="apple-section">
        <div class="apple-section-header">
          <span class="apple-section-title">${t("dl.queueTitle")} (${queueApps.length})</span>
        </div>
        <div class="apple-grouped-list">
          ${items}
        </div>
      </div>
    `;
  }

  // Completed items
  let completedSection = "";
  if (completedEntries.length > 0) {
    const items = completedEntries.map(([appId, d]) => {
      const s = S.epicSummaries.find((x) => x.appName === appId);
      const cover = s?.cover || "";
      return `
        <div class="apple-list-row">
          <div class="apple-row-left">
            <span class="apple-row-check">${icon("check", 12)}</span>
            ${cover ? `<img class="apple-row-thumb" src="${esc(cover)}" alt="" />` : `<div class="apple-row-thumb-fallback">${icon("gamepad-2", 16)}</div>`}
            <div class="apple-row-info">
              <div class="apple-row-title">${esc(d.title)}</div>
              <div class="apple-row-meta" style="color:#10b981">${t("dl.completedReady")}</div>
            </div>
          </div>
          <div class="apple-row-right">
            <button class="apple-pill-btn play" data-act="epic-play" data-id="${appId}">
              ${icon("play", 11)} ${t("common.play")}
            </button>
            <button class="apple-icon-btn" data-act="manage-game" data-id="${appId}" title="${t("common.manage")}">
              ${icon("settings", 13)}
            </button>
          </div>
        </div>
      `;
    }).join("");

    completedSection = `
      <div class="apple-section">
        <div class="apple-section-header">
          <span class="apple-section-title">${t("dl.recentCompleted")} (${completedEntries.length})</span>
        </div>
        <div class="apple-grouped-list">
          ${items}
        </div>
      </div>
    `;
  }

  const recentSection =
    recentInstalled.length > 0
      ? `
    <div class="apple-section">
      <div class="apple-section-header">
        <span class="apple-section-title">${t("downloads.recentTitle")}</span>
        <button class="apple-section-link" data-act="goto-library">
          <span>${t("downloads.goLibrary")}</span>
          ${icon("chevron-right", 12)}
        </button>
      </div>
      <div class="apple-grouped-list">
        ${recentInstalled
          .map(
            (s) => `
          <div class="apple-list-row">
            <div class="apple-row-left clickable" data-act="epic-detail" data-id="${s.appName}" title="${esc(s.title)}">
              ${s.cover ? `<img class="apple-row-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="apple-row-thumb-fallback">${icon("gamepad-2", 16)}</div>`}
              <div class="apple-row-info">
                <div class="apple-row-title" title="${esc(s.title)}">${esc(s.title)}</div>
                <div class="apple-row-meta">
                  <span>${fmtBytes(s.installSize || 0)}</span>
                  <span class="apple-row-dot" aria-hidden="true">•</span>
                  <span class="apple-row-status">${icon("check", 10)} ${t("settings.eosInstalled")}</span>
                </div>
              </div>
            </div>
            <div class="apple-row-right">
              <button class="apple-pill-btn play" data-act="epic-play" data-id="${s.appName}">
                ${icon("play", 11)}
                <span>${t("common.play")}</span>
              </button>
              <button class="apple-icon-btn" data-act="manage-game" data-id="${s.appName}" title="${t("common.manage")}">
                ${icon("settings", 13)}
              </button>
            </div>
          </div>`,
          )
          .join("")}
      </div>
    </div>
  `
      : "";

  const settingsPanel = `
    <div class="dl-settings-panel">
      <div class="dl-settings-head">
        <div class="dl-settings-title">${icon("settings", 16)} ${t("downloads.settingsTitle")}</div>
        <span class="dl-settings-hint">${t("downloads.settingsHint")}</span>
      </div>
      <div class="dl-settings-rows">
        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.netProfile")}</div>
            <div class="dl-settings-row-desc">${t("downloads.netProfileDesc")}</div>
          </div>
          <div class="dl-settings-row-control net-profile-pills">
            <button class="net-profile-btn ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">${icon("zap", 13)} ${t("downloads.profileMax")}</button>
            <button class="net-profile-btn ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">${icon("shield-check", 13)} ${t("downloads.profileBalanced")}</button>
            <button class="net-profile-btn ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">${icon("clock", 13)} ${t("downloads.profileLow")}</button>
          </div>
        </div>

        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.speedBits")}</div>
          </div>
          <div class="dl-settings-row-control">
            <label class="toggle-switch">
              <input type="checkbox" data-act="toggle-speed-bits" ${S.speedInBits ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.pauseOnPlay")}</div>
            <div class="dl-settings-row-desc">${t("downloads.pauseOnPlayDesc")}</div>
          </div>
          <div class="dl-settings-row-control">
            <label class="toggle-switch">
              <input type="checkbox" data-act="toggle-pause-on-play" ${S.pauseOnPlay ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.installDir")}</div>
          </div>
          <div class="dl-settings-row-control">
            <input id="dl-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || t("downloads.defaultPlaceholder"))}" autocomplete="off" spellcheck="false" />
            <button class="ps5-btn-icon" data-act="dl-pick-install-dir" title="${t("downloads.pickFolder")}">${icon("folder", 15)}</button>
            <button class="ps5-btn primary" data-act="dl-save-install-dir">${t("common.save")}</button>
          </div>
        </div>

        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.cdnLabel")}</div>
            <div class="dl-settings-row-desc">${t("downloads.cdnHint")}</div>
          </div>
          <div class="dl-settings-row-control">
            <span class="dl-cdn-current" id="dl-cdn-current" title="${S.preferredCdn ? esc(S.preferredCdn) : ""}">${S.preferredCdn ? esc(S.preferredCdn) : t("downloads.cdnAuto")}</span>
            <button class="ps5-btn secondary" data-act="dl-find-fastest-cdn">${icon("zap", 13)} ${t("downloads.cdnFind")}</button>
            ${S.preferredCdn ? `<button class="ps5-btn ghost" data-act="dl-reset-cdn">${t("downloads.cdnReset")}</button>` : ""}
          </div>
        </div>

        <div class="dl-settings-row">
          <div class="dl-settings-row-text">
            <div class="dl-settings-row-title">${t("downloads.cacheLabel")}</div>
            <div class="dl-settings-row-desc">${t("downloads.cacheDesc")}</div>
          </div>
          <div class="dl-settings-row-control">
            <button class="ps5-btn ghost" data-act="dl-cleanup-cache">${icon("trash", 13)} ${t("downloads.cacheClear")}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const headerAction = `
    <button class="apple-header-btn ${S.downloadsSettingsOpen ? "active" : ""}" data-act="toggle-downloads-settings">${icon("settings", 14)} <span>${t("downloads.settingsTitle")}</span></button>
    <button class="apple-header-btn" data-act="open-storage-manager">${icon("hard-drive", 14)} <span>${t("storage.open")}</span></button>
  `;

  return `
    <div class="ps5-page ps5-downloads-page">
      <header class="ps5-page-header apple-downloads-header">
        <div class="ps5-header-main">
          <h1 class="ps5-header-title">${t("downloads.title")}</h1>
          <p class="ps5-header-subtitle">${t("downloads.subtitle")}</p>
        </div>
        <div class="ps5-header-actions">${headerAction}</div>
      </header>
      <main class="ps5-page-body">
        <div class="dl-hub apple-hub">
          ${heroMarkup}
          ${chartMarkup}
          ${S.downloadsSettingsOpen ? settingsPanel : ""}
          ${updatesSection}
          ${queueSection}
          ${completedSection}
          ${recentSection}
        </div>
      </main>
    </div>
  `;
}
