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
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BOOKMARKS_STORAGE_KEY,
  DEFAULT_BOOKMARKS,
  HOMEPAGE_STORAGE_KEY,
  loadBookmarks,
} from "./browser-shared";
import {
  activeCrosshair,
  applyNotificationOptions,
  commitCrosshair,
  commitHudConfig,
  handleSettingsToggle,
  paintCrosshairPreview,
  renderSettingsView,
  resetNotificationOptionsSession,
  scheduleCrosshairConfig,
  type SettingsDeps,
} from "./overlay-settings";
import {
  applyHudConfig,
  loadHudConfig,
  type HudConfig,
  type HudCorner,
  type HudMode,
} from "./overlay-hud-config";
import { OVERLAY_DISABLED_KEY, OVERLAY_ENABLED_KEY, OVERLAY_HUD_KEY, OVERLAY_OPACITY_KEY } from "../../core/constants";
import { HAS_NATIVE_CAPTURE, IS_WINDOWS } from "../../core/platform";
import { ensureNotesMigration, notesFontSize, onNotesChanged } from "../notes/notes-client";
import { handleOverlayNotesAction, overlayNotesScope, refreshOverlayNotes, renderOverlayNotes, setOverlayNotesScope, setOverlayNotesSettingsRepaint } from "../notes/overlay-notes";
import { ssToggleFavorite } from "../screenshots/ss-settings";
import { clipHotkeyName } from "../screenshots/ss-settings";
import { clipFolderPath, epicOpenFolderPath } from "../../epic";
import {
  clipCard,
  clipClock,
  configureClipWidget,
  loadLastClip,
  refreshClipWidget,
  startClipPolling,
  stopClipPolling,
  toggleClipRecording,
} from "./overlay-clips";
import {
  clearShotFilters,
  closeShotFilterPopover,
  configureScreenshots,
  cycleShotSort,
  hideLightbox,
  isShotFilterPopoverOpen,
  lightboxIsOpen,
  loadScreenshots,
  resetScreenshotsSession,
  showLightbox,
  stepLightbox,
  toggleShotFilterPopover,
  toggleShotGameFilter,
  toggleShotsFavoritesOnly,
} from "./overlay-screenshots";
import {
  activePerformanceMetric,
  applyMetricsSample,
  configurePerformance,
  enableFps,
  renderPerf,
  resetPerformanceSession,
  setPerformanceMetric,
  updateMetricsUi,
  type MetricsSample,
  type PerfMetric,
} from "./overlay-performance";
import { configureHome, renderHome, renderHomeSafe } from "./overlay-home";
import {
  achievementData,
  applyLiveAchievementUnlock,
  clearAchievementDetail,
  configureAchievements,
  hasAchievementDetail,
  loadAchievements,
  openAchDetail,
  openAchUrl,
  resetAchievementsSession,
  setAchievementFilter,
  startTrackerPolling,
  stopTrackerPolling,
  toggleAchievementReveal,
  toggleTrackedAchievement,
} from "./overlay-achievements";
import { SS_DENSITY_KEY, SS_SORT_KEY } from "../../core/constants";
import { discordPageVisible, overlayHotkeyLabel, spotifyPageVisible } from "../../core/page-visibility";
import { icon, type IconName } from "../../core/icons";
import { applyCrosshairConfig, type CrosshairConfig, type CrosshairHotkey, type CrosshairShape } from "../../core/crosshair";
import { esc } from "../../core/utils";
import { type AchievementNotificationOptions } from "../../steam";
import { initialLanguage, localizeMessage, setLanguage, t } from "../../i18n";
import {
  clearSpotifySearch,
  configureMusic,
  cycleSpotifyRepeat,
  cycleSpotifyShuffle,
  ensureSpotifyEngine,
  getOverlayMedia,
  mediaCardInnerHtml,
  mediaCardTitleHtml,
  openSpotifyLink,
  overlaySpotifyControl,
  paintSpotifyProgress,
  playTrack,
  refreshLibrary,
  refreshMedia,
  renderMusicTab,
  resetMusicSession,
  seekSpotifyFromPointer,
  selectPlaylist,
  setMusicViewMode,
  skipSpotifyTrack,
  toggleSpotifyMiniView,
  toggleSpotifyPlay,
  toggleSpotifySearch,
} from "./overlay-music";
import {
  configureAudio,
  handleAudioPresetAction,
  refreshAudio,
  renderAudio,
  startAudioPolling,
  stopAudioPolling,
  toggleAudioMasterMute,
  toggleAudioMute,
} from "./overlay-audio";
import {
  applyWidgetPinState,
  clampWidgetsIntoView,
  configureWidgets,
  ghostOpacity,
  initWidgetDragging,
  initWidgetResizing,
  isWidgetPinned,
  loadWidgetPos,
  loadWidgetSize,
  pinnedWidgetTabs,
  resetWidgetLayout,
  setWidgetPinned,
  syncPinnedToRust,
  syncWidgetSizeClasses,
} from "./overlay-widgets";
import {
  configureController,
  focusDefault,
  onMouseActivity,
  refreshDock,
  removeGamepadFocus,
  resetControllerSession,
  scheduleGamepadFrame,
  stopGamepadPolling,
  suppressGamepadInput,
  type Dir,
} from "./overlay-controller";
import {
  closeRecentMenu,
  configureChrome,
  initBatteryMonitoring,
  isRecentMenuOpen,
  launchRecentGame,
  paintBattery,
  refreshRecentGamesPill,
  shellHtml,
  showBatteryPercent,
  showClockSeconds,
  toggleRecentMenu,
} from "./overlay-chrome";
import { wireInputEvents } from "./overlay-inputs";
import {
  addFriend,
  answerFriendRequest,
  applyCallState,
  applyDmDeleted,
  applyDmEdited,
  applyDmResult,
  applyFriendsState,
  applyMessageDeleted,
  applyRequestDone,
  applyRequestSent,
  applySdkFriends,
  applySdkState,
  applySearchResults,
  applyStatusDone,
  applyVoiceState,
  applyWebVoice,
  cancelEdit,
  clearDiscordFilter,
  configureDiscord,
  endDiscordCall,
  isDiscordCallMuted,
  mergeHistory,
  muteDiscordCall,
  noteIncoming,
  notifyIncomingCall,
  openDiscordInLauncher,
  renderDiscordChat,
  renderDiscordSocial,
  runUserSearch,
  saveEdit,
  sendDiscordReply,
  setDiscordPickerMode,
  setDiscordStatus,
  startDiscordCall,
  startDiscordSdk,
  startEdit,
  selectReplyTarget,
  retryReply,
  deleteReply,
  refreshWebVoice,
  refreshSdkState,
  resetDiscordSession,
  type DiscordFriendsState,
  type DiscordVoiceState,
  type HistoryMessage,
  type SdkState,
  type WebVoiceState,
} from "./overlay-discord";
import { toast } from "../../core/toast";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "../../styles/tokens.css";
import "../../styles/components.css";
import "./overlay.css";

/* ---------- Constants & Storage ---------- */

const ENABLED_KEY = OVERLAY_ENABLED_KEY;
const HUD_KEY = OVERLAY_HUD_KEY;
const OPACITY_KEY = OVERLAY_OPACITY_KEY;
const DISABLED_KEY = OVERLAY_DISABLED_KEY;

/** Stored panel opacity, clamped to the slider's range. */
function savedOpacity(): number {
  const raw = Number(localStorage.getItem(OPACITY_KEY) ?? "100");
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 100;
}

function applyOpacity(val: number): void {
  const shell = document.getElementById("ov-shell");
  if (!shell) return;
  const pct = Math.max(0, Math.min(100, val)) / 100;
  shell.style.setProperty("--ov-panel-alpha", String(pct));
  // 100% keeps the palette's designed scrim; lower values fade it with the
  // panels so the game really shows through instead of hitting a 60% floor.
  shell.style.setProperty("--ov-scrim-alpha", String(pct * 0.45));
}

/* ---------- Native HUD appearance ---------- */

/* ---------- Data Types ---------- */

interface OpenPayload {
  appName: string;
  title: string;
}

type TabId = "home" | "perf" | "ach" | "shots" | "clip" | "notes" | "music" | "audio" | "discord" | "chat" | "browser" | "settings";

/**
 * The Browser tab is built and working (window, tabs, commands), but it stays
 * out of the dock for now: 0.1.28 ships without it while the panel/browser
 * pairing settles. Bringing it back is this one flag — set it to true.
 */
const BROWSER_TAB_ENABLED = true;

const TABS: { id: TabId; icon: IconName; key: string }[] = [
  { id: "perf", icon: "activity", key: "overlay.tabPerformance" },
  { id: "shots", icon: "camera", key: "overlay.tabScreenshots" },
  { id: "clip", icon: "video", key: "overlay.tabClips" },
  { id: "music", icon: "spotify", key: "overlay.tabSpotify" },
  { id: "audio", icon: "volume-2", key: "overlay.tabAudio" },
  { id: "discord", icon: "discord", key: "overlay.tabDiscord" },
  { id: "chat", icon: "discord", key: "overlay.discordChat" },
  { id: "ach", icon: "trophy", key: "overlay.tabAchievements" },
  { id: "browser", icon: "globe", key: "overlay.tabBrowser" },
  { id: "notes", icon: "edit", key: "overlay.tabNotes" },
  { id: "settings", icon: "settings", key: "overlay.tabSettings" },
];

/** Pages turned off in the launcher's settings disappear here too. */
function visibleTabs(): typeof TABS {
  return TABS.filter(
    (tab) =>
      tab.id !== "chat" &&
      tab.id !== "settings" &&
      (BROWSER_TAB_ENABLED || tab.id !== "browser") &&
      (HAS_NATIVE_CAPTURE || (tab.id !== "shots" && tab.id !== "clip")) &&
      (tab.id !== "audio" || IS_WINDOWS) &&
      (tab.id !== "music" || (IS_WINDOWS && spotifyPageVisible())) &&
      (tab.id !== "discord" || (IS_WINDOWS && discordPageVisible())),
  );
}

/* ---------- State ---------- */

let context: OpenPayload = { appName: "", title: "" };
/** True once `onOpen` has laid out the panel for the current session. */
let panelOpened = false;
/** Opened without a tracked game (over the launcher or any other window). */
let launcherMode = false;
let sessionStartEpoch = Date.now();
let activeTab: TabId = (localStorage.getItem("efxlve-overlay-tab") as TabId) || "home";
if (!IS_WINDOWS && (activeTab === "shots" || activeTab === "clip")) activeTab = "home";
let browserBounds: { x: number; y: number; w: number; h: number } | null = null;
/** Games with capture turned off, for the settings widget's per-game row. */
let overlayDisabledGames: string[] = [];
let overlayDisabledGamesFetched = false;

let mediaPollTimer: number | null = null;
let clockTimer: number | null = null;

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

/** `game::` contexts come from openings without a tracked game. */
function isLauncherContext(payload: OpenPayload): boolean {
  return !payload.appName || payload.appName.startsWith("game::");
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

function formatSessionTime(ms: number): string {
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/* ---------- Xbox Game Bar Floating Widget System ---------- */

const DEFAULT_WIDGETS: TabId[] = ["perf", "music"];
let openWidgets = new Set<TabId>();

/** The default set follows the pages the user kept enabled. */
function defaultWidgets(): TabId[] {
  const allowed = new Set(visibleTabs().map((tab) => tab.id));
  return DEFAULT_WIDGETS.filter((id) => allowed.has(id));
}

function loadOpenWidgets(): Set<TabId> {
  try {
    const raw = localStorage.getItem("efxlve-overlay-widgets");
    if (raw) {
      const parsed = JSON.parse(raw);
      // An empty array is a real state (the user closed every widget): the
      // defaults are only for a profile that never saved a layout.
      if (Array.isArray(parsed)) {
        // Do not resurrect a widget whose page was disabled in the launcher:
        // it would float without a topbar toggle. Settings and the DM companion
        // are not regular pages, so keep them out of this filter.
        const pages = new Set(visibleTabs().map((tab) => tab.id));
        const allowed = (id: TabId): boolean =>
          id === "settings" ||
          (id === "chat" ? pages.has("discord") : pages.has(id));
        return new Set(
          parsed.filter(
            (id) => TABS.some((t) => t.id === id) && allowed(id as TabId),
          ) as TabId[],
        );
      }
    }
  } catch {
    // fallback
  }
  return new Set(defaultWidgets());
}

function saveOpenWidgets(): void {
  localStorage.setItem("efxlve-overlay-widgets", JSON.stringify([...openWidgets]));
}

function isWidgetOpen(tab: TabId): boolean {
  return openWidgets.has(tab);
}

let highestZIndex = 100;

function bringToFront(tab: TabId): void {
  activeTab = tab;
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) {
    highestZIndex += 1;
    widget.style.zIndex = String(highestZIndex);
  }
  void invoke("overlay_raise").catch(() => undefined);
}

function renderWidgetContent(tab: TabId): void {
  if (launcherMode && GAME_ONLY_TABS.includes(tab)) {
    const el = viewEl(tab);
    if (el) el.innerHTML = noGameStateHtml(tab);
    return;
  }
  if (tab === "perf") renderPerf();
  else if (tab === "ach") void loadAchievements();
  else if (tab === "shots") void loadScreenshots();
  else if (tab === "clip") startClipPolling();
  else if (tab === "notes") renderOverlayNotes();
  else if (tab === "music") {
    renderMusicTab();
    void refreshMedia();
  } else if (tab === "audio") {
    renderAudio();
    startAudioPolling();
  } else if (tab === "discord") {
    renderDiscordSocial();
    void invoke("discord_voice_watch_start").catch(() => undefined);
    void refreshWebVoice();
    void refreshSdkState();
  } else if (tab === "chat") {
    renderDiscordChat();
    void refreshSdkState();
  } else if (tab === "browser") {
    void invoke("overlay_browser_open", { url: null });
  } else if (tab === "settings") {
    renderSettings();
  }
}

function openWidget(tab: TabId, render = true): void {
  openWidgets.add(tab);
  saveOpenWidgets();
  syncPinnedToRust();

  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) {
    const size = loadWidgetSize(tab);
    widget.style.width = `${size.w}px`;
    widget.style.height = `${size.h}px`;
    // The open event positions every widget, but a widget toggled from the
    // launcher harness or a restored shell can arrive without an inline place.
    if (!widget.style.left || !widget.style.top) {
      const pos = loadWidgetPos(tab);
      widget.style.left = `${pos.x}px`;
      widget.style.top = `${pos.y}px`;
    }
    syncWidgetSizeClasses(tab, size.w, size.h);
    widget.style.display = "flex";
    bringToFront(tab);
  }
  applyWidgetPinState(tab);

  const toggleBtn = document.querySelector<HTMLElement>(`[data-ov-widget-toggle="${tab}"]`);
  if (toggleBtn) toggleBtn.classList.add("active");

  if (render) renderWidgetContent(tab);

  if (tab === "ach") startTrackerPolling();
  if (tab === "discord") {
    void invoke("discord_voice_watch_start").catch(() => undefined);
    void refreshWebVoice();
    void refreshSdkState();
  } else if (tab === "music") {
    void refreshMedia();
  }
}

function closeWidget(tab: TabId): void {
  openWidgets.delete(tab);
  saveOpenWidgets();
  syncPinnedToRust();

  if (tab === "clip") stopClipPolling();
  if (tab === "audio") stopAudioPolling();
  if (tab === "ach") {
    stopTrackerPolling();
    clearAchievementDetail(false);
  }

  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) widget.style.display = "none";

  const toggleBtn = document.querySelector<HTMLElement>(`[data-ov-widget-toggle="${tab}"]`);
  if (toggleBtn) toggleBtn.classList.remove("active");

  if (tab === "discord" && !isWidgetOpen("discord")) {
    void invoke("discord_voice_watch_stop").catch(() => undefined);
  }
}

function toggleWidget(tab: TabId): void {
  if (tab === "browser") {
    const toggleBtn = document.querySelector<HTMLElement>('[data-ov-widget-toggle="browser"]');
    const currentlyActive = toggleBtn?.classList.contains("active");
    if (currentlyActive) {
      void invoke("overlay_browser_close");
      if (toggleBtn) toggleBtn.classList.remove("active");
      openWidgets.delete("browser");
    } else {
      void invoke("overlay_browser_open", { url: null });
      if (toggleBtn) toggleBtn.classList.add("active");
      openWidgets.add("browser");
    }
    saveOpenWidgets();
    return;
  }
  if (isWidgetOpen(tab)) {
    closeWidget(tab);
  } else {
    openWidget(tab);
  }
}

function viewEl(tab: TabId): HTMLElement | null {
  return (
    document.getElementById(`ov-widget-${tab}-body`) ||
    document.querySelector<HTMLElement>(`[data-ov-view="${tab}"]`)
  );
}

/** Frame-time canvas plus the "waiting for data" label over it. */
function setTab(tab: TabId, fromOpen = false): void {
  // Spotify playback and the Discord social SDK are Windows-only backends; the
  // shortcuts on the home cards must not open a tab that cannot work.
  if (!IS_WINDOWS && (tab === "music" || tab === "discord" || tab === "shots" || tab === "clip")) {
    return;
  }
  activeTab = tab;
  localStorage.setItem("efxlve-overlay-tab", tab);
  if (tab === "home") {
    for (const t of defaultWidgets()) openWidget(t);
    return;
  }
  openWidget(tab);
  bringToFront(tab);
}

/** Tabs that only make sense with a running game. */
const GAME_ONLY_TABS: TabId[] = ["ach", "clip"];

/** Friendly stand-in for a game-only tab while the overlay runs over the launcher. */
function noGameStateHtml(tab: TabId): string {
  const meta = TABS.find((entry) => entry.id === tab);
  return `
    <div class="ov-page-title">${icon(meta?.icon ?? "layers", 20)} <span>${esc(t(meta?.key ?? "overlay.tabHome"))}</span></div>
    <div class="ov-empty-block">
      <div class="ov-empty-icon">${icon("gamepad-2", 26)}</div>
      <div class="ov-empty-title">${esc(t("overlay.noGameTab"))}</div>
      <div class="ov-empty-desc">${esc(t("overlay.noGameTabDesc"))}</div>
      <button class="btn ghost small" data-ov="launcher">${icon("external", 13)} ${esc(t("overlay.openLauncher"))}</button>
    </div>`;
}

/* ---------- Clips (recorder widget) ---------- */
// The widget lives in overlay-clips.ts; configureClipWidget() supplies the
// page queries it must not import.

/* ---------- Live Clock & Session ---------- */

function updateClock(): void {  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const secs = String(now.getSeconds()).padStart(2, "0");

  const timeEl = document.getElementById("ov-clock-time");
  const secEl = document.getElementById("ov-clock-sec");
  const sessionEl = document.getElementById("ov-session-text");

  if (timeEl) timeEl.textContent = `${hours}:${mins}`;
  if (secEl) {
    secEl.textContent = `:${secs}`;
    secEl.style.display = showClockSeconds() ? "inline" : "none";
  }
  if (sessionEl) sessionEl.textContent = formatSessionTime(Date.now() - sessionStartEpoch);
  if (isWidgetOpen("music")) paintSpotifyProgress();
}

/* ---------- Views Rendering ---------- */

/* 1. Home / Overview Modular Dashboard */
// The dashboard lives in overlay-home.ts; the wrapper supplies the
// page-owned context, widget queries and media helpers.

/* 3. Full Achievements View */
// The list, detail page and tracker live in overlay-achievements.ts; the
// wrapper supplies the page-owned context and widget queries.

/* 4. Full Screenshots View */
// The gallery and lightbox live in overlay-screenshots.ts.

/* 5. Full Notes View */
/** The notes widget lives in `notes/overlay-notes.ts`: the same list the
 * launcher's Notes page and the game drawer write. */
function renderNotes(): void {
  renderOverlayNotes();
}

/* 6. Full Music View */
// The player, library and Spotify widget live in overlay-music.ts.

/* 7. Browser View */
/**
 * The panel cannot host pages itself, so the tab is only the doorway: the
 * browser window floats over the game with its own tab strip and opens the
 * moment the tab is picked (no second button to hunt for). `renderWidgetContent`
 * is the whole view — there is no widget body for it.
 */

/* 9. Settings View */
// Rendering lives in overlay-settings.ts; this wrapper supplies the
// overlay-owned state that module must not import.
function settingsDeps(): SettingsDeps {
  return {
    context: () => context,
    launcherMode: () => launcherMode,
    isSettingsOpen: () => isWidgetOpen("settings"),
    settingsBody: () => viewEl("settings"),
    repaint: () => {
      const body = viewEl("settings");
      const scroll = body?.scrollTop ?? 0;
      renderSettingsView(settingsDeps());
      if (body) body.scrollTop = scroll;
    },
    savedOpacity,
    overlayDisabledGames: () => overlayDisabledGames,
    setOverlayDisabledGames: (list) => {
      overlayDisabledGames = list;
    },
    overlayDisabledGamesFetched: () => overlayDisabledGamesFetched,
    markOverlayDisabledGamesFetched: () => {
      overlayDisabledGamesFetched = true;
    },
    disabledGames,
    saveDisabled,
    isDisabledGame,
    clockSeconds: showClockSeconds,
    batteryPercent: showBatteryPercent,
    updateClock,
    paintBattery,
    tabs: () => TABS,
    pinnedTabs: () => pinnedWidgetTabs(),
    ghostOpacity: (tab) => ghostOpacity(tab as TabId),
  };
}

function renderSettings(): void {
  renderSettingsView(settingsDeps());
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

    // Screenshot star: toggles a favorite without opening the lightbox.
    const favBtn = target.closest<HTMLElement>('[data-ov="ov-shot-favorite"]');
    if (favBtn) {
      const path = favBtn.dataset.path ?? "";
      if (path) {
        ssToggleFavorite(path);
        void loadScreenshots();
      }
      return;
    }

    // The notes widget has its own module: list, editor, checklists.
    const notesActionEl = target.closest<HTMLElement>("[data-ov]");
    if (notesActionEl && handleOverlayNotesAction(notesActionEl.dataset.ov, notesActionEl)) return;

    // Backdrop click outside any widget and topbar closes the overlay, unless clicking over the browser window
    if (target.id === "ov-shell" || target.id === "ov-widgets-container") {
      // The browser reports screen coordinates; the click is overlay-local.
      const localX = browserBounds ? browserBounds.x - (window.screenX || 0) : 0;
      const localY = browserBounds ? browserBounds.y - (window.screenY || 0) : 0;
      if (
        browserBounds &&
        isWidgetOpen("browser") &&
        event.clientX >= localX &&
        event.clientX <= localX + browserBounds.w &&
        event.clientY >= localY &&
        event.clientY <= localY + browserBounds.h
      ) {
        void invoke("overlay_browser_raise").catch(() => undefined);
        return;
      }
      void invoke("overlay_hide");
      return;
    }

    // Topbar widget toggle button
    const widgetToggleBtn = target.closest<HTMLElement>("[data-ov-widget-toggle]");
    if (widgetToggleBtn?.dataset.ovWidgetToggle) {
      toggleWidget(widgetToggleBtn.dataset.ovWidgetToggle as TabId);
      return;
    }

    // Widget header close button
    const widgetCloseBtn = target.closest<HTMLElement>("[data-ov-widget-close]");
    if (widgetCloseBtn?.dataset.ovWidgetClose) {
      closeWidget(widgetCloseBtn.dataset.ovWidgetClose as TabId);
      return;
    }

    // Widget header pin button
    const widgetPinBtn = target.closest<HTMLElement>("[data-ov-widget-pin]");
    if (widgetPinBtn?.dataset.ovWidgetPin) {
      const tab = widgetPinBtn.dataset.ovWidgetPin as TabId;
      const pinning = !isWidgetPinned(tab);
      setWidgetPinned(tab, pinning);
      if (pinning && localStorage.getItem("efxlve-overlay-pin-hint") !== "seen") {
        localStorage.setItem("efxlve-overlay-pin-hint", "seen");
        toast(t("overlay.pinHint"));
      }
      return;
    }

    // Audio mixer: mute one session, the master bus, or refresh the list.
    const audioPresetBtn = target.closest<HTMLElement>("[data-audio-preset]");
    if (audioPresetBtn?.dataset.audioPreset) {
      handleAudioPresetAction(audioPresetBtn.dataset.audioPreset);
      return;
    }
    const audioMuteBtn = target.closest<HTMLElement>("[data-audio-mute]");
    if (audioMuteBtn?.dataset.audioMute) {
      void toggleAudioMute(audioMuteBtn.dataset.audioMute);
      return;
    }
    if (target.closest<HTMLElement>("[data-audio-master-mute]")) {
      void toggleAudioMasterMute();
      return;
    }
    if (target.closest<HTMLElement>("[data-audio-refresh]")) {
      void refreshAudio(true);
      return;
    }

    // Native HUD mode, corner and text color.
    const hudModeBtn = target.closest<HTMLElement>('[data-ov="hud-mode"]');
    if (hudModeBtn?.dataset.mode) {
      commitHudConfig({ ...loadHudConfig(), mode: hudModeBtn.dataset.mode as HudMode });
      return;
    }
    const hudCornerBtn = target.closest<HTMLElement>('[data-ov="hud-corner"]');
    if (hudCornerBtn?.dataset.corner) {
      commitHudConfig({ ...loadHudConfig(), corner: hudCornerBtn.dataset.corner as HudCorner });
      return;
    }
    const hudColorBtn = target.closest<HTMLElement>('[data-ov="hud-color"]');
    if (hudColorBtn?.dataset.color) {
      commitHudConfig({ ...loadHudConfig(), color: hudColorBtn.dataset.color });
      return;
    }

    // Crosshair shape and colour swatches.
    const crosshairShapeBtn = target.closest<HTMLElement>('[data-ov="crosshair-shape"]');
    if (crosshairShapeBtn?.dataset.shape) {
      commitCrosshair(
        { ...activeCrosshair(), shape: crosshairShapeBtn.dataset.shape as CrosshairShape },
        true,
      );
      return;
    }
    const crosshairColorBtn = target.closest<HTMLElement>('[data-ov="crosshair-color"]');
    if (crosshairColorBtn?.dataset.color) {
      commitCrosshair({ ...activeCrosshair(), color: crosshairColorBtn.dataset.color }, true);
      return;
    }

    // Perf metric selection card/chip
    const perfMetricBtn = target.closest<HTMLElement>("[data-perf-metric]");
    if (perfMetricBtn?.dataset.perfMetric) {
      setPerformanceMetric(perfMetricBtn.dataset.perfMetric as PerfMetric);
      const metric = activePerformanceMetric();
      document.querySelectorAll<HTMLElement>("[data-perf-metric]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.perfMetric === metric);
      });
      updateMetricsUi();
      return;
    }

    // Screenshot game category filter row (toggle checkbox)
    const filterRow = target.closest<HTMLElement>("[data-ov-filter-game]");
    if (filterRow?.dataset.ovFilterGame) {
      toggleShotGameFilter(filterRow.dataset.ovFilterGame);
      return;
    }

    // Close screenshots filter popover when clicking outside
    if (isShotFilterPopoverOpen() && !target.closest(".ov-shots-filter-wrapper")) {
      closeShotFilterPopover();
    }

    // Close recent games menu when clicking outside
    if (isRecentMenuOpen() && !target.closest(".ov-topbar-recent-wrap")) {
      closeRecentMenu();
    }

    // Tab button
    const tabBtn = target.closest<HTMLElement>("[data-ov-tab]");
    if (tabBtn?.dataset.ovTab) {
      setTab(tabBtn.dataset.ovTab as TabId);
      return;
    }

    // Dashboard card: the whole card opens its section. A real action inside
    // the card (the next-target row) wins over the card-wide navigation.
    const navCard = target.closest<HTMLElement>("[data-nav-target]");
    if (navCard?.dataset.navTarget && !target.closest("[data-ov]")) {
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
    const actionEl = target.closest<HTMLElement>("[data-ov]");
    const action = actionEl?.dataset.ov;
    if (!action || !actionEl) return;

    if (action === "ach-open") {
      const name = actionEl.dataset.ach;
      if (name) openAchDetail(name);
      return;
    } else if (action === "ach-back") {
      clearAchievementDetail();
      return;
    } else if (action === "ach-filter") {
      const value = actionEl.dataset.val;
      if (value) setAchievementFilter(value);
      return;
    } else if (action === "ach-refresh") {
      void loadAchievements(true);
      return;
    } else if (action === "ach-reveal") {
      const name = actionEl.dataset.ach;
      if (name) toggleAchievementReveal(name);
      return;
    } else if (action === "ach-guide") {
      openAchUrl(actionEl.dataset.url);
      return;
    } else if (action === "ach-track" || action === "ach-untrack") {
      const name = actionEl.dataset.ach;
      if (name) toggleTrackedAchievement(name);
      return;
    }

    if (action === "close") void invoke("overlay_hide");
    else if (action === "launcher") {
      closeRecentMenu();
      void invoke("overlay_show_launcher");
    } else if (action === "toggle-recent-menu") {
      toggleRecentMenu();
      return;
    } else if (action === "launch-recent-game") {
      const id = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (id) void launchRecentGame(id);
      return;
    }
    else if (action === "browser-open" || action === "open-browser-window") {
      const el = target.closest<HTMLElement>("[data-ov]");
      const url = el?.dataset.url || null;
      void invoke("overlay_browser_open", { url });
    } else if (action === "home-browser-go") {
      const input = document.getElementById("ov-home-browser-input") as HTMLInputElement | null;
      const url = input?.value.trim() || null;
      void invoke("overlay_browser_open", { url });
    } else if (action === "browser-hub-go") {
      const input = document.getElementById("ov-browser-hub-input") as HTMLInputElement | null;
      const url = input?.value.trim() || null;
      void invoke("overlay_browser_open", { url });
    } else if (action === "clip-toggle") {
      void toggleClipRecording();
      return;
    } else if (action === "clip-folder") {
      void clipFolderPath()
        .then((path) => epicOpenFolderPath(path))
        .catch(() => undefined);
      return;
    } else if (action === "shots-folder") {
      if (launcherMode) {
        void invoke("epic_open_screenshot_dir");
      } else {
        void invoke("epic_open_game_screenshots_folder", { appName: context.appName, title: context.title });
      }
    } else if (action === "shots-filter-toggle") {
      toggleShotFilterPopover();
      return;
    } else if (action === "shots-filter-clear") {
      clearShotFilters();
      return;
    } else if (action === "ss-sort") {
      const sort = target.closest<HTMLElement>("[data-ov]")?.dataset.sort;
      if (sort === "newest" || sort === "oldest" || sort === "name" || sort === "size") {
        localStorage.setItem(SS_SORT_KEY, sort);
        renderSettings();
        if (isWidgetOpen("shots")) void loadScreenshots();
      }
      return;
    } else if (action === "ss-density") {
      const density = target.closest<HTMLElement>("[data-ov]")?.dataset.density;
      if (density === "s" || density === "m" || density === "l") {
        localStorage.setItem(SS_DENSITY_KEY, density);
        renderSettings();
        if (isWidgetOpen("shots")) void loadScreenshots();
      }
      return;
    } else if (action === "shots-fav-filter") {
      toggleShotsFavoritesOnly();
      return;
    } else if (action === "shots-sort-cycle") {
      cycleShotSort();
      return;
    }
    else if (action === "close-lightbox") hideLightbox();
    else if (action === "lightbox-prev") stepLightbox(-1);
    else if (action === "lightbox-next") stepLightbox(1);
    else if (action === "enable-fps") void enableFps();
    else if (action === "open-discord" || action === "discord-open-launcher") {
      void openDiscordInLauncher("https://discord.com/channels/@me");
    } else if (action === "discord-sdk-start") {
      void startDiscordSdk();
    } else if (action === "discord-reply" || action === "discord-select-friend") {
      const row = target.closest<HTMLElement>("[data-ov]");
      const friendId = row?.dataset.id;
      if (friendId) selectReplyTarget(friendId, row?.dataset.name || friendId);
    } else if (action === "discord-open-social") {
      openWidget("discord");
      bringToFront("discord");
    } else if (action === "discord-clear-filter") {
      clearDiscordFilter();
    } else if (action === "discord-voice-leave") {
      void invoke("discord_voice_watch_stop").catch(() => undefined);
    } else if (action === "discord-send") {
      void sendDiscordReply();
    } else if (action === "discord-retry") {
      const entryId = Number(target.closest<HTMLElement>("[data-ov]")?.dataset.entry);
      if (Number.isFinite(entryId)) void retryReply(entryId);
    } else if (action === "discord-delete") {
      const entryId = Number(target.closest<HTMLElement>("[data-ov]")?.dataset.entry);
      if (Number.isFinite(entryId)) void deleteReply(entryId);
    } else if (action === "discord-edit") {
      const entryId = Number(target.closest<HTMLElement>("[data-ov]")?.dataset.entry);
      if (Number.isFinite(entryId)) startEdit(entryId);
    } else if (action === "discord-edit-save") {
      void saveEdit();
    } else if (action === "discord-edit-cancel") {
      cancelEdit();
    } else if (action === "discord-picker") {
      const mode = target.closest<HTMLElement>("[data-ov]")?.dataset.mode;
      setDiscordPickerMode(mode ?? "friends");
    } else if (action === "discord-call-start") {
      const friendId = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (friendId) void startDiscordCall(friendId);
    } else if (action === "discord-call-end") {
      void endDiscordCall();
    } else if (action === "discord-call-mute") {
      void muteDiscordCall(!isDiscordCallMuted());
    } else if (action === "discord-status") {
      const value = target.closest<HTMLElement>("[data-ov]")?.dataset.status;
      if (value) void setDiscordStatus(value);
    } else if (action === "discord-search-run") {
      runUserSearch();
    } else if (action === "discord-add") {
      const username = target.closest<HTMLElement>("[data-ov]")?.dataset.username;
      if (username) void addFriend(username);
    } else if (action === "discord-accept" || action === "discord-reject") {
      const friendId = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (friendId) void answerFriendRequest(friendId, action === "discord-accept");
    } else if (action === "discord-open-dm") {
      const friendId = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (friendId) void openDiscordInLauncher(`https://discord.com/channels/@me/${friendId}`);
    } else if (action === "discord-open-group") {
      const channelId = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (channelId) void openDiscordInLauncher(`https://discord.com/channels/@me/${channelId}`);
    } else if (action === "discord-open-channel") {
      const row = target.closest<HTMLElement>("[data-ov]");
      const channelId = row?.dataset.id;
      const guildId = row?.dataset.guild;
      if (channelId) {
        void openDiscordInLauncher(
          guildId
            ? `https://discord.com/channels/${guildId}/${channelId}`
            : `https://discord.com/channels/@me/${channelId}`,
        );
      }
    } else if (action === "restore-game") {
      const key = target.closest<HTMLElement>("[data-ov]")?.dataset.key;
      if (key) {
        saveDisabled(disabledGames().filter((g) => g.key !== key));
        renderSettings();
      }
    } else if (action === "reset-widget-layout") {
      resetWidgetLayout();
      toast(t("overlay.saved"), "ok");
    } else if (action === "media-toggle" || action === "sp-toggle") {
      toggleSpotifyPlay();
    } else if (action === "media-prev" || action === "sp-prev") {
      skipSpotifyTrack(-1);
    } else if (action === "media-next" || action === "sp-next") {
      skipSpotifyTrack(1);
    } else if (action === "sp-shuffle") {
      cycleSpotifyShuffle();
    } else if (action === "sp-repeat") {
      cycleSpotifyRepeat();
    } else if (action === "sp-seek") {
      seekSpotifyFromPointer(event.clientX);
    } else if (action === "sp-engine-start") {
      ensureSpotifyEngine(true);
    } else if (action === "sp-toggle-mini-view") {
      toggleSpotifyMiniView();
    } else if (action === "sp-tab-playlists" || action === "sp-back-playlists") {
      setMusicViewMode("playlists");
    } else if (action === "sp-tab-tracks" || action === "sp-show-tracks") {
      setMusicViewMode("tracks");
    } else if (action === "sp-toggle-search") {
      toggleSpotifySearch();
    } else if (action === "sp-clear-search") {
      clearSpotifySearch();
    } else if (action === "sp-select-playlist") {
      const uri = target.closest<HTMLElement>("[data-ov]")?.dataset.uri;
      if (uri) void selectPlaylist(uri);
    } else if (action === "sp-play-track") {
      const uri = target.closest<HTMLElement>("[data-ov]")?.dataset.uri;
      if (uri) void playTrack(uri);
    } else if (action === "sp-refresh-library") {
      void refreshLibrary();
    } else if (action === "sp-open") {
      void openSpotifyLink();
    } else if (action === "add-browser-bookmark") {
      const labelInput = document.getElementById("ov-add-bm-label") as HTMLInputElement | null;
      const urlInput = document.getElementById("ov-add-bm-url") as HTMLInputElement | null;
      const label = labelInput?.value.trim();
      let url = urlInput?.value.trim();
      if (label && url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          url = `https://${url}`;
        }
        const current = loadBookmarks();
        const host = url.toLowerCase();
        let iconName: Parameters<typeof icon>[0] = "globe";
        if (host.includes("youtube.com")) iconName = "youtube";
        else if (host.includes("twitter.com") || host.includes("x.com")) iconName = "twitter";
        else if (host.includes("google.com")) iconName = "search";
        else if (host.includes("reddit.com")) iconName = "users";
        else if (host.includes("twitch.tv")) iconName = "monitor";
        else if (host.includes("steam")) iconName = "gamepad-2";
        else if (host.includes("discord.com")) iconName = "discord";
        else if (host.includes("github.com")) iconName = "github";
        else if (host.includes("spotify.com")) iconName = "spotify";

        current.push({ label, iconName, url });
        localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(current));
        void emit("overlay-browser-bookmarks-updated", {});
        renderSettings();
      }
    } else if (action === "delete-browser-bookmark") {
      const idx = Number(target.closest<HTMLElement>("[data-ov]")?.dataset.index);
      if (!Number.isNaN(idx)) {
        const current = loadBookmarks();
        current.splice(idx, 1);
        localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(current));
        void emit("overlay-browser-bookmarks-updated", {});
        renderSettings();
      }
    } else if (action === "reset-browser-bookmarks") {
      localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(DEFAULT_BOOKMARKS));
      void emit("overlay-browser-bookmarks-updated", {});
      renderSettings();
    }
  });

  // Settings controls, text fields and the keyboard live in overlay-inputs.ts.
  wireInputEvents({
    contextAppName: () => context.appName,
    settingsDeps: () => settingsDeps(),
    saveOpacity: applyOpacity,
  });

  // Mouse or trackpad use takes the focus ring away; the next controller or
  // keyboard input brings it back.
  window.addEventListener("mousemove", onMouseActivity);
  document.addEventListener("mousedown", onMouseActivity);

  // A controller can be connected after the panel opened; wake the idle poll
  // immediately instead of waiting for the 250ms fallback.
  window.addEventListener("gamepadconnected", () => {
    if (!document.hidden) scheduleGamepadFrame();
  });

  // The window is hidden while the panel is closed: rAF pauses and the pad
  // state (prevButtons) goes stale. Suppress input briefly on every re-show so
  // the button that opened the panel cannot close it on the first frame.
  document.addEventListener("visibilitychange", () => {
    // The panel and the browser window never share the screen — Rust hides the
    // browser whenever the panel hides or shows — so this only re-arms the pad.
    if (document.hidden) {
      stopOverlayLoops();
      stopClipPolling();
      return;
    }
    // A ghost HUD keeps its own clock/media/clip timers; re-arming here would
    // restart the pad poll the game is supposed to own.
    if (ghostMode) return;
    suppressGamepadInput();
    startOverlayLoops();
    startClipPolling();
    if (isWidgetOpen("audio")) startAudioPolling();
  });

  // The panel is re-placed over the game on every open and the game can change
  // resolution: pull widgets back on screen when the surface changes size.
  let clampTimer: number | null = null;
  window.addEventListener("resize", () => {
    if (clampTimer !== null) window.clearTimeout(clampTimer);
    clampTimer = window.setTimeout(() => {
      clampTimer = null;
      clampWidgetsIntoView();
    }, 150);
  });
}

/* ---------- Controller & Keyboard Navigation ---------- */
// Focus ring, D-pad polling and the B/Esc back path live in
// overlay-controller.ts.

/* ---------- Lifecycle ---------- */

/** True while the panel is a click-through HUD over the game. */
let ghostMode = false;

/**
 * Ghost mode keeps the pinned cards on screen while the game owns the mouse
 * and keyboard. The page drops the scrim and the bar through the body class;
 * the pad poll stops because nothing here can be activated.
 */
function setGhostMode(on: boolean): void {
  ghostMode = on;
  document.body.classList.toggle("ov-ghost", on);
  if (!on) return;
  hideLightbox();
  removeGamepadFocus();
  document.body.classList.remove("ov-using-gamepad");
  stopGamepadPolling();
  // Only a pinned Discord card needs the voice worker, and only a pinned clip
  // card needs the recorder poll. The next open restarts both.
  if (!isWidgetPinned("discord") && !isWidgetPinned("chat")) {
    void invoke("discord_voice_watch_stop").catch(() => undefined);
  }
  if (!isWidgetPinned("clip")) stopClipPolling();
  if (!isWidgetPinned("audio")) stopAudioPolling();
  if (isWidgetPinned("ach")) {
    clearAchievementDetail();
  }
}

/**
 * Timers and the gamepad rAF only run while the overlay is actually visible.
 * The hidden WebView is kept warm for instant opening; it must not wake the
 * compositor or poll a pad between sessions.
 */
function startOverlayLoops(): void {
  if (document.hidden) return;
  if (clockTimer === null) {
    clockTimer = window.setInterval(() => updateClock(), 1000);
  }
  // The timer stops on close, so the first tick would leave the old time on
  // screen for a second after every reopen.
  updateClock();
  if (mediaPollTimer === null) {
    mediaPollTimer = window.setInterval(() => {
      if (document.hidden) return;
      // A ghost panel only updates a pinned music card; an unpinned one is
      // hidden and must not keep a poll alive.
      if (ghostMode && !isWidgetPinned("music")) return;
      if (isWidgetOpen("music")) void refreshMedia();
    }, 2500);
  }
  scheduleGamepadFrame();
}

function stopOverlayLoops(): void {
  if (clockTimer !== null) {
    window.clearInterval(clockTimer);
    clockTimer = null;
  }
  if (mediaPollTimer !== null) {
    window.clearInterval(mediaPollTimer);
    mediaPollTimer = null;
  }
  stopGamepadPolling();
  stopAudioPolling();
}

/** Lays out the widgets the page remembers as open: position, size, pin and
 *  content. `onOpen` and a page that boots straight into ghost both use it. */
function restoreOpenWidgets(): void {
  openWidgets = loadOpenWidgets();
  for (const tab of TABS) {
    const widget = document.getElementById(`ov-widget-${tab.id}`);
    const toggleBtn = document.querySelector<HTMLElement>(`[data-ov-widget-toggle="${tab.id}"]`);
    if (!widget) continue;

    const pos = loadWidgetPos(tab.id);
    widget.style.left = `${pos.x}px`;
    widget.style.top = `${pos.y}px`;

    const size = loadWidgetSize(tab.id);
    widget.style.width = `${size.w}px`;
    widget.style.height = `${size.h}px`;
    syncWidgetSizeClasses(tab.id, size.w, size.h);

    const isOpen = openWidgets.has(tab.id);
    widget.style.display = isOpen ? "flex" : "none";
    if (toggleBtn) toggleBtn.classList.toggle("active", isOpen);
    applyWidgetPinState(tab.id);

    if (isOpen) {
      renderWidgetContent(tab.id);
      // `openWidget` starts this, but a widget restored from storage never went
      // through it: without this the tracker's 30 s refresh never starts.
      if (tab.id === "ach") startTrackerPolling();
    }
  }
  // Rust decides the close path from this count: above zero means ghost mode.
  syncPinnedToRust();
}

async function onOpen(payload: OpenPayload): Promise<void> {
  // The overlay page outlives a Settings language change: pull the current
  // language on every open so no widget shows the previous one.
  await setLanguage(initialLanguage()).catch(() => undefined);
  // A ghost panel coming back is a normal interactive panel again. A ghost
  // event can land while this open is still awaiting the language; do not let
  // the open undo it.
  if (!ghostMode) setGhostMode(false);
  context = payload;
  resetNotificationOptionsSession();
  resetPerformanceSession();
  resetAchievementsSession();
  resetScreenshotsSession();
  resetMusicSession();
  resetDiscordSession();
  resetControllerSession();
  sessionStartEpoch = Date.now();
  suppressGamepadInput();

  // A block keeps the panel away from a game; the launcher/desktop is never
  // blocked, so a stale entry cannot lock the overlay away for good.
  if (context.appName && !isLauncherContext(context) && isDisabledGame(context.appName)) {
    void invoke("overlay_hide");
    return;
  }

  if (!document.getElementById("ov-shell")) {
    const root = document.getElementById("ov-root");
    if (!root) return;
    root.innerHTML = shellHtml();
    wireEvents();
    initWidgetDragging();
    initWidgetResizing();
  }
  applyOpacity(savedOpacity());

  document.documentElement.dataset.surface = "soft";
  hideLightbox();

  const launcher = isLauncherContext(context);
  launcherMode = launcher;
  // The notes widget follows the context: the game, or the launcher.
  setOverlayNotesScope(overlayNotesScope(launcher, context.appName));

  refreshRecentGamesPill();
  initBatteryMonitoring();
  paintBattery();

  updateClock();
  refreshDock();

  // Load and position open widgets
  restoreOpenWidgets();

  // Sync browser button and state
  const browserBtn = document.querySelector<HTMLElement>('[data-ov-widget-toggle="browser"]');
  void invoke<boolean>("overlay_browser_is_open")
    .then((isOpen) => {
      const active = Boolean(isOpen);
      if (browserBtn) browserBtn.classList.toggle("active", active);
      if (active) openWidgets.add("browser");
      else openWidgets.delete("browser");
      saveOpenWidgets();
    })
    .catch(() => undefined);

  // Preload achievements and screenshots. The achievements prefetch feeds the
  // home card even when the achievements widget itself is closed.
  const { store } = splitKey(context.appName);
  if (context.appName && store !== "game") {
    void loadAchievements();
    if (openWidgets.has("shots")) void loadScreenshots();
  }

  // The receiver starts only when the music widget is opened by a user who has
  // already approved playback; opening the panel for performance or captures
  // must not start a Spotify session.
  void refreshMedia();

  // A connected pad means the user wants controller affordances right away.
  const pad = navigator.getGamepads ? navigator.getGamepads().find((p) => p && p.connected) : undefined;
  if (pad && !ghostMode) {
    document.body.classList.add("ov-using-gamepad");
    focusDefault();
  }
  panelOpened = true;
}

/**
 * Steam events carry the bare AppID; every other store and custom game carries
 * its launcher key, which is exactly what the panel keeps in `context.appName`.
 */
function achievementEventMatchesContext(appId: string): boolean {
  if (!appId) return false;
  return context.appName === appId || context.appName === `steam::${appId}`;
}

async function boot(): Promise<void> {
  document.documentElement.dataset.surface = "soft";
  await setLanguage(initialLanguage());

  configureClipWidget({
    isOpen: () => isWidgetOpen("clip"),
    body: () => viewEl("clip"),
  });
  configureAchievements({
    context: () => context,
    ghostMode: () => ghostMode,
    isWidgetOpen: (tab) => isWidgetOpen(tab),
    isWidgetPinned: (tab) => isWidgetPinned(tab),
    viewEl: (tab) => viewEl(tab),
    openWidget: (tab, render) => openWidget(tab, render),
    renderHome: renderHomeSafe,
    splitKey,
  });
  configureScreenshots({
    context: () => context,
    launcherMode: () => launcherMode,
    viewEl: () => viewEl("shots"),
    renderHome: renderHomeSafe,
    splitKey,
  });
  configurePerformance({
    viewEl: (tab) => viewEl(tab),
    isWidgetOpen: (tab) => isWidgetOpen(tab),
  });
  configureHome({
    context: () => context,
    launcherMode: () => launcherMode,
    activeTab: () => activeTab,
    viewEl: () => viewEl("home"),
    splitKey,
    storeLabel,
    media: () => getOverlayMedia(),
    mediaTitleHtml: () => mediaCardTitleHtml(),
    mediaInnerHtml: () => mediaCardInnerHtml(),
  });
  configureMusic({
    isWidgetOpen: (tab) => isWidgetOpen(tab),
    viewEl: (tab) => viewEl(tab),
    renderHome: renderHomeSafe,
    syncWidgetSizeClasses: (tab, w, h) => syncWidgetSizeClasses(tab as TabId, w, h),
  });
  configureDiscord({
    viewEl: (tab) => viewEl(tab),
    isWidgetOpen: (tab) => isWidgetOpen(tab),
    openWidget: (tab) => openWidget(tab),
    bringToFront: (tab) => bringToFront(tab),
  });
  configureAudio({
    isWidgetOpen: (tab) => isWidgetOpen(tab),
    viewEl: (tab) => viewEl(tab),
    ghostMode: () => ghostMode,
    isWidgetPinned: (tab) => isWidgetPinned(tab),
  });
  configureWidgets({
    isWidgetOpen: (tab) => isWidgetOpen(tab as TabId),
    bringToFront: (tab) => bringToFront(tab as TabId),
    tabIds: () => TABS.map((tab) => tab.id),
  });
  configureController({
    isWidgetOpen: (tab) => isWidgetOpen(tab as TabId),
    visibleTabs: () => visibleTabs(),
    activeTab: () => activeTab,
    setTab: (tab) => setTab(tab as TabId),
    ghostMode: () => ghostMode,
    recentMenuOpen: () => isRecentMenuOpen(),
  });
  configureChrome({
    context: () => context,
    launcherMode: () => launcherMode,
    visibleTabs: () => visibleTabs(),
    allTabs: () => TABS,
    isWidgetOpen: (tab) => isWidgetOpen(tab as TabId),
    isWidgetPinned: (tab) => isWidgetPinned(tab),
  });

  const root = document.getElementById("ov-root");
  if (root && !document.getElementById("ov-shell")) {
    root.innerHTML = shellHtml();
    wireEvents();
    initWidgetDragging();
    initWidgetResizing();
  }
  // Apply the saved opacity before the first paint, not only when a game opens
  // the overlay, so the window never flashes the default scrim.
  applyOpacity(savedOpacity());

  // Keep the native crosshair in step with the saved settings. Visibility is
  // owned by the launcher boot and the Settings toggle, so a hotkey toggle-off
  // survives this page load.
  applyCrosshairConfig(activeCrosshair(context.appName));
  applyHudConfig();

  // A first open can be closed before `onOpen` runs. Tell Rust about the pins
  // the page remembers now, so that close already knows a ghost HUD is wanted.
  openWidgets = loadOpenWidgets();
  syncPinnedToRust();

  startOverlayLoops();

  await listen<OpenPayload>("overlay-open", (event) => {
    setGhostMode(false);
    startOverlayLoops();
    startClipPolling();
    void onOpen(event.payload);
  });

  // The main Settings page writes the same switches. Take its normalized
  // answer instead of keeping a second stale copy in the panel.
  await listen<AchievementNotificationOptions>("achievement-notification-options", (event) => {
    applyNotificationOptions(event.payload);
  });

  // The panel became a click-through HUD: keep only the pinned cards, drop the
  // pad poll and leave the game in control. Clock/media timers stay alive so a
  // pinned performance or music card keeps updating.
  await listen<OpenPayload>("overlay-ghost", (event) => {
    // A page that boots after the panel already ghosted never ran the open
    // pipeline: lay out the remembered widgets before dropping the chrome.
    if (!panelOpened) {
      context = event.payload ?? { appName: "", title: "" };
      launcherMode = isLauncherContext(context);
      setOverlayNotesScope(overlayNotesScope(launcherMode, context.appName));
      restoreOpenWidgets();
    }
    setGhostMode(true);
  });

  await listen<{ open: boolean }>("overlay-browser-state", (event) => {
    const isOpen = Boolean(event.payload?.open);
    if (!isOpen) browserBounds = null;
    const toggleBtn = document.querySelector<HTMLElement>('[data-ov-widget-toggle="browser"]');
    if (toggleBtn) toggleBtn.classList.toggle("active", isOpen);
    if (isOpen) {
      openWidgets.add("browser");
    } else {
      openWidgets.delete("browser");
    }
    saveOpenWidgets();
  });

  await listen<{ x: number; y: number; w: number; h: number }>("overlay-browser-bounds", (event) => {
    browserBounds = event.payload;
  });

  await listen("overlay-close", () => {
    panelOpened = false;
    setGhostMode(false);
    hideLightbox();
    removeGamepadFocus();
    resetControllerSession();
    closeRecentMenu();
    document.body.classList.remove("ov-using-gamepad");
    stopOverlayLoops();
    stopClipPolling();
    stopTrackerPolling();
    // Rust's `hide_now` already hides the browser through `hide_with_overlay`
    // (a pinned PiP player survives), and browser-window.ts hides itself as a
    // safety net. Calling `overlay_browser_close` here killed PiP every close.
    // The voice worker is only meant to run while its tab is visible.
    void invoke("discord_voice_watch_stop").catch(() => undefined);
  });

  // The recorder announces itself: a card over the game is the only notification
  // a player actually sees, and a recording nobody notices never gets stopped.
  await listen<{ path: string }>("clip-started", () => {
    clipCard("overlay.clipStartedTitle", t("overlay.clipStartedBody", { key: clipHotkeyName() }));
    void refreshClipWidget(true);
  });

  await listen<{ path: string; frames: number; seconds?: number }>("clip-saved", (event) => {
    const name = event.payload.path.split(/[\\/]/).pop() ?? "";
    const seconds = event.payload.seconds ?? 0;
    clipCard(
      "overlay.clipSavedTitle",
      t("overlay.clipSavedBody", { name, time: clipClock(seconds) }),
    );
    void loadLastClip().then(() => refreshClipWidget(true));
  });

  await listen<string>("clip-error", (event) => {
    clipCard("overlay.clipFailedTitle", localizeMessage(event.payload));
    void refreshClipWidget(true);
  });

  // The native watcher already showed the toast; the panel still has to fold
  // the unlock into its own list and home card. Steam events name the bare
  // AppID, while store and custom games name their launcher key.
  await listen<{ appId: string; name: string; displayName: string; description: string }>(
    "achievement-unlocked",
    (event) => {
      if (!achievementData()) return;
      if (!achievementEventMatchesContext(event.payload.appId)) return;
      applyLiveAchievementUnlock(event.payload.name);
    },
  );

  await listen<MetricsSample>("overlay-metrics", (event) => {
    applyMetricsSample(event.payload);
  });

  await listen<DiscordVoiceState>("discord-voice-state", (event) => {
    applyVoiceState(event.payload);
  });

  await listen<DiscordFriendsState>("discord-friends-state", (event) => {
    applyFriendsState(event.payload);
  });

  await listen<WebVoiceState>("discord-web-voice", (event) => {
    applyWebVoice(event.payload);
  });

  await listen<SdkState>("discord-sdk-state", (event) => {
    applySdkState(event.payload);
  });

  await listen<DiscordFriendsState>("discord-sdk-friends", (event) => {
    applySdkFriends(event.payload);
  });

  // The send outcome lands in the log row: "Sending?" becomes "Sent", or the
  // row turns into a retry, so a failed message is never silently lost. The
  // message id is what delete and open-in-launcher need later.
  await listen<{ userId: string; ok: boolean; messageId?: string; error?: string }>("discord-sdk-dm", (event) => {
    applyDmResult(event.payload);
  });

  // Messages the other side sends while the overlay is open, straight from the
  // SDK's message callback.
    // Incoming call: the launcher's own client rings, and the overlay says so.
  await listen<{ from: string }>("discord-web-call", (event) => {
    void notifyIncomingCall(event.payload.from);
  });

  await listen<{ friendId: string; messageId?: string; text: string; attachment?: string; at: number }>(
    "discord-sdk-message",
    (event) => {
      noteIncoming(
        event.payload.friendId,
        event.payload.text,
        event.payload.at,
        event.payload.messageId,
        event.payload.attachment,
      );
    },
  );

  // History for a conversation: the log opens with the real thread, not just
  // what happened since the overlay started.
  await listen<{ friendId: string; messages: HistoryMessage[] }>(
    "discord-sdk-history",
    (event) => {
      mergeHistory(event.payload.friendId, event.payload.messages);
    },
  );

  // A message deleted anywhere (including from here) leaves the log: a row for
  // something that no longer exists would be a lie.
  await listen<{ messageId: string }>("discord-sdk-message-deleted", (event) => {
    applyMessageDeleted(event.payload.messageId);
  });

  await listen<{ userId: string; messageId: string; ok: boolean; error?: string }>(
    "discord-sdk-dm-deleted",
    (event) => {
      applyDmDeleted(event.payload);
    },
  );

  // The DM call the overlay started: active, muted, ended.
  await listen<{ state: string; friendId: string; muted: boolean; error?: string | null }>(
    "discord-sdk-call",
    (event) => {
      applyCallState(event.payload);
    },
  );

  // The status takeover closes itself on success; the chip takes the new dot
  // (the social graph is re-read by the worker).
  await listen<{ status: string; ok: boolean; error?: string }>("discord-sdk-status-done", (event) => {
    applyStatusDone(event.payload);
  });

  // The add-friend search: results, and the request outcome.
  await listen<{ query: string; users: { id: string; name: string; username: string; avatarUrl: string }[] }>(
    "discord-sdk-search",
    (event) => {
      applySearchResults(event.payload);
    },
  );

  await listen<{ username: string; ok: boolean; error?: string }>("discord-sdk-request-sent", (event) => {
    applyRequestSent(event.payload);
  });

  // A friend request answered: the row goes at once, and the relationship
  // callback re-reads the list from Discord shortly after.
  await listen<{ userId: string; accept: boolean; ok: boolean; error?: string }>(
    "discord-sdk-request-done",
    (event) => {
      applyRequestDone(event.payload);
    },
  );

  // The edit result: the row takes the new text, and the composer goes back to
  // writing (the compose draft returns from the stash).
  await listen<{ userId: string; messageId: string; text?: string; ok: boolean; error?: string }>(
    "discord-sdk-dm-edited",
    (event) => {
      applyDmEdited(event.payload);
    },
  );

  // The SDK resumes its sealed session in the background: after the first
  // approval the panel is connected before it is ever opened, and messages
  // that arrive meanwhile are already in the log. A first-time user gets the
  // Connect button instead of an unasked prompt.
  void invoke("discord_sdk_start", { silent: true }).catch(() => undefined);

  try {
    const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
    const hud = localStorage.getItem(HUD_KEY) === "true";
    await invoke("overlay_set_enabled", { enabled });
    await invoke("overlay_set_hud", { enabled: hud });
  } catch {
    // Initial boot sync
  }

  // The panel can be created by the first Shift+Tab instead of at launcher
  // boot. If it was already shown while this page was loading, replay the open
  // payload now that the listener above exists.
  void invoke("overlay_page_ready").catch(() => undefined);
}

void boot();

// The notes wiring lives outside boot: boot's `listen` awaits abort in a
// browser (no Tauri), and the notes migration and repaint hook must not depend
// on those succeeding.
void ensureNotesMigration();
onNotesChanged(() => refreshOverlayNotes());
setOverlayNotesSettingsRepaint(() => {
  if (isWidgetOpen("settings")) renderSettings();
});
