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
  setText,
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
  emptyBlockHtml,
  ensureSpotifyEngine,
  getOverlayMedia,
  mediaCardInnerHtml,
  mediaCardTitleHtml,
  openDiscordInLauncher,
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
  setSpotifySearchQuery,
  skipSpotifyTrack,
  toggleSpotifyMiniView,
  toggleSpotifyPlay,
  toggleSpotifySearch,
} from "./overlay-music";
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
  cancelDiscordEdit,
  clearDiscordFilter,
  configureDiscord,
  endDiscordCall,
  focusSelectedFriendRow,
  growComposer,
  isDiscordCallMuted,
  isEditingDiscordEntry,
  mergeHistory,
  muteDiscordCall,
  noteIncoming,
  notifyIncomingCall,
  renderDiscordChat,
  renderDiscordSocial,
  runUserSearch,
  saveEdit,
  sendDiscordReply,
  setDiscordFriendsFilter,
  setDiscordPickerMode,
  setDiscordReplyDraft,
  setDiscordSearchQuery,
  setDiscordStatus,
  startDiscordCall,
  startDiscordSdk,
  startEdit,
  stepReplyTarget,
  submitDiscordComposer,
  selectReplyTarget,
  retryReply,
  deleteReply,
  refreshWebVoice,
  refreshSdkState,
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
const CLOCK_SECONDS_KEY = "efxlve-overlay-clock-seconds";
const BATTERY_PERCENT_KEY = "efxlve-overlay-battery-percent";

function showClockSeconds(): boolean {
  return localStorage.getItem(CLOCK_SECONDS_KEY) === "true";
}

function showBatteryPercent(): boolean {
  return localStorage.getItem(BATTERY_PERCENT_KEY) === "true";
}

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

interface AudioSession {
  id: string;
  pid: number;
  name: string;
  displayName: string;
  icon: string;
  volume: number;
  muted: boolean;
  system: boolean;
}

interface AudioState {
  master: number;
  masterMuted: boolean;
  sessions: AudioSession[];
  devices: AudioDevice[];
  defaultDevice: string;
}

interface AudioDevice {
  id: string;
  name: string;
  default: boolean;
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
/** Audio mixer: the last poll, a debounce hold while a slider moves, and the
 *  timers that coalesce volume writes. */
let audioState: AudioState | null = null;
let audioError = "";
let audioLoading = false;
let audioPollTimer: number | null = null;
let audioHoldUntil = 0;
const audioVolumeTimers = new Map<string, number>();
let audioMasterTimer: number | null = null;
/** Crosshair slider writes are coalesced: one native update per 50 ms. */
/** Games with capture turned off, for the settings widget's per-game row. */
let overlayDisabledGames: string[] = [];
let overlayDisabledGamesFetched = false;
let sessionStartEpoch = Date.now();
let activeTab: TabId = (localStorage.getItem("efxlve-overlay-tab") as TabId) || "home";
if (!IS_WINDOWS && (activeTab === "shots" || activeTab === "clip")) activeTab = "home";
let browserBounds: { x: number; y: number; w: number; h: number } | null = null;

let mediaPollTimer: number | null = null;
let clockTimer: number | null = null;
let gamepadRaf: number | null = null;
let gamepadWakeTimer: number | null = null;

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

/* ---------- Pinned widgets ---------- */

/** A pinned widget keeps its place and size, and stays over the game as a
 *  click-through HUD when the panel closes. */
const PIN_KEY = "efxlve-overlay-pins";
let widgetPins = loadWidgetPins();

function loadWidgetPins(): Set<TabId> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((id) => TABS.some((t) => t.id === id)) as TabId[]);
      }
    }
  } catch {
    // fallback
  }
  return new Set();
}

function saveWidgetPins(): void {
  localStorage.setItem(PIN_KEY, JSON.stringify([...widgetPins]));
}

function isWidgetPinned(tab: TabId): boolean {
  return widgetPins.has(tab);
}

const GHOST_OPACITY_KEY = "efxlve-overlay-ghost-opacity";

/** Per-widget opacity while the card sits in the click-through HUD. */
function loadGhostOpacities(): Record<string, number> {
  try {
    const raw = localStorage.getItem(GHOST_OPACITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map: Record<string, number> = {};
    for (const [tab, value] of Object.entries(parsed)) {
      const number = Number(value);
      if (Number.isFinite(number)) map[tab] = Math.max(0.25, Math.min(1, number));
    }
    return map;
  } catch {
    return {};
  }
}

function ghostOpacity(tab: TabId): number {
  return loadGhostOpacities()[tab] ?? 1;
}

function setGhostOpacity(tab: TabId, value: number): void {
  const map = loadGhostOpacities();
  map[tab] = Math.max(0.25, Math.min(1, value));
  localStorage.setItem(GHOST_OPACITY_KEY, JSON.stringify(map));
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) widget.style.setProperty("--ghost-opacity", String(map[tab]));
}

/** Flips one widget's pin and repaints its header button. */
function setWidgetPinned(tab: TabId, pinned: boolean): void {
  if (pinned) widgetPins.add(tab);
  else widgetPins.delete(tab);
  saveWidgetPins();
  applyWidgetPinState(tab);
  syncPinnedToRust();
}

function applyWidgetPinState(tab: TabId): void {
  const pinned = isWidgetPinned(tab);
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) {
    widget.classList.toggle("is-pinned", pinned);
    widget.style.setProperty("--ghost-opacity", String(ghostOpacity(tab)));
  }
  const btn = document.querySelector<HTMLElement>(`[data-ov-widget-pin="${tab}"]`);
  if (!btn) return;
  btn.classList.toggle("is-pinned", pinned);
  btn.title = pinned ? t("overlay.widgetUnpin") : t("overlay.widgetPin");
}

/**
 * Pinned widgets that are actually open: only those survive the close as a
 * ghost HUD. Rust keeps the number so the hotkey and the close button agree
 * without a round trip at close time.
 */
function pinnedOnScreen(): TabId[] {
  return [...widgetPins].filter((tab) => tab !== "browser" && openWidgets.has(tab));
}

function syncPinnedToRust(): void {
  void invoke("overlay_set_pinned", { count: pinnedOnScreen().length }).catch(() => undefined);
}

interface WidgetPos {
  x: number;
  y: number;
}

/** The floating bar ends at 56px; a widget header must start below it. */
const OVERLAY_SAFE_TOP = 64;
const WIDGET_MARGIN = 8;

function getDefaultWidgetPos(tab: TabId): WidgetPos {
  const winW = typeof window !== "undefined" ? window.innerWidth || 1920 : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight || 1080 : 1080;
  const musicX = Math.max(WIDGET_MARGIN, winW - 384);
  // The three default widgets form one row on a 1280px panel: performance,
  // captures, music. Below that the captures column goes under performance
  // instead of being clipped by the music widget.
  const topRowShotsX = 24 + 350 + 16;
  const topRowFits = topRowShotsX + 340 + 16 <= musicX;
  const shotsX = topRowFits ? topRowShotsX : 24;
  const shotsY = topRowFits ? 72 : 72 + 380 + 12;
  const lowerY = Math.max(OVERLAY_SAFE_TOP, winH - 328);
  switch (tab) {
    case "perf":
      return { x: 24, y: 72 };
    case "shots":
      return { x: shotsX, y: shotsY };
    case "clip":
      // Bottom-left, on its own: it is the one widget worth leaving pinned
      // while playing, so it should not sit under the performance panel.
      return { x: 24, y: lowerY };
    case "music":
      return { x: musicX, y: 72 };
    case "audio":
      // Bottom-center: clear of the performance/music row and the clip/notes
      // corners.
      return { x: Math.max(24, Math.floor((winW - 380) / 2)), y: Math.max(OVERLAY_SAFE_TOP, winH - 460) };
    case "discord":
      return { x: Math.max(24, winW - 740), y: 72 };
    case "chat":
      return { x: Math.max(24, winW - 390), y: 72 };
    case "ach":
      return { x: Math.max(24, Math.min(380, winW - 420)), y: 72 };
    case "browser":
      return { x: Math.max(24, Math.floor((winW - 500) / 2)), y: 80 };
    case "notes":
      return { x: Math.max(24, winW - 360), y: Math.max(OVERLAY_SAFE_TOP, winH - 400) };
    case "settings":
      return { x: Math.max(24, Math.floor((winW - 440) / 2)), y: 90 };
    default:
      return { x: 24, y: 72 };
  }
}

function loadWidgetPos(tab: TabId): WidgetPos {
  try {
    const raw = localStorage.getItem(`efxlve-ov-pos-${tab}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        // Older builds could persist a clamp performed while the hidden window
        // was 1x1. Those 8/8 (or 8/64 after the topbar guard) entries stacked
        // every widget in one corner; treat them as missing and let the tiled
        // default win.
        if (parsed.y < OVERLAY_SAFE_TOP || (parsed.x <= WIDGET_MARGIN && parsed.y <= OVERLAY_SAFE_TOP)) {
          return getDefaultWidgetPos(tab);
        }
        const winW = window.innerWidth || 1920;
        const winH = window.innerHeight || 1080;
        const size = loadWidgetSize(tab);
        const maxX = Math.max(WIDGET_MARGIN, winW - size.w - WIDGET_MARGIN);
        const maxY = Math.max(OVERLAY_SAFE_TOP, winH - size.h - WIDGET_MARGIN);
        const clampedX = Math.max(WIDGET_MARGIN, Math.min(maxX, parsed.x));
        const clampedY = Math.max(OVERLAY_SAFE_TOP, Math.min(maxY, parsed.y));
        return { x: clampedX, y: clampedY };
      }
    }
  } catch {
    // fallback
  }
  return getDefaultWidgetPos(tab);
}

function saveWidgetPos(tab: TabId, pos: WidgetPos): void {
  localStorage.setItem(`efxlve-ov-pos-${tab}`, JSON.stringify(pos));
}

interface WidgetSizeLimits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

interface WidgetSize {
  w: number;
  h: number;
}

function getWidgetSizeLimits(tab: TabId): WidgetSizeLimits {
  switch (tab) {
    case "perf":
      return { minW: 310, minH: 350, maxW: 600, maxH: 600 };
    case "shots":
      return { minW: 280, minH: 240, maxW: 800, maxH: 800 };
    case "clip":
      return { minW: 280, minH: 220, maxW: 520, maxH: 620 };
    case "music":
      return { minW: 260, minH: 140, maxW: 600, maxH: 800 };
    case "audio":
      return { minW: 300, minH: 260, maxW: 560, maxH: 700 };
    case "discord":
      return { minW: 280, minH: 320, maxW: 600, maxH: 900 };
    case "chat":
      return { minW: 300, minH: 320, maxW: 800, maxH: 900 };
    case "ach":
      return { minW: 280, minH: 260, maxW: 700, maxH: 800 };
    case "notes":
      return { minW: 260, minH: 220, maxW: 700, maxH: 700 };
    case "settings":
      return { minW: 360, minH: 340, maxW: 720, maxH: 850 };
    default:
      return { minW: 260, minH: 200, maxW: 800, maxH: 800 };
  }
}

function getDefaultWidgetSize(tab: TabId): WidgetSize {
  switch (tab) {
    case "perf":
      return { w: 350, h: 380 };
    case "shots":
      // The narrow fallback places captures under performance; keep it short
      // enough to stay above the taskbar on a 1080p monitor.
      return {
        w: 340,
        h: (window.innerWidth || 1920) < 1200 && (window.innerHeight || 1080) < 920 ? 360 : 420,
      };
    case "clip":
      return { w: 320, h: 300 };
    case "music":
      return { w: 360, h: 420 };
    case "audio":
      return { w: 380, h: 440 };
    case "discord":
      return { w: 330, h: 540 };
    case "chat":
      return { w: 380, h: 540 };
    case "ach":
      return { w: 380, h: 480 };
    case "notes":
      return { w: 340, h: 360 };
    case "settings":
      return { w: 480, h: 580 };
    default:
      return { w: 340, h: 400 };
  }
}

function loadWidgetSize(tab: TabId): WidgetSize {
  const limits = getWidgetSizeLimits(tab);
  const def = getDefaultWidgetSize(tab);
  try {
    const raw = localStorage.getItem(`efxlve-ov-size-${tab}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { w?: number; h?: number };
      if (typeof parsed.w === "number" && typeof parsed.h === "number") {
        const winW = typeof window !== "undefined" ? window.innerWidth || 1920 : 1920;
        const winH = typeof window !== "undefined" ? window.innerHeight || 1080 : 1080;
        const clampedW = Math.max(limits.minW, Math.min(Math.min(limits.maxW, winW - 16), parsed.w));
        const clampedH = Math.max(limits.minH, Math.min(Math.min(limits.maxH, winH - 60), parsed.h));
        return { w: clampedW, h: clampedH };
      }
    }
  } catch {
    // fallback
  }
  return def;
}

function saveWidgetSize(tab: TabId, size: WidgetSize): void {
  localStorage.setItem(`efxlve-ov-size-${tab}`, JSON.stringify(size));
}

/** Toggles responsive helper classes on widget containers when resized. */
function syncWidgetSizeClasses(tab: TabId, w: number, h: number): void {
  const el = document.getElementById(`ov-widget-${tab}`);
  if (!el) return;
  el.classList.toggle("ov-compact-h", h < 380);
  el.classList.toggle("ov-mini-h", h < 240);
  el.classList.toggle("ov-narrow-w", w < 300);
}

/** Keeps every open widget on screen when the panel changes size or monitor. */
function clampWidgetsIntoView(): void {
  const winW = window.innerWidth || 1920;
  const winH = window.innerHeight || 1080;
  // A hidden overlay is often resized to a 1x1 helper surface. Clamping then
  // writes 8/8 over every saved position, which is exactly how all widgets
  // ended up stacked in the corner. Never persist a layout from that state.
  if (document.hidden || winW < 480 || winH < 320) return;
  for (const tab of TABS) {
    const el = document.getElementById(`ov-widget-${tab.id}`);
    if (!el || el.style.display === "none") continue;
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 300;
    const maxX = Math.max(WIDGET_MARGIN, winW - width - WIDGET_MARGIN);
    const maxY = Math.max(OVERLAY_SAFE_TOP, winH - height - WIDGET_MARGIN);
    const x = Math.max(WIDGET_MARGIN, Math.min(maxX, el.offsetLeft));
    const y = Math.max(OVERLAY_SAFE_TOP, Math.min(maxY, el.offsetTop));
    if (x === el.offsetLeft && y === el.offsetTop) continue;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    saveWidgetPos(tab.id, { x, y });
  }
}

/** Puts every open widget back on its default tile and forgets saved places. */
function resetWidgetLayout(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("efxlve-ov-pos-")) localStorage.removeItem(key);
  }
  for (const tab of TABS) {
    const widget = document.getElementById(`ov-widget-${tab.id}`);
    if (!widget || widget.style.display === "none") continue;
    const pos = getDefaultWidgetPos(tab.id);
    widget.style.left = `${pos.x}px`;
    widget.style.top = `${pos.y}px`;
  }
  clampWidgetsIntoView();
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

let draggingTab: TabId | null = null;
let dragStartX = 0;
let dragStartY = 0;
let widgetStartLeft = 0;
let widgetStartTop = 0;
let draggingInitialized = false;

/** Ends a drag: saves the place and drops the grabbing state. */
function finishWidgetDrag(): void {
  if (!draggingTab) return;
  const el = document.getElementById(`ov-widget-${draggingTab}`);
  if (el) saveWidgetPos(draggingTab, { x: el.offsetLeft, y: el.offsetTop });
  document.querySelectorAll(".ov-widget-header.is-dragging").forEach((header) => {
    header.classList.remove("is-dragging");
  });
  draggingTab = null;
}

function initWidgetDragging(): void {
  if (draggingInitialized) return;
  draggingInitialized = true;

  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const widget = target.closest<HTMLElement>(".ov-widget");
    if (widget && widget.dataset.widgetId) {
      bringToFront(widget.dataset.widgetId as TabId);
    }

    const header = target.closest<HTMLElement>("[data-widget-drag]");
    if (!header) return;

    if (target.closest("button, input, [data-ov-toggle], [data-ov-widget-close], a")) return;

    const tabId = header.dataset.widgetDrag as TabId | undefined;
    if (!tabId) return;
    // A pinned widget keeps its place.
    if (isWidgetPinned(tabId)) return;

    const el = document.getElementById(`ov-widget-${tabId}`);
    if (!el) return;

    draggingTab = tabId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    widgetStartLeft = el.offsetLeft;
    widgetStartTop = el.offsetTop;
    header.classList.add("is-dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!draggingTab) return;
    // Released outside the window: no mouseup will arrive.
    if ((e.buttons & 1) === 0) {
      finishWidgetDrag();
      return;
    }
    const el = document.getElementById(`ov-widget-${draggingTab}`);
    if (!el) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const winW = window.innerWidth || 1920;
    const winH = window.innerHeight || 1080;
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 300;

    const newX = Math.max(WIDGET_MARGIN, Math.min(Math.max(WIDGET_MARGIN, winW - width - WIDGET_MARGIN), widgetStartLeft + dx));
    const newY = Math.max(OVERLAY_SAFE_TOP, Math.min(Math.max(OVERLAY_SAFE_TOP, winH - height - WIDGET_MARGIN), widgetStartTop + dy));

    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
  });

  window.addEventListener("mouseup", finishWidgetDrag);
}

let resizingTab: TabId | null = null;
let resizeStartX = 0;
let resizeStartY = 0;
let widgetStartW = 0;
let widgetStartH = 0;
let resizingInitialized = false;

/** Ends a resize: stores the final size and drops the resize cursor. */
function finishWidgetResize(): void {
  if (!resizingTab) return;
  const el = document.getElementById(`ov-widget-${resizingTab}`);
  if (el) {
    saveWidgetSize(resizingTab, { w: el.offsetWidth, h: el.offsetHeight });
    syncWidgetSizeClasses(resizingTab, el.offsetWidth, el.offsetHeight);
  }
  resizingTab = null;
  document.body.style.cursor = "";
}

function initWidgetResizing(): void {
  if (resizingInitialized) return;
  resizingInitialized = true;

  document.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const resizer = target.closest<HTMLElement>("[data-widget-resize]");
    if (!resizer) return;

    const tabId = resizer.dataset.widgetResize as TabId | undefined;
    if (!tabId) return;
    // A pinned widget keeps its size (its handle is hidden as well).
    if (isWidgetPinned(tabId)) return;

    const el = document.getElementById(`ov-widget-${tabId}`);
    if (!el) return;

    bringToFront(tabId);
    resizingTab = tabId;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    widgetStartW = el.offsetWidth;
    widgetStartH = el.offsetHeight;
    document.body.style.cursor = "nwse-resize";
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener("mousemove", (e) => {
    if (!resizingTab) return;
    // Released outside the window: no mouseup will arrive.
    if ((e.buttons & 1) === 0) {
      finishWidgetResize();
      return;
    }
    const el = document.getElementById(`ov-widget-${resizingTab}`);
    if (!el) return;

    const limits = getWidgetSizeLimits(resizingTab);
    const winW = window.innerWidth || 1920;
    const winH = window.innerHeight || 1080;

    const maxAllowedW = Math.min(limits.maxW, Math.max(limits.minW, winW - el.offsetLeft - 8));
    const maxAllowedH = Math.min(limits.maxH, Math.max(limits.minH, winH - el.offsetTop - 8));

    const newW = Math.max(limits.minW, Math.min(maxAllowedW, widgetStartW + (e.clientX - resizeStartX)));
    const newH = Math.max(limits.minH, Math.min(maxAllowedH, widgetStartH + (e.clientY - resizeStartY)));

    el.style.width = `${newW}px`;
    el.style.height = `${newH}px`;
    syncWidgetSizeClasses(resizingTab, newW, newH);
  });

  window.addEventListener("mouseup", finishWidgetResize);
}

/* ---------- Battery Monitoring ---------- */

interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
  addEventListener(type: "chargingchange" | "levelchange", listener: EventListener): void;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

let cachedBattery: { level: number; charging: boolean } | null = null;
let batteryListenerAttached = false;

function initBatteryMonitoring(): void {
  const nav = navigator as NavigatorWithBattery;
  if (!nav.getBattery || batteryListenerAttached) return;
  batteryListenerAttached = true;
  nav.getBattery()
    .then((battery) => {
      const update = (): void => {
        cachedBattery = {
          level: Math.round(battery.level * 100),
          charging: battery.charging,
        };
        paintBattery();
      };
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    })
    .catch(() => undefined);
}

function paintBattery(): void {
  const el = document.getElementById("ov-topbar-battery");
  if (!el) return;
  const showPct = showBatteryPercent();
  if (!cachedBattery) {
    el.innerHTML = `<span class="ov-battery-icon">${icon("battery", 15)}</span>`;
    el.title = t("common.battery");
    return;
  }
  const ic = cachedBattery.charging ? icon("battery-charging", 15) : icon("battery", 15);
  el.innerHTML = `
    <span class="ov-battery-icon">${ic}</span>
    ${showPct ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
  `;
  el.title = `${t("common.battery")}: ${cachedBattery.level}%`;
}

/* ---------- Recent Games (Top Bar Left) ---------- */

interface RecentGameInfo {
  appName: string;
  title: string;
  coverUrl?: string;
}

let recentMenuOpen = false;

function inferStoreLabel(appName: string): string {
  if (appName.startsWith("steam::")) return "Steam";
  if (appName.startsWith("gog::")) return "GOG";
  if (appName.startsWith("amazon::")) return "Amazon";
  if (appName.startsWith("ubisoft::")) return "Ubisoft";
  if (appName.startsWith("ea::")) return "EA";
  if (appName.startsWith("xbox::")) return "Xbox";
  if (appName.startsWith("battlenet::")) return "Battle.net";
  if (appName.startsWith("riot::")) return "Riot";
  if (appName.startsWith("custom::")) return t("customGames.storeLabel");
  return "Epic Games";
}

function getRecentGames(): RecentGameInfo[] {
  let list: RecentGameInfo[] = [];
  try {
    const raw = localStorage.getItem("efxlve-recent-games-cache");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
    }
  } catch {
    // fallback
  }

  if (list.length === 0) {
    try {
      const raw = localStorage.getItem("efxlve-recent");
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length > 0) {
          list = ids.map((id: string) => {
            let title = id;
            let coverUrl = "";
            if (id.startsWith("steam::")) {
              const appId = id.slice(7);
              title = `Steam App ${appId}`;
              coverUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
            }
            return { appName: id, title, coverUrl };
          });
        }
      }
    } catch {
      // fallback
    }
  }

  if (!launcherMode && context.appName && context.title) {
    const idx = list.findIndex((g) => g.appName === context.appName);
    if (idx >= 0) {
      const [item] = list.splice(idx, 1);
      list.unshift(item);
    } else {
      list.unshift({ appName: context.appName, title: context.title });
    }
  }

  return list.slice(0, 5);
}

function recentGamesPillHtml(): string {
  const list = getRecentGames();
  const isPlaying = !launcherMode && Boolean(context.title);
  const activeTitle = isPlaying ? context.title : "";
  const pillTitle = activeTitle.split(/\s+[–—-]\s+/)[0].trim() || activeTitle;
  const activeGame = isPlaying
    ? list.find((g) => g.appName === context.appName) || { appName: context.appName, title: context.title, coverUrl: "" }
    : null;

  return `
    <button class="ov-topbar-game-hub-btn ${isPlaying ? "is-playing" : ""}" id="ov-topbar-game-hub-btn" data-ov="toggle-recent-menu" title="${esc(t("profile.recentGamesTitle"))}">
      ${isPlaying ? `
        <span class="ov-hub-art-wrap">
          ${activeGame?.coverUrl
            ? `<img class="ov-hub-art" src="${esc(activeGame.coverUrl)}" alt="" />`
            : `<span class="ov-hub-art ov-ph">${icon("gamepad-2", 13)}</span>`
          }
          <span class="ov-hub-live-dot" title="${esc(t("overlay.running"))}"></span>
        </span>
        <span class="ov-hub-title" title="${esc(activeTitle)}">${esc(pillTitle)}</span>
      ` : `
        <span class="ov-hub-icon">${icon("gamepad-2", 14)}</span>
        <span class="ov-hub-title">${esc(t("profile.recentGamesTitle"))}</span>
        <span class="ov-hub-chip">${list.length}</span>
      `}
      <span class="ov-hub-arrow">${icon("chevron-down", 11)}</span>
    </button>
    <div class="ov-quick-launch-popover" id="ov-recent-dropdown"${recentMenuOpen ? "" : ' style="display:none"'}>
      <div class="ov-quick-header">
        <div class="ov-quick-header-title">
          ${icon("sparkles", 13)}
          <span>${esc(t("profile.recentGamesTitle"))}</span>
        </div>
        <span class="ov-quick-header-badge">${list.length} ${esc(t("profile.games"))}</span>
      </div>
      <div class="ov-quick-cards">
        ${list.length > 0 ? list.map((g) => {
          const isCurrent = !launcherMode && context.appName === g.appName;
          const storeLabel = inferStoreLabel(g.appName);
          return `
            <button class="ov-quick-card ${isCurrent ? "is-current" : ""}" data-ov="launch-recent-game" data-id="${esc(g.appName)}" title="${esc(g.title)}">
              <div class="ov-quick-card-art-wrap">
                ${g.coverUrl ? `<img class="ov-quick-card-art" src="${esc(g.coverUrl)}" alt="" loading="lazy" />` : `<div class="ov-quick-card-art ov-ph">${icon("gamepad-2", 16)}</div>`}
                ${isCurrent ? `<span class="ov-quick-live-indicator" title="${esc(t("overlay.running"))}"></span>` : ""}
              </div>
              <div class="ov-quick-card-info">
                <span class="ov-quick-card-title">${esc(g.title)}</span>
                <div class="ov-quick-card-tags">
                  ${isCurrent
                    ? `<span class="ov-quick-tag is-running">● ${esc(t("overlay.running"))}</span>`
                    : `<span class="ov-quick-tag is-store">${esc(storeLabel)}</span>`
                  }
                </div>
              </div>
              <div class="ov-quick-card-action">
                <span class="ov-quick-play-btn">${icon("play", 11)}</span>
              </div>
            </button>
          `;
        }).join("") : `
          <div class="ov-quick-empty">${esc(t("profile.noRecentGames"))}</div>
        `}
      </div>
    </div>`;
}

function refreshRecentGamesPill(): void {
  const wrap = document.getElementById("ov-topbar-recent-wrap");
  if (wrap) wrap.innerHTML = recentGamesPillHtml();
}

function toggleRecentMenu(): void {
  recentMenuOpen = !recentMenuOpen;
  const menu = document.getElementById("ov-recent-dropdown");
  if (menu) menu.style.display = recentMenuOpen ? "flex" : "none";
}

function closeRecentMenu(): void {
  recentMenuOpen = false;
  const menu = document.getElementById("ov-recent-dropdown");
  if (menu) menu.style.display = "none";
}

async function launchRecentGame(appName: string): Promise<void> {
  closeRecentMenu();
  if (!launcherMode && context.appName === appName) {
    void invoke("overlay_hide");
    return;
  }
  const separator = appName.indexOf("::");
  const store = separator >= 0 ? appName.slice(0, separator) : "";
  const id = separator >= 0 ? appName.slice(separator + 2) : appName;
  try {
    if (store === "steam") {
      // The opener plugin only allows mailto/tel/http(s); steam:// dies there
      // and the old code still closed the panel, so the click looked dead.
      await invoke("steam_game_action", { appId: id, action: "launch" });
    } else if (store === "amazon") {
      await invoke("nile_launch", { id });
    } else if (store === "custom") {
      await invoke("custom_games_launch", { id });
    } else if (store === "ea" || store === "ubisoft" || store === "xbox" || store === "battlenet" || store === "riot") {
      await invoke("companion_launch", { store, id });
    } else if (store === "gog") {
      await invoke("gog_launch_game", { gameId: appName });
    } else {
      await invoke("epic_launch_game", { appName });
    }
  } catch {
    void invoke("overlay_show_launcher");
  }
  void invoke("overlay_hide");
}

/* ---------- Shell HTML Template ---------- */

function shellHtml(): string {
  const hudActive = localStorage.getItem(HUD_KEY) === "true";
  const tabs = visibleTabs();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const padConnected = Boolean(gamepads.find((p) => p && p.connected));
  return `
    <div class="ov" id="ov-shell">
      <!-- Floating Top Widget Bar (Xbox Game Bar style) -->
      <header class="ov-topbar" id="ov-topbar">
        <div class="ov-topbar-recent-wrap" id="ov-topbar-recent-wrap">
          ${recentGamesPillHtml()}
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-widgets" id="ov-topbar-widgets">
          ${tabs.map((tab) => `
            <button class="ov-topbar-btn ${isWidgetOpen(tab.id) ? "active" : ""}" data-ov-widget-toggle="${tab.id}" title="${esc(t(tab.key))}">
              ${icon(tab.icon, 15)}
              <span class="ov-topbar-btn-label">${esc(t(tab.key))}</span>
            </button>
          `).join("")}
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-clock">
          <span id="ov-clock-time">00:00</span><span class="ov-clock-sec" id="ov-clock-sec" style="${showClockSeconds() ? "" : "display:none"}">:00</span>
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-battery" id="ov-topbar-battery" title="${esc(t("common.battery"))}">
          <span class="ov-battery-icon">${icon("battery", 15)}</span>
          ${showBatteryPercent() && cachedBattery ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
        </div>

        <div class="ov-topbar-gamepad" id="ov-topbar-gamepad" style="${padConnected ? "" : "display:none"}" title="${esc(t("settings.secController"))}">
          ${icon("gamepad-2", 15)}
        </div>

        <button class="ov-topbar-btn ov-topbar-settings-btn ${isWidgetOpen("settings") ? "active" : ""}" data-ov-widget-toggle="settings" title="${esc(t("overlay.tabSettings"))}">
          ${icon("settings", 15)}
        </button>

        <button class="ov-topbar-btn ov-topbar-close-btn" data-ov="close" title="${esc(t("common.close"))}">
          ${icon("x", 15)}
        </button>
      </header>

      <!-- Floating Widgets Container -->
      <div class="ov-widgets-container" id="ov-widgets-container">
        ${TABS.filter((t) => t.id !== "browser").map((tab) => `
          <section class="ov-widget" id="ov-widget-${tab.id}" data-widget-id="${tab.id}">
            <header class="ov-widget-header" data-widget-drag="${tab.id}">
              <div class="ov-widget-title">
                ${icon(tab.icon, 14)}
                <span>${esc(tab.id === "discord" ? t("overlay.discordSocial") : tab.id === "chat" ? t("overlay.discordChat") : t(tab.key))}</span>
              </div>
              <div class="ov-widget-header-actions">
                ${tab.id === "music" ? `
                  <button class="ov-widget-tool-btn ov-sp-mini-toggle-btn" id="ov-sp-mini-toggle-btn" data-ov="sp-toggle-mini-view" title="${esc(t("overlay.library"))}">
                    ${icon("list", 12)}
                  </button>
                ` : ""}
                <button class="ov-widget-tool-btn ov-widget-pin-btn${isWidgetPinned(tab.id) ? " is-pinned" : ""}" data-ov-widget-pin="${tab.id}" title="${esc(isWidgetPinned(tab.id) ? t("overlay.widgetUnpin") : t("overlay.widgetPin"))}">
                  ${icon("pin", 12)}
                </button>
                <button class="ov-widget-tool-btn ov-widget-close-btn" data-ov-widget-close="${tab.id}" title="${esc(t("common.close"))}">
                  ${icon("x", 13)}
                </button>
              </div>
            </header>
            <div class="ov-widget-body" id="ov-widget-${tab.id}-body" data-ov-view="${tab.id}"></div>
            <div class="ov-widget-resizer" data-widget-resize="${tab.id}" title="${esc(t("overlay.widgetResize"))}"></div>
          </section>
        `).join("")}
      </div>

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

/* 6b. Audio Mixer View */

const AUDIO_PRESETS_KEY = "efxlve-overlay-audio-presets";

interface AudioPresetSession {
  key: string;
  volume: number;
  muted: boolean;
}

interface AudioPreset {
  name: string;
  master: number;
  masterMuted: boolean;
  sessions: AudioPresetSession[];
}

let audioPresetSelected = "";

/** The stable part of a session across polls: the process name, or the system bus. */
function audioSessionKey(session: AudioSession): string {
  if (session.system || session.pid === 0) return "system";
  return session.name || `pid:${session.pid}`;
}

function loadAudioPresets(): AudioPreset[] {
  try {
    const raw = localStorage.getItem(AUDIO_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AudioPreset[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((preset) => preset && typeof preset.name === "string" && Array.isArray(preset.sessions))
      .map((preset) => ({
        name: preset.name,
        master: Number.isFinite(preset.master) ? Math.max(0, Math.min(1, preset.master)) : 1,
        masterMuted: preset.masterMuted === true,
        sessions: preset.sessions
          .filter((entry) => entry && typeof entry.key === "string")
          .map((entry) => ({
            key: entry.key,
            volume: Number.isFinite(entry.volume) ? Math.max(0, Math.min(1, entry.volume)) : 1,
            muted: entry.muted === true,
          })),
      }));
  } catch {
    return [];
  }
}

function saveAudioPresets(presets: AudioPreset[]): void {
  // Keep the newest: a preset the UI just reported as saved must not be the one
  // silently dropped at the 12-entry cap.
  localStorage.setItem(AUDIO_PRESETS_KEY, JSON.stringify(presets.slice(-12)));
}

function captureAudioPreset(): AudioPreset | null {
  if (!audioState) return null;
  const presets = loadAudioPresets();
  const name = `Mix ${presets.length + 1}`;
  return {
    name,
    master: audioState.master,
    masterMuted: audioState.masterMuted,
    sessions: audioState.sessions.map((session) => ({
      key: audioSessionKey(session),
      volume: session.volume,
      muted: session.muted,
    })),
  };
}

async function applyAudioPreset(preset: AudioPreset): Promise<void> {
  const sessions = audioState?.sessions ?? [];
  const tasks: Promise<unknown>[] = [
    invoke("overlay_audio_set_master", { volume: preset.master }),
    invoke("overlay_audio_set_master_mute", { muted: preset.masterMuted }),
  ];
  for (const entry of preset.sessions) {
    const session = sessions.find((item) => audioSessionKey(item) === entry.key);
    if (!session) continue;
    tasks.push(invoke("overlay_audio_set_volume", { id: session.id, volume: entry.volume }));
    tasks.push(invoke("overlay_audio_set_mute", { id: session.id, muted: entry.muted }));
  }
  await Promise.allSettled(tasks);
  await refreshAudio(true);
  toast(t("overlay.audioPresetApplied", { name: preset.name }));
}

/** The row label: system sounds, the app's own display name, or the process. */
function audioLabel(session: AudioSession): string {
  if (session.system || session.pid === 0) return t("overlay.audioSystem");
  return session.displayName || session.name || `PID ${session.pid}`;
}

/** The muted second line: the executable behind a friendly display name. */
function audioSubLabel(session: AudioSession): string {
  if (session.system || session.pid === 0) return "";
  if (!session.displayName || !session.name || session.displayName === session.name) return "";
  return session.name;
}

function audioRowHtml(opts: {
  master?: boolean;
  id?: string;
  label: string;
  sub?: string;
  icon?: string;
  volume: number;
  muted: boolean;
  system?: boolean;
}): string {
  const id = opts.id ?? "";
  const rangeAttr = opts.master ? "data-audio-master" : `data-audio-volume="${esc(id)}"`;
  const muteAttr = opts.master ? "data-audio-master-mute" : `data-audio-mute="${esc(id)}"`;
  const percent = Math.round(opts.volume * 100);
  return `
    <div class="ov-audio-row${opts.master ? " is-master" : ""}">
      <div class="ov-audio-name" title="${esc(opts.label)}${opts.sub ? ` · ${esc(opts.sub)}` : ""}">
        ${opts.icon ? `<img class="ov-audio-icon" src="${esc(opts.icon)}" alt="" />` : icon(opts.master || opts.system ? "volume-2" : "music", 13)}
        <div class="ov-audio-text">
          <span class="ov-audio-label">${esc(opts.label)}</span>
          ${opts.sub ? `<span class="ov-audio-sub">${esc(opts.sub)}</span>` : ""}
        </div>
      </div>
      <input class="ov-audio-range" type="range" min="0" max="100" step="1" value="${percent}" ${rangeAttr} />
      <span class="ov-audio-pct">${percent}%</span>
      <button class="ov-audio-mute${opts.muted ? " is-muted" : ""}" ${muteAttr} title="${esc(opts.muted ? t("overlay.discordCallUnmute") : t("overlay.discordCallMute"))}">
        ${icon(opts.muted ? "volume-x" : "volume-2", 13)}
      </button>
    </div>`;
}

function renderAudio(): void {
  const el = viewEl("audio");
  if (!el) return;
  const scroll = el.scrollTop;
  if (audioError) {
    el.innerHTML = emptyBlockHtml("volume-2", t("overlay.audioUnavailable"), audioError);
    el.scrollTop = scroll;
    return;
  }
  if (!audioState) {
    el.innerHTML = `<div class="ov-audio-loading">${esc(t("overlay.audioLoading"))}</div>`;
    el.scrollTop = scroll;
    return;
  }
  const master = audioRowHtml({
    master: true,
    label: t("overlay.audioMaster"),
    volume: audioState.master,
    muted: audioState.masterMuted,
  });
  const presets = loadAudioPresets();
  if (!presets.some((preset) => preset.name === audioPresetSelected)) {
    audioPresetSelected = presets[0]?.name ?? "";
  }
  const devices = audioState.devices ?? [];
  const deviceRow = `<div class="ov-audio-presets">
    <span class="ov-audio-presets-title">${icon("volume-2", 12)} ${esc(t("overlay.audioOutput"))}</span>
    <select class="input select small" id="ov-audio-device" ${devices.length === 0 ? "disabled" : ""}>
      ${devices.length === 0
        ? `<option>${esc(t("overlay.audioUnavailable"))}</option>`
        : devices.map((device) => `<option value="${esc(device.id)}" ${device.default || device.id === audioState?.defaultDevice ? "selected" : ""}>${esc(device.name)}</option>`).join("")}
    </select>
  </div>`;
  const presetRow = `<div class="ov-audio-presets">
    <span class="ov-audio-presets-title">${icon("layers", 12)} ${esc(t("overlay.audioPresetsTitle"))}</span>
    <select class="input select small" id="ov-audio-preset-select" ${presets.length === 0 ? "disabled" : ""}>
      ${presets.length === 0
        ? `<option>${esc(t("overlay.audioPresetEmpty"))}</option>`
        : presets.map((preset) => `<option value="${esc(preset.name)}" ${preset.name === audioPresetSelected ? "selected" : ""}>${esc(preset.name)}</option>`).join("")}
    </select>
    <button class="btn ghost small" data-audio-preset="save">${esc(t("overlay.audioPresetSave"))}</button>
    <button class="btn ghost small" data-audio-preset="apply" ${presets.length === 0 ? "disabled" : ""}>${esc(t("overlay.audioPresetApply"))}</button>
    <button class="btn ghost small" data-audio-preset="delete" ${presets.length === 0 ? "disabled" : ""}>${esc(t("overlay.audioPresetDelete"))}</button>
  </div>`;
  const rows = audioState.sessions.map((session) =>
    audioRowHtml({
      id: session.id,
      label: audioLabel(session),
      sub: audioSubLabel(session),
      icon: session.icon,
      volume: session.volume,
      muted: session.muted,
      system: session.system,
    }),
  );
  el.innerHTML = `
    <div class="ov-audio">
      <div class="ov-audio-head">
        <span class="ov-audio-title">${icon("volume-2", 14)} ${esc(t("overlay.tabAudio"))}</span>
        <button class="ov-audio-refresh" data-audio-refresh title="${esc(t("overlay.audioRefresh"))}">${icon("refresh", 13)}</button>
      </div>
      ${deviceRow}
      ${presetRow}
      ${master}
      <div class="ov-audio-list">
        ${rows.length > 0 ? rows.join("") : emptyBlockHtml("volume-2", t("overlay.audioEmpty"), t("overlay.audioEmptyDesc"))}
      </div>
    </div>`;
  el.scrollTop = scroll;
}

/** Pulls the session list. Polling pauses while a slider is being dragged so
 *  the next poll cannot overwrite the value under the thumb. */
async function refreshAudio(force = false): Promise<void> {
  if (!force && performance.now() < audioHoldUntil) return;
  if (audioLoading) return;
  audioLoading = true;
  try {
    audioState = await invoke<AudioState>("overlay_audio_state");
    audioError = "";
  } catch (error) {
    audioError = String(error);
  } finally {
    audioLoading = false;
  }
  if (isWidgetOpen("audio")) {
    if (
      document.activeElement?.id === "ov-audio-preset-select" ||
      document.activeElement?.id === "ov-audio-device"
    ) {
      return;
    }
    renderAudio();
  }
}

function startAudioPolling(): void {
  if (audioPollTimer !== null) return;
  void refreshAudio(true);
  audioPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (ghostMode && !isWidgetPinned("audio")) return;
    void refreshAudio(false);
  }, 2000);
}

function stopAudioPolling(): void {
  if (audioPollTimer !== null) {
    window.clearInterval(audioPollTimer);
    audioPollTimer = null;
  }
}

function scheduleAudioVolume(id: string, volume: number): void {
  const previous = audioVolumeTimers.get(id);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    audioVolumeTimers.delete(id);
    void invoke("overlay_audio_set_volume", { id, volume }).catch(() => undefined);
  }, 60);
  audioVolumeTimers.set(id, timer);
}

function scheduleAudioMaster(volume: number): void {
  if (audioMasterTimer !== null) window.clearTimeout(audioMasterTimer);
  audioMasterTimer = window.setTimeout(() => {
    audioMasterTimer = null;
    void invoke("overlay_audio_set_master", { volume }).catch(() => undefined);
  }, 60);
}

async function toggleAudioMute(id: string): Promise<void> {
  const session = audioState?.sessions.find((entry) => entry.id === id);
  if (!session) return;
  session.muted = !session.muted;
  audioHoldUntil = performance.now() + 1200;
  renderAudio();
  try {
    await invoke("overlay_audio_set_mute", { id, muted: session.muted });
  } catch {
    // The next poll restores the real state.
  }
}

async function toggleAudioMasterMute(): Promise<void> {
  if (!audioState) return;
  audioState.masterMuted = !audioState.masterMuted;
  audioHoldUntil = performance.now() + 1200;
  renderAudio();
  try {
    await invoke("overlay_audio_set_master_mute", { muted: audioState.masterMuted });
  } catch {
    // The next poll restores the real state.
  }
}

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
    pinnedTabs: () => [...widgetPins],
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
      const action = audioPresetBtn.dataset.audioPreset;
      if (action === "save") {
        const preset = captureAudioPreset();
        if (preset) {
          saveAudioPresets([...loadAudioPresets(), preset]);
          audioPresetSelected = preset.name;
          renderAudio();
          toast(t("overlay.audioPresetSaved", { name: preset.name }));
        }
      } else if (action === "apply") {
        const preset = loadAudioPresets().find((item) => item.name === audioPresetSelected);
        if (preset) void applyAudioPreset(preset);
        else toast(t("overlay.audioPresetMissing"), "err");
      } else if (action === "delete") {
        const remaining = loadAudioPresets().filter((item) => item.name !== audioPresetSelected);
        saveAudioPresets(remaining);
        audioPresetSelected = remaining[0]?.name ?? "";
        renderAudio();
      }
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
    if (recentMenuOpen && !target.closest(".ov-topbar-recent-wrap")) {
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

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    if (input.id === "ov-audio-preset-select") {
      audioPresetSelected = input.value;
      return;
    }
    if (input.id === "ov-audio-device") {
      const id = input.value;
      if (!id) return;
      void invoke("overlay_audio_set_device", { id })
        .then(() => refreshAudio(true))
        .catch((error) => toast(String(error), "err"));
      return;
    }
    if (input.dataset.crosshairHotkey !== undefined) {
      commitCrosshair(
        { ...activeCrosshair(), hotkey: input.value as CrosshairHotkey },
        true,
      );
      return;
    }
    const toggle = input.dataset.ovToggle;
    if (toggle && handleSettingsToggle(toggle, input, settingsDeps())) {
      return;
    }
    if (input.id === "ov-setting-browser-hp-select") {
      const sel = input as unknown as HTMLSelectElement;
      const customInput = document.getElementById("ov-setting-browser-hp-custom") as HTMLInputElement | null;
      if (sel.value === "custom") {
        if (customInput) {
          customInput.style.display = "inline-block";
          customInput.focus();
        }
      } else {
        if (customInput) customInput.style.display = "none";
        localStorage.setItem(HOMEPAGE_STORAGE_KEY, sel.value);
      }
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "ov-discord-search") {
      setDiscordSearchQuery(target.value);
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-dc-friends-filter") {
      setDiscordFriendsFilter(target.value);
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-sp-search-input") {
      setSpotifySearchQuery(target.value);
      return;
    }
    if (target instanceof HTMLTextAreaElement && target.id === "ov-discord-reply-input") {
      setDiscordReplyDraft(target.value);
      growComposer(target);
      const count = document.querySelector<HTMLElement>(".composer-count");
      if (count) count.textContent = `${target.value.length} / 2000`;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-setting-browser-hp-custom") {
      let val = target.value.trim();
      if (val && !val.startsWith("http://") && !val.startsWith("https://")) {
        val = `https://${val}`;
      }
      if (val) localStorage.setItem(HOMEPAGE_STORAGE_KEY, val);
      return;
    }
    const input = event.target as HTMLInputElement | null;
    if (input?.dataset.crosshairSize !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-size-val");
      if (badge) badge.textContent = `${Math.round(value)}px`;
      const next = { ...activeCrosshair(), size: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairGap !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-gap-val");
      if (badge) badge.textContent = `${Math.round(value)}px`;
      const next = { ...activeCrosshair(), gap: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairThickness !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-thickness-val");
      if (badge) badge.textContent = `${value.toFixed(1)}px`;
      const next = { ...activeCrosshair(), thickness: value };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.crosshairOpacity !== undefined) {
      const value = Number(input.value);
      const badge = document.getElementById("ov-crosshair-opacity-val");
      if (badge) badge.textContent = `${Math.round(value)}%`;
      const next = { ...activeCrosshair(), opacity: value / 100 };
      paintCrosshairPreview(next);
      scheduleCrosshairConfig(next);
      return;
    }
    if (input?.dataset.ghostOpacity) {
      const tab = input.dataset.ghostOpacity as TabId;
      const value = Number(input.value) / 100;
      const badge = document.getElementById(`ov-ghost-opacity-${tab}`);
      if (badge) badge.textContent = `${Math.round(value * 100)}%`;
      setGhostOpacity(tab, value);
      return;
    }
    if (input?.dataset.audioVolume !== undefined) {
      const id = input.dataset.audioVolume;
      const volume = Number(input.value) / 100;
      audioHoldUntil = performance.now() + 1500;
      const pct = input.closest(".ov-audio-row")?.querySelector(".ov-audio-pct");
      if (pct) pct.textContent = `${input.value}%`;
      scheduleAudioVolume(id, volume);
      return;
    }
    if (input?.dataset.audioMaster !== undefined) {
      const volume = Number(input.value) / 100;
      audioHoldUntil = performance.now() + 1500;
      const pct = input.closest(".ov-audio-row")?.querySelector(".ov-audio-pct");
      if (pct) pct.textContent = `${input.value}%`;
      scheduleAudioMaster(volume);
      return;
    }
    if (input?.dataset.ovOpacity === undefined) return;
    const val = Number(input.value);
    localStorage.setItem(OPACITY_KEY, String(val));
    applyOpacity(val);
    const badge = document.getElementById("ov-opacity-val");
    if (badge) badge.textContent = `${val}%`;
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
    // The lightbox is modal: arrows page through the gallery and Escape closes
    // it, instead of moving the hidden panel's focus ring behind it.
    if (lightboxIsOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        hideLightbox();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
    }
    if (event.key === "Escape" && isShotFilterPopoverOpen()) {
      closeShotFilterPopover();
      return;
    }
    // Composer keys: Enter sends, Shift+Enter adds a line, Ctrl+Up/Down walks
    // the friend list without leaving the box.
    const typed = event.target;
    // Enter in the add-friend search runs it.
    if (typed instanceof HTMLInputElement && typed.id === "ov-discord-search") {
      if (event.key === "Enter") {
        event.preventDefault();
        runUserSearch();
      }
      return;
    }
    if (typed instanceof HTMLInputElement && (typed.id === "ov-home-browser-input" || typed.id === "ov-browser-hub-input")) {
      if (event.key === "Enter") {
        event.preventDefault();
        const url = typed.value.trim() || null;
        void invoke("overlay_browser_open", { url });
      }
      return;
    }
    if (typed instanceof HTMLInputElement && (typed.id === "ov-add-bm-label" || typed.id === "ov-add-bm-url")) {
      if (event.key === "Enter") {
        event.preventDefault();
        const addBtn = document.querySelector<HTMLButtonElement>('[data-ov="add-browser-bookmark"]');
        addBtn?.click();
      }
      return;
    }
    const inComposer = typed instanceof HTMLTextAreaElement && typed.id === "ov-discord-reply-input";
    if (inComposer && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDiscordComposer();
      return;
    }
    if (inComposer && (event.ctrlKey || event.metaKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      stepReplyTarget(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // Typing on a focused friend row jumps into the box with that letter.
    if (!isTextEntryFocused() && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const row = document.activeElement as HTMLElement | null;
      if (row?.dataset.ov === "discord-select-friend" && row.dataset.id) {
        event.preventDefault();
        selectReplyTarget(row.dataset.id, row.dataset.name || row.dataset.id, event.key);
        return;
      }
    }
    if (isTextEntryFocused()) {
      // Esc leaves the box back to the friend row first; the next Esc closes.
      // While editing, it cancels the edit and brings the compose draft back.
      if (event.key === "Escape") {
        if (isEditingDiscordEntry()) {
          cancelDiscordEdit();
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
          focusSelectedFriendRow();
        }
      }
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
      // The lightbox is modal: never activate a control hidden behind it.
      if (lightboxIsOpen()) {
        const box = document.getElementById("ov-lightbox");
        if (focusedEl && box?.contains(focusedEl)) focusedEl.click();
        return;
      }
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
    gamepadSuppressUntil = performance.now() + 450;
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

function onMouseActivity(): void {
  document.body.classList.remove("ov-using-gamepad");
  removeGamepadFocus();
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

  // A modal lightbox owns the ring: nothing behind it may be activated unseen.
  if (lightboxIsOpen()) {
    document.querySelectorAll("#ov-lightbox button").forEach(push);
    return items;
  }

  push(document.getElementById("ov-topbar-game-hub-btn"));
  document.querySelectorAll(".ov-topbar-btn").forEach(push);
  // The quick-launch popover sits outside the widgets; without this the pad can
  // open it but never reach a card.
  if (recentMenuOpen) {
    document.querySelectorAll("#ov-recent-dropdown .ov-quick-card").forEach(push);
  }

  document.querySelectorAll<HTMLElement>(".ov-widget").forEach((w) => {
    if (w.style.display !== "none") {
      w.querySelectorAll<HTMLElement>(
        "button, [data-ov-preview], [data-nav-row], .ov-card[data-nav-target], textarea, input, select",
      ).forEach((el) => {
        // Toggle switches hide their checkbox: the ring belongs on the label.
        if (el instanceof HTMLInputElement && el.type === "checkbox") {
          push(el.closest(".switch") ?? el);
        } else {
          push(el);
        }
      });
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
  return document.querySelector<HTMLElement>(`.ov-topbar-btn[data-ov-widget-toggle="${tab}"]`);
}

function focusDefault(): void {
  // A modal lightbox owns the ring: default to one of its own buttons.
  if (lightboxIsOpen()) {
    focusElement(getFocusableElements()[0] ?? null);
    return;
  }
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

/** Left/right or A on a select cycles its enabled options. */
function adjustSelect(select: HTMLSelectElement, step: number): void {
  const options = Array.from(select.options).filter((option) => !option.disabled);
  if (options.length < 2) return;
  const current = Math.max(0, options.indexOf(select.options[select.selectedIndex]));
  const next = (current + step + options.length) % options.length;
  select.selectedIndex = Array.from(select.options).indexOf(options[next]);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function activateFocused(): void {
  // A lightbox is modal: the ring must live inside it, never on a control the
  // user cannot see behind the image.
  if (lightboxIsOpen() && (!focusedEl || !document.getElementById("ov-lightbox")?.contains(focusedEl))) {
    focusDefault();
    return;
  }
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
  if (el instanceof HTMLSelectElement) {
    adjustSelect(el, 1);
    return;
  }
  const switchesTab = el.matches("[data-nav-target], [data-ov-tab], [data-ov-widget-toggle]");
  el.click();
  // A card or chevron that switched tabs hides the old view: the ring moves
  // to the new active dock button right away.
  window.setTimeout(() => {
    if (switchesTab || !focusedEl || !focusedEl.isConnected) focusElement(dockTabButton(activeTab));
  }, 0);
}

function cycleTab(delta: number): void {
  const tabs = visibleTabs();
  if (tabs.length === 0) return;
  const found = tabs.findIndex((tab) => tab.id === activeTab);
  // `activeTab` can be a settings/chat view that is not in the dock: start at
  // the first tab for RB, the last one for LB, instead of index -1 maths.
  const currentIdx = found >= 0 ? found : delta > 0 ? -1 : 0;
  const nextIdx = (currentIdx + delta + tabs.length) % tabs.length;
  setTab(tabs[nextIdx].id);
  focusElement(dockTabButton(tabs[nextIdx].id));
}

/** Rebuilds the topbar widgets when page visibility changed. */
function refreshDock(): void {
  const host = document.getElementById("ov-topbar-widgets");
  if (!host) return;
  const tabs = visibleTabs();
  host.innerHTML = tabs.map((tab) => `
    <button class="ov-topbar-btn ${isWidgetOpen(tab.id) ? "active" : ""}" data-ov-widget-toggle="${tab.id}" title="${esc(t(tab.key))}">
      ${icon(tab.icon, 15)}
      <span class="ov-topbar-btn-label">${esc(t(tab.key))}</span>
    </button>
  `).join("");
  document.querySelector<HTMLElement>(".ov-topbar-settings-btn")?.classList.toggle("active", isWidgetOpen("settings"));
}

/** B / Esc: close the lightbox, leave the text box, then close. */
function goBack(): void {
  if (lightboxIsOpen()) {
    hideLightbox();
    return;
  }
  if (hasAchievementDetail() && isWidgetOpen("ach")) {
    clearAchievementDetail();
    return;
  }
  if (isTextEntryFocused()) {
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  void invoke("overlay_hide");
}

function scheduleGamepadFrame(): void {
  if (gamepadWakeTimer !== null) {
    window.clearTimeout(gamepadWakeTimer);
    gamepadWakeTimer = null;
  }
  if (gamepadRaf === null && !document.hidden && !ghostMode) {
    gamepadRaf = requestAnimationFrame(pollGamepadLoop);
  }
}

/** No pad connected: check again shortly instead of waking the GPU at 60 Hz. */
function scheduleGamepadWake(): void {
  if (gamepadRaf !== null || gamepadWakeTimer !== null) return;
  gamepadWakeTimer = window.setTimeout(() => {
    gamepadWakeTimer = null;
    scheduleGamepadFrame();
  }, 250);
}

function pollGamepadLoop(): void {
  gamepadRaf = null;
  if (document.hidden || ghostMode) return;

  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = gamepads.find((p) => p && p.connected);

  const topbarPadEl = document.getElementById("ov-topbar-gamepad");

  if (!pad) {
    if (topbarPadEl && topbarPadEl.style.display !== "none") {
      topbarPadEl.style.display = "none";
    }
    prevButtons = [];
    scheduleGamepadWake();
    return;
  }

  if (topbarPadEl && topbarPadEl.style.display === "none") {
    topbarPadEl.style.display = "inline-flex";
  }

  const buttons = pad.buttons.map((b) => b.pressed);

  // Swallow input right after the panel opened: the shortcut that opened it
  // (Guide, Start+Back) is usually still held on the first frames.
  if (performance.now() < gamepadSuppressUntil) {
    prevButtons = buttons;
    scheduleGamepadFrame();
    return;
  }

  // A focused text box owns the pad too: replying must not be interrupted by a
  // drifting stick or a stray button press.
  if (isTextEntryFocused()) {
    prevButtons = buttons;
    scheduleGamepadFrame();
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
      } else if (focusedEl instanceof HTMLSelectElement && (dir === "left" || dir === "right")) {
        adjustSelect(focusedEl, dir === "right" ? 1 : -1);
      } else {
        moveFocus(dir);
      }
    }
  } else {
    lastDir = null;
  }

  if (anyInput) {
    document.body.classList.add("ov-using-gamepad");
    ensureFocus();
  }

  prevButtons = buttons;
  scheduleGamepadFrame();
}

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

function stopGamepadPolling(): void {
  if (gamepadRaf !== null) {
    cancelAnimationFrame(gamepadRaf);
    gamepadRaf = null;
  }
  if (gamepadWakeTimer !== null) {
    window.clearTimeout(gamepadWakeTimer);
    gamepadWakeTimer = null;
  }
  prevButtons = [];
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
  sessionStartEpoch = Date.now();
  gamepadSuppressUntil = performance.now() + 450;

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
