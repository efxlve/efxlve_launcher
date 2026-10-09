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
import {
  formatTime as formatSpotifyTime,
  spotifyControl,
  spotifyNowPlaying,
  spotifyStatus,
  type NowPlaying,
  type SpotifyStatus,
} from "../music/spotify-client";
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
  fpsAvailable: boolean;
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
/** Spotify Web API state (takes priority over the SMTC fallback). */
let spotifyState: SpotifyStatus | null = null;
let spotifyNow: NowPlaying | null = null;
let spotifyBaseMs = 0;
let spotifyBaseAt = 0;
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
    case "game": return t("overlay.gameLabel");
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

/** One-time Windows permission notice for the ETW FPS counter. */
let fpsEnableState: "idle" | "enabled" | "denied" = "idle";

function fpsNoticeHtml(m: MetricsSample | null): string {
  if (!m || m.fpsAvailable) return "";
  const text =
    fpsEnableState === "enabled"
      ? t("overlay.fpsEnabled")
      : fpsEnableState === "denied"
      ? t("overlay.fpsDenied")
      : t("overlay.fpsPermission");
  return `
    <div class="ov-fps-notice">
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

/** Hides the notice when the counter runs; creates it on the first sample. */
function updateFpsNotice(): void {
  const activeView = document.querySelector<HTMLElement>(".ov-view.active");
  const notices = activeView
    ? [...activeView.querySelectorAll<HTMLElement>(".ov-fps-notice")]
    : [];
  if (metrics?.fpsAvailable === true) {
    // Hide every notice, including ones parked in inactive views.
    document.querySelectorAll<HTMLElement>(".ov-fps-notice").forEach((el) => {
      el.hidden = true;
    });
    return;
  }
  if (!metrics) return;
  if (notices.length === 0) {
    // The view rendered before the first sample; re-render it so the notice
    // exists. Notices in other (hidden) views never block the active one.
    if (activeTab === "home") renderHomeSafe();
    else if (activeTab === "perf") renderPerf();
    return;
  }
  notices.forEach((el) => {
    el.hidden = false;
  });
  refreshFpsNotices();
}

async function enableFps(): Promise<void> {
  try {
    const status = await invoke<string>("overlay_enable_fps");
    fpsEnableState = status === "denied" ? "denied" : "enabled";
  } catch {
    fpsEnableState = "denied";
  }
  refreshFpsNotices();
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
            · ${esc(t("overlay.hintArrows"))} · ${esc(t("overlay.hintEnter"))}
          </span>
          <span class="gamepad-hints" style="display:none">
            <span class="ov-glyph-pill">Ⓐ ${esc(t("overlay.padSelect"))}</span>
            <span class="ov-glyph-pill">Ⓑ ${esc(t("overlay.padBack"))}</span>
            <span class="ov-glyph-pill">LB/RB ${esc(t("overlay.padTabs"))}</span>
            <span class="ov-glyph-pill">☰ ${esc(t("overlay.padClose"))}</span>
          </span>
        </div>
        <div class="ov-footer-right" id="ov-foot-store"></div>
      </footer>

      <!-- Screenshot Lightbox Modal -->
      <div class="ov-lightbox" id="ov-lightbox" style="display:none">
        <button class="ov-lightbox-nav ov-lightbox-prev" data-ov="lightbox-prev" title="${esc(t("overlay.previous"))}">${icon("chevron-left", 26)}</button>
        <div class="ov-lightbox-content">
          <img id="ov-lightbox-img" src="" alt="" />
          <div class="ov-lightbox-counter" id="ov-lightbox-counter"></div>
          <button class="ov-lightbox-close" data-ov="close-lightbox">${icon("x", 18)}</button>
        </div>
        <button class="ov-lightbox-nav ov-lightbox-next" data-ov="lightbox-next" title="${esc(t("overlay.next"))}">${icon("chevron-right", 26)}</button>
      </div>
    </div>`;
}

function viewEl(tab: TabId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ov-view="${tab}"]`);
}

/** Frame-time canvas plus the "waiting for data" label over it. */
function perfCanvasHtml(id: string, extraAttrs = ""): string {
  return `
    <div class="ov-perf-canvas-wrap">
      <canvas class="ov-perf-canvas" id="${id}"${extraAttrs}></canvas>
      <div class="ov-perf-empty">${esc(t("overlay.noFpsData"))}</div>
    </div>`;
}

/** Hides the "waiting for data" label as soon as FPS samples exist. */
function updatePerfEmptyStates(): void {
  const hasData = metrics?.fps != null || fpsHistory.length > 0;
  document.querySelectorAll<HTMLElement>(".ov-perf-empty").forEach((el) => {
    el.hidden = hasData;
  });
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
  else if (tab === "music") {
    renderMusicTab();
    void refreshMedia();
  } else if (tab === "discord") renderDiscord();
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
  if (activeTab === "music") paintSpotifyProgress();
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
              <span style="color:var(--ok)">● ${esc(t("overlay.running"))}</span>
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
          <span class="ov-perf-val${m?.fps != null ? "" : " is-empty"}" id="ov-home-fps">${currentFps}</span>
          <span class="ov-perf-unit">FPS</span>
          <span class="ov-perf-frame${m?.frameMs != null ? "" : " is-empty"}" id="ov-home-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : ""}</span>
        </div>
        ${perfCanvasHtml("ov-home-perf-canvas")}
        <div class="ov-metrics-mini">
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.cpu"))}</span>
            <span class="ov-metric-num${m ? "" : " is-empty"}" id="ov-home-cpu">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.gpu"))}</span>
            <span class="ov-metric-num${m?.gpu != null ? "" : " is-empty"}" id="ov-home-gpu">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.ram"))}</span>
            <span class="ov-metric-num${m ? "" : " is-empty"}" id="ov-home-ram">${m ? fmtMb(m.ramUsedMb) : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">HUD</span>
            <span class="ov-metric-num" style="display:flex;align-items:center;height:100%">
              <label class="switch" style="transform:scale(0.8)"><input type="checkbox" data-ov-toggle="hud" ${hudActive ? "checked" : ""} /><span class="track"></span></label>
            </span>
          </div>
        </div>
        ${fpsNoticeHtml(m)}
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
        ${mediaCardInnerHtml()}
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
  updatePerfEmptyStates();
}

/** Re-renders home only when it is the visible tab and nothing is being typed. */
function renderHomeSafe(): void {
  if (activeTab !== "home") return;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
  renderHome();
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
        <span class="ov-perf-val${m?.fps != null ? "" : " is-empty"}" id="ov-perf-fps">${m?.fps != null ? Math.round(m.fps) : "—"}</span>
        <span class="ov-perf-unit">FPS</span>
        <span class="ov-perf-frame${m?.frameMs != null ? "" : " is-empty"}" id="ov-perf-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms frame time` : ""}</span>
      </div>
      ${perfCanvasHtml("ov-perf-canvas", ' style="height:140px"')}
    </div>

    <div class="ov-dashboard" style="margin-bottom:16px">
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.cpu"))}</div>
        <div class="ov-perf-val${m ? "" : " is-empty"}" id="ov-perf-cpu" style="font-size:32px">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</div>
        <span id="ov-perf-cpu-total" style="font-size:11px;color:var(--text-3)">Total: ${m ? `${Math.round(m.cpu)}%` : "—"}</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.gpu"))}</div>
        <div class="ov-perf-val${m?.gpu != null ? "" : " is-empty"}" id="ov-perf-gpu" style="font-size:32px">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">GPU Utilization</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.vram"))}</div>
        <div class="ov-perf-val${m?.vramUsedMb != null ? "" : " is-empty"}" id="ov-perf-vram" style="font-size:32px">${m?.vramUsedMb != null ? fmtMb(m.vramUsedMb) : "—"}</div>
        <span style="font-size:11px;color:var(--text-3)">Video Memory</span>
      </div>
      <div class="ov-card ov-span-3">
        <div class="ov-metric-label">${esc(t("overlay.ram"))}</div>
        <div class="ov-perf-val${m ? "" : " is-empty"}" id="ov-perf-ram" style="font-size:32px">${m ? fmtMb(m.ramUsedMb) : "—"}</div>
        <span id="ov-perf-ram-total" style="font-size:11px;color:var(--text-3)">Total: ${m ? fmtMb(m.ramTotalMb) : "—"}</span>
      </div>
    </div>

    <div class="ov-setting-item">
      <div class="ov-setting-info">
        <div class="ov-setting-name">${esc(t("overlay.hudTitle"))}</div>
        <div class="ov-setting-desc">${esc(t("overlay.hudDesc"))}</div>
      </div>
      <label class="switch"><input type="checkbox" data-ov-toggle="hud" ${hudActive ? "checked" : ""} /><span class="track"></span></label>
    </div>
    ${fpsNoticeHtml(m)}
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

/* Patches the live numbers in place. A full re-render here would drop the
   notes textarea focus and the scroll position every second. */
function setText(id: string, text: string, empty = false): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("is-empty", empty);
}

function updateMetricsUi(): void {
  const m = metrics;
  updateFpsNotice();
  updatePerfEmptyStates();
  if (activeTab === "home" && viewEl("home")?.querySelector(".ov-card")) {
    setText("ov-home-fps", m?.fps != null ? String(Math.round(m.fps)) : "—", m?.fps == null);
    setText("ov-home-frame", m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : "", m?.frameMs == null);
    setText("ov-home-cpu", m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—", !m);
    setText("ov-home-gpu", m?.gpu != null ? `${Math.round(m.gpu)}%` : "—", m?.gpu == null);
    setText("ov-home-ram", m ? fmtMb(m.ramUsedMb) : "—", !m);
    drawPerfCanvas();
  } else if (activeTab === "perf" && document.getElementById("ov-perf-fps")) {
    setText("ov-perf-fps", m?.fps != null ? String(Math.round(m.fps)) : "—", m?.fps == null);
    setText("ov-perf-frame", m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms frame time` : "", m?.frameMs == null);
    setText("ov-perf-cpu", m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—", !m);
    setText("ov-perf-cpu-total", `Total: ${m ? `${Math.round(m.cpu)}%` : "—"}`);
    setText("ov-perf-gpu", m?.gpu != null ? `${Math.round(m.gpu)}%` : "—", m?.gpu == null);
    setText("ov-perf-vram", m?.vramUsedMb != null ? fmtMb(m.vramUsedMb) : "—", m?.vramUsedMb == null);
    setText("ov-perf-ram", m ? fmtMb(m.ramUsedMb) : "—", !m);
    setText("ov-perf-ram-total", `Total: ${m ? fmtMb(m.ramTotalMb) : "—"}`);
    drawPerfCanvas();
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
      if (store === "game") {
        // A title the launcher did not install: no store to ask.
        cachedAchievements = null;
      } else if (store === "steam") {
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
    renderHomeSafe();
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
        <div class="ov-ach-row${item.unlocked ? " unlocked" : ""}" data-nav-row>
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
  renderHomeSafe();
}

/* 4. Full Screenshots View */
async function loadScreenshots(force = false): Promise<void> {
  const el = viewEl("shots");
  if (!el) return;
  if (cachedScreenshots.length === 0 || force) {
    el.innerHTML = `<div class="ov-empty">${esc(t("common.calculating"))}</div>`;
    const { store } = splitKey(context.appName);
    if (store === "game") {
      // A title the launcher did not install: no store library to scan.
      cachedScreenshots = [];
    } else {
      try {
        cachedScreenshots = await invoke<ScreenshotItem[]>("epic_get_game_screenshots", {
          appName: context.appName,
          title: context.title,
        });
      } catch {
        cachedScreenshots = [];
      }
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
  renderHomeSafe();
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
/** Spotify when connected, the Windows media session otherwise. */
async function refreshMedia(): Promise<void> {
  const status = await spotifyStatus().catch(() => null);
  const wasActive = spotifyActive();
  spotifyState = status;

  if (status?.connected) {
    const now = await spotifyNowPlaying().catch(() => spotifyNow);
    if (now) {
      spotifyBaseMs = now.progressMs;
      spotifyBaseAt = Date.now();
    }
    spotifyNow = now;
  } else {
    spotifyNow = null;
    try {
      mediaState = await invoke<MediaState>("overlay_media_state");
    } catch {
      mediaState = { available: false, title: "", artist: "", playing: false, source: "", positionS: 0, durationS: 0 };
    }
  }

  if (spotifyActive() !== wasActive) {
    // The card layout changes with the source: rebuild the visible surface.
    if (activeTab === "music") renderMusicTab();
    else renderHomeSafe();
    return;
  }
  patchMediaSurfaces();
}

function spotifyActive(): boolean {
  return spotifyState?.connected === true;
}

/** Home dashboard media card content. */
function mediaCardInnerHtml(): string {
  if (spotifyActive()) {
    const now = spotifyNow;
    if (!now) return `<div class="ov-empty" style="padding:24px 0">${esc(t("overlay.noMedia"))}</div>`;
    return `
      <div class="ov-media-top">
        ${now.artUrl
          ? `<img class="ov-media-art" id="ov-media-art" src="${esc(now.artUrl)}" alt="" />`
          : `<div class="ov-media-icon">${icon("music", 22)}</div>`}
        <div class="ov-media-details">
          <div class="ov-media-title" id="ov-media-title">${esc(now.title)}</div>
          <div class="ov-media-artist" id="ov-media-artist">${esc(now.artist)}</div>
          <div class="ov-media-source" id="ov-media-source">Spotify${now.deviceName ? ` · ${esc(now.deviceName)}` : ""}</div>
        </div>
      </div>
      <div class="ov-media-btns">
        <button class="icon-btn" data-ov="media-prev">${icon("skip-back", 18)}</button>
        <button class="btn" data-ov="media-toggle" style="width:48px;justify-content:center" id="ov-media-toggle">${icon(now.isPlaying ? "pause" : "play", 18)}</button>
        <button class="icon-btn" data-ov="media-next">${icon("skip-forward", 18)}</button>
      </div>`;
  }
  if (mediaState.available) {
    return `
      <div class="ov-media-top">
        <div class="ov-media-icon">${icon("volume-2", 22)}</div>
        <div class="ov-media-details">
          <div class="ov-media-title" id="ov-media-title">${esc(mediaState.title)}</div>
          <div class="ov-media-artist" id="ov-media-artist">${esc(mediaState.artist)}</div>
          <div class="ov-media-source" id="ov-media-source">${esc(mediaState.source)}</div>
        </div>
      </div>
      <div class="ov-media-btns">
        <button class="icon-btn" data-ov="media-prev">${icon("chevron-left", 18)}</button>
        <button class="btn" data-ov="media-toggle" style="width:48px;justify-content:center" id="ov-media-toggle">${icon(mediaState.playing ? "pause" : "play", 18)}</button>
        <button class="icon-btn" data-ov="media-next">${icon("chevron-right", 18)}</button>
      </div>`;
  }
  return `<div class="ov-empty" style="padding:24px 0">${esc(t("overlay.noMedia"))}</div>`;
}

/* 6. Full Music View */
function renderMusicTab(): void {
  const el = viewEl("music");
  if (!el) return;
  const connected = spotifyActive();
  el.innerHTML = `
    <div class="ov-page-title">
      ${icon("music", 20)} <span>${esc(t("overlay.tabMusic"))}</span>
      ${connected ? `<span class="ov-badge-pill" style="margin-left:8px">${icon("volume-2", 12)} <span>${esc(spotifyState?.user || "Spotify")}</span></span>` : ""}
    </div>
    ${connected ? spotifyPlayerHtml() : smtcPlayerHtml()}
    <p class="ov-note" style="text-align:center;margin-top:16px">${esc(connected ? t("overlay.musicNoteSpotify") : t("overlay.musicNote"))}</p>`;
}

function spotifyPlayerHtml(): string {
  const now = spotifyNow;
  return `
    <div class="ov-card ov-sp-player">
      ${now?.artUrl
        ? `<img class="ov-sp-art" id="ov-sp-art" src="${esc(now.artUrl)}" alt="" />`
        : `<div class="ov-media-icon ov-sp-art">${icon("music", 40)}</div>`}
      <div class="ov-sp-info">
        <div class="ov-sp-title" id="ov-sp-title">${esc(now?.title || t("overlay.noMedia"))}</div>
        <div class="ov-sp-artist" id="ov-sp-artist">${esc(now?.artist || "")}</div>
        <div class="ov-sp-album" id="ov-sp-album">${esc(now?.album || "")}</div>
        <div class="ov-sp-progress" id="ov-sp-progress" data-ov="sp-seek">
          <div class="ov-sp-progress-fill" id="ov-sp-progress-fill"></div>
        </div>
        <div class="ov-sp-times"><span id="ov-sp-elapsed">0:00</span><span id="ov-sp-duration">${now ? formatSpotifyTime(now.durationMs) : "0:00"}</span></div>
        <div class="ov-sp-controls">
          <button class="icon-btn${now?.shuffle ? " active" : ""}" id="ov-sp-shuffle" data-ov="sp-shuffle" title="${esc(t("music.shuffle"))}">${icon("shuffle", 16)}</button>
          <button class="icon-btn" data-ov="sp-prev" title="${esc(t("music.previous"))}">${icon("skip-back", 20)}</button>
          <button class="btn" data-ov="sp-toggle" style="width:56px;height:44px;justify-content:center" id="ov-sp-toggle" title="${esc(t("music.playPause"))}">${icon(now?.isPlaying ? "pause" : "play", 20)}</button>
          <button class="icon-btn" data-ov="sp-next" title="${esc(t("music.next"))}">${icon("skip-forward", 20)}</button>
          <button class="icon-btn${now && now.repeat !== "off" ? " active" : ""}" id="ov-sp-repeat" data-ov="sp-repeat" title="${esc(t("music.repeat"))}">${icon("repeat", 16)}</button>
        </div>
        <div class="ov-sp-extras">
          <span class="ov-sp-device" id="ov-sp-device">${icon("monitor", 13)} ${esc(now?.deviceName || "")}</span>
          <span class="ov-sp-volume">${icon("volume-2", 14)}<input type="range" id="ov-sp-volume" min="0" max="100" value="${now?.volumePercent ?? 100}" /></span>
          ${now?.url ? `<button class="btn ghost small" data-ov="sp-open">${icon("external", 14)} ${esc(t("overlay.openSpotify"))}</button>` : ""}
        </div>
      </div>
    </div>`;
}

function smtcPlayerHtml(): string {
  return `
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
    </div>`;
}

/** In-place updates for whichever media surfaces exist right now. */
function patchMediaSurfaces(): void {
  const connected = spotifyActive();
  const homeTitle = document.getElementById("ov-media-title");
  if (homeTitle) {
    homeTitle.textContent = connected ? spotifyNow?.title || t("overlay.noMedia") : mediaState.title;
    setText("ov-media-artist", connected ? spotifyNow?.artist || "" : mediaState.artist);
    setText(
      "ov-media-source",
      connected
        ? `Spotify${spotifyNow?.deviceName ? ` · ${spotifyNow.deviceName}` : ""}`
        : mediaState.source,
    );
    const toggle = document.getElementById("ov-media-toggle");
    if (toggle) toggle.innerHTML = icon((connected ? spotifyNow?.isPlaying : mediaState.playing) ? "pause" : "play", 18);
  }

  if (document.getElementById("ov-sp-title")) {
    setText("ov-sp-title", spotifyNow?.title || t("overlay.noMedia"));
    setText("ov-sp-artist", spotifyNow?.artist || "");
    setText("ov-sp-album", spotifyNow?.album || "");
    setText("ov-sp-duration", spotifyNow ? formatSpotifyTime(spotifyNow.durationMs) : "0:00");
    const device = document.getElementById("ov-sp-device");
    if (device) device.innerHTML = `${icon("monitor", 13)} ${esc(spotifyNow?.deviceName || "")}`;
    const toggle = document.getElementById("ov-sp-toggle");
    if (toggle) toggle.innerHTML = icon(spotifyNow?.isPlaying ? "pause" : "play", 20);
    document.getElementById("ov-sp-shuffle")?.classList.toggle("active", Boolean(spotifyNow?.shuffle));
    const repeat = document.getElementById("ov-sp-repeat");
    if (repeat) {
      repeat.classList.toggle("active", Boolean(spotifyNow && spotifyNow.repeat !== "off"));
      repeat.classList.toggle("repeat-track", spotifyNow?.repeat === "track");
    }
    const volume = document.getElementById("ov-sp-volume") as HTMLInputElement | null;
    if (volume && document.activeElement !== volume && spotifyNow?.volumePercent != null) {
      volume.value = String(spotifyNow.volumePercent);
    }
    paintSpotifyProgress();
  }
}

/** Moves the music-tab progress bar between API polls. */
function paintSpotifyProgress(): void {
  const fill = document.getElementById("ov-sp-progress-fill");
  if (!fill) return;
  const now = spotifyNow;
  const duration = now?.durationMs || 0;
  let elapsed = spotifyBaseMs;
  if (now?.isPlaying) elapsed += Date.now() - spotifyBaseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
  setText("ov-sp-elapsed", formatSpotifyTime(elapsed));
}

/** Optimistic transport call from the overlay. */
async function overlaySpotifyControl(
  action: "play" | "pause" | "next" | "previous" | "seek" | "volume" | "shuffle" | "repeat",
  value?: number | null,
): Promise<void> {
  if (action === "play" || action === "pause") {
    if (spotifyNow) spotifyNow = { ...spotifyNow, isPlaying: action === "play" };
    patchMediaSurfaces();
  }
  try {
    await spotifyControl(action, value ?? null);
  } catch {
    // Poll below re-syncs from the API.
  }
  window.setTimeout(() => void refreshMedia(), 400);
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

let lightboxIndex = -1;

function lightboxIsOpen(): boolean {
  const box = document.getElementById("ov-lightbox");
  return !!box && box.style.display !== "none";
}

function showLightbox(src: string): void {
  const box = document.getElementById("ov-lightbox");
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  const counter = document.getElementById("ov-lightbox-counter");
  if (!box || !img) return;
  lightboxIndex = cachedScreenshots.findIndex((item) => item.data_url === src);
  img.src = src;
  if (counter) counter.textContent = lightboxIndex >= 0 && cachedScreenshots.length > 1 ? `${lightboxIndex + 1} / ${cachedScreenshots.length}` : "";
  box.style.display = "grid";
}

/** Steps through the screenshots while the lightbox is open (LB/RB, arrows). */
function stepLightbox(delta: number): void {
  const items = cachedScreenshots;
  if (lightboxIndex < 0 || items.length === 0) return;
  lightboxIndex = (lightboxIndex + delta + items.length) % items.length;
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  const counter = document.getElementById("ov-lightbox-counter");
  if (img) img.src = items[lightboxIndex].data_url;
  if (counter) counter.textContent = `${lightboxIndex + 1} / ${items.length}`;
}

function hideLightbox(): void {
  const box = document.getElementById("ov-lightbox");
  if (box) box.style.display = "none";
  lightboxIndex = -1;
}

/* ---------- Global Click & Change Wiring ---------- */

function wireEvents(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Lightbox backdrop closes the preview.
    const lightbox = document.getElementById("ov-lightbox");
    if (lightbox && target === lightbox) {
      hideLightbox();
      return;
    }

    // Tab button
    const tabBtn = target.closest<HTMLElement>("[data-ov-tab]");
    if (tabBtn?.dataset.ovTab) {
      setTab(tabBtn.dataset.ovTab as TabId);
      return;
    }

    // Dashboard card: the whole card opens its section.
    const navCard = target.closest<HTMLElement>("[data-nav-target]");
    if (navCard?.dataset.navTarget) {
      setTab(navCard.dataset.navTarget as TabId);
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
    else if (action === "lightbox-prev") stepLightbox(-1);
    else if (action === "lightbox-next") stepLightbox(1);
    else if (action === "enable-fps") void enableFps();
    else if (action === "open-discord") void openUrl("discord://");
    else if (action === "restore-game") {
      const key = target.closest<HTMLElement>("[data-ov]")?.dataset.key;
      if (key) {
        saveDisabled(disabledGames().filter((g) => g.key !== key));
        renderSettings();
      }
    } else if (action === "media-toggle") {
      if (spotifyActive()) void overlaySpotifyControl(spotifyNow?.isPlaying ? "pause" : "play");
      else void mediaControl(mediaState.playing ? "pause" : "play");
    } else if (action === "media-prev") {
      if (spotifyActive()) void overlaySpotifyControl("previous");
      else void mediaControl("previous");
    } else if (action === "media-next") {
      if (spotifyActive()) void overlaySpotifyControl("next");
      else void mediaControl("next");
    } else if (action === "sp-toggle") {
      void overlaySpotifyControl(spotifyNow?.isPlaying ? "pause" : "play");
    } else if (action === "sp-prev") {
      void overlaySpotifyControl("previous");
    } else if (action === "sp-next") {
      void overlaySpotifyControl("next");
    } else if (action === "sp-shuffle") {
      void overlaySpotifyControl("shuffle", spotifyNow?.shuffle ? 0 : 1);
    } else if (action === "sp-repeat") {
      const next = spotifyNow?.repeat === "off" ? 1 : spotifyNow?.repeat === "context" ? 2 : 0;
      void overlaySpotifyControl("repeat", next);
    } else if (action === "sp-seek") {
      const bar = document.getElementById("ov-sp-progress");
      const now = spotifyNow;
      if (bar && now?.durationMs) {
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        void overlaySpotifyControl("seek", Math.round(ratio * now.durationMs));
      }
    } else if (action === "sp-open") {
      if (spotifyNow?.url) void openUrl(spotifyNow.url);
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

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.id === "ov-sp-volume") {
      void overlaySpotifyControl("volume", Number(input.value));
    }
  });

  document.addEventListener("keydown", (event) => {
    // Shift+Tab is the global close hotkey; plain Tab would jump focus to
    // hidden nodes, so it is swallowed here.
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (isTextEntryFocused()) {
      if (event.key === "Escape") (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = dirs[event.key];
    if (dir) {
      event.preventDefault();
      if (focusedEl instanceof HTMLInputElement && focusedEl.type === "range" && (dir === "left" || dir === "right")) {
        adjustRange(focusedEl, dir === "right" ? 4 : -4);
        return;
      }
      moveFocus(dir);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateFocused();
      return;
    }
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      goBack();
    }
  });

  // Mouse or trackpad use takes the focus ring away; the next controller or
  // keyboard input brings it back.
  window.addEventListener("mousemove", onMouseActivity);
  document.addEventListener("mousedown", onMouseActivity);

  // The window is hidden while the panel is closed: rAF pauses and the pad
  // state (prevButtons) goes stale. Suppress input briefly on every re-show so
  // the button that opened the panel cannot close it on the first frame.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) gamepadSuppressUntil = performance.now() + 450;
  });
}

function onMouseActivity(): void {
  document.body.classList.remove("ov-using-gamepad");
  removeGamepadFocus();
}

async function mediaControl(action: string): Promise<void> {
  try {
    await invoke("overlay_media_control", { action });
  } catch {
    // Media session gone
  }
  void refreshMedia();
}

/* ---------- Controller & Keyboard Navigation ---------- */

type Dir = "up" | "down" | "left" | "right";

let focusedEl: HTMLElement | null = null;
let prevButtons: boolean[] = [];
let navRepeatAt = 0;
let lastDir: Dir | null = null;
/** Input is ignored briefly after open so the button that opened the panel
 *  (Guide / Start+Back, still held) cannot close it on the first frame. */
let gamepadSuppressUntil = 0;

function removeGamepadFocus(): void {
  document.querySelectorAll(".ov-controller-focus").forEach((el) => {
    el.classList.remove("ov-controller-focus");
  });
  focusedEl = null;
}

/** True while a text box owns the keyboard (arrow keys must move the caret). */
function isTextEntryFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "button", "submit"].includes(el.type);
  }
  return el.isContentEditable;
}

function isRenderable(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 && rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function getFocusableElements(): HTMLElement[] {
  const items: HTMLElement[] = [];
  const push = (el: Element | null) => {
    const node = el as HTMLElement | null;
    if (!node || items.includes(node) || !isRenderable(node)) return;
    items.push(node);
  };

  document.querySelectorAll(".ov-dock-btn").forEach(push);
  push(document.querySelector(".ov-btn-resume"));

  const activeView = document.querySelector<HTMLElement>(".ov-view.active");
  activeView?.querySelectorAll<HTMLElement>(
    "button, [data-ov-preview], [data-nav-row], .ov-card[data-nav-target], textarea, input",
  ).forEach((el) => {
    // Toggle switches hide their checkbox: the ring belongs on the label.
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      push(el.closest(".switch") ?? el);
    } else {
      push(el);
    }
  });

  return items;
}

function focusElement(el: HTMLElement | null): void {
  removeGamepadFocus();
  if (!el || !isRenderable(el)) return;
  focusedEl = el;
  el.classList.add("ov-controller-focus");
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function dockTabButton(tab: TabId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.ov-dock-btn[data-ov-tab="${tab}"]`);
}

function focusDefault(): void {
  focusElement(dockTabButton(activeTab) ?? getFocusableElements()[0] ?? null);
}

function ensureFocus(): void {
  if (focusedEl && focusedEl.isConnected) return;
  focusDefault();
}

/** Moves the ring to the nearest element in the pressed direction (2D map). */
function moveFocus(dir: Dir): void {
  ensureFocus();
  const items = getFocusableElements();
  if (items.length === 0) return;
  if (!focusedEl || !items.includes(focusedEl)) {
    focusDefault();
    return;
  }

  const cur = focusedEl.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of items) {
    if (el === focusedEl) continue;
    const rect = el.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - cx;
    const dy = rect.top + rect.height / 2 - cy;
    const inDir =
      dir === "left" ? dx < -6 :
      dir === "right" ? dx > 6 :
      dir === "up" ? dy < -6 :
      dy > 6;
    if (!inDir) continue;
    const horizontal = dir === "left" || dir === "right";
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + cross * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) focusElement(best);
}

function adjustRange(input: HTMLInputElement, step: number): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const next = Math.min(max, Math.max(min, Number(input.value) + step));
  if (next === Number(input.value)) return;
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function activateFocused(): void {
  ensureFocus();
  const el = focusedEl;
  if (!el || !el.isConnected) return;
  if (el instanceof HTMLInputElement && el.type === "range") return;
  if (el.classList.contains("switch")) {
    el.querySelector<HTMLInputElement>("input")?.click();
    return;
  }
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text")) {
    el.focus();
    return;
  }
  const switchesTab = el.matches("[data-nav-target], [data-ov-tab]");
  el.click();
  // A card or chevron that switched tabs hides the old view: the ring moves
  // to the new active dock button right away.
  window.setTimeout(() => {
    if (switchesTab || !focusedEl || !focusedEl.isConnected) focusElement(dockTabButton(activeTab));
  }, 0);
}

function cycleTab(delta: number): void {
  const currentIdx = TABS.findIndex((tab) => tab.id === activeTab);
  const nextIdx = (currentIdx + delta + TABS.length) % TABS.length;
  setTab(TABS[nextIdx].id);
  focusElement(dockTabButton(TABS[nextIdx].id));
}

/** B / Esc: close the lightbox, leave the text box, go home, then close. */
function goBack(): void {
  if (lightboxIsOpen()) {
    hideLightbox();
    return;
  }
  if (isTextEntryFocused()) {
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  if (activeTab !== "home") {
    setTab("home");
    focusElement(dockTabButton("home"));
    return;
  }
  void invoke("overlay_hide");
}

function pollGamepadLoop(): void {
  requestAnimationFrame(pollGamepadLoop);
  if (document.hidden) return;

  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = gamepads.find((p) => p && p.connected);

  const badgeEl = document.getElementById("ov-controller-badge");
  const badgeNameEl = document.getElementById("ov-controller-name");

  if (!pad) {
    if (badgeEl && badgeEl.style.display !== "none") {
      badgeEl.style.display = "none";
    }
    prevButtons = [];
    return;
  }

  if (badgeEl && badgeEl.style.display === "none") {
    badgeEl.style.display = "inline-flex";
    const id = pad.id.toLowerCase();
    const name = id.includes("playstation") || id.includes("dualsense") || id.includes("dualshock")
      ? "DualSense"
      : id.includes("nintendo") || id.includes("switch")
      ? "Switch Pro"
      : id.includes("xbox")
      ? "Xbox"
      : "Controller";
    if (badgeNameEl) badgeNameEl.textContent = name;
  }

  const buttons = pad.buttons.map((b) => b.pressed);

  // Swallow input right after the panel opened: the shortcut that opened it
  // (Guide, Start+Back) is usually still held on the first frames.
  if (performance.now() < gamepadSuppressUntil) {
    prevButtons = buttons;
    return;
  }

  const isEdge = (idx: number): boolean => Boolean(buttons[idx] && !prevButtons[idx]);
  let anyInput = false;

  // A (0): Select / Activate
  if (isEdge(0)) {
    anyInput = true;
    activateFocused();
  }

  // B (1): Back / Close
  if (isEdge(1)) {
    anyInput = true;
    goBack();
  }

  // LB (4) / RB (5): tabs, or previous/next screenshot in the lightbox.
  if (isEdge(4)) {
    anyInput = true;
    if (lightboxIsOpen()) stepLightbox(-1);
    else cycleTab(-1);
  }

  if (isEdge(5)) {
    anyInput = true;
    if (lightboxIsOpen()) stepLightbox(1);
    else cycleTab(1);
  }

  // Start (9) or Guide (16): close the overlay.
  if (isEdge(9) || isEdge(16)) {
    anyInput = true;
    void invoke("overlay_hide");
  }

  // Directional: D-pad or left stick.
  const dpadUp = buttons[12];
  const dpadDown = buttons[13];
  const dpadLeft = buttons[14];
  const dpadRight = buttons[15];
  const axisY = pad.axes[1] || 0;
  const axisX = pad.axes[0] || 0;

  let dir: Dir | null = null;
  if (dpadUp || axisY < -0.45) dir = "up";
  else if (dpadDown || axisY > 0.45) dir = "down";
  else if (dpadLeft || axisX < -0.45) dir = "left";
  else if (dpadRight || axisX > 0.45) dir = "right";

  const now = performance.now();
  if (dir) {
    anyInput = true;
    if (dir !== lastDir || now - navRepeatAt > 170) {
      lastDir = dir;
      navRepeatAt = now;
      if (focusedEl instanceof HTMLInputElement && focusedEl.type === "range" && (dir === "left" || dir === "right")) {
        adjustRange(focusedEl, dir === "right" ? 4 : -4);
      } else {
        moveFocus(dir);
      }
    }
  } else {
    lastDir = null;
  }

  // Right stick scrolls the open page without moving the ring.
  const scrollAxis = pad.axes[3] || 0;
  if (!lightboxIsOpen() && Math.abs(scrollAxis) > 0.28) {
    const main = document.getElementById("ov-main");
    if (main) main.scrollTop += scrollAxis * 22;
    anyInput = true;
  }

  if (anyInput) {
    document.body.classList.add("ov-using-gamepad");
    ensureFocus();
  }

  prevButtons = buttons;
}

/* ---------- Lifecycle ---------- */

async function onOpen(payload: OpenPayload): Promise<void> {
  context = payload;
  metrics = null;
  fpsHistory = [];
  cachedAchievements = null;
  cachedScreenshots = [];
  spotifyState = null;
  spotifyNow = null;
  spotifyBaseMs = 0;
  spotifyBaseAt = 0;
  sessionStartEpoch = Date.now();
  gamepadSuppressUntil = performance.now() + 450;

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

  hideLightbox();

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

  // Fill the dashboard cards in the background; the loads re-render home when
  // they land (they do not block the open).
  if (context.appName && store !== "game") {
    void loadAchievements();
    void loadScreenshots();
  }

  void refreshMedia();

  // A connected pad means the user wants controller affordances right away.
  const pad = navigator.getGamepads ? navigator.getGamepads().find((p) => p && p.connected) : undefined;
  if (pad) {
    document.body.classList.add("ov-using-gamepad");
    focusDefault();
  }
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
    removeGamepadFocus();
    document.body.classList.remove("ov-using-gamepad");
  });

  await listen<MetricsSample>("overlay-metrics", (event) => {
    metrics = event.payload;
    if (metrics.fps != null) {
      fpsHistory.push(metrics.fps);
      if (fpsHistory.length > 60) fpsHistory.shift();
    }
    updateMetricsUi();
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
