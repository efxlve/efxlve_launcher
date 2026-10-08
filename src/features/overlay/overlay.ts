/**
 * In-game overlay panel (Steam-like full-screen dashboard & HUD).
 *
 * Runs in its own webview over the game. Features:
 * - Live session timer and digital clock
 * - Controller navigation (D-pad/Stick, A/B, LB/RB, Start/Guide)
 * - Modular Overview dashboard (Session, Performance, Achievements, Screenshots, Music, Notes)
 * - Dedicated views for Performance, Achievements, Screenshots (with Lightbox), Notes, Music, Discord, Settings
 * - Seamless keyboard (Shift+Tab / Esc) and gamepad navigation.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OVERLAY_DISABLED_KEY, OVERLAY_ENABLED_KEY, OVERLAY_HUD_KEY, OVERLAY_OPACITY_KEY } from "../../core/constants";
import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";
import { currentLanguage, initialLanguage, setLanguage, t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import "../../styles/tokens.css";
import "../../styles/components.css";
import "./overlay.css";

/* ---------- Constants & Storage ---------- */

const ENABLED_KEY = OVERLAY_ENABLED_KEY;
const HUD_KEY = OVERLAY_HUD_KEY;
const OPACITY_KEY = OVERLAY_OPACITY_KEY;
const DISABLED_KEY = OVERLAY_DISABLED_KEY;

/* ---------- Data Types ---------- */

interface OpenPayload {
  appName: string;
  title: string;
}

interface MetricsSample {
  running: boolean;
  pid: number | null;
  fps: number | null;
  frameMs: number | null;
  cpu: number;
  gameCpu: number | null;
  ramUsedMb: number;
  ramTotalMb: number;
  gpu: number | null;
  vramUsedMb: number | null;
}

interface AchievementItem {
  name: string;
  display_name?: string;
  description?: string;
  unlocked?: boolean;
  hidden?: boolean;
  icon_link?: string;
}

interface AchievementsData {
  achievements: AchievementItem[];
  user_unlocked: number;
  total_achievements: number;
}

interface ScreenshotItem {
  file_path: string;
  file_name: string;
  date_str: string;
  data_url: string;
}

interface MediaState {
  available: boolean;
  title: string;
  artist: string;
  playing: boolean;
  source: string;
  positionS: number;
  durationS: number;
}

type TabId = "home" | "perf" | "ach" | "shots" | "notes" | "music" | "discord" | "settings";

const TABS: { id: TabId; icon: IconName; key: string }[] = [
  { id: "home", icon: "layers", key: "overlay.tabHome" },
  { id: "perf", icon: "cpu", key: "overlay.tabPerformance" },
  { id: "ach", icon: "trophy", key: "overlay.tabAchievements" },
  { id: "shots", icon: "camera", key: "overlay.tabScreenshots" },
  { id: "notes", icon: "edit", key: "overlay.tabNotes" },
  { id: "music", icon: "volume-2", key: "overlay.tabMusic" },
  { id: "discord", icon: "users", key: "overlay.tabDiscord" },
  { id: "settings", icon: "settings", key: "overlay.tabSettings" },
];

/* ---------- State ---------- */

let context: OpenPayload = { appName: "", title: "" };
let metrics: MetricsSample | null = null;
let fpsHistory: number[] = [];
let mediaState: MediaState = {
  available: false,
  title: "",
  artist: "",
  playing: false,
  source: "",
  positionS: 0,
  durationS: 0,
};
let cachedAchievements: AchievementsData | null = null;
let cachedScreenshots: ScreenshotItem[] = [];
let sessionStartEpoch = Date.now();
let activeTab: TabId = (localStorage.getItem("efxlve-overlay-tab") as TabId) || "home";

let mediaPollTimer: number | null = null;
let clockTimer: number | null = null;
let notesSaveTimer: number | null = null;

/* ---------- Helpers ---------- */

function splitKey(key: string): { store: string; id: string } {
  const index = key.indexOf("::");
  return index < 0
    ? { store: "epic", id: key }
    : { store: key.slice(0, index), id: key.slice(index + 2) };
}

function storeLabel(store: string): string {
  switch (store) {
    case "epic": return "Epic Games";
    case "gog": return "GOG";
    case "steam": return "Steam";
    case "amazon": return "Amazon Games";
    case "xbox": return "Xbox";
    case "battlenet": return "Battle.net";
    case "ubisoft": return "Ubisoft Connect";
    case "ea": return "EA App";
    case "riot": return "Riot Games";
    default: return store;
  }
}

interface DisabledGame {
  key: string;
  title: string;
}

function disabledGames(): DisabledGame[] {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return { key: item, title: item };
        const record = item as { key?: unknown; title?: unknown };
        return {
          key: typeof record.key === "string" ? record.key : "",
          title: typeof record.title === "string" && record.title ? record.title : String(record.key ?? ""),
        };
      })
      .filter((item) => item.key.length > 0);
  } catch {
    return [];
  }
}

function saveDisabled(list: DisabledGame[]): void {
  localStorage.setItem(DISABLED_KEY, JSON.stringify(list));
}

function isDisabledGame(appName: string): boolean {
  return disabledGames().some((item) => item.key === appName);
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function formatSessionTime(ms: number): string {
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/* ---------- Shell HTML Template ---------- */

function shellHtml(): string {
  return `
    <div class="ov" id="ov-shell">
      <!-- Top Header -->
      <header class="ov-header">
        <div class="ov-header-left">
          <div class="ov-game-cover" id="ov-game-cover">
            ${icon("gamepad-2", 20)}
          </div>
          <div class="ov-game-meta">
            <h1 class="ov-game-title" id="ov-game-title">—</h1>
            <div class="ov-game-sub" id="ov-game-sub"></div>
          </div>
        </div>

        <div class="ov-header-center">
          <div class="ov-clock">
            <span id="ov-clock-time">00:00</span><span class="ov-clock-sec" id="ov-clock-sec">:00</span>
          </div>
          <div class="ov-session-pill">
            ${icon("clock", 12)} <span id="ov-session-text">0m</span>
          </div>
        </div>

        <div class="ov-header-right">
          <div class="ov-controller-badge" id="ov-controller-badge" style="display:none">
            ${icon("gamepad-2", 14)} <span id="ov-controller-name">Controller</span>
          </div>
          <button class="ov-btn-resume" data-ov="close" title="${esc(t("common.close"))}">
            <span>${esc(t("common.close"))}</span>
            <kbd class="ov-kbd">Esc</kbd>
            <span class="ov-pad-b">Ⓑ</span>
          </button>
        </div>
      </header>

      <!-- Main Content Area -->
      <main class="ov-main" id="ov-main">
        <section class="ov-view" data-ov-view="home"></section>
        <section class="ov-view" data-ov-view="perf"></section>
        <section class="ov-view" data-ov-view="ach"></section>
        <section class="ov-view" data-ov-view="shots"></section>
        <section class="ov-view" data-ov-view="notes"></section>
        <section class="ov-view" data-ov-view="music"></section>
        <section class="ov-view" data-ov-view="discord"></section>
        <section class="ov-view" data-ov-view="settings"></section>
      </main>

      <!-- Floating Quick-Access Dock -->
      <nav class="ov-dock">
        <span class="ov-bumper-hint ov-bumper-lb">LB</span>
        <div class="ov-dock-items">
          ${TABS.map((tab) => `
            <button class="ov-dock-btn" data-ov-tab="${tab.id}" title="${esc(t(tab.key))}">
              ${icon(tab.icon, 16)}
              <span>${esc(t(tab.key))}</span>
            </button>`).join("")}
        </div>
        <span class="ov-bumper-hint ov-bumper-rb">RB</span>
      </nav>

      <!-- Bottom Status & Hints -->
      <footer class="ov-footer">
        <div class="ov-footer-left">
          <span class="keyboard-hints">
            <kbd class="ov-kbd">Shift</kbd>+<kbd class="ov-kbd">Tab</kbd> ${esc(t("overlay.hotkeyHint"))}
          </span>
          <span class="gamepad-hints" style="display:none">
            <span class="ov-glyph-pill">Ⓐ ${esc(t("overlay.restore") ? "Select" : "Select")}</span>
            <span class="ov-glyph-pill">Ⓑ ${esc(t("common.close"))}</span>
            <span class="ov-glyph-pill">LB / RB Tab</span>
            <span class="ov-glyph-pill">D-Pad / Stick</span>
          </span>
        </div>
        <div class="ov-footer-right" id="ov-foot-store"></div>
      </footer>

      <!-- Screenshot Lightbox Modal -->
      <div class="ov-lightbox" id="ov-lightbox" style="display:none">
        <div class="ov-lightbox-content">
          <img id="ov-lightbox-img" src="" alt="" />
          <button class="ov-lightbox-close" data-ov="close-lightbox">${icon("x", 18)}</button>
        </div>
      </div>
    </div>`;
}

function viewEl(tab: TabId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ov-view="${tab}"]`);
}

function setTab(tab: TabId): void {
  activeTab = tab;
  localStorage.setItem("efxlve-overlay-tab", tab);

  document.querySelectorAll<HTMLElement>("[data-ov-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.ovTab === tab);
  });
  document.querySelectorAll<HTMLElement>("[data-ov-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.ovView === tab);
  });

  if (tab === "home") renderHome();
  else if (tab === "perf") renderPerf();
  else if (tab === "ach") void loadAchievements();
  else if (tab === "shots") void loadScreenshots();
  else if (tab === "notes") renderNotes();
  else if (tab === "music") void refreshMedia();
  else if (tab === "discord") renderDiscord();
  else if (tab === "settings") renderSettings();

  if (tab === "perf" || tab === "home") drawPerfCanvas();
}

/* ---------- Live Clock & Session ---------- */

function updateClock(): void {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const secs = String(now.getSeconds()).padStart(2, "0");

  const timeEl = document.getElementById("ov-clock-time");
  const secEl = document.getElementById("ov-clock-sec");
  const sessionEl = document.getElementById("ov-session-text");

  if (timeEl) timeEl.textContent = `${hours}:${mins}`;
  if (secEl) secEl.textContent = `:${secs}`;
  if (sessionEl) sessionEl.textContent = formatSessionTime(Date.now() - sessionStartEpoch);
}

/* ---------- Views Rendering ---------- */

/* 1. Home / Overview Modular Dashboard */
function renderHome(): void {
  const el = viewEl("home");
  if (!el) return;
  const { store } = splitKey(context.appName);
  const m = metrics;
  const currentFps = m?.fps != null ? Math.round(m.fps) : "—";
  const hudActive = localStorage.getItem(HUD_KEY) === "true";

  // Achievements preview
  const achData = cachedAchievements;
  const achUnlocked = achData?.user_unlocked ?? 0;
  const achTotal = achData?.total_achievements ?? achData?.achievements?.length ?? 0;
  const achPct = achTotal > 0 ? Math.round((achUnlocked / achTotal) * 100) : 0;
  const recentAchs = achData?.achievements ? achData.achievements.slice(0, 3) : [];

  // Screenshots preview
  const shotsPreview = cachedScreenshots.slice(0, 4);

  // Notes preview
  const savedNotes = localStorage.getItem(`efxlve-overlay-notes::${context.appName}`) ?? "";

  el.innerHTML = `
    <div class="ov-dashboard">
      <!-- Session Card -->
      <div class="ov-card ov-span-12">
        <div class="ov-hero-banner">
          <div class="ov-hero-info">
            <div class="ov-hero-game">${esc(context.title || context.appName || "Game")}</div>
            <div class="ov-hero-status">
              <span class="ov-badge-pill">${storeLogo(store, 14)} <span>${esc(storeLabel(store))}</span></span>
              <span>·</span>
              <span style="color:var(--ok)">● ${esc(t("status.running", { title: "" }).trim() || "Running")}</span>
            </div>
          </div>
          <div class="ov-hero-actions">
            <button class="btn" data-ov="launcher">${icon("external", 14)} ${esc(t("overlay.openLauncher"))}</button>
          </div>
        </div>
      </div>

      <!-- Live Performance Card -->
      <div class="ov-card ov-span-6" data-nav-target="perf">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("cpu", 14)} <span class="title-text">${esc(t("overlay.tabPerformance"))}</span></div>
          <button class="ov-card-action" data-ov-tab="perf">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-perf-hero">
          <span class="ov-perf-val">${currentFps}</span>
          <span class="ov-perf-unit">FPS</span>
          <span class="ov-perf-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : ""}</span>
        </div>
        <canvas class="ov-perf-canvas" id="ov-home-perf-canvas"></canvas>
        <div class="ov-metrics-mini">
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.cpu"))}</span>
            <span class="ov-metric-num">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.gpu"))}</span>
            <span class="ov-metric-num">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.ram"))}</span>
            <span class="ov-metric-num">${m ? fmtMb(m.ramUsedMb) : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">HUD</span>
            <span class="ov-metric-num" style="display:flex;align-items:center;height:100%">
              <label class="switch" style="transform:scale(0.8)"><input type="checkbox" data-ov-toggle="hud" ${hudActive ? "checked" : ""} /><span class="track"></span></label>
            </span>
          </div>
        </div>
      </div>

      <!-- Achievements Card -->
      <div class="ov-card ov-span-6" data-nav-target="ach">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("trophy", 14)} <span class="title-text">${esc(t("overlay.tabAchievements"))}</span></div>
          <button class="ov-card-action" data-ov-tab="ach">${achTotal > 0 ? `${achUnlocked}/${achTotal}` : ""} ${icon("chevron-right", 16)}</button>
        </div>
        ${achTotal > 0 ? `
          <div class="ov-ach-summary">
            <div class="ov-ach-bar"><span style="width:${achPct}%"></span></div>
            <span class="ov-ach-pct">%${achPct}</span>
          </div>
          <div class="ov-ach-mini-list">
            ${recentAchs.map((item) => `
              <div class="ov-ach-item${item.unlocked ? " unlocked" : ""}">
                ${item.icon_link ? `<img class="ov-ach-thumb" src="${esc(item.icon_link)}" alt="" />` : `<span class="ov-ach-thumb"></span>`}
                <div class="ov-ach-meta">
                  <div class="ov-ach-name">${esc(item.display_name || item.name)}</div>
                  <div class="ov-ach-desc">${esc(item.description || "")}</div>
                </div>
                ${item.unlocked ? `<span style="color:var(--ok)">${icon("check", 14)}</span>` : ""}
              </div>`).join("")}
          </div>` : `
          <div class="ov-empty" style="padding:24px 0">${esc(t("overlay.noAchievements"))}</div>`}
      </div>

      <!-- Media Player Card -->
      <div class="ov-card ov-span-6 ov-media-card">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("volume-2", 14)} <span class="title-text">${esc(t("overlay.tabMusic"))}</span></div>
          <button class="ov-card-action" data-ov-tab="music">${icon("chevron-right", 16)}</button>
        </div>
        ${mediaState.available ? `
          <div class="ov-media-top">
            <div class="ov-media-icon">${icon("volume-2", 22)}</div>
            <div class="ov-media-details">
              <div class="ov-media-title">${esc(mediaState.title)}</div>
              <div class="ov-media-artist">${esc(mediaState.artist)}</div>
              <div class="ov-media-source">${esc(mediaState.source)}</div>
            </div>
          </div>
          <div class="ov-media-btns">
            <button class="icon-btn" data-ov="media-prev">${icon("chevron-left", 18)}</button>
            <button class="btn" data-ov="media-toggle" style="width:48px;justify-content:center">${icon(mediaState.playing ? "pause" : "play", 18)}</button>
            <button class="icon-btn" data-ov="media-next">${icon("chevron-right", 18)}</button>
          </div>` : `
          <div class="ov-empty" style="padding:24px 0">${esc(t("overlay.noMedia"))}</div>`}
      </div>

      <!-- Recent Screenshots Card -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("camera", 14)} <span class="title-text">${esc(t("overlay.tabScreenshots"))}</span></div>
          <button class="ov-card-action" data-ov-tab="shots">${icon("chevron-right", 16)}</button>
        </div>
        ${shotsPreview.length > 0 ? `
          <div class="ov-shots-grid">
            ${shotsPreview.map((s) => `
              <div class="ov-shot-item" data-ov-preview="${esc(s.data_url)}" title="${esc(s.date_str)}">
                <img src="${esc(s.data_url)}" alt="" loading="lazy" />
              </div>`).join("")}
          </div>` : `
          <div class="ov-empty" style="padding:24px 0">
            <div>${esc(t("overlay.noShots"))}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:4px">${esc(t("overlay.captureHint"))}</div>
          </div>`}
      </div>

      <!-- Quick Notes Card -->
      <div class="ov-card ov-span-12">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("edit", 14)} <span class="title-text">${esc(t("overlay.tabNotes"))}</span></div>
          <span style="font-size:11px;color:var(--text-3)" id="ov-home-notes-status">${savedNotes ? esc(t("overlay.saved")) : ""}</span>
        </div>
        <textarea class="ov-notes-area" id="ov-home-notes" placeholder="${esc(t("overlay.notesPlaceholder"))}" spellcheck="false">${esc(savedNotes)}</textarea>
      </div>
    </div>`;

  wireNotesInput("ov-home-notes", "ov-home-notes-status");
  drawPerfCanvas();
}

/* 2. Full Performance View */
function renderPerf(): void {
  const el = viewEl("perf");
  if (!el) return;
  const m = metrics;
  const hudActive = localStorage.getItem(HUD_KEY) === "true";

  el.innerHTML = `
    <div class="ov-page-title">${icon("cpu", 20)} <span>${esc(t("overlay.tabPerformance"))}</span></div>
    <div class="ov-card" style="margin-bottom:16px">
      <div class="ov-perf-hero">
        <span class="ov-perf-val">${m?.fps != null ? Math.round(m.fps) : "—"}</span>
        <span class="ov-perf-unit">FPS</span>
        <span class="ov-perf-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms frame time` : ""}</span>
      </div>
      <canvas class="ov-perf-canvas" id="ov-perf-canvas" style="height:140px"></canvas>
    </div>

    <div class="ov-dashboard" style="margin-bottom:16px">
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.cpu"))}</div>
        <div class="ov-perf-val" style="font-size:32px">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">Total: ${m ? `${Math.round(m.cpu)}%` : "—"}</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.gpu"))}</div>
        <div class="ov-perf-val" style="font-size:32px">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">GPU Utilization</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.vram"))}</div>
        <div class="ov-perf-val" style="font-size:32px">${m?.vramUsedMb != null ? fmtMb(m.vramUsedMb) : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">Video Memory</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.ram"))}</div>
        <div class="ov-perf-val" style="font-size:32px">${m ? fmtMb(m.ramUsedMb) : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">Total: ${m ? fmtMb(m.ramTotalMb) : "—"}</span>
      </div>
    </div>

    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.hudTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.hudDesc"))}</div>
      </div>
      <label class="switch"><input type="checkbox" data-ov-toggle="hud" ${hudActive ? "checked" : ""} /><span class="track"></span></label>
    </div>
    <p class="ov-note">${esc(t("overlay.perfNote"))}</p>`;

  drawPerfCanvas();
}

function drawPerfCanvas(): void {
  const canvasIds = ["ov-perf-canvas", "ov-home-perf-canvas"];
  for (const id of canvasIds) {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas) continue;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 600;
    const height = rect.height || 100;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.resetTransform?.();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const data = fpsHistory.length > 0 ? fpsHistory : [0];
    const max = Math.max(...data, 60) * 1.15;

    // Grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = height - height * (i * 0.25);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const len = 60;
    const step = width / (len - 1);
    const points = data.map((val, idx) => {
      const x = (idx + (len - data.length)) * step;
      const y = height - (val / max) * (height - 12) - 6;
      return [x, Math.max(6, Math.min(height - 6, y))] as const;
    });

    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        const [px, py] = points[i - 1];
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
      ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
      ctx.fill();
    }
  }
}

/* 3. Full Achievements View */
async function loadAchievements(force = false): Promise<void> {
  const el = viewEl("ach");
  if (!el) return;
  if (!cachedAchievements || force) {
    el.innerHTML = `<div class="ov-empty">${esc(t("ach.checking"))}</div>`;
    const { store, id } = splitKey(context.appName);
    try {
      if (store === "steam") {
        cachedAchievements = await invoke<AchievementsData>("steam_get_achievements", { appId: id, force: false });
      } else if (store === "gog") {
        cachedAchievements = await invoke<AchievementsData>("gog_get_achievements", { gameId: id });
      } else if (store === "epic") {
        cachedAchievements = await invoke<AchievementsData>("epic_get_achievements", { appName: context.appName, forceRefresh: false });
      } else {
        cachedAchievements = await invoke<AchievementsData>("companion_achievements", {
          store,
          id,
          title: context.title,
          language: currentLanguage(),
        });
      }
    } catch {
      cachedAchievements = null;
    }
  }

  const data = cachedAchievements;
  if (!data || !data.achievements || data.achievements.length === 0) {
    el.innerHTML = `
      <div class="ov-page-title">${icon("trophy", 20)} <span>${esc(t("overlay.tabAchievements"))}</span></div>
      <div class="ov-empty">${esc(t("overlay.noAchievements"))}</div>`;
    return;
  }

  const total = data.total_achievements || data.achievements.length;
  const unlocked = data.user_unlocked;
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;

  const rows = [...data.achievements]
    .sort((a, b) => Number(Boolean(b.unlocked)) - Number(Boolean(a.unlocked)))
    .map((item) => {
      const name = item.unlocked || !item.hidden ? item.display_name || item.name : t("ach.hiddenName");
      const desc = item.unlocked || !item.hidden ? item.description || "" : t("ach.hiddenDesc");
      return `
        <div class="ov-ach-row${item.unlocked ? " unlocked" : ""}">
          ${item.icon_link ? `<img class="ov-ach-icon" src="${esc(item.icon_link)}" alt="" loading="lazy" />` : `<span class="ov-ach-icon"></span>`}
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#fff">${esc(name)}</div>
            <div style="font-size:12px;color:var(--text-3)">${esc(desc)}</div>
          </div>
          <span class="ov-ach-state">${item.unlocked ? `${icon("check", 14)} ${esc(t("ach.earned"))}` : "·"}</span>
        </div>`;
    }).join("");

  el.innerHTML = `
    <div class="ov-page-title">${icon("trophy", 20)} <span>${esc(t("overlay.tabAchievements"))} (${unlocked}/${total})</span></div>
    <div class="ov-ach-summary" style="margin-bottom:18px">
      <div class="ov-ach-bar"><span style="width:${pct}%"></span></div>
      <span class="ov-ach-pct">%${pct}</span>
    </div>
    <div class="ov-ach-full-list">${rows}</div>`;
}

/* 4. Full Screenshots View */
async function loadScreenshots(force = false): Promise<void> {
  const el = viewEl("shots");
  if (!el) return;
  if (cachedScreenshots.length === 0 || force) {
    el.innerHTML = `<div class="ov-empty">${esc(t("common.calculating"))}</div>`;
    try {
      cachedScreenshots = await invoke<ScreenshotItem[]>("epic_get_game_screenshots", {
        appName: context.appName,
        title: context.title,
      });
    } catch {
      cachedScreenshots = [];
    }
  }

  el.innerHTML = `
    <div class="ov-page-title" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:10px">${icon("camera", 20)} <span>${esc(t("overlay.tabScreenshots"))}</span></div>
      <button class="btn ghost small" data-ov="shots-folder">${icon("folder", 14)} ${esc(t("overlay.openFolder"))}</button>
    </div>
    ${cachedScreenshots.length === 0 ? `
      <div class="ov-empty">
        <div>${esc(t("overlay.noShots"))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:6px">${esc(t("overlay.captureHint"))}</div>
      </div>` : `
      <div class="ov-shots-grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:12px">
        ${cachedScreenshots.map((item) => `
          <div class="ov-shot-item" data-ov-preview="${esc(item.data_url)}" title="${esc(item.date_str)}">
            <img src="${esc(item.data_url)}" alt="" loading="lazy" />
          </div>`).join("")}
      </div>`}`;
}

/* 5. Full Notes View */
function renderNotes(): void {
  const el = viewEl("notes");
  if (!el) return;
  const saved = localStorage.getItem(`efxlve-overlay-notes::${context.appName}`) ?? "";
  el.innerHTML = `
    <div class="ov-page-title" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:10px">${icon("edit", 20)} <span>${esc(t("overlay.tabNotes"))}</span></div>
      <span style="font-size:12px;color:var(--text-3)" id="ov-full-notes-status">${saved ? esc(t("overlay.saved")) : ""}</span>
    </div>
    <textarea class="ov-notes-area" id="ov-full-notes" style="height:380px" placeholder="${esc(t("overlay.notesPlaceholder"))}" spellcheck="false">${esc(saved)}</textarea>
    <p class="ov-note">${esc(t("overlay.notesHint"))}</p>`;

  wireNotesInput("ov-full-notes", "ov-full-notes-status");
}

function wireNotesInput(inputId: string, statusId: string): void {
  const area = document.getElementById(inputId) as HTMLTextAreaElement | null;
  area?.addEventListener("input", () => {
    if (notesSaveTimer) window.clearTimeout(notesSaveTimer);
    notesSaveTimer = window.setTimeout(() => {
      notesSaveTimer = null;
      localStorage.setItem(`efxlve-overlay-notes::${context.appName}`, area.value);
      const tag = document.getElementById(statusId);
      if (tag) tag.textContent = t("overlay.saved");
    }, 350);
  });
}

/* 6. Full Music View */
async function refreshMedia(): Promise<void> {
  try {
    mediaState = await invoke<MediaState>("overlay_media_state");
  } catch {
    mediaState = { available: false, title: "", artist: "", playing: false, source: "", positionS: 0, durationS: 0 };
  }

  const el = viewEl("music");
  if (!el) return;
  el.innerHTML = `
    <div class="ov-page-title">${icon("volume-2", 20)} <span>${esc(t("overlay.tabMusic"))}</span></div>
    <div class="ov-card" style="align-items:center;padding:48px 24px;text-align:center">
      <div class="ov-media-icon" style="width:72px;height:72px;border-radius:16px;margin-bottom:18px">
        ${icon("volume-2", 36)}
      </div>
      ${mediaState.available ? `
        <div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:4px">${esc(mediaState.title)}</div>
        <div style="font-size:15px;color:var(--text-2);margin-bottom:6px">${esc(mediaState.artist)}</div>
        <div style="font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:24px">${esc(mediaState.source)}</div>
        <div class="ov-media-btns" style="gap:16px">
          <button class="icon-btn" data-ov="media-prev" style="width:42px;height:42px">${icon("chevron-left", 22)}</button>
          <button class="btn" data-ov="media-toggle" style="width:58px;height:42px;justify-content:center">${icon(mediaState.playing ? "pause" : "play", 22)}</button>
          <button class="icon-btn" data-ov="media-next" style="width:42px;height:42px">${icon("chevron-right", 22)}</button>
        </div>` : `
        <div style="font-size:16px;font-weight:600;color:var(--text-2)">${esc(t("overlay.noMedia"))}</div>`}
    </div>
    <p class="ov-note" style="text-align:center;margin-top:16px">${esc(t("overlay.musicNote"))}</p>`;
}

/* 7. Discord View */
function renderDiscord(): void {
  const el = viewEl("discord");
  if (!el) return;
  el.innerHTML = `
    <div class="ov-page-title">${icon("users", 20)} <span>${esc(t("overlay.tabDiscord"))}</span></div>
    <div class="ov-dashboard">
      <div class="ov-card ov-span-12">
        <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:6px">${esc(t("overlay.discordPresenceTitle"))}</div>
        <p style="font-size:13px;color:var(--text-2);margin:0 0 16px">${esc(t("overlay.discordPresenceDesc"))}</p>
        <button class="btn" data-ov="open-discord">${icon("external", 14)} ${esc(t("overlay.openDiscord"))}</button>
      </div>
      <div class="ov-card ov-span-12">
        <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:6px">${esc(t("overlay.discordVoiceTitle"))}</div>
        <p style="font-size:13px;color:var(--text-2);margin:0">${esc(t("overlay.discordVoiceDesc"))}</p>
      </div>
    </div>`;
}

/* 8. Settings View */
function renderSettings(): void {
  const el = viewEl("settings");
  if (!el) return;
  const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
  const hud = localStorage.getItem(HUD_KEY) === "true";
  const opacity = Number(localStorage.getItem(OPACITY_KEY) ?? "100");
  const disabled = isDisabledGame(context.appName);
  const disabledList = disabledGames();

  el.innerHTML = `
    <div class="ov-page-title">${icon("settings", 20)} <span>${esc(t("overlay.tabSettings"))}</span></div>
    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.enabledTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.enabledDesc"))}</div>
      </div>
      <label class="switch"><input type="checkbox" data-ov-toggle="enabled" ${enabled ? "checked" : ""} /><span class="track"></span></label>
    </div>

    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.hudTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.hudDesc"))}</div>
      </div>
      <label class="switch"><input type="checkbox" data-ov-toggle="hud" ${hud ? "checked" : ""} /><span class="track"></span></label>
    </div>

    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.opacityTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.opacityDesc"))}</div>
      </div>
      <input type="range" min="60" max="100" step="1" value="${opacity}" data-ov-opacity style="width:160px" />
    </div>

    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.disableTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.disableDesc"))}</div>
      </div>
      <label class="switch"><input type="checkbox" data-ov-toggle="disable-game" ${disabled ? "checked" : ""} /><span class="track"></span></label>
    </div>

    ${disabledList.length > 0 ? `
      <div class="ov-card" style="margin-top:16px">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">${esc(t("overlay.disabledListTitle"))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">${esc(t("overlay.disabledListDesc"))}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${disabledList.map((g) => `
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:13px">${esc(g.title)}</span>
              <button class="btn ghost small" data-ov="restore-game" data-key="${esc(g.key)}">${esc(t("overlay.restore"))}</button>
            </div>`).join("")}
        </div>
      </div>` : ""}`;
}

function applyOpacity(val: number): void {
  const shell = document.getElementById("ov-shell");
  if (!shell) return;
  shell.classList.remove("ov-opacity-90", "ov-opacity-75", "ov-opacity-60");
  if (val <= 60) shell.classList.add("ov-opacity-60");
  else if (val <= 75) shell.classList.add("ov-opacity-75");
  else if (val < 100) shell.classList.add("ov-opacity-90");
}

/* ---------- Screenshot Lightbox ---------- */

function showLightbox(src: string): void {
  const box = document.getElementById("ov-lightbox");
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  if (!box || !img) return;
  img.src = src;
  box.style.display = "grid";
}

function hideLightbox(): void {
  const box = document.getElementById("ov-lightbox");
  if (box) box.style.display = "none";
}

/* ---------- Global Click & Change Wiring ---------- */

function wireEvents(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Tab button
    const tabBtn = target.closest<HTMLElement>("[data-ov-tab]");
    if (tabBtn?.dataset.ovTab) {
      setTab(tabBtn.dataset.ovTab as TabId);
      return;
    }

    // Screenshot preview
    const previewEl = target.closest<HTMLElement>("[data-ov-preview]");
    if (previewEl?.dataset.ovPreview) {
      showLightbox(previewEl.dataset.ovPreview);
      return;
    }

    // Actions
    const action = target.closest<HTMLElement>("[data-ov]")?.dataset.ov;
    if (!action) return;

    if (action === "close") void invoke("overlay_hide");
    else if (action === "launcher") void invoke("overlay_show_launcher");
    else if (action === "shots-folder") void invoke("epic_open_game_screenshots_folder", { appName: context.appName, title: context.title });
    else if (action === "close-lightbox") hideLightbox();
    else if (action === "open-discord") void openUrl("discord://");
    else if (action === "restore-game") {
      const key = target.closest<HTMLElement>("[data-ov]")?.dataset.key;
      if (key) {
        saveDisabled(disabledGames().filter((g) => g.key !== key));
        renderSettings();
      }
    } else if (action === "media-toggle") {
      void mediaControl(mediaState.playing ? "pause" : "play");
    } else if (action === "media-prev") {
      void mediaControl("previous");
    } else if (action === "media-next") {
      void mediaControl("next");
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    const toggle = input.dataset.ovToggle;
    if (toggle === "enabled") {
      localStorage.setItem(ENABLED_KEY, String(input.checked));
      void invoke("overlay_set_enabled", { enabled: input.checked });
    } else if (toggle === "hud") {
      localStorage.setItem(HUD_KEY, String(input.checked));
      void invoke("overlay_set_hud", { enabled: input.checked });
      // Sync other checkboxes if present
      document.querySelectorAll<HTMLInputElement>('input[data-ov-toggle="hud"]').forEach((chk) => {
        chk.checked = input.checked;
      });
    } else if (toggle === "disable-game") {
      const next = input.checked
        ? [...disabledGames().filter((i) => i.key !== context.appName), { key: context.appName, title: context.title || context.appName }]
        : disabledGames().filter((i) => i.key !== context.appName);
      saveDisabled(next);
      if (input.checked) void invoke("overlay_hide");
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.dataset.ovOpacity === undefined) return;
    const val = Number(input.value);
    localStorage.setItem(OPACITY_KEY, String(val));
    applyOpacity(val);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const lb = document.getElementById("ov-lightbox");
      if (lb && lb.style.display !== "none") {
        hideLightbox();
      } else {
        void invoke("overlay_hide");
      }
    }
  });

  window.addEventListener("mousemove", () => {
    document.body.classList.remove("ov-using-gamepad");
    removeGamepadFocus();
  });
}

async function mediaControl(action: string): Promise<void> {
  try {
    await invoke("overlay_media_control", { action });
  } catch {
    // Media session gone
  }
  void refreshMedia();
}

/* ---------- Controller & Gamepad Support ---------- */

let focusedIndex = -1;
let prevButtons: boolean[] = [];
let axisRepeatTimer = 0;
let lastAxisDir: "up" | "down" | "left" | "right" | null = null;

function removeGamepadFocus(): void {
  document.querySelectorAll(".ov-controller-focus").forEach((el) => {
    el.classList.remove("ov-controller-focus");
  });
}

function getFocusableElements(): HTMLElement[] {
  // Select active view interactive items and dock buttons
  const activeView = document.querySelector<HTMLElement>(".ov-view.active");
  const candidates: HTMLElement[] = [];

  // Dock items
  document.querySelectorAll<HTMLElement>(".ov-dock-btn").forEach((b) => candidates.push(b));
  // Resume button
  const resumeBtn = document.querySelector<HTMLElement>(".ov-btn-resume");
  if (resumeBtn) candidates.push(resumeBtn);

  if (activeView) {
    activeView.querySelectorAll<HTMLElement>("button, [data-ov-preview], .ov-card[data-nav-target], input, textarea").forEach((el) => {
      if (el.offsetParent !== null) candidates.push(el);
    });
  }

  return candidates;
}

function updateGamepadFocus(delta: number): void {
  const items = getFocusableElements();
  if (items.length === 0) return;

  focusedIndex = (focusedIndex + delta + items.length) % items.length;
  removeGamepadFocus();
  const target = items[focusedIndex];
  if (target) {
    target.classList.add("ov-controller-focus");
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function cycleTab(delta: number): void {
  const currentIdx = TABS.findIndex((t) => t.id === activeTab);
  const nextIdx = (currentIdx + delta + TABS.length) % TABS.length;
  setTab(TABS[nextIdx].id);
}

function pollGamepadLoop(): void {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = gamepads.find((p) => p && p.connected);

  const badgeEl = document.getElementById("ov-controller-badge");
  const badgeNameEl = document.getElementById("ov-controller-name");

  if (pad) {
    if (badgeEl && badgeEl.style.display === "none") {
      badgeEl.style.display = "inline-flex";
      const name = pad.id.toLowerCase().includes("playstation")
        ? "DualSense"
        : pad.id.toLowerCase().includes("nintendo")
        ? "Switch Pro"
        : "Controller";
      if (badgeNameEl) badgeNameEl.textContent = name;
    }

    // Detect button transitions
    const buttons = pad.buttons.map((b) => b.pressed);

    const isEdge = (idx: number): boolean => Boolean(buttons[idx] && !prevButtons[idx]);

    let anyInput = false;

    // A Button (0): Select / Activate
    if (isEdge(0)) {
      anyInput = true;
      const items = getFocusableElements();
      const current = items[focusedIndex];
      if (current) current.click();
    }

    // B Button (1): Back / Close
    if (isEdge(1)) {
      anyInput = true;
      const lb = document.getElementById("ov-lightbox");
      if (lb && lb.style.display !== "none") {
        hideLightbox();
      } else if (activeTab !== "home") {
        setTab("home");
      } else {
        void invoke("overlay_hide");
      }
    }

    // LB (4): Previous Tab
    if (isEdge(4)) {
      anyInput = true;
      cycleTab(-1);
    }

    // RB (5): Next Tab
    if (isEdge(5)) {
      anyInput = true;
      cycleTab(1);
    }

    // Start (9) or Guide (16): Close Overlay
    if (isEdge(9) || isEdge(16)) {
      anyInput = true;
      void invoke("overlay_hide");
    }

    // Directional (D-pad or Left Stick)
    const dpadUp = buttons[12];
    const dpadDown = buttons[13];
    const dpadLeft = buttons[14];
    const dpadRight = buttons[15];
    const axisY = pad.axes[1] || 0;
    const axisX = pad.axes[0] || 0;

    const stickUp = axisY < -0.45;
    const stickDown = axisY > 0.45;
    const stickLeft = axisX < -0.45;
    const stickRight = axisX > 0.45;

    let dir: "up" | "down" | "left" | "right" | null = null;
    if (dpadUp || stickUp) dir = "up";
    else if (dpadDown || stickDown) dir = "down";
    else if (dpadLeft || stickLeft) dir = "left";
    else if (dpadRight || stickRight) dir = "right";

    const now = Date.now();
    if (dir) {
      anyInput = true;
      if (dir !== lastAxisDir || now - axisRepeatTimer > 250) {
        lastAxisDir = dir;
        axisRepeatTimer = now;
        if (dir === "down" || dir === "right") updateGamepadFocus(1);
        else if (dir === "up" || dir === "left") updateGamepadFocus(-1);
      }
    } else {
      lastAxisDir = null;
    }

    if (anyInput) {
      document.body.classList.add("ov-using-gamepad");
    }

    prevButtons = buttons;
  } else {
    if (badgeEl && badgeEl.style.display !== "none") {
      badgeEl.style.display = "none";
    }
  }

  requestAnimationFrame(pollGamepadLoop);
}

/* ---------- Lifecycle ---------- */

async function onOpen(payload: OpenPayload): Promise<void> {
  context = payload;
  metrics = null;
  fpsHistory = [];
  cachedAchievements = null;
  cachedScreenshots = [];
  sessionStartEpoch = Date.now();

  if (context.appName && isDisabledGame(context.appName)) {
    void invoke("overlay_hide");
    return;
  }

  if (!document.getElementById("ov-shell")) {
    const root = document.getElementById("ov-root");
    if (!root) return;
    root.innerHTML = shellHtml();
    wireEvents();
    applyOpacity(Number(localStorage.getItem(OPACITY_KEY) ?? "100"));
  }

  const { store } = splitKey(context.appName);
  const titleEl = document.getElementById("ov-game-title");
  const subEl = document.getElementById("ov-game-sub");
  const storeEl = document.getElementById("ov-foot-store");

  if (titleEl) titleEl.textContent = context.title || context.appName;
  if (subEl) {
    subEl.innerHTML = `<span class="ov-badge-pill">${storeLogo(store, 12)} <span>${esc(storeLabel(store))}</span></span>`;
  }
  if (storeEl) {
    storeEl.innerHTML = `<span style="display:flex;align-items:center;gap:6px">${storeLogo(store, 12)} <span>${esc(storeLabel(store))}</span></span>`;
  }

  updateClock();
  setTab(activeTab || "home");
  void refreshMedia();
}

async function boot(): Promise<void> {
  await setLanguage(initialLanguage());

  const root = document.getElementById("ov-root");
  if (root && !document.getElementById("ov-shell")) {
    root.innerHTML = shellHtml();
    wireEvents();
  }

  clockTimer = window.setInterval(updateClock, 1000);
  mediaPollTimer = window.setInterval(() => {
    if (document.getElementById("ov-shell")) void refreshMedia();
  }, 2500);

  requestAnimationFrame(pollGamepadLoop);

  await listen<OpenPayload>("overlay-open", (event) => {
    void onOpen(event.payload);
  });

  await listen("overlay-close", () => {
    hideLightbox();
  });

  await listen<MetricsSample>("overlay-metrics", (event) => {
    metrics = event.payload;
    if (metrics.fps != null) {
      fpsHistory.push(metrics.fps);
      if (fpsHistory.length > 60) fpsHistory.shift();
    }
    if (activeTab === "perf") renderPerf();
    else if (activeTab === "home") renderHome();
  });

  try {
    const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
    const hud = localStorage.getItem(HUD_KEY) === "true";
    await invoke("overlay_set_enabled", { enabled });
    await invoke("overlay_set_hud", { enabled: hud });
  } catch {
    // Initial boot sync
  }
}

void boot();
