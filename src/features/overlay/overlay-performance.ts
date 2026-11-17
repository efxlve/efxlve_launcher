/**
 * Overlay Performance view: telemetry readings, metric cards, the chart canvas
 * and the live in-place patches driven by the metrics event.
 *
 * One-way dependency: the page configures widget queries through
 * configurePerformance; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "../../core/platform";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t, t as i18nT } from "../../i18n";

export interface MetricsSample {
  running: boolean;
  pid: number | null;
  fps: number | null;
  frameMs: number | null;
  low1Fps?: number | null;
  low01Fps?: number | null;
  frames?: number[];
  fpsAvailable: boolean;
  cpu: number;
  cpuGhz?: number | null;
  gameCpu: number | null;
  ramUsedMb: number;
  ramTotalMb: number;
  gpu: number | null;
  vramUsedMb: number | null;
  vramTotalMb?: number | null;
  cpuTempC?: number | null;
  cpuPowerW?: number | null;
  gpuTempC?: number | null;
  gpuPowerW?: number | null;
}

export type PerfMetric = "cpu" | "gpu" | "vram" | "ram" | "fps";

interface PerformanceDeps {
  viewEl: (tab: "perf") => HTMLElement | null;
  isWidgetOpen: (tab: "perf") => boolean;
}

let deps: PerformanceDeps | null = null;

export function configurePerformance(next: PerformanceDeps): void {
  deps = next;
}

let metrics: MetricsSample | null = null;
let activePerfMetric: PerfMetric = "cpu";
let fpsHistory: number[] = [];
let cpuHistory: number[] = [];
let gpuHistory: number[] = [];
let vramHistory: number[] = [];
let ramHistory: number[] = [];
let fpsEnableState: "idle" | "enabled" | "denied" = "idle";

function perfView(): HTMLElement | null {
  return deps?.viewEl("perf") ?? null;
}

function perfOpen(): boolean {
  return deps?.isWidgetOpen("perf") ?? false;
}

/** Compact MB/GB label shared with the Home dashboard. */
export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** The last sample; Home's FPS card reads the same one. */
export function metricsSample(): MetricsSample | null {
  return metrics;
}

export function activePerformanceMetric(): PerfMetric {
  return activePerfMetric;
}

export function setPerformanceMetric(metric: PerfMetric): void {
  activePerfMetric = metric;
}

/** A new panel session starts from clean history. */
export function resetPerformanceSession(): void {
  metrics = null;
  activePerfMetric = "cpu";
  fpsHistory = [];
  cpuHistory = [];
  gpuHistory = [];
  vramHistory = [];
  ramHistory = [];
  fpsEnableState = "idle";
}

/** One metrics event: update the history windows, then patch the live DOM. */
export function applyMetricsSample(sample: MetricsSample): void {
  metrics = sample;

  const cpuVal = metrics.gameCpu ?? metrics.cpu;
  cpuHistory.push(cpuVal);
  if (cpuHistory.length > 60) cpuHistory.shift();

  const gpuVal = metrics.gpu ?? 0;
  gpuHistory.push(gpuVal);
  if (gpuHistory.length > 60) gpuHistory.shift();

  const vramTotal = metrics.vramTotalMb ?? 8192;
  const vramUsed = metrics.vramUsedMb ?? 0;
  const vramPercent = vramTotal > 0 ? (vramUsed / vramTotal) * 100 : 0;
  vramHistory.push(vramPercent);
  if (vramHistory.length > 60) vramHistory.shift();

  const ramPercent = metrics.ramTotalMb > 0 ? (metrics.ramUsedMb / metrics.ramTotalMb) * 100 : 0;
  ramHistory.push(ramPercent);
  if (ramHistory.length > 60) ramHistory.shift();

  if (metrics.fps != null) {
    fpsHistory.push(metrics.fps);
    if (fpsHistory.length > 60) fpsHistory.shift();
  } else {
    fpsHistory.push(0);
    if (fpsHistory.length > 60) fpsHistory.shift();
  }

  updateMetricsUi();
}

export function fpsNoticeHtml(m: MetricsSample | null): string {
  if (!IS_WINDOWS || !m || m.fpsAvailable) return "";
  const text =
    fpsEnableState === "enabled"
      ? t("overlay.fpsEnabled")
      : fpsEnableState === "denied"
      ? t("overlay.fpsDenied")
      : t("overlay.fpsPermission");
  return `
    <div class="ov-fps-notice" id="ov-fps-notice">
      ${icon("info", 14)}
      <span class="ov-fps-notice-text">${esc(text)}</span>
      <button class="btn ghost small" data-ov="enable-fps" ${fpsEnableState === "idle" ? "" : "disabled"}>${esc(t("overlay.fpsEnable"))}</button>
    </div>`;
}

/** Applies the current enable state to notices already on screen. */
function refreshFpsNotices(): void {
  const text =
    fpsEnableState === "enabled"
      ? t("overlay.fpsEnabled")
      : fpsEnableState === "denied"
      ? t("overlay.fpsDenied")
      : t("overlay.fpsPermission");
  document.querySelectorAll<HTMLElement>(".ov-fps-notice").forEach((notice) => {
    const label = notice.querySelector<HTMLElement>(".ov-fps-notice-text");
    if (label && label.textContent !== text) label.textContent = text;
    notice.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = fpsEnableState !== "idle";
    });
  });
}

/** Adds or removes the permission notice in the Perf widget as the counter's
 * availability changes. It patches in place: re-rendering the widget on every
 * sample was a full DOM rebuild each second. */
function updateFpsNotice(): void {
  const existing = document.getElementById("ov-fps-notice");
  if (!IS_WINDOWS) {
    existing?.remove();
    return;
  }
  if (metrics?.fpsAvailable === true) {
    existing?.remove();
    return;
  }
  if (!metrics) return;
  if (existing) {
    refreshFpsNotices();
    return;
  }
  if (!perfOpen()) return;
  const perf = document.querySelector<HTMLElement>("#ov-widget-perf-body .ov-perf");
  if (!perf) return;
  perf.insertAdjacentHTML("afterbegin", fpsNoticeHtml(metrics));
  refreshFpsNotices();
}

export async function enableFps(): Promise<void> {
  try {
    const status = await invoke<string>("overlay_enable_fps");
    fpsEnableState = status === "started" || status === "already" ? "enabled" : "denied";
  } catch {
    fpsEnableState = "denied";
  }
  refreshFpsNotices();
}


export function perfCanvasHtml(id: string, extraAttrs = ""): string {
  return `
    <div class="ov-perf-canvas-wrap">
      <canvas class="ov-perf-canvas" id="${id}"${extraAttrs}></canvas>
      <div class="ov-perf-empty">${esc(t("overlay.noFpsData"))}</div>
    </div>`;
}

/** Hides the "waiting for data" label as soon as FPS samples exist. */
export function updatePerfEmptyStates(): void {
  const hasData = metrics?.fps != null || fpsHistory.length > 0 || (metrics?.frames?.length ?? 0) > 0;
  document.querySelectorAll<HTMLElement>(".ov-perf-empty").forEach((el) => {
    el.hidden = hasData;
  });
}

function statusLevel(pct: number): "ok" | "warn" | "err" {
  if (pct >= 85) return "err";
  if (pct >= 65) return "warn";
  return "ok";
}

function getTelemetryReadings(m: MetricsSample | null) {
  const cpuVal = Math.round(m ? (m.gameCpu ?? m.cpu) : 0);
  const gpuVal = m?.gpu != null ? Math.round(m.gpu) : 0;
  const ramUsed = m?.ramUsedMb ?? 0;
  const ramTotal = m?.ramTotalMb ?? 1;
  const ramPct = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;
  const vramUsed = m?.vramUsedMb ?? 0;
  const vramTotal = m?.vramTotalMb ?? 8192;
  const vramPct = vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0;
  const fpsVal = m?.fps != null ? Math.round(m.fps) : null;
  const fpsBarPct = fpsVal != null ? Math.min(100, Math.round((fpsVal / 144) * 100)) : 0;

  const cpuTemp = m?.cpuTempC != null ? `${Math.round(m.cpuTempC)}°C` : "";
  const cpuPower = m?.cpuPowerW != null ? `${Math.round(m.cpuPowerW)}W` : "";
  const gpuTemp = m?.gpuTempC != null ? `${Math.round(m.gpuTempC)}°C` : "";
  const gpuPower = m?.gpuPowerW != null ? `${Math.round(m.gpuPowerW)}W` : "";
  const cpuSub = [m?.cpuGhz ? `${m.cpuGhz.toFixed(2)} GHz` : t("overlay.perfProcessor"), cpuTemp, cpuPower]
    .filter(Boolean)
    .join(" · ");
  const gpuState = m?.running ? t("overlay.perfGpuActive") : t("overlay.perfGpuSystem");
  const gpuSub = [gpuState, gpuTemp, gpuPower].filter(Boolean).join(" · ");
  const ramSub = ramUsed > 0 ? fmtMb(ramUsed) : t("overlay.perfMemory");
  const vramSub = vramUsed > 0 ? fmtMb(vramUsed) : t("overlay.perfMemory");
  const ramSubTitle = `${fmtMb(ramUsed)} / ${fmtMb(ramTotal)}`;
  const vramSubTitle = `${fmtMb(vramUsed)} / ${fmtMb(vramTotal)}`;
  const subFps =
    m?.frameMs != null
      ? `${m.frameMs.toFixed(1)} ms`
      : m?.running
        ? "..."
        : t("overlay.perfIdle");
  const low1 = m?.low1Fps != null ? Math.round(m.low1Fps) : null;
  const low01 = m?.low01Fps != null ? Math.round(m.low01Fps) : null;
  const lowsText =
    low1 != null || low01 != null
      ? [
          low1 != null ? `1% ${low1}` : "",
          low01 != null ? `0.1% ${low01}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const frameData = (m?.frames ?? []).filter((value) => Number.isFinite(value) && value > 0);

  let data: number[] = [];
  let tag = "CPU";
  let num = `${cpuVal}%`;
  let sub = cpuSub;
  let peakVal = "0%";
  let avgVal = "0%";
  let minVal = "0%";

  switch (activePerfMetric) {
    case "cpu": {
      data = cpuHistory;
      tag = "CPU";
      num = `${cpuVal}%`;
      sub = cpuSub;
      const valid = data.length > 0 ? data : [cpuVal];
      const peak = Math.round(Math.max(...valid));
      const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
      const min = Math.round(Math.min(...valid));
      peakVal = `${peak}%`;
      avgVal = `${avg}%`;
      minVal = `${min}%`;
      break;
    }
    case "gpu": {
      data = gpuHistory;
      tag = "GPU";
      num = `${gpuVal}%`;
      sub = gpuSub;
      const valid = data.length > 0 ? data : [gpuVal];
      const peak = Math.round(Math.max(...valid));
      const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
      const min = Math.round(Math.min(...valid));
      peakVal = `${peak}%`;
      avgVal = `${avg}%`;
      minVal = `${min}%`;
      break;
    }
    case "ram": {
      data = ramHistory;
      tag = "RAM";
      num = `${ramPct}%`;
      sub = ramSubTitle;
      const valid = data.length > 0 ? data : [ramPct];
      const peak = Math.round(Math.max(...valid));
      const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
      const min = Math.round(Math.min(...valid));
      peakVal = `${peak}%`;
      avgVal = `${avg}%`;
      minVal = `${min}%`;
      break;
    }
    case "vram": {
      data = vramHistory;
      tag = "VRAM";
      num = `${vramPct}%`;
      sub = vramSubTitle;
      const valid = data.length > 0 ? data : [vramPct];
      const peak = Math.round(Math.max(...valid));
      const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
      const min = Math.round(Math.min(...valid));
      peakVal = `${peak}%`;
      avgVal = `${avg}%`;
      minVal = `${min}%`;
      break;
    }
    case "fps": {
      data = frameData;
      tag = "FPS";
      num = fpsVal != null ? String(fpsVal) : "--";
      sub = subFps;
      const minMs = frameData.length > 0 ? Math.min(...frameData) : 0;
      const avgMs =
        frameData.length > 0
          ? frameData.reduce((a, b) => a + b, 0) / frameData.length
          : 0;
      const maxMs = frameData.length > 0 ? Math.max(...frameData) : 0;
      minVal = minMs > 0 ? `${minMs.toFixed(1)} ms` : "--";
      avgVal = avgMs > 0 ? `${avgMs.toFixed(1)} ms` : "--";
      peakVal = maxMs > 0 ? `${maxMs.toFixed(1)} ms` : "--";
      break;
    }
  }

  const windowLabel =
    activePerfMetric === "fps"
      ? t("overlay.frameWindow", { n: String(frameData.length) })
      : "60s";

  return {
    cpuVal,
    gpuVal,
    ramPct,
    vramPct,
    fpsVal,
    fpsBarPct,
    cpuSub,
    gpuSub,
    ramSub,
    vramSub,
    ramSubTitle,
    vramSubTitle,
    subFps,
    low1,
    low01,
    lowsText,
    frameData,
    windowLabel,
    cpuStatus: statusLevel(cpuVal),
    gpuStatus: statusLevel(gpuVal),
    ramStatus: statusLevel(ramPct),
    vramStatus: statusLevel(vramPct),
    tag,
    num,
    sub,
    peakVal,
    avgVal,
    minVal,
  };
}

/* 2. Bespoke Efxlve Telemetry View */
export function renderPerf(): void {
  const el = perfView();
  if (!el) return;
  const m = metrics;
  const t = getTelemetryReadings(m);

  el.innerHTML = `
    <div class="ov-perf">
      ${fpsNoticeHtml(m)}
      ${IS_WINDOWS ? `<!-- Top FPS Row -->
      <button class="ov-perf-card ov-perf-fps-row ${activePerfMetric === "fps" ? "active" : ""}" data-perf-metric="fps" type="button">
        <div class="ov-perf-fps-left">
          <span class="ov-perf-icon">${icon("zap", 14)}</span>
          <span class="ov-perf-card-title">FPS</span>
          <span class="ov-perf-fps-num" id="ov-chip-val-fps">${t.fpsVal != null ? String(t.fpsVal) : "--"}</span>
        </div>
        <div class="ov-perf-fps-right">
          <span class="ov-perf-sub" id="ov-perf-frame-ms">${t.subFps}</span>
          <span class="ov-perf-lows" id="ov-perf-lows">${t.lowsText}</span>
        </div>
      </button>` : ""}

      <!-- Hardware Telemetry Cards (2x2 Grid on Windows, CPU/RAM elsewhere) -->
      <div class="ov-perf-grid">
        <!-- CPU Card -->
        <button class="ov-perf-card ${activePerfMetric === "cpu" ? "active" : ""}" data-perf-metric="cpu" type="button">
          <div class="ov-perf-card-head">
            <div class="ov-perf-card-title-group">
              <span class="ov-perf-icon">${icon("cpu", 13)}</span>
              <span class="ov-perf-card-title">CPU</span>
            </div>
            <span class="ov-perf-sub" id="ov-card-sub-cpu">${t.cpuSub}</span>
          </div>
          <div class="ov-perf-card-num" id="ov-chip-val-cpu">${t.cpuVal}%</div>
          <div class="ov-perf-bar"><div class="ov-perf-bar-fill ${t.cpuStatus}" id="ov-chip-bar-cpu" style="width:${t.cpuVal}%"></div></div>
        </button>

        ${IS_WINDOWS ? `<!-- GPU Card -->
        <button class="ov-perf-card ${activePerfMetric === "gpu" ? "active" : ""}" data-perf-metric="gpu" type="button">
          <div class="ov-perf-card-head">
            <div class="ov-perf-card-title-group">
              <span class="ov-perf-icon">${icon("activity", 13)}</span>
              <span class="ov-perf-card-title">GPU</span>
            </div>
            <span class="ov-perf-sub" id="ov-card-sub-gpu">${t.gpuSub}</span>
          </div>
          <div class="ov-perf-card-num" id="ov-chip-val-gpu">${t.gpuVal}%</div>
          <div class="ov-perf-bar"><div class="ov-perf-bar-fill ${t.gpuStatus}" id="ov-chip-bar-gpu" style="width:${t.gpuVal}%"></div></div>
        </button>` : ""}

        <!-- RAM Card -->
        <button class="ov-perf-card ${activePerfMetric === "ram" ? "active" : ""}" data-perf-metric="ram" type="button" title="${t.ramSubTitle}">
          <div class="ov-perf-card-head">
            <div class="ov-perf-card-title-group">
              <span class="ov-perf-icon">${icon("server", 13)}</span>
              <span class="ov-perf-card-title">RAM</span>
            </div>
            <span class="ov-perf-sub" id="ov-card-sub-ram">${t.ramSub}</span>
          </div>
          <div class="ov-perf-card-num" id="ov-chip-val-ram">${t.ramPct}%</div>
          <div class="ov-perf-bar"><div class="ov-perf-bar-fill ${t.ramStatus}" id="ov-chip-bar-ram" style="width:${t.ramPct}%"></div></div>
        </button>

        ${IS_WINDOWS ? `<!-- VRAM Card -->
        <button class="ov-perf-card ${activePerfMetric === "vram" ? "active" : ""}" data-perf-metric="vram" type="button" title="${t.vramSubTitle}">
          <div class="ov-perf-card-head">
            <div class="ov-perf-card-title-group">
              <span class="ov-perf-icon">${icon("hard-drive", 13)}</span>
              <span class="ov-perf-card-title">VRAM</span>
            </div>
            <span class="ov-perf-sub" id="ov-card-sub-vram">${t.vramSub}</span>
          </div>
          <div class="ov-perf-card-num" id="ov-chip-val-vram">${t.vramPct}%</div>
          <div class="ov-perf-bar"><div class="ov-perf-bar-fill ${t.vramStatus}" id="ov-chip-bar-vram" style="width:${t.vramPct}%"></div></div>
        </button>` : ""}
      </div>

      <!-- Telemetry Scope (Chart) -->
      <div class="ov-perf-scope">
        <div class="ov-perf-scope-head">
          <div class="ov-perf-scope-title-group">
            <span class="ov-perf-scope-title" id="ov-scope-tag">${t.tag}</span>
            <span class="ov-perf-scope-val" id="ov-scope-num">${t.num}</span>
          </div>
          <div class="ov-perf-scope-stats">
            <span>Min <b id="ov-stat-min-val">${t.minVal}</b></span>
            <span>${i18nT("overlay.perfAvg")} <b id="ov-stat-avg-val">${t.avgVal}</b></span>
            <span>${i18nT("overlay.perfPeak")} <b id="ov-stat-peak-val">${t.peakVal}</b></span>
          </div>
        </div>

        <div class="ov-perf-canvas-wrap">
          <canvas class="ov-perf-canvas" id="ov-perf-canvas"></canvas>
        </div>

        <div class="ov-perf-timeline">
          <span id="ov-perf-window-label">${t.windowLabel}</span>
          <span>${i18nT("overlay.perfNow")}</span>
        </div>
      </div>
    </div>`;

  drawPerfCanvas();
}

export function drawPerfCanvas(): void {
  const canvas = document.getElementById("ov-perf-canvas") as HTMLCanvasElement | null;
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 360;
    const height = rect.height || 100;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.resetTransform?.();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      let data: number[] = [];
      let maxVal = 100;

      switch (activePerfMetric) {
        case "cpu":
          data = cpuHistory.length > 0 ? cpuHistory : [0];
          maxVal = 100;
          break;
        case "gpu":
          data = gpuHistory.length > 0 ? gpuHistory : [0];
          maxVal = 100;
          break;
        case "ram":
          data = ramHistory.length > 0 ? ramHistory : [0];
          maxVal = 100;
          break;
        case "vram":
          data = vramHistory.length > 0 ? vramHistory : [0];
          maxVal = 100;
          break;
        case "fps":
          data = (metrics?.frames ?? []).filter(
            (value) => Number.isFinite(value) && value > 0,
          );
          if (data.length === 0) data = [0];
          maxVal = Math.max(33, ...data) * 1.15;
          break;
      }

      // Horizontal reference grid lines at 25%, 50%, 75%
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      for (const pct of [0.25, 0.5, 0.75]) {
        const y = Math.round(height - pct * (height - 16) - 8);
        ctx.beginPath();
        ctx.moveTo(30, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.restore();

      // Axis labels on left margin
      ctx.font = "9px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fillText(activePerfMetric === "fps" ? `${Math.round(maxVal)} ms` : "100%", 2, 10);
      ctx.fillText(activePerfMetric === "fps" ? `${Math.round(maxVal / 2)} ms` : "50%", 2, Math.round(height / 2) + 3);
      ctx.fillText("0", 2, height - 3);

      const chartLeft = 32;
      const chartWidth = Math.max(10, width - chartLeft - 4);
      const len = activePerfMetric === "fps" ? Math.max(2, data.length) : 60;
      const step = chartWidth / (len - 1);
      const offset = len - data.length;
      const points = data.map((val, idx) => {
        const x = chartLeft + (offset + idx) * step;
        const norm = maxVal > 0 ? Math.min(1, Math.max(0, val / maxVal)) : 0;
        const y = height - norm * (height - 16) - 8;
        return [x, Math.max(4, Math.min(height - 4, y))] as const;
      });

      if (points.length > 1) {
        // Subtle area fill
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, "rgba(255, 255, 255, 0.10)");
        grad.addColorStop(1, "rgba(255, 255, 255, 0.00)");

        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          const [x, y] = points[i];
          const [px, py] = points[i - 1];
          ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.75;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();

        ctx.lineTo(points[points.length - 1][0], height);
        ctx.lineTo(points[0][0], height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Sharp solid white point on latest reading
        const [lastX, lastY] = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      }
    }
  }

  const homeCanvas = document.getElementById("ov-home-perf-canvas") as HTMLCanvasElement | null;
  if (homeCanvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = homeCanvas.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 68;
    if (homeCanvas.width !== Math.round(width * dpr)) homeCanvas.width = Math.round(width * dpr);
    if (homeCanvas.height !== Math.round(height * dpr)) homeCanvas.height = Math.round(height * dpr);
    const ctx = homeCanvas.getContext("2d");
    if (ctx) {
      ctx.resetTransform?.();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const data = (metrics?.fps != null ? fpsHistory : cpuHistory).length > 0
        ? (metrics?.fps != null ? fpsHistory : cpuHistory)
        : [0];
      const maxVal = metrics?.fps != null ? Math.max(60, ...data) * 1.15 : 100;
      const len = 60;
      const step = width / (len - 1);
      const offset = len - data.length;
      const points = data.map((val, idx) => {
        const x = (offset + idx) * step;
        const norm = maxVal > 0 ? Math.min(1, Math.max(0, val / maxVal)) : 0;
        const y = height - norm * (height - 8) - 4;
        return [x, Math.max(3, Math.min(height - 3, y))] as const;
      });

      if (points.length > 1) {
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, "rgba(255, 255, 255, 0.10)");
        grad.addColorStop(1, "rgba(255, 255, 255, 0.0)");

        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          const [x, y] = points[i];
          const [px, py] = points[i - 1];
          ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.75;
        ctx.stroke();

        ctx.lineTo(points[points.length - 1][0], height);
        ctx.lineTo(points[0][0], height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }
  }
}

/* Patches the live numbers in place. */
export function setText(id: string, text: string, empty = false): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("is-empty", empty);
}

export function updateMetricsUi(): void {
  const m = metrics;
  updateFpsNotice();
  updatePerfEmptyStates();

  if (perfOpen() && document.getElementById("ov-chip-val-cpu")) {
    const t = getTelemetryReadings(m);

    setText("ov-chip-val-cpu", `${t.cpuVal}%`);
    setText("ov-chip-val-gpu", `${t.gpuVal}%`);
    setText("ov-chip-val-ram", `${t.ramPct}%`);
    setText("ov-chip-val-vram", `${t.vramPct}%`);
    setText("ov-chip-val-fps", t.fpsVal != null ? String(t.fpsVal) : "--");

    setText("ov-card-sub-cpu", t.cpuSub);
    setText("ov-card-sub-gpu", t.gpuSub);
    setText("ov-card-sub-ram", t.ramSub);
    setText("ov-card-sub-vram", t.vramSub);
    setText("ov-perf-frame-ms", t.subFps);
    setText("ov-perf-lows", t.lowsText);
    setText("ov-perf-window-label", t.windowLabel);

    const ramCard = document.querySelector<HTMLElement>('[data-perf-metric="ram"]');
    if (ramCard) ramCard.title = t.ramSubTitle;
    const vramCard = document.querySelector<HTMLElement>('[data-perf-metric="vram"]');
    if (vramCard) vramCard.title = t.vramSubTitle;

    const setBar = (id: string, pct: number, status: string) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.width = `${pct}%`;
        el.classList.toggle("warn", status === "warn");
        el.classList.toggle("err", status === "err");
      }
    };
    setBar("ov-chip-bar-cpu", t.cpuVal, t.cpuStatus);
    setBar("ov-chip-bar-gpu", t.gpuVal, t.gpuStatus);
    setBar("ov-chip-bar-ram", t.ramPct, t.ramStatus);
    setBar("ov-chip-bar-vram", t.vramPct, t.vramStatus);

    setText("ov-scope-tag", t.tag);
    setText("ov-scope-num", t.num, t.num === "--");
    setText("ov-stat-min-val", t.minVal);
    setText("ov-stat-avg-val", t.avgVal);
    setText("ov-stat-peak-val", t.peakVal);

    drawPerfCanvas();
  }

  if (document.getElementById("ov-home-fps")) {
    if (m?.fps != null) {
      setText("ov-home-fps", String(Math.round(m.fps)));
      setText("ov-home-frame", m.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : "");
    } else {
      setText("ov-home-fps", m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—");
      setText("ov-home-frame", m?.cpuGhz ? `${m.cpuGhz.toFixed(2)} GHz` : "");
    }
    drawPerfCanvas();
  }
}

