/**
 * In-game overlay panel (second window, shown by the Rust hotkey thread).
 *
 * Runs in its own webview over the game: Home, Performance, Screenshots,
 * Notes, Achievements, Music, Discord and Settings. It talks to the launcher
 * through the normal commands and the `overlay-*` / `overlay-metrics` events;
 * window visibility stays in Rust.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";
import { currentLanguage, initialLanguage, setLanguage, t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import "./overlay.css";

/* ---------- Local preferences (the main app re-applies them at boot) ---------- */

const ENABLED_KEY = "efxlve-overlay-enabled";
const HUD_KEY = "efxlve-overlay-hud";
const OPACITY_KEY = "efxlve-overlay-opacity";
const DISABLED_KEY = "efxlve-overlay-disabled-games";

/* ---------- Data shapes ---------- */

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

/* ---------- State ---------- */

let context: OpenPayload = { appName: "", title: "" };
let metrics: MetricsSample | null = null;
let fpsHistory: number[] = [];
let mediaTimer: number | null = null;
let notesTimer: number | null = null;
const loaded = { shots: false, achievements: false };

type TabId = "home" | "perf" | "shots" | "notes" | "ach" | "music" | "discord" | "settings";

const TABS: { id: TabId; icon: IconName; key: string }[] = [
  { id: "home", icon: "layers", key: "overlay.tabHome" },
  { id: "perf", icon: "cpu", key: "overlay.tabPerformance" },
  { id: "shots", icon: "camera", key: "overlay.tabScreenshots" },
  { id: "notes", icon: "edit", key: "overlay.tabNotes" },
  { id: "ach", icon: "trophy", key: "overlay.tabAchievements" },
  { id: "music", icon: "volume-2", key: "overlay.tabMusic" },
  { id: "discord", icon: "users", key: "overlay.tabDiscord" },
  { id: "settings", icon: "settings", key: "overlay.tabSettings" },
];

let activeTab: TabId = (localStorage.getItem("efxlve-overlay-tab") as TabId) || "home";

/* ---------- Helpers ---------- */

function splitKey(key: string): { store: string; id: string } {
  const index = key.indexOf("::");
  return index < 0
    ? { store: "epic", id: key }
    : { store: key.slice(0, index), id: key.slice(index + 2) };
}

function storeLabel(store: string): string {
  if (store === "epic") return "Epic Games";
  if (store === "gog") return "GOG";
  if (store === "steam") return "Steam";
  if (store === "amazon") return "Amazon Games";
  if (store === "xbox") return "Xbox";
  if (store === "battlenet") return "Battle.net";
  if (store === "ubisoft") return "Ubisoft Connect";
  if (store === "ea") return "EA App";
  if (store === "riot") return "Riot Games";
  return store;
}

function disabledGames(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function saveDisabled(list: string[]): void {
  localStorage.setItem(DISABLED_KEY, JSON.stringify(list));
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/* ---------- Render ---------- */

function shellHtml(): string {
  return `
    <div class="ov" id="ov-shell">
      <div class="ov-panel">
        <header class="ov-head">
          <span class="ov-cover" style="display:grid;place-items:center;color:var(--text-3)">${icon("gamepad-2", 18)}</span>
          <div class="ov-head-text">
            <div class="ov-title" id="ov-game-title">—</div>
            <div class="ov-sub" id="ov-game-sub"></div>
          </div>
          <button class="icon-btn" data-ov="close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </header>
        <nav class="ov-tabs">
          ${TABS.map((tab) => `
            <button class="ov-tab" data-ov-tab="${tab.id}">
              ${icon(tab.icon, 14)}<span>${esc(t(tab.key))}</span>
            </button>`).join("")}
        </nav>
        <main class="ov-body">
          <section class="ov-view" data-ov-view="home"></section>
          <section class="ov-view" data-ov-view="perf"></section>
          <section class="ov-view" data-ov-view="shots"></section>
          <section class="ov-view" data-ov-view="notes"></section>
          <section class="ov-view" data-ov-view="ach"></section>
          <section class="ov-view" data-ov-view="music"></section>
          <section class="ov-view" data-ov-view="discord"></section>
          <section class="ov-view" data-ov-view="settings"></section>
        </main>
        <footer class="ov-foot">
          <span class="ov-key">Shift</span><span>+</span><span class="ov-key">Tab</span>
          <span>${esc(t("overlay.hotkeyHint"))}</span>
          <span style="margin-left:auto" id="ov-foot-store"></span>
        </footer>
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
  // Views with transient data re-render on entry; screenshots and achievements
  // load lazily below.
  if (tab === "home") renderHome();
  if (tab === "perf") renderPerf();
  if (tab === "notes") renderNotes();
  if (tab === "discord") renderDiscord();
  if (tab === "settings") renderSettings();
  if (tab === "shots") void loadScreenshots();
  if (tab === "ach") void loadAchievements();
  if (tab === "music") {
    void refreshMedia();
    startMediaPolling();
  } else {
    stopMediaPolling();
  }
  if (tab === "perf") drawPerfCanvas();
}

/* ---------- Home ---------- */

function renderHome(): void {
  const el = viewEl("home");
  if (!el) return;
  const { store } = splitKey(context.appName);
  el.innerHTML = `
    <div class="ov-home-meta">
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("profile.currentActive"))}</div><div class="ov-stat-value">${esc(context.title || "—")}</div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("profile.store"))}</div><div class="ov-stat-value" style="display:flex;align-items:center;gap:8px">${storeLogo(store, 16)}<span>${esc(storeLabel(store))}</span></div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.fps"))}</div><div class="ov-stat-value">${metrics?.fps != null ? Math.round(metrics.fps) : "—"}</div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.cpu"))}</div><div class="ov-stat-value">${metrics ? `${Math.round(metrics.gameCpu ?? metrics.cpu)}%` : "—"}</div></div>
    </div>
    <div class="ov-actions">
      <button class="btn" data-ov="launcher">${icon("external", 14)} ${esc(t("overlay.openLauncher"))}</button>
      <button class="btn ghost" data-ov-tab="perf">${icon("cpu", 14)} ${esc(t("overlay.tabPerformance"))}</button>
      <button class="btn ghost" data-ov-tab="notes">${icon("edit", 14)} ${esc(t("overlay.tabNotes"))}</button>
    </div>
    <p class="ov-note">${esc(t("overlay.homeNote"))}</p>`;
}

/* ---------- Performance ---------- */

function renderPerf(): void {
  const el = viewEl("perf");
  if (!el) return;
  const m = metrics;
  el.innerHTML = `
    <div class="ov-perf-top">
      <span class="ov-fps">${m?.fps != null ? Math.round(m.fps) : "—"}</span>
      <span class="ov-fps-unit">FPS</span>
      <span class="ov-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : ""}</span>
    </div>
    <canvas id="ov-perf-canvas"></canvas>
    <div class="ov-metrics">
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.cpu"))}</div><div class="ov-stat-value">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.gpu"))}</div><div class="ov-stat-value">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.vram"))}</div><div class="ov-stat-value">${m?.vramUsedMb != null ? fmtMb(m.vramUsedMb) : "—"}</div></div>
      <div class="ov-stat"><div class="ov-stat-label">${esc(t("overlay.ram"))}</div><div class="ov-stat-value">${m ? `${fmtMb(m.ramUsedMb)} / ${fmtMb(m.ramTotalMb)}` : "—"}</div></div>
    </div>
    <p class="ov-note">${esc(t("overlay.perfNote"))}</p>`;
  drawPerfCanvas();
}

function drawPerfCanvas(): void {
  const canvas = document.getElementById("ov-perf-canvas") as HTMLCanvasElement | null;
  if (!canvas || activeTab !== "perf") return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || 640;
  const height = rect.height || 130;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const data = fpsHistory.length > 0 ? fpsHistory : [0];
  const max = Math.max(...data, 60) * 1.15;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i <= 3; i++) {
    const y = height - height * (i * 0.25);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const len = 60;
  const step = width / (len - 1);
  const points = data.map((value, index) => {
    const x = (index + (len - data.length)) * step;
    const y = height - (value / max) * (height - 12) - 6;
    return [x, Math.max(6, Math.min(height - 6, y))] as const;
  });
  if (points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      const [px, py] = points[i - 1];
      const mx = (px + x) / 2;
      ctx.quadraticCurveTo(px, py, mx, (py + y) / 2);
    }
    const [lx, ly] = points[points.length - 1];
    ctx.lineTo(lx, ly);
    ctx.strokeStyle = "#f2f2f2";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fill();
  }
}

/* ---------- Screenshots ---------- */

async function loadScreenshots(force = false): Promise<void> {
  const el = viewEl("shots");
  if (!el) return;
  if (loaded.shots && !force) return;
  loaded.shots = true;
  el.innerHTML = `<div class="ov-empty">${esc(t("common.calculating"))}</div>`;
  let items: ScreenshotItem[] = [];
  try {
    items = await invoke<ScreenshotItem[]>("epic_get_game_screenshots", {
      appName: context.appName,
      title: context.title,
    });
  } catch {
    items = [];
  }
  el.innerHTML = `
    <div class="ov-actions" style="margin-bottom:12px">
      <button class="btn ghost" data-ov="shots-folder">${icon("folder", 14)} ${esc(t("overlay.openFolder"))}</button>
      <span class="ov-note" style="margin:0">${esc(t("overlay.captureHint"))}</span>
    </div>
    ${items.length === 0
      ? `<div class="ov-empty">${esc(t("overlay.noShots"))}</div>`
      : `<div class="ov-shots">${items.slice(0, 12).map((item) => `
          <div class="ov-shot" title="${esc(item.date_str)}"><img src="${esc(item.data_url)}" alt="" loading="lazy" /></div>`).join("")}</div>`}`;
}

/* ---------- Notes ---------- */

function renderNotes(): void {
  const el = viewEl("notes");
  if (!el) return;
  const saved = localStorage.getItem(`efxlve-overlay-notes::${context.appName}`) ?? "";
  el.innerHTML = `
    <textarea class="ov-notes" id="ov-notes" placeholder="${esc(t("overlay.notesPlaceholder"))}" spellcheck="false">${esc(saved)}</textarea>
    <div class="ov-notes-hint"><span>${esc(t("overlay.notesHint"))}</span><span id="ov-notes-saved">${saved ? esc(t("overlay.saved")) : ""}</span></div>`;
  const area = document.getElementById("ov-notes") as HTMLTextAreaElement | null;
  area?.addEventListener("input", () => {
    if (notesTimer) window.clearTimeout(notesTimer);
    notesTimer = window.setTimeout(() => {
      notesTimer = null;
      localStorage.setItem(`efxlve-overlay-notes::${context.appName}`, area.value);
      const tag = document.getElementById("ov-notes-saved");
      if (tag) tag.textContent = t("overlay.saved");
    }, 400);
  });
}

/* ---------- Achievements ---------- */

async function loadAchievements(force = false): Promise<void> {
  const el = viewEl("ach");
  if (!el) return;
  if (loaded.achievements && !force) return;
  loaded.achievements = true;
  el.innerHTML = `<div class="ov-empty">${esc(t("ach.checking"))}</div>`;
  const { store, id } = splitKey(context.appName);
  let data: AchievementsData | null = null;
  try {
    if (store === "steam") {
      data = await invoke<AchievementsData>("steam_get_achievements", { appId: id, force: false });
    } else if (store === "gog") {
      data = await invoke<AchievementsData>("gog_get_achievements", { gameId: id });
    } else if (store === "epic") {
      data = await invoke<AchievementsData>("epic_get_achievements", { appName: context.appName, forceRefresh: false });
    } else {
      data = await invoke<AchievementsData>("companion_achievements", {
        store,
        id,
        title: context.title,
        language: currentLanguage(),
      });
    }
  } catch {
    data = null;
  }
  if (!data || data.achievements.length === 0) {
    el.innerHTML = `<div class="ov-empty">${esc(t("overlay.noAchievements"))}</div>`;
    return;
  }
  const total = data.total_achievements || data.achievements.length;
  const unlocked = data.user_unlocked;
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;
  const rows = [...data.achievements]
    .sort((a, b) => Number(Boolean(b.unlocked)) - Number(Boolean(a.unlocked)))
    .slice(0, 60)
    .map((item) => {
      const name = item.unlocked || !item.hidden ? item.display_name || item.name : t("ach.hiddenName");
      const desc = item.unlocked || !item.hidden ? item.description || "" : t("ach.hiddenDesc");
      return `
        <div class="ov-ach-row${item.unlocked ? " unlocked" : ""}">
          ${item.icon_link ? `<img class="ov-ach-icon" src="${esc(item.icon_link)}" alt="" loading="lazy" />` : `<span class="ov-ach-icon"></span>`}
          <div class="ov-ach-text">
            <div class="ov-ach-name">${esc(name)}</div>
            <div class="ov-ach-desc">${esc(desc)}</div>
          </div>
          <span class="ov-ach-state">${item.unlocked ? icon("check", 12) : "·"} ${item.unlocked ? esc(t("ach.earned")) : ""}</span>
        </div>`;
    })
    .join("");
  el.innerHTML = `
    <div class="ov-ach-head">
      <span class="ov-ach-count">${icon("trophy", 14)} ${unlocked} / ${total}</span>
      <div class="progress ov-ach-progress"><span style="width:${pct}%"></span></div>
      <span class="ov-ach-count">%${pct}</span>
    </div>
    <div class="ov-ach-list">${rows}</div>`;
}

/* ---------- Music ---------- */

async function refreshMedia(): Promise<void> {
  const el = viewEl("music");
  if (!el) return;
  let state: MediaState;
  try {
    state = await invoke<MediaState>("overlay_media_state");
  } catch {
    state = { available: false, title: "", artist: "", playing: false, source: "", positionS: 0, durationS: 0 };
  }
  el.innerHTML = `
    <div class="ov-music">
      <span style="color:var(--text-3)">${icon("volume-2", 34)}</span>
      ${state.available
        ? `<div class="ov-music-title">${esc(state.title)}</div>
           <div class="ov-music-artist">${esc(state.artist)}</div>
           <div class="ov-music-source">${esc(state.source)}</div>`
        : `<div class="ov-music-title">${esc(t("overlay.noMedia"))}</div>`}
      <div class="ov-music-controls">
        <button class="icon-btn" data-ov="media-prev" title="${esc(t("overlay.previous"))}">${icon("chevron-left", 20)}</button>
        <button class="btn" data-ov="media-toggle" style="width:46px;justify-content:center">${icon(state.playing ? "pause" : "play", 18)}</button>
        <button class="icon-btn" data-ov="media-next" title="${esc(t("overlay.next"))}">${icon("chevron-right", 20)}</button>
      </div>
    </div>
    <p class="ov-note" style="text-align:center">${esc(t("overlay.musicNote"))}</p>`;
}

function startMediaPolling(): void {
  if (mediaTimer !== null) return;
  mediaTimer = window.setInterval(() => {
    if (activeTab === "music") void refreshMedia();
  }, 2000);
}

function stopMediaPolling(): void {
  if (mediaTimer !== null) {
    window.clearInterval(mediaTimer);
    mediaTimer = null;
  }
}

/* ---------- Discord ---------- */

function renderDiscord(): void {
  const el = viewEl("discord");
  if (!el) return;
  el.innerHTML = `
    <div class="ov-discord">
      <div class="ov-discord-card">
        <h3>${esc(t("overlay.discordPresenceTitle"))}</h3>
        <p>${esc(t("overlay.discordPresenceDesc"))}</p>
      </div>
      <div class="ov-discord-card">
        <h3>${esc(t("overlay.discordVoiceTitle"))}</h3>
        <p>${esc(t("overlay.discordVoiceDesc"))}</p>
      </div>
      <div class="ov-actions">
        <button class="btn" data-ov="open-discord">${icon("external", 14)} ${esc(t("overlay.openDiscord"))}</button>
        <button class="btn ghost" data-ov="launcher">${icon("settings", 14)} ${esc(t("overlay.openLauncher"))}</button>
      </div>
    </div>`;
}

/* ---------- Settings ---------- */

function renderSettings(): void {
  const el = viewEl("settings");
  if (!el) return;
  const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
  const hud = localStorage.getItem(HUD_KEY) === "true";
  const opacity = Number(localStorage.getItem(OPACITY_KEY) ?? "100");
  const disabled = disabledGames().includes(context.appName);
  const toggle = (act: string, on: boolean): string =>
    `<label class="switch"><input type="checkbox" data-ov-toggle="${act}" ${on ? "checked" : ""} /><span class="track"></span></label>`;
  el.innerHTML = `
    <div class="ov-settings">
      <div class="ov-setting">
        <div class="ov-setting-text"><div class="ov-setting-title">${esc(t("overlay.enabledTitle"))}</div><div class="ov-setting-desc">${esc(t("overlay.enabledDesc"))}</div></div>
        ${toggle("enabled", enabled)}
      </div>
      <div class="ov-setting">
        <div class="ov-setting-text"><div class="ov-setting-title">${esc(t("overlay.hudTitle"))}</div><div class="ov-setting-desc">${esc(t("overlay.hudDesc"))}</div></div>
        ${toggle("hud", hud)}
      </div>
      <div class="ov-setting">
        <div class="ov-setting-text"><div class="ov-setting-title">${esc(t("overlay.opacityTitle"))}</div><div class="ov-setting-desc">${esc(t("overlay.opacityDesc"))}</div></div>
        <input type="range" min="60" max="100" step="1" value="${opacity}" data-ov-opacity style="width:160px" />
      </div>
      <div class="ov-setting">
        <div class="ov-setting-text"><div class="ov-setting-title">${esc(t("overlay.disableTitle"))}</div><div class="ov-setting-desc">${esc(t("overlay.disableDesc"))}</div></div>
        ${toggle("disable-game", disabled)}
      </div>
    </div>`;
}

function applyOpacity(value: number): void {
  const shell = document.getElementById("ov-shell");
  if (!shell) return;
  shell.classList.remove("ov-opacity-90", "ov-opacity-75", "ov-opacity-60");
  if (value <= 60) shell.classList.add("ov-opacity-60");
  else if (value <= 75) shell.classList.add("ov-opacity-75");
  else if (value < 100) shell.classList.add("ov-opacity-90");
}

/* ---------- Events ---------- */

async function applySettingsToRust(): Promise<void> {
  const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
  const hud = localStorage.getItem(HUD_KEY) === "true";
  try {
    await invoke("overlay_set_enabled", { enabled });
    await invoke("overlay_set_hud", { enabled: hud });
  } catch {
    // The Rust side will pick the defaults up on the next boot re-apply.
  }
}

function wireEvents(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const tabButton = target.closest<HTMLElement>("[data-ov-tab]");
    if (tabButton?.dataset.ovTab) {
      setTab(tabButton.dataset.ovTab as TabId);
      return;
    }
    const action = target.closest<HTMLElement>("[data-ov]")?.dataset.ov;
    if (!action) return;
    if (action === "close") void invoke("overlay_hide");
    else if (action === "launcher") void invoke("overlay_show_launcher");
    else if (action === "shots-folder") void invoke("epic_open_game_screenshots_folder", { appName: context.appName, title: context.title });
    else if (action === "open-discord") void openUrl("discord://");
    else if (action === "media-toggle") void mediaControl(mediaPlaying ? "pause" : "play");
    else if (action === "media-prev") void mediaControl("previous");
    else if (action === "media-next") void mediaControl("next");
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
    } else if (toggle === "disable-game") {
      const list = disabledGames();
      const next = input.checked
        ? [...new Set([...list, context.appName])]
        : list.filter((key) => key !== context.appName);
      saveDisabled(next);
      if (input.checked) void invoke("overlay_hide");
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.dataset.ovOpacity === undefined) return;
    const value = Number(input.value);
    localStorage.setItem(OPACITY_KEY, String(value));
    applyOpacity(value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void invoke("overlay_hide");
    }
  });
}

let mediaPlaying = false;

async function mediaControl(action: string): Promise<void> {
  try {
    await invoke("overlay_media_control", { action });
  } catch {
    // Nothing playing / session gone.
  }
  void refreshMedia();
}

/* ---------- Lifecycle ---------- */

async function onOpen(payload: OpenPayload): Promise<void> {
  context = payload;
  metrics = null;
  fpsHistory = [];
  loaded.shots = false;
  loaded.achievements = false;
  mediaPlaying = false;

  // Per-game opt-out: close immediately, the game keeps the key.
  if (disabledGames().includes(context.appName)) {
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
  const footEl = document.getElementById("ov-foot-store");
  if (titleEl) titleEl.textContent = context.title || context.appName;
  if (subEl) {
    subEl.innerHTML = `${storeLogo(store, 12)}<span>${esc(storeLabel(store))}</span><span>·</span><span>${esc(t("overlay.overlayLabel"))}</span>`;
  }
  if (footEl) footEl.textContent = context.appName;

  renderHome();
  renderPerf();
  renderNotes();
  renderDiscord();
  renderSettings();
  setTab(activeTab === "shots" || activeTab === "ach" ? "home" : activeTab);
  if (activeTab === "home") setTab("home");
}

async function boot(): Promise<void> {
  // The overlay is its own webview: load the dictionary the launcher saved.
  await setLanguage(initialLanguage());

  await listen<OpenPayload>("overlay-open", (event) => {
    void onOpen(event.payload);
  });
  await listen("overlay-close", () => {
    stopMediaPolling();
  });
  await listen<MetricsSample>("overlay-metrics", (event) => {
    metrics = event.payload;
    if (metrics.fps != null) {
      fpsHistory.push(metrics.fps);
      if (fpsHistory.length > 60) fpsHistory.shift();
    }
    if (activeTab === "perf") {
      renderPerf();
    } else if (activeTab === "home") {
      renderHome();
    }
  });

  // When the window is shown before the open event lands, show something.
  if (document.getElementById("ov-root") && !document.getElementById("ov-shell")) {
    const root = document.getElementById("ov-root");
    if (root) root.innerHTML = shellHtml();
    wireEvents();
  }

  // Re-apply persisted preferences once per overlay boot.
  void applySettingsToRust();
}

void boot();
