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
  getHomepage,
  loadBookmarks,
} from "./browser-shared";
import { OVERLAY_DISABLED_KEY, OVERLAY_ENABLED_KEY, OVERLAY_HUD_KEY, OVERLAY_OPACITY_KEY } from "../../core/constants";
import { ensureNotesMigration, notesFontSize, onNotesChanged } from "../notes/notes-client";
import { handleOverlayNotesAction, overlayNotesScope, refreshOverlayNotes, renderOverlayNotes, setOverlayNotesScope, setOverlayNotesSettingsRepaint } from "../notes/overlay-notes";
import { ssDensity, ssFavorites, ssNotifyOn, ssSort, ssSortItems, ssSoundOn, ssToggleFavorite } from "../screenshots/ss-settings";
import { clipFps, clipHotkeyName } from "../screenshots/ss-settings";
import { epicGetScreenshotDisabledGames, epicSetScreenshotDisabledGames, epicOpenFolderPath } from "../../epic";
import {
  clipList,
  clipStart,
  clipStatus,
  clipStop,
  clipFolderPath,
  type ClipItem,
  type ClipStatus,
} from "../../epic";
import { SS_DENSITY_KEY, SS_NOTIFY_KEY, SS_SORT_KEY, SS_SOUND_KEY } from "../../core/constants";
import { discordPageVisible, spotifyPageVisible } from "../../core/page-visibility";
import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";
import { currentLanguage, initialLanguage, localizeMessage, setLanguage, t } from "../../i18n";
import {
  formatTime as formatSpotifyTime,
  spotifyPlaybackControl,
  spotifyPlaybackNow,
  spotifyPlaybackPlay,
  spotifyPlaybackPlaylistTracks,
  spotifyPlaybackPlaylists,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  type NowPlaying,
  type PlaylistSummary,
  type TrackSummary,
} from "../music/spotify-client";
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
  cpuGhz?: number | null;
  gameCpu: number | null;
  ramUsedMb: number;
  ramTotalMb: number;
  gpu: number | null;
  vramUsedMb: number | null;
  vramTotalMb?: number | null;
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
  game_title?: string;
  /** Present on the wire; the overlay sorts and sizes with them. */
  timestamp?: number;
  size_bytes?: number;
}

type TabId = "home" | "perf" | "ach" | "shots" | "clip" | "notes" | "music" | "discord" | "chat" | "browser" | "settings";

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
  { id: "discord", icon: "discord", key: "overlay.tabDiscord" },
  { id: "chat", icon: "discord", key: "overlay.discordReplyTitle" },
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
      (tab.id !== "music" || spotifyPageVisible()) &&
      (tab.id !== "discord" || discordPageVisible()),
  );
}

/* ---------- State ---------- */

let context: OpenPayload = { appName: "", title: "" };
/** Opened without a tracked game (over the launcher or any other window). */
let launcherMode = false;
let metrics: MetricsSample | null = null;
type PerfMetric = "cpu" | "gpu" | "vram" | "ram" | "fps";
let activePerfMetric: PerfMetric = "cpu";
let fpsHistory: number[] = [];
let cpuHistory: number[] = [];
let gpuHistory: number[] = [];
let vramHistory: number[] = [];
let ramHistory: number[] = [];
/** The launcher's Connect receiver (the only source the overlay shows). */
let spotifyEngineOn = false;
let spotifyDeviceName = "";
let spotifyNow: NowPlaying | null = null;
let spotifyBaseMs = 0;
let spotifyBaseAt = 0;
let lastMediaActive = false;
/** Library browser state (playlists + the open playlist's tracks). */
let playlists: PlaylistSummary[] | null = null;
let playlistsState: "idle" | "loading" | "ready" | "error" = "idle";
let playlistsError = "";
let selectedPlaylist: string | null = null;
let playlistTracks: TrackSummary[] | null = null;
let tracksState: "idle" | "loading" | "ready" | "error" = "idle";
let tracksError = "";
let tracksFor: string | null = null;
let cachedAchievements: AchievementsData | null = null;
let cachedScreenshots: ScreenshotItem[] = [];
let selectedGameFilters = new Set<string>();
let filterPopoverOpen = false;
let sessionStartEpoch = Date.now();
let activeTab: TabId = (localStorage.getItem("efxlve-overlay-tab") as TabId) || "home";
let browserBounds: { x: number; y: number; w: number; h: number } | null = null;

/* ---------- Discord voice (streamed by the Rust worker) ---------- */

interface VoiceParticipant {
  id: string;
  name: string;
  avatarUrl: string;
  speaking: boolean;
  muted: boolean;
}

interface VoiceChannel {
  id: string;
  name: string;
  guildId: string | null;
}

interface DiscordVoiceState {
  status: string;
  channel: VoiceChannel | null;
  participants: VoiceParticipant[];
  error: string | null;
}

let voiceState: DiscordVoiceState = { status: "idle", channel: null, participants: [], error: null };
/** Last channel with its people, kept so a reconnect does not blank the card. */
let lastVoiceChannel: VoiceChannel | null = null;
let lastVoiceParticipants: VoiceParticipant[] = [];

interface FriendEntry {
  id: string;
  name: string;
  avatarUrl: string;
  /** "online" | "idle" | "dnd" | "offline" */
  status: string;
}

interface DiscordFriendsState {
  status: string;
  friends: FriendEntry[];
  /** Incoming requests, straight from the SDK's relationship list. */
  pendingUsers?: FriendEntry[];
  pending: number;
  error: string | null;
}

let friendsState: DiscordFriendsState = { status: "idle", friends: [], pending: 0, error: null };
/** Last list, kept so a reconnect does not blank the card. */
let lastFriends: FriendEntry[] = [];
let lastFriendsPending = 0;

/* ---------- Discord Social SDK (the reply path) ---------- */

interface SdkMe {
  id: string;
  name: string;
  avatarUrl: string;
  /** "online" | "idle" | "dnd" | "offline" */
  status?: string;
}

interface SdkState {
  /** "idle" | "starting" | "authorizing" | "connecting" | "ready" | "error" */
  status: string;
  error: string | null;
  me: SdkMe | null;
}

let sdkState: SdkState = { status: "idle", error: null, me: null };
/** The SDK's own relationship list: the source that also works with no page. */
let sdkFriends: DiscordFriendsState = { status: "idle", friends: [], pending: 0, error: null };

/** The launcher's own Discord page call (no desktop app involved). */
interface WebVoiceParticipant {
  id: string;
  name: string;
  avatarUrl: string;
  muted: boolean;
  speaking: boolean;
}

interface WebFriend {
  id: string;
  name: string;
  avatarUrl: string;
  status: string;
}

/** A group DM the launcher's own client knows. Read-only here: the overlay
 * lists it and opens the conversation in the real client. */
interface WebGroupConversation {
  id: string;
  name: string;
  members: { id: string; name: string; avatarUrl: string }[];
  memberCount: number;
  unread: number;
  preview: { author: string; text: string } | null;
}

interface WebVoiceState {
  inCall: boolean;
  channel: { id: string; name: string; guild: string } | null;
  participants: WebVoiceParticipant[];
  /** Relationships read from the same stores. */
  friends?: WebFriend[];
  friendsTotal?: number;
  pending?: number;
  /** Voice channels to jump to (the client opens them; joining stays there). */
  channels?: { id: string; name: string; guild: string; guildId: string }[];
  /** Group DMs the client has: the overlay shows them, the client writes them. */
  conversations?: WebGroupConversation[];
}

let webVoice: WebVoiceState | null = null;

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
  if (metrics?.fpsAvailable === true) {
    existing?.remove();
    return;
  }
  if (!metrics) return;
  if (existing) {
    refreshFpsNotices();
    return;
  }
  if (!isWidgetOpen("perf")) return;
  const perf = document.querySelector<HTMLElement>("#ov-widget-perf-body .ov-perf");
  if (!perf) return;
  perf.insertAdjacentHTML("afterbegin", fpsNoticeHtml(metrics));
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

/* ---------- Xbox Game Bar Floating Widget System ---------- */

const DEFAULT_WIDGETS: TabId[] = ["perf", "music"];
let openWidgets = new Set<TabId>();

function loadOpenWidgets(): Set<TabId> {
  try {
    const raw = localStorage.getItem("efxlve-overlay-widgets");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return new Set(parsed.filter((id) => TABS.some((t) => t.id === id)) as TabId[]);
      }
    }
  } catch {
    // fallback
  }
  return new Set(DEFAULT_WIDGETS);
}

function saveOpenWidgets(): void {
  localStorage.setItem("efxlve-overlay-widgets", JSON.stringify([...openWidgets]));
}

function isWidgetOpen(tab: TabId): boolean {
  return openWidgets.has(tab);
}

/* ---------- Pinned widgets ---------- */

/** A pinned widget keeps its place and size until it is unpinned. */
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

/** Flips one widget's pin and repaints its header button. */
function setWidgetPinned(tab: TabId, pinned: boolean): void {
  if (pinned) widgetPins.add(tab);
  else widgetPins.delete(tab);
  saveWidgetPins();
  applyWidgetPinState(tab);
}

function applyWidgetPinState(tab: TabId): void {
  const pinned = isWidgetPinned(tab);
  const widget = document.getElementById(`ov-widget-${tab}`);
  if (widget) widget.classList.toggle("is-pinned", pinned);
  const btn = document.querySelector<HTMLElement>(`[data-ov-widget-pin="${tab}"]`);
  if (!btn) return;
  btn.classList.toggle("is-pinned", pinned);
  btn.title = pinned ? t("overlay.widgetUnpin") : t("overlay.widgetPin");
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
        // was 1x1. Those 8/8 entries stacked every widget in one corner; treat
        // them as missing and let the tiled default win.
        if (parsed.y < OVERLAY_SAFE_TOP) return getDefaultWidgetPos(tab);
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

  if (tab === "discord") {
    void invoke("discord_voice_watch_start").catch(() => undefined);
    void refreshWebVoice();
    void refreshSdkState();
  } else if (tab === "music") {
    ensureSpotifyEngine();
    void refreshMedia();
  }
}

function closeWidget(tab: TabId): void {
  openWidgets.delete(tab);
  saveOpenWidgets();

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
    el.title = t("tv.battery");
    return;
  }
  const ic = cachedBattery.charging ? icon("battery-charging", 15) : icon("battery", 15);
  el.innerHTML = `
    <span class="ov-battery-icon">${ic}</span>
    ${showPct ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
  `;
  el.title = `${t("tv.battery")}: ${cachedBattery.level}%${cachedBattery.charging ? " (Şarj oluyor)" : ""}`;
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
        <span class="ov-hub-title" title="${esc(activeTitle)}">${esc(activeTitle)}</span>
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
        <span class="ov-quick-header-badge">${list.length} Oyun</span>
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
          <div class="ov-quick-empty">Son oynanan oyun yok</div>
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
  try {
    if (appName.startsWith("steam::")) {
      const appId = appName.slice(7);
      await openUrl(`steam://run/${appId}`).catch(() => undefined);
    } else if (appName.startsWith("gog::")) {
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

        <div class="ov-topbar-battery" id="ov-topbar-battery" title="${esc(t("tv.battery"))}">
          <span class="ov-battery-icon">${icon("battery", 15)}</span>
          ${showBatteryPercent() && cachedBattery ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
        </div>

        <div class="ov-topbar-gamepad" id="ov-topbar-gamepad" style="${padConnected ? "" : "display:none"}" title="Oyun Kumandası">
          ${icon("gamepad-2", 15)}
        </div>

        <button class="ov-topbar-btn ov-topbar-settings-btn ${isWidgetOpen("settings") ? "active" : ""}" data-ov-widget-toggle="settings" title="${esc(t("overlay.tabSettings"))}">
          ${icon("settings", 15)}
        </button>
      </header>

      <!-- Floating Widgets Container -->
      <div class="ov-widgets-container" id="ov-widgets-container">
        ${TABS.filter((t) => t.id !== "browser").map((tab) => `
          <section class="ov-widget" id="ov-widget-${tab.id}" data-widget-id="${tab.id}">
            <header class="ov-widget-header" data-widget-drag="${tab.id}">
              <div class="ov-widget-title">
                ${icon(tab.icon, 14)}
                <span>${esc(tab.id === "discord" ? t("overlay.tabDiscord") + " Sosyal" : tab.id === "chat" ? t("overlay.tabDiscord") + " Sohbet" : t(tab.key))}</span>
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

function setTab(tab: TabId, fromOpen = false): void {
  activeTab = tab;
  localStorage.setItem("efxlve-overlay-tab", tab);
  if (tab === "home") {
    for (const t of DEFAULT_WIDGETS) openWidget(t);
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

/** Live recorder state, refreshed while the overlay is on screen. */
let clipState: ClipStatus | null = null;
let lastClip: ClipItem | null = null;
let clipPollTimer: number | null = null;

/** mm:ss for a clip: a clip timer has to tick every second, which the session
 *  pill's minute-granularity format does not. */
function clipClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function clipWidgetHtml(): string {
  const running = clipState?.running ?? false;
  const seconds = clipState?.seconds ?? 0;
  const frames = clipState?.frames ?? 0;
  const error = clipState?.error ?? "";
  const asked = clipState?.fps ?? clipFps();
  // The recorder writes frames as fast as it can, so the honest number is the
  // measured one — the same one the file's own header carries.
  const measured = running && seconds > 0 ? frames / seconds : 0;
  const rate = measured > 0 ? `${measured.toFixed(1)} / ${asked}` : String(asked);
  return `
    <div class="ov-clip">
      <div class="ov-clip-state${running ? " is-recording" : ""}">
        <span class="ov-clip-dot"></span>
        <span class="ov-clip-state-text">${esc(t(running ? "overlay.clipRecording" : "overlay.clipIdle"))}</span>
        <span class="ov-clip-timer">${clipClock(seconds)}</span>
      </div>
      <div class="ov-clip-meta">
        <span>${esc(t("overlay.clipFrames", { count: String(frames) }))}</span>
        <span>${esc(t("overlay.clipRate", { rate }))}</span>
      </div>
      <button class="ov-clip-btn${running ? " is-stop" : ""}" data-ov="clip-toggle">
        ${running ? icon("square", 14) : icon("video", 14)}
        <span>${esc(t(running ? "overlay.clipStop" : "overlay.clipRecord"))}</span>
      </button>
      <div class="ov-clip-hint">${esc(t("overlay.clipHotkeyHint", { key: clipHotkeyName() }))}</div>
      ${error ? `<div class="ov-clip-error">${esc(localizeMessage(error))}</div>` : ""}
      ${lastClip ? `
        <div class="ov-clip-last" title="${esc(lastClip.path)}">
          <div class="ov-clip-last-name">${esc(lastClip.name)}</div>
          <div class="ov-clip-last-meta">${esc(clipClock(lastClip.seconds))} · ${esc(fmtMb(Math.round(lastClip.sizeBytes / (1024 * 1024))))}</div>
        </div>` : ""}
      <button class="ov-clip-folder" data-ov="clip-folder">${icon("folder", 12)} <span>${esc(t("overlay.clipOpenFolder"))}</span></button>
    </div>`;
}

/** Repaints the widget, optionally asking Rust for the live state first. */
async function refreshClipWidget(fetch: boolean): Promise<void> {
  if (fetch) {
    try {
      clipState = await clipStatus();
    } catch {
      clipState = null;
    }
    // The list is only needed to show the last clip; fetch it once.
    if (isWidgetOpen("clip") && !lastClip) await loadLastClip();
  }
  syncClipIndicator();
  if (!isWidgetOpen("clip")) return;
  const body = viewEl("clip");
  if (body) body.innerHTML = clipWidgetHtml();
}

/** The dock button carries the recording dot, so the state shows even with the
 *  widget itself closed. */
function syncClipIndicator(): void {
  const running = clipState?.running ?? false;
  const btn = document.querySelector<HTMLElement>('[data-ov-widget-toggle="clip"]');
  if (btn) btn.classList.toggle("is-recording", running);
}

async function loadLastClip(): Promise<void> {
  try {
    const clips = await clipList();
    lastClip = clips[0] ?? null;
  } catch {
    lastClip = null;
  }
}

function startClipPolling(): void {
  void refreshClipWidget(true);
  void loadLastClip().then(() => refreshClipWidget(false));
  if (clipPollTimer !== null) return;
  clipPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    // The dock dot only needs live polling while the recorder is running; a
    // closed, idle clip widget should not ask Rust for its state twice a second.
    if (isWidgetOpen("clip") || clipState?.running) void refreshClipWidget(true);
  }, 1000);
}

function stopClipPolling(): void {
  if (clipPollTimer === null) return;
  window.clearInterval(clipPollTimer);
  clipPollTimer = null;
}

async function toggleClipRecording(): Promise<void> {
  try {
    if (clipState?.running) await clipStop();
    else await clipStart();
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
  // Rust flips the flag on its own thread; give it a moment before reading back.
  window.setTimeout(() => void refreshClipWidget(true), 250);
}

/** The card over the game. The launcher's notification is invisible in a
 *  full-screen game, which is exactly where a clip is taken. */
function clipCard(titleKey: string, body: string): void {
  void invoke("overlay_flash_hint", { title: t(titleKey), body }).catch(() => undefined);
}

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
function renderHome(): void {
  const el = viewEl("home");
  if (!el) return;
  if (launcherMode) {
    renderHomeLauncher(el);
    return;
  }
  const { store } = splitKey(context.appName);
  const m = metrics;
  const currentFps = m?.fps != null ? Math.round(m.fps) : "—";
  const hudActive = localStorage.getItem(HUD_KEY) === "true";

  // Achievements preview
  const achData = cachedAchievements;
  const achUnlocked = achData?.user_unlocked ?? 0;
  const achTotal = achData?.total_achievements ?? achData?.achievements?.length ?? 0;
  const achPct = achTotal > 0 ? Math.round((achUnlocked / achTotal) * 100) : 0;
  const recentAchs = achData?.achievements ? achData.achievements.slice(0, 2) : [];

  // Screenshots preview
  const shotsPreview = cachedScreenshots.slice(0, 4);

  el.innerHTML = `
    <div class="ov-dashboard">
      <!-- Session Hero Banner -->
      <div class="ov-card ov-span-12 ov-hero-card">
        <div class="ov-hero-banner">
          <div class="ov-hero-info">
            <div class="ov-hero-game">${esc(context.title || context.appName || "Game")}</div>
            <div class="ov-hero-status">
              <span class="ov-badge-pill">${esc(storeLabel(store))}</span>
              <span>·</span>
              <span style="color:var(--ok)">● ${esc(t("overlay.running"))}</span>
            </div>
          </div>
          <div class="ov-hero-actions">
            <button class="btn ghost small" data-ov="browser-open">${icon("globe", 14)} <span>${esc(t("overlay.tabBrowser"))}</span></button>
            <button class="btn ghost small" data-ov="launcher">${icon("external", 14)} <span>${esc(t("overlay.openLauncher"))}</span></button>
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
        ${perfCanvasHtml("ov-home-perf-canvas", ' style="height:68px"')}
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

      <!-- In-Game Web Browser Quick Launch Card -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("globe", 14)} <span class="title-text">${esc(t("overlay.tabBrowser"))}</span></div>
          <button class="ov-card-action" data-ov-tab="browser">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-home-browser-bar">
          <input id="ov-home-browser-input" class="input ov-home-browser-input" placeholder="${esc(t("overlay.browserAddress"))}" spellcheck="false" />
          <button class="btn primary small" data-ov="home-browser-go" title="${esc(t("overlay.tabBrowser"))}">${icon("chevron-right", 14)}</button>
        </div>
        <div class="ov-home-browser-chips">
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.google.com">${icon("search", 12)} <span>Google</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.youtube.com">${icon("play", 12)} <span>YouTube</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.fandom.com">${icon("gamepad-2", 12)} <span>Wiki</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.reddit.com/r/gaming">${icon("globe", 12)} <span>Reddit</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://discord.com/app">${icon("discord", 12)} <span>Discord</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://steamcommunity.com">${icon("users", 12)} <span>Steam</span></button>
        </div>
        <button class="btn ghost small full" data-ov="browser-open">
          ${icon("external", 13)} <span>${esc(t("overlay.tabBrowser"))} Penceresini Aç</span>
        </button>
      </div>

      <!-- Media Player Card -->
      <div class="ov-card ov-span-6 ov-media-card">
        <div class="ov-card-head">
          <div class="ov-card-title" id="ov-media-card-title" data-kind="${getOverlayMedia().isSpotify ? "spotify" : "media"}">${mediaCardTitleHtml()}</div>
          <button class="ov-card-action" data-ov-tab="music">${icon("chevron-right", 16)}</button>
        </div>
        ${mediaCardInnerHtml()}
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
          <div class="ov-empty" style="padding:16px 0">${esc(t("overlay.noAchievements"))}</div>`}
      </div>

      <!-- Quick Notes Card -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("edit", 14)} <span class="title-text">${esc(t("overlay.tabNotes"))}</span></div>
          <button class="ov-card-action" data-ov-tab="notes">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-note">${esc(t("overlay.notesHint"))}</div>
      </div>

      <!-- Recent Screenshots Strip (shown if screenshots exist) -->
      ${shotsPreview.length > 0 ? `
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("camera", 14)} <span class="title-text">${esc(t("overlay.tabScreenshots"))}</span></div>
          <button class="ov-card-action" data-ov-tab="shots">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-shots-grid" style="grid-template-columns:repeat(4, 1fr);gap:8px">
          ${shotsPreview.map((s) => `
            <div class="ov-shot-item" data-ov-preview="${esc(s.data_url)}" title="${esc(s.date_str)}">
              <img src="${esc(s.data_url)}" alt="" loading="lazy" />
            </div>`).join("")}
        </div>
      </div>` : ""}
    </div>`;

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

/** Home while the overlay runs without a game: launcher actions + media + browser. */
function renderHomeLauncher(el: HTMLElement): void {
  el.innerHTML = `
    <div class="ov-dashboard">
      <div class="ov-card ov-span-12 ov-launcher-hero">
        <div class="ov-launcher-mark">${icon("layers", 28)}</div>
        <div class="ov-launcher-meta">
          <div class="ov-launcher-title">${esc(t("overlay.launcherModeTitle"))}</div>
          <div class="ov-launcher-desc">${esc(t("overlay.launcherModeDesc"))}</div>
        </div>
        <div class="ov-launcher-actions">
          <button class="btn" data-ov="launcher">${icon("external", 14)} ${esc(t("overlay.openLauncher"))}</button>
          <button class="btn ghost" data-ov="browser-open">${icon("globe", 14)} ${esc(t("overlay.tabBrowser"))}</button>
          <button class="btn ghost" data-ov-tab="music">${icon("spotify", 14)} ${esc(t("overlay.tabSpotify"))}</button>
        </div>
      </div>

      <div class="ov-card ov-span-6 ov-media-card">
        <div class="ov-card-head">
          <div class="ov-card-title" id="ov-media-card-title" data-kind="${getOverlayMedia().isSpotify ? "spotify" : "media"}">${mediaCardTitleHtml()}</div>
          <button class="ov-card-action" data-ov-tab="music">${icon("chevron-right", 16)}</button>
        </div>
        ${mediaCardInnerHtml()}
      </div>

      <!-- Quick Browser Card in Launcher Mode -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("globe", 14)} <span class="title-text">${esc(t("overlay.tabBrowser"))}</span></div>
          <button class="ov-card-action" data-ov-tab="browser">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-home-browser-bar">
          <input id="ov-home-browser-input" class="input ov-home-browser-input" placeholder="${esc(t("overlay.browserAddress"))}" spellcheck="false" />
          <button class="btn primary small" data-ov="home-browser-go" title="${esc(t("overlay.tabBrowser"))}">${icon("chevron-right", 14)}</button>
        </div>
        <div class="ov-home-browser-chips">
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.google.com">${icon("search", 12)} <span>Google</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.youtube.com">${icon("play", 12)} <span>YouTube</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.reddit.com/r/gaming">${icon("globe", 12)} <span>Reddit</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://discord.com/app">${icon("discord", 12)} <span>Discord</span></button>
        </div>
        <button class="btn ghost small full" data-ov="browser-open">
          ${icon("external", 13)} <span>${esc(t("overlay.tabBrowser"))} Penceresini Aç</span>
        </button>
      </div>
    </div>`;
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

  const isTr = (localStorage.getItem("efxlve_lang") || "").startsWith("tr");

  const cpuSub = m?.cpuGhz ? `${m.cpuGhz.toFixed(2)} GHz` : (isTr ? "İşlemci" : "Processor");
  const gpuSub = m?.running ? (isTr ? "3D Aktif" : "3D Active") : (isTr ? "Sistem 3D" : "System 3D");
  const ramSub = ramUsed > 0 ? fmtMb(ramUsed) : (isTr ? "Bellek" : "Memory");
  const vramSub = vramUsed > 0 ? fmtMb(vramUsed) : (isTr ? "Bellek" : "Memory");
  const ramSubTitle = `${fmtMb(ramUsed)} / ${fmtMb(ramTotal)}`;
  const vramSubTitle = `${fmtMb(vramUsed)} / ${fmtMb(vramTotal)}`;
  const subFps = m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : (m?.running ? "..." : (isTr ? "Beklemede" : "Idle"));

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
      data = fpsHistory;
      tag = "FPS";
      num = fpsVal != null ? String(fpsVal) : "--";
      sub = subFps;
      const validFps = data.filter((v) => v > 0);
      const peak = validFps.length > 0 ? Math.round(Math.max(...validFps)) : (fpsVal ?? 0);
      const avg = validFps.length > 0 ? Math.round(validFps.reduce((a, b) => a + b, 0) / validFps.length) : (fpsVal ?? 0);
      const min = validFps.length > 0 ? Math.round(Math.min(...validFps)) : (fpsVal ?? 0);
      peakVal = peak > 0 ? String(peak) : "--";
      avgVal = avg > 0 ? String(avg) : "--";
      minVal = min > 0 ? String(min) : "--";
      break;
    }
  }

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
    isTr,
  };
}

/* 2. Bespoke Efxlve Telemetry View */
function renderPerf(): void {
  const el = viewEl("perf");
  if (!el) return;
  const m = metrics;
  const t = getTelemetryReadings(m);

  el.innerHTML = `
    <div class="ov-perf">
      ${fpsNoticeHtml(m)}
      <!-- Top FPS Row -->
      <button class="ov-perf-card ov-perf-fps-row ${activePerfMetric === "fps" ? "active" : ""}" data-perf-metric="fps" type="button">
        <div class="ov-perf-fps-left">
          <span class="ov-perf-icon">${icon("zap", 14)}</span>
          <span class="ov-perf-card-title">FPS</span>
          <span class="ov-perf-fps-num" id="ov-chip-val-fps">${t.fpsVal != null ? String(t.fpsVal) : "--"}</span>
        </div>
        <div class="ov-perf-fps-right">
          <span class="ov-perf-sub" id="ov-perf-frame-ms">${t.subFps}</span>
        </div>
      </button>

      <!-- 4 Hardware Telemetry Cards (2x2 Grid) -->
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

        <!-- GPU Card -->
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
        </button>

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

        <!-- VRAM Card -->
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
        </button>
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
            <span>${t.isTr ? "Ort" : "Avg"} <b id="ov-stat-avg-val">${t.avgVal}</b></span>
            <span>${t.isTr ? "Zirve" : "Peak"} <b id="ov-stat-peak-val">${t.peakVal}</b></span>
          </div>
        </div>

        <div class="ov-perf-canvas-wrap">
          <canvas class="ov-perf-canvas" id="ov-perf-canvas"></canvas>
        </div>

        <div class="ov-perf-timeline">
          <span>60s</span>
          <span>${t.isTr ? "Şimdi" : "Now"}</span>
        </div>
      </div>
    </div>`;

  drawPerfCanvas();
}

function drawPerfCanvas(): void {
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
          data = fpsHistory.length > 0 ? fpsHistory : [0];
          maxVal = Math.max(60, ...data) * 1.15;
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
      ctx.fillText(activePerfMetric === "fps" ? `${Math.round(maxVal)}` : "100%", 2, 10);
      ctx.fillText(activePerfMetric === "fps" ? `${Math.round(maxVal / 2)}` : "50%", 2, Math.round(height / 2) + 3);
      ctx.fillText("0", 2, height - 3);

      const chartLeft = 32;
      const chartWidth = Math.max(10, width - chartLeft - 4);
      const len = 60;
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

  if (isWidgetOpen("perf") && document.getElementById("ov-chip-val-cpu")) {
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
          <div class="ov-ach-body">
            <div class="ov-ach-name">${esc(name)}</div>
            <div class="ov-ach-desc">${esc(desc)}</div>
          </div>
          ${
            item.unlocked
              ? `<span class="ov-ach-check" title="${esc(t("ach.earned"))}">${icon("check", 13)}</span>`
              : `<span class="ov-ach-locked" title="${esc(t("ach.locked"))}">${icon("lock", 11)}</span>`
          }
        </div>`;
    }).join("");

  el.innerHTML = `
    <div class="ov-page-title">${icon("trophy", 20)} <span>${esc(t("overlay.tabAchievements"))}</span></div>
    <div class="ov-ach-summary">
      <div class="ov-ach-count"><strong>${unlocked}</strong> / ${total}</div>
      <div class="ov-ach-bar"><span style="width:${pct}%"></span></div>
      <div class="ov-ach-pct">%${pct}</div>
    </div>
    <div class="ov-ach-full-list">${rows}</div>`;
  renderHomeSafe();
}

/** The game a capture belongs to; untitled files share the "Other" bucket. */
function shotGameLabel(item: ScreenshotItem): string {
  return item.game_title?.trim() || t("overlay.otherGame");
}

/* 4. Full Screenshots View */
/** Session-only: the overlay's own "favorites only" chip. */
let overlayShotsFavoritesOnly = false;
/** Games with capture turned off, for the settings widget's per-game row. */
let overlayDisabledGames: string[] = [];
let overlayDisabledGamesFetched = false;

function getVisibleScreenshots(): ScreenshotItem[] {
  const favorites = ssFavorites();
  let items = cachedScreenshots;
  if (selectedGameFilters.size > 0) {
    items = items.filter((item) => selectedGameFilters.has(shotGameLabel(item).toLowerCase()));
  }
  if (overlayShotsFavoritesOnly) {
    items = items.filter((item) => favorites.has(item.file_path));
  }
  return ssSortItems(
    items,
    (item) => item.timestamp ?? 0,
    (item) => item.file_name,
    (item) => item.size_bytes ?? 0,
  );
}

async function loadScreenshots(force = false): Promise<void> {
  const el = viewEl("shots");
  if (!el) return;
  if (cachedScreenshots.length === 0 || force) {
    el.innerHTML = `<div class="ov-empty">${esc(t("common.calculating"))}</div>`;
    if (launcherMode) {
      try {
        cachedScreenshots = await invoke<ScreenshotItem[]>("epic_get_all_screenshots");
      } catch {
        cachedScreenshots = [];
      }
    } else {
      const { store, id } = splitKey(context.appName);
      if (store === "steam") {
        try {
          cachedScreenshots = await invoke<ScreenshotItem[]>("steam_get_game_screenshots", { appId: id });
        } catch {
          cachedScreenshots = [];
        }
      } else if (store === "game") {
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
  }

  const isTr = (localStorage.getItem("efxlve_lang") || "").startsWith("tr");

  // Build game counts map
  const gameCounts = new Map<string, number>();
  for (const item of cachedScreenshots) {
    const g = shotGameLabel(item);
    gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
  }

  // Prune deleted/obsolete filters
  if (selectedGameFilters.size > 0) {
    const validKeys = new Set(Array.from(gameCounts.keys()).map((k) => k.toLowerCase()));
    for (const key of Array.from(selectedGameFilters)) {
      if (!validKeys.has(key)) {
        selectedGameFilters.delete(key);
      }
    }
  }

  const activeFilterCount = selectedGameFilters.size;
  const visibleShots = getVisibleScreenshots();

  const titleText = launcherMode
    ? esc(t("overlay.tabScreenshots"))
    : (context.title ? `${esc(context.title)} — ${esc(t("overlay.tabScreenshots"))}` : esc(t("overlay.tabScreenshots")));

  const filterBtnHtml = gameCounts.size > 1 ? `
    <div class="ov-shots-filter-wrapper">
      <button
        class="btn ghost small ov-shots-filter-btn ${activeFilterCount > 0 ? "active" : ""}"
        data-ov="shots-filter-toggle"
        type="button"
        title="${isTr ? "Oyun Filtresi" : "Game Filter"}"
      >
        ${icon("sliders", 13)}
        <span>${isTr ? "Filtrele" : "Filter"}</span>
        ${activeFilterCount > 0 ? `<span class="ov-shots-filter-active-count">${activeFilterCount}</span>` : ""}
        ${icon("chevron-down", 11)}
      </button>
      <div class="ov-shots-filter-popover ${filterPopoverOpen ? "open" : ""}" id="ov-shots-filter-popover">
        <div class="ov-shots-filter-popover-header">
          <span class="ov-shots-filter-popover-title">${isTr ? "Oyun Filtresi" : "Game Filter"}</span>
          ${activeFilterCount > 0 ? `
            <button class="btn ghost tiny ov-shots-filter-clear-btn" data-ov="shots-filter-clear" type="button">
              ${isTr ? "Temizle" : "Clear"}
            </button>
          ` : ""}
        </div>
        <div class="ov-shots-filter-popover-list">
          <div class="ov-shots-filter-row" data-ov-filter-game="all">
            <div class="ov-shots-filter-checkbox ${selectedGameFilters.size === 0 ? "checked" : ""}">
              ${selectedGameFilters.size === 0 ? icon("check", 12) : ""}
            </div>
            <span class="ov-shots-filter-label">${isTr ? "Tümü" : "All"}</span>
            <span class="ov-shots-filter-row-count">${cachedScreenshots.length}</span>
          </div>
          <div class="ov-shots-filter-popover-divider"></div>
          ${Array.from(gameCounts.entries()).map(([game, count]) => {
            const isChecked = selectedGameFilters.has(game.toLowerCase());
            return `
              <div class="ov-shots-filter-row" data-ov-filter-game="${esc(game)}">
                <div class="ov-shots-filter-checkbox ${isChecked ? "checked" : ""}">
                  ${isChecked ? icon("check", 12) : ""}
                </div>
                <span class="ov-shots-filter-label" title="${esc(game)}">${esc(game)}</span>
                <span class="ov-shots-filter-row-count">${count}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </div>` : "";

  el.innerHTML = `
    <div class="ov-page-title" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        ${icon("camera", 20)}
        <span>${titleText}</span>
        <span class="ov-shots-count-pill" title="${visibleShots.length} ${isTr ? "ekran görüntüsü" : "screenshots"}">${visibleShots.length}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${filterBtnHtml}
        <button class="btn ghost small ${overlayShotsFavoritesOnly ? "active" : ""}" data-ov="shots-fav-filter" title="${esc(t("ss.filterFavorites"))}">
          ${icon("star", 14)}
        </button>
        <button class="btn ghost small" data-ov="shots-sort-cycle" title="${esc(t("ss.sortTitle"))}">
          ${icon("list", 14)} <span>${esc(overlaySortLabel())}</span>
        </button>
        <button class="btn ghost small" data-ov="shots-folder" title="${esc(t("overlay.openFolder"))}">
          ${icon("folder", 14)} <span>${esc(t("overlay.openFolder"))}</span>
        </button>
      </div>
    </div>
    ${visibleShots.length === 0 ? `
      <div class="ov-empty">
        <div>${esc(t("overlay.noShots"))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:6px">${esc(t("overlay.captureHint"))}</div>
      </div>` : `
      <div class="ov-shots-grid" style="grid-template-columns:repeat(auto-fill, minmax(${overlayDensityPx()}px, 1fr));gap:12px">
        ${visibleShots.map((item) => {
          const tooltip = item.game_title ? `${item.game_title} • ${item.date_str}` : item.date_str;
          const isFavorite = ssFavorites().has(item.file_path);
          return `
            <div class="ov-shot-item" data-ov-preview="${esc(item.data_url)}" title="${esc(tooltip)}">
              <img src="${esc(item.data_url)}" alt="" loading="lazy" />
              ${item.game_title ? `<div class="ov-shot-badge">${esc(item.game_title)}</div>` : ""}
              <button class="ov-shot-fav${isFavorite ? " is-favorite" : ""}" data-ov="ov-shot-favorite" data-path="${esc(item.file_path)}" title="${esc(isFavorite ? t("ss.unfavorite") : t("ss.favorite"))}">
                ${icon("star", 12)}
              </button>
            </div>`;
        }).join("")}
      </div>`}`;
  renderHomeSafe();
}

/** The overlay's sort button label (the shared order). */
function overlaySortLabel(): string {
  switch (ssSort()) {
    case "oldest": return t("ss.sortOldest");
    case "name": return t("ss.sortName");
    case "size": return t("ss.sortSize");
    default: return t("ss.sortNewest");
  }
}

/** The overlay's grid minimum width per density step. */
function overlayDensityPx(): number {
  switch (ssDensity()) {
    case "s": return 140;
    case "l": return 320;
    default: return 220;
  }
}

/* 5. Full Notes View */
/** The notes widget lives in `notes/overlay-notes.ts`: the same list the
 * launcher's Notes page and the game drawer write. */
function renderNotes(): void {
  renderOverlayNotes();
}

/* 6. Full Music View */

interface OverlayMediaModel {
  active: boolean;
  isSpotify: boolean;
  source: string;
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  canSeek: boolean;
  canShuffleRepeat: boolean;
  shuffle: boolean;
  repeat: string;
  volumePercent: number | null;
  deviceName: string;
  url: string;
}

function getOverlayMedia(): OverlayMediaModel {
  if (spotifyEngineOn && spotifyNow) {
    return {
      active: true,
      isSpotify: true,
      source: spotifyNow.deviceName ? `Spotify · ${spotifyNow.deviceName}` : "Spotify",
      title: spotifyNow.title || t("overlay.noMedia"),
      artist: spotifyNow.artist || "",
      album: spotifyNow.album || "",
      artUrl: spotifyNow.artUrl || "",
      isPlaying: spotifyNow.isPlaying,
      positionMs: spotifyNow.progressMs,
      durationMs: spotifyNow.durationMs,
      canSeek: true,
      canShuffleRepeat: true,
      shuffle: spotifyNow.shuffle,
      repeat: spotifyNow.repeat,
      volumePercent: spotifyNow.volumePercent,
      deviceName: spotifyNow.deviceName,
      url: spotifyNow.url,
    };
  }
  return {
    active: false,
    isSpotify: true,
    source: "Spotify",
    title: t("overlay.noMedia"),
    artist: t("overlay.idleHint"),
    album: "",
    artUrl: "",
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    canSeek: false,
    canShuffleRepeat: false,
    shuffle: false,
    repeat: "off",
    volumePercent: null,
    deviceName: "",
    url: "spotify:",
  };
}

function spotifyLogoSvg(size = 48): string {
  return `<svg class="ov-sp-logo-svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.563.387-.857.208-2.35-1.435-5.308-1.76-8.793-.963-.335.077-.67-.133-.746-.468-.077-.334.132-.67.467-.746 3.808-.87 7.076-.505 9.72 1.11.295.18.388.563.209.858zm1.224-2.72c-.226.368-.71.482-1.077.256-2.69-1.653-6.79-2.132-9.97-1.167-.412.124-.852-.11-.977-.522-.124-.412.11-.852.522-.977 3.633-1.102 8.147-.568 11.246 1.332.367.227.48.71.256 1.078zm.105-2.835C14.692 8.92 9.375 8.745 6.297 9.68c-.495.15-1.02-.132-1.17-.626-.15-.494.133-1.02.627-1.17 3.535-1.073 9.404-.866 13.14 1.352.444.264.59.84.327 1.284-.264.444-.84.59-1.284.327z"/></svg>`;
}

let lastSpotifyStartAttempt = 0;

/** Ensures the Spotify playback engine is running in the background silently. */
function ensureSpotifyEngine(): void {
  const now = Date.now();
  if (spotifyEngineOn || now - lastSpotifyStartAttempt < 10000) return;
  lastSpotifyStartAttempt = now;
  void spotifyPlaybackStart()
    .then(() => {
      spotifyEngineOn = true;
    })
    .catch(() => undefined);
}

/** The launcher's Spotify receiver, or the idle state. */
async function refreshMedia(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  spotifyEngineOn = status?.running === true;
  spotifyDeviceName = status?.deviceName ?? "";
  if (!spotifyEngineOn) {
    ensureSpotifyEngine();
  }

  const now = spotifyEngineOn ? await spotifyPlaybackNow().catch(() => null) : null;
  if (now) {
    spotifyBaseMs = now.progressMs;
    spotifyBaseAt = Date.now();
  }
  spotifyNow = now;

  const m = getOverlayMedia();
  if (m.active !== lastMediaActive) {
    lastMediaActive = m.active;
    if (isWidgetOpen("music")) renderMusicTab();
    else renderHomeSafe();
    return;
  }
  patchMediaSurfaces();
}

/** Home media card header (always the launcher's Spotify receiver). */
function mediaCardTitleHtml(): string {
  return `${icon("spotify", 14)} <span class="title-text">${esc(t("overlay.tabSpotify"))}</span>`;
}

/** Home dashboard media card content. */
function mediaCardInnerHtml(): string {
  const m = getOverlayMedia();
  if (m.active) {
    return `
      <div class="ov-media-top">
        ${m.artUrl
          ? `<img class="ov-media-art" id="ov-media-art" src="${esc(m.artUrl)}" alt="" />`
          : m.isSpotify
          ? `<div class="ov-media-icon" id="ov-media-art">${icon("music", 20)}</div>`
          : `<div class="ov-media-icon" id="ov-media-art">${icon("volume-2", 20)}</div>`}
        <div class="ov-media-details">
          <div class="ov-media-title" id="ov-media-title">${esc(m.title)}</div>
          <div class="ov-media-artist" id="ov-media-artist">${esc(m.artist)}</div>
          <div class="ov-media-source" id="ov-media-source">${esc(m.source)}</div>
        </div>
      </div>
      <div class="ov-media-btns">
        <button class="icon-btn" data-ov="media-prev">${icon("skip-back", 18)}</button>
        <button class="btn" data-ov="media-toggle" style="width:48px;justify-content:center" id="ov-media-toggle">${icon(m.isPlaying ? "pause" : "play", 18)}</button>
        <button class="icon-btn" data-ov="media-next">${icon("skip-forward", 18)}</button>
      </div>`;
  }
  return `
    <div class="ov-media-top" style="margin-bottom:8px">
      <div class="ov-media-icon">${icon("music", 20)}</div>
      <div class="ov-media-details">
        <div class="ov-media-title" id="ov-media-title">${esc(t("overlay.noMedia"))}</div>
        <div class="ov-media-artist" id="ov-media-artist">${esc(t("overlay.openSpotify"))}</div>
      </div>
    </div>
    <div class="ov-media-btns">
      <button class="btn ghost small" data-ov="sp-open" style="width:100%;justify-content:center">${icon("external", 14)} <span>${esc(t("overlay.openSpotify"))}</span></button>
    </div>`;
}

/* 6. Spotify Overlay Widget View */
let musicViewMode: "playlists" | "tracks" = "playlists";
let spotifySearchQuery = "";
let spotifySearchOpen = false;
let spotifyMiniView: "player" | "library" = "player";

function updateMusicMiniViewState(): void {
  const widget = document.getElementById("ov-widget-music");
  if (!widget) return;
  widget.dataset.miniView = spotifyMiniView;
  const btn = document.getElementById("ov-sp-mini-toggle-btn");
  if (btn) {
    btn.innerHTML = spotifyMiniView === "player" ? icon("list", 12) : icon("music", 12);
    btn.title = spotifyMiniView === "player" ? t("overlay.library") : "Player";
  }
}

function renderMusicTab(): void {
  const el = viewEl("music");
  if (!el) return;
  ensureSpotifyEngine();
  if (!selectedPlaylist && musicViewMode === "tracks") {
    musicViewMode = "playlists";
  }
  el.innerHTML = `
    ${unifiedPlayerHtml(getOverlayMedia())}
    ${libraryHtml()}`;
  renderPlaylistList();
  renderTrackList();
  void ensurePlaylists();
  const widget = document.getElementById("ov-widget-music");
  if (widget) {
    syncWidgetSizeClasses("music", widget.offsetWidth, widget.offsetHeight);
    updateMusicMiniViewState();
  }
}

function unifiedPlayerHtml(m: OverlayMediaModel): string {
  if (!m.active) {
    return `
      <div class="ov-card ov-sp-player ov-sp-idle">
        <div class="ov-sp-player-main">
          <div class="ov-sp-art ov-sp-art-spotify" id="ov-sp-art">
            ${spotifyLogoSvg(32)}
          </div>
          <div class="ov-sp-info">
            <div class="ov-sp-title" id="ov-sp-title">${esc(t("overlay.noMedia"))}</div>
            <div class="ov-sp-artist" id="ov-sp-artist">${esc(t("overlay.idleHint"))}</div>
          </div>
        </div>
        <div class="ov-sp-idle-actions">
          <button class="btn ghost small ov-sp-open-btn" data-ov="sp-open">
            ${icon("external", 13)} <span>${esc(t("overlay.openSpotify"))}</span>
          </button>
        </div>
      </div>`;
  }

  return `
    <div class="ov-card ov-sp-player"${m.artUrl ? ` style="--ov-hero-art:url('${esc(m.artUrl)}')"` : ""}>
      <div class="ov-sp-player-main">
        ${m.artUrl
          ? `<img class="ov-sp-art" id="ov-sp-art" src="${esc(m.artUrl)}" alt="" />`
          : m.isSpotify
          ? `<div class="ov-sp-art ov-sp-art-spotify" id="ov-sp-art">${spotifyLogoSvg(32)}</div>`
          : `<div class="ov-media-icon ov-sp-art" id="ov-sp-art">${icon("music", 26)}</div>`}
        <div class="ov-sp-info">
          <div class="ov-sp-meta-top">
            <div class="ov-sp-title" id="ov-sp-title" title="${esc(m.title)}">${esc(m.title)}</div>
          </div>
          <div class="ov-sp-artist" id="ov-sp-artist" title="${esc(m.artist)}">${esc(m.artist)}</div>
          <div class="ov-sp-album" id="ov-sp-album"${m.album ? "" : ' style="display:none"'}>${esc(m.album)}</div>
        </div>
      </div>

      <div class="ov-sp-timeline">
        <div class="ov-sp-progress" id="ov-sp-progress" data-ov="sp-seek" title="${m.canSeek ? "Seek" : ""}">
          <div class="ov-sp-progress-fill" id="ov-sp-progress-fill"></div>
        </div>
        <div class="ov-sp-times">
          <span id="ov-sp-elapsed">0:00</span>
          <span id="ov-sp-duration">${m.durationMs ? formatSpotifyTime(m.durationMs) : "0:00"}</span>
        </div>
      </div>

      <div class="ov-sp-controls">
        ${m.canShuffleRepeat ? `<button class="icon-btn ov-sp-ctrl-btn${m.shuffle ? " active" : ""}" id="ov-sp-shuffle" data-ov="sp-shuffle" title="${esc(t("music.shuffle"))}">${icon("shuffle", 14)}</button>` : ""}
        <button class="icon-btn ov-sp-ctrl-btn" data-ov="media-prev" title="${esc(t("music.previous"))}">${icon("skip-back", 16)}</button>
        <button class="btn primary ov-sp-play-btn" data-ov="media-toggle" id="ov-sp-toggle" title="${esc(t("music.playPause"))}">
          ${icon(m.isPlaying ? "pause" : "play", 18)}
        </button>
        <button class="icon-btn ov-sp-ctrl-btn" data-ov="media-next" title="${esc(t("music.next"))}">${icon("skip-forward", 16)}</button>
        ${m.canShuffleRepeat ? `<button class="icon-btn ov-sp-ctrl-btn${m.repeat !== "off" ? " active" : ""}" id="ov-sp-repeat" data-ov="sp-repeat" title="${esc(t("music.repeat"))}">${icon("repeat", 14)}</button>` : ""}
      </div>

      <div class="ov-sp-extras">
        ${m.volumePercent != null ? `
          <div class="ov-sp-volume" title="Volume">
            ${icon("volume-2", 13)}
            <input type="range" id="ov-sp-volume" min="0" max="100" value="${m.volumePercent}" />
          </div>` : `<span></span>`}
        <button class="btn ghost small ov-sp-open-btn" data-ov="sp-open" title="${esc(t("overlay.openSpotify"))}">
          ${icon("external", 12)} <span>${esc(t("overlay.tabSpotify"))}</span>
        </button>
      </div>
    </div>`;
}

/* ---------- Library browser (dual-tab: playlists <-> tracks) ---------- */

function libraryTabsHtml(): string {
  const plCount = playlists?.length ?? 0;
  const trCount = playlistTracks?.length ?? 0;
  return `
    <div class="ov-sp-tabs-bar">
      <div class="ov-sp-tabs">
        <button class="ov-sp-tab-btn ${musicViewMode === "playlists" ? "active" : ""}" data-ov="sp-tab-playlists" type="button">
          ${icon("list", 13)}
          <span>${esc(t("overlay.library"))}</span>
          ${plCount > 0 ? `<span class="ov-sp-count-pill">${plCount}</span>` : ""}
        </button>
        <button class="ov-sp-tab-btn ${musicViewMode === "tracks" ? "active" : ""}" data-ov="sp-tab-tracks" type="button">
          ${icon("music", 13)}
          <span>${esc(t("overlay.tracks"))}</span>
          ${trCount > 0 ? `<span class="ov-sp-count-pill">${trCount}</span>` : ""}
        </button>
      </div>
      <div class="ov-sp-tab-actions">
        <button class="icon-btn small ov-sp-action-btn${spotifySearchOpen ? " active" : ""}" data-ov="sp-toggle-search" title="${esc(t("common.search"))}">
          ${icon("search", 13)}
        </button>
        <button class="icon-btn small ov-sp-action-btn" data-ov="sp-refresh-library" title="${esc(t("overlay.refresh"))}">
          ${icon("refresh", 13)}
        </button>
      </div>
    </div>
    ${spotifySearchOpen ? `
      <div class="ov-sp-search-box">
        ${icon("search", 12)}
        <input type="text" id="ov-sp-search-input" placeholder="${esc(t("lib.searchPlaceholder"))}" value="${esc(spotifySearchQuery)}" />
        ${spotifySearchQuery ? `<button class="ov-sp-search-clear" data-ov="sp-clear-search" title="Clear">${icon("x", 12)}</button>` : ""}
      </div>` : ""}`;
}

function libraryHtml(): string {
  return `
    <div class="ov-sp-library">
      <div class="ov-sp-library-header" id="ov-sp-library-header">
        ${libraryTabsHtml()}
      </div>
      <div class="ov-sp-panes">
        <div class="ov-sp-pane" id="ov-sp-playlist-list"${musicViewMode === "playlists" ? "" : ' style="display:none"'}></div>
        <div class="ov-sp-pane" id="ov-sp-track-list"${musicViewMode === "tracks" ? "" : ' style="display:none"'}></div>
      </div>
    </div>`;
}

function setMusicViewMode(mode: "playlists" | "tracks"): void {
  musicViewMode = mode;
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
  const plList = document.getElementById("ov-sp-playlist-list");
  const trList = document.getElementById("ov-sp-track-list");
  if (plList) plList.style.display = mode === "playlists" ? "flex" : "none";
  if (trList) trList.style.display = mode === "tracks" ? "flex" : "none";
  if (mode === "playlists") renderPlaylistList();
  else renderTrackList();
}

/** Shimmering rows while a library pane loads. */
function skeletonHtml(): string {
  return `<div class="ov-sp-skeleton">${Array.from(
    { length: 5 },
    (_, index) => `
    <div class="ov-sp-skel-row">
      <span class="ov-sp-skel-art"></span>
      <span class="ov-sp-skel-lines">
        <span class="ov-sp-skel-line" style="width:${72 - index * 9}%"></span>
        <span class="ov-sp-skel-line short" style="width:${38 - index * 4}%"></span>
      </span>
    </div>`,
  ).join("")}</div>`;
}

/** Shared centered empty/error block for the library panes. */
function emptyBlockHtml(iconName: IconName, title: string, desc = "", action = ""): string {
  return `
    <div class="ov-empty-block">
      <div class="ov-empty-icon">${icon(iconName, 24)}</div>
      <div class="ov-empty-title">${esc(title)}</div>
      ${desc ? `<div class="ov-empty-desc">${esc(desc)}</div>` : ""}
      ${action}
    </div>`;
}

function retryButtonHtml(): string {
  return `<button class="btn ghost small" data-ov="sp-refresh-library">${icon("refresh", 13)} ${esc(t("overlay.retry"))}</button>`;
}

function renderPlaylistList(): void {
  const host = document.getElementById("ov-sp-playlist-list");
  if (!host) return;
  if (playlistsState === "idle" || playlistsState === "loading") {
    host.innerHTML = skeletonHtml();
    return;
  }
  if (playlistsState === "error") {
    host.innerHTML = emptyBlockHtml("alert-triangle", t("overlay.playlistsError"), playlistsError.slice(0, 140), retryButtonHtml());
    return;
  }
  let lists = playlists ?? [];
  if (spotifySearchQuery.trim()) {
    const q = spotifySearchQuery.trim().toLowerCase();
    lists = lists.filter((l) => l.name.toLowerCase().includes(q));
  }
  if (lists.length === 0) {
    if (spotifySearchQuery.trim()) {
      host.innerHTML = emptyBlockHtml("search", "Sonuç Bulunamadı", "Farklı bir arama terimi deneyin.");
    } else {
      host.innerHTML = emptyBlockHtml("list", t("overlay.noPlaylists"), "", retryButtonHtml());
    }
    return;
  }
  host.innerHTML = lists
    .map(
      (list) => `
      <button class="ov-sp-row ov-sp-pl-row${list.uri === selectedPlaylist ? " selected" : ""}" data-ov="sp-select-playlist" data-uri="${esc(list.uri)}">
        ${list.artUrl
          ? `<img class="ov-sp-row-art" src="${esc(list.artUrl)}" alt="" loading="lazy" />`
          : `<span class="ov-sp-row-art ov-sp-row-art-empty">${icon("music", 15)}</span>`}
        <span class="ov-sp-row-meta">
          <span class="ov-sp-row-name">${esc(list.name)}</span>
          <span class="ov-sp-row-sub">${list.trackCount} ${esc(t("overlay.tracks"))}</span>
        </span>
        <span class="ov-sp-row-arrow">${icon("chevron-right", 14)}</span>
      </button>`,
    )
    .join("");
}

function renderTrackList(): void {
  const host = document.getElementById("ov-sp-track-list");
  if (!host) return;
  if (!selectedPlaylist) {
    host.innerHTML = `
      <div class="ov-empty-block">
        <div class="ov-empty-icon">${icon("list", 28)}</div>
        <div class="ov-empty-title">${esc(t("overlay.libraryEmptyTitle"))}</div>
        <div class="ov-empty-desc">${esc(t("overlay.libraryEmptyDesc"))}</div>
        <button class="btn primary small" data-ov="sp-tab-playlists" style="margin-top:10px">
          ${icon("list", 13)} <span>${esc(t("overlay.library"))}</span>
        </button>
      </div>`;
    return;
  }
  if (tracksState === "idle" || tracksState === "loading") {
    host.innerHTML = skeletonHtml();
    return;
  }
  if (tracksState === "error") {
    host.innerHTML = emptyBlockHtml("alert-triangle", t("overlay.playlistsError"), tracksError.slice(0, 140), retryButtonHtml());
    return;
  }
  let tracks = playlistTracks ?? [];
  if (spotifySearchQuery.trim()) {
    const q = spotifySearchQuery.trim().toLowerCase();
    tracks = tracks.filter((t) => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  }
  const selObj = playlists?.find((p) => p.uri === selectedPlaylist);
  const trackHeaderHtml = `
    <div class="ov-sp-tracklist-bar">
      <div class="ov-sp-tl-left">
        <button class="btn ghost small ov-sp-back-inline" data-ov="sp-tab-playlists" title="${esc(t("music.back"))}">
          ${icon("arrow-left", 12)} <span>${esc(t("music.back"))}</span>
        </button>
        <span class="ov-sp-tl-title" title="${esc(selObj?.name || "")}">${esc(selObj?.name || t("overlay.tracks"))}</span>
      </div>
      <span class="ov-sp-tl-count">${playlistTracks?.length ?? 0} ${esc(t("overlay.tracks"))}</span>
    </div>`;

  if (tracks.length === 0) {
    if (spotifySearchQuery.trim()) {
      host.innerHTML = trackHeaderHtml + emptyBlockHtml("search", "Sonuç Bulunamadı", "Arama terimini değiştirin.");
    } else {
      host.innerHTML = trackHeaderHtml + emptyBlockHtml("list", t("overlay.noTracks"), "", retryButtonHtml());
    }
    return;
  }
  host.innerHTML = trackHeaderHtml + tracks
    .map(
      (track, index) => `
      <button class="ov-sp-row ov-sp-track" data-ov="sp-play-track" data-uri="${esc(track.uri)}" data-index="${index + 1}">
        <span class="ov-sp-track-index">${index + 1}</span>
        ${track.artUrl ? `<img class="ov-sp-row-art" src="${esc(track.artUrl)}" alt="" loading="lazy" />` : ""}
        <span class="ov-sp-row-meta">
          <span class="ov-sp-row-name">${esc(track.name)}</span>
          <span class="ov-sp-row-sub">${esc(track.artist)}</span>
        </span>
        <span class="ov-sp-track-time">${formatSpotifyTime(track.durationMs)}</span>
      </button>`,
    )
    .join("");
  paintTrackHighlight();
}

/** Marks the row of the track the engine is playing right now. */
function paintTrackHighlight(): void {
  const current = spotifyNow?.uri ?? "";
  document.querySelectorAll<HTMLElement>(".ov-sp-track").forEach((row) => {
    const playing = Boolean(current) && row.dataset.uri === current;
    row.classList.toggle("playing", playing);
    const index = row.querySelector<HTMLElement>(".ov-sp-track-index");
    if (index) index.innerHTML = playing ? icon("volume-2", 12) : row.dataset.index ?? "";
  });
}

/** Loads the rootlist once per overlay session (the Rust side caches it too). */
async function ensurePlaylists(force = false): Promise<void> {
  if (!force && (playlistsState === "loading" || playlistsState === "ready")) return;
  playlistsState = "loading";
  playlistsError = "";
  renderPlaylistList();
  try {
    playlists = await spotifyPlaybackPlaylists(force);
    playlistsState = "ready";
  } catch (error) {
    playlistsError = String(error).replace(/^Error: /, "");
    playlistsState = "error";
  }
  renderPlaylistList();
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
}

/** Opens a playlist: highlight it and load its tracks. */
async function selectPlaylist(uri: string): Promise<void> {
  selectedPlaylist = uri;
  setMusicViewMode("tracks");
  renderPlaylistList();
  if (playlistTracks && tracksState === "ready" && tracksFor === uri) {
    renderTrackList();
    const header = document.getElementById("ov-sp-library-header");
    if (header) header.innerHTML = libraryTabsHtml();
    return;
  }
  tracksFor = uri;
  playlistTracks = null;
  tracksState = "loading";
  tracksError = "";
  renderTrackList();
  try {
    playlistTracks = await spotifyPlaybackPlaylistTracks(uri);
    tracksState = "ready";
  } catch (error) {
    tracksError = String(error).replace(/^Error: /, "");
    tracksState = "error";
  }
  renderTrackList();
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
}

/** Starts the open playlist at the clicked track. */
async function playTrack(trackUri: string): Promise<void> {
  if (!selectedPlaylist) return;
  spotifyMiniView = "player";
  updateMusicMiniViewState();
  try {
    await spotifyPlaybackPlay(selectedPlaylist, trackUri);
  } catch {
    // The next poll shows whatever the engine did.
  }
  window.setTimeout(() => void refreshMedia(), 600);
}

/**
 * "Open in Spotify": prefers the launcher's embedded page (the launcher comes
 * forward with the track); falls back to the browser when the embedded page
 * has no Spotify session.
 */
async function openSpotifyLink(): Promise<void> {
  const url = spotifyNow?.url && spotifyNow.url !== "spotify:" ? spotifyNow.url : "https://open.spotify.com/";
  try {
    const opened = await invoke<boolean>("spotify_open_in_launcher", { url });
    if (opened) return;
  } catch {
    // Fall through to the browser.
  }
  void openUrl(url).catch(() => undefined);
}

/**
 * Opens a conversation in the launcher's own Discord client and brings the
 * launcher forward: typing and joining stay in the real client, so the overlay
 * never writes anything by itself.
 */
async function openDiscordInLauncher(url: string): Promise<void> {
  try {
    await invoke("discord_open_conversation", { url });
  } catch {
    // Older hosts have no such command; the launcher still comes forward.
  }
  void invoke("overlay_show_launcher").catch(() => undefined);
}

/** Forces a library refresh (the Rust caches are bypassed). */
async function refreshLibrary(): Promise<void> {
  if (musicViewMode === "tracks" && selectedPlaylist) {
    tracksState = "loading";
    tracksError = "";
    renderTrackList();
    try {
      playlistTracks = await spotifyPlaybackPlaylistTracks(selectedPlaylist);
      tracksState = "ready";
    } catch (error) {
      tracksError = String(error).replace(/^Error: /, "");
      tracksState = "error";
    }
    renderTrackList();
  } else {
    await ensurePlaylists(true);
  }
}

/** Swaps an artwork slot between the image and its placeholder. */
function patchArt(id: string, artUrl: string, placeholderSvg: string, placeholderClass: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (artUrl) {
    if (el.tagName !== "IMG") {
      el.outerHTML = `<img class="${placeholderClass}" id="${id}" src="${esc(artUrl)}" alt="" />`;
    } else if (el.getAttribute("src") !== artUrl) {
      el.setAttribute("src", artUrl);
    }
  } else if (el.tagName === "IMG") {
    el.outerHTML = `<div class="${placeholderClass}" id="${id}">${placeholderSvg}</div>`;
  }
}

/** In-place updates for whichever media surfaces exist right now. */
function patchMediaSurfaces(): void {
  const m = getOverlayMedia();
  const homeTitle = document.getElementById("ov-media-title");
  if (homeTitle) {
    homeTitle.textContent = m.active ? m.title : t("overlay.noMedia");
    setText("ov-media-artist", m.active ? m.artist : t("overlay.openSpotify"));
    setText("ov-media-source", m.active ? m.source : "");
    const cardTitle = document.getElementById("ov-media-card-title");
    if (cardTitle) {
      const kind = m.isSpotify ? "spotify" : "media";
      if (cardTitle.dataset.kind !== kind) {
        cardTitle.dataset.kind = kind;
        cardTitle.innerHTML = mediaCardTitleHtml();
      }
    }
    const toggle = document.getElementById("ov-media-toggle");
    if (toggle) toggle.innerHTML = icon(m.isPlaying ? "pause" : "play", 18);
    patchArt(
      "ov-media-art",
      m.artUrl,
      icon("music", 20),
      "ov-media-icon",
    );
  }

  const spTitle = document.getElementById("ov-sp-title");
  if (spTitle) {
    spTitle.textContent = m.title;
    setText("ov-sp-artist", m.artist);
    const albumEl = document.getElementById("ov-sp-album");
    if (albumEl) {
      albumEl.textContent = m.album;
      albumEl.style.display = m.album ? "" : "none";
    }
    const badge = document.getElementById("ov-sp-source-badge");
    if (badge) {
      badge.innerHTML = `${m.isSpotify ? icon("spotify", 12) : icon("volume-2", 12)} <span>${esc(m.source)}</span>`;
      badge.className = "ov-badge-pill";
    }
    const toggle = document.getElementById("ov-sp-toggle");
    if (toggle) toggle.innerHTML = icon(m.isPlaying ? "pause" : "play", 18);

    const shuffleBtn = document.getElementById("ov-sp-shuffle");
    if (shuffleBtn) shuffleBtn.classList.toggle("active", Boolean(m.shuffle));

    const repeatBtn = document.getElementById("ov-sp-repeat");
    if (repeatBtn) {
      repeatBtn.classList.toggle("active", m.repeat !== "off");
      repeatBtn.classList.toggle("repeat-track", m.repeat === "track");
    }

    const volume = document.getElementById("ov-sp-volume") as HTMLInputElement | null;
    if (volume && document.activeElement !== volume && m.volumePercent != null) {
      volume.value = String(m.volumePercent);
    }

    patchArt(
      "ov-sp-art",
      m.artUrl,
      m.isSpotify ? spotifyLogoSvg(30) : icon("music", 24),
      m.isSpotify && !m.artUrl ? "ov-sp-art ov-sp-art-spotify" : "ov-sp-art",
    );

    paintSpotifyProgress();
    paintTrackHighlight();
  }
}

/** Moves the music-tab progress bar between API polls. */
function paintSpotifyProgress(): void {
  const fill = document.getElementById("ov-sp-progress-fill");
  if (!fill) return;
  const m = getOverlayMedia();
  const duration = m.durationMs || 0;
  let elapsed = spotifyBaseMs;
  if (spotifyNow?.isPlaying) elapsed += Date.now() - spotifyBaseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
  setText("ov-sp-elapsed", formatSpotifyTime(elapsed));
  setText("ov-sp-duration", duration > 0 ? formatSpotifyTime(duration) : "0:00");
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
    await spotifyPlaybackControl(action, value ?? null);
  } catch {
    // Poll below re-syncs from the engine.
  }
  window.setTimeout(() => void refreshMedia(), 400);
}

/* 7. Browser View */
/**
 * The panel cannot host pages itself, so the tab is only the doorway: the
 * browser window floats over the game with its own tab strip and opens the
 * moment the tab is picked (no second button to hunt for). `renderWidgetContent`
 * is the whole view — there is no widget body for it.
 */

/* 8. Discord View */
/**
 * Exactly two areas: the friend picker (left) and the conversation (right).
 * Everything else — requests, channels, adding a friend, the status — is a
 * takeover behind one labelled button in the picker or conversation header, so
 * the default screen only shows who is talking and what they said. Writing and
 * calling go through the Social SDK; the full client stays one tab away.
 */

/** One message in the conversation: what we sent, and what arrived. */
interface ReplyLogEntry {
  id: number;
  friendId: string;
  /** The Discord message id, once the SDK reported it: delete and open need it. */
  messageId?: string;
  time: string;
  text: string;
  /** An attachment's name (image, GIF, sticker): the SDK sends no URL. */
  attachment?: string;
  state: "sending" | "sent" | "error";
  error?: string;
  /** "out" = sent from here, "in" = received. */
  direction: "out" | "in";
}

let replyLog: ReplyLogEntry[] = [];
let replyLogSeq = 0;
/** Per-friend drafts, so switching targets never loses what was typed. */
const replyDrafts = new Map<string, string>();
/** Unread arrivals per friend, cleared when their conversation is picked. */
const replyUnread = new Map<string, number>();
const LAST_FRIEND_KEY = "efxlve-overlay-dm";
/** The friend the composer writes to. */
let replyTarget: { id: string; name: string } | null = null;
/** True while a send is in flight: the button stays disabled until the SDK reports. */
let replySending = false;
/** The log row being edited, if any: the composer then saves instead of sends. */
let editingEntryId: number | null = null;
/** The compose draft put aside while editing, per friend. */
const editStash = new Map<string, string>();
/** Which takeover borrows the picker column, if any. */
type PickerMode = "friends" | "requests" | "add" | "status";
let pickerMode: PickerMode = "friends";
/** The add-friend search's state. */
let searchQuery = "";
let searchRan = false;
let searchResults: { id: string; name: string; username: string; avatarUrl: string }[] = [];
/** Usernames a request was sent to this session, so the row stops offering it. */
const sentRequests = new Set<string>();
/** The DM call the overlay started, if any (the SDK's own call). */
let callState: { active: boolean; friendId: string | null; muted: boolean } = {
  active: false,
  friendId: null,
  muted: false,
};

/** The friend rows the picker shows: the live desktop read, the launcher's own
 * web client, the SDK's own list, then the last known list. Online first. */
function friendEntries(): FriendEntry[] {
  const state = friendsState;
  const live = state.status === "ready" && state.friends.length ? state.friends : null;
  const web = webVoice && webVoice.friends && webVoice.friends.length ? webVoice.friends : null;
  const sdk = sdkFriends.status === "ready" && sdkFriends.friends.length ? sdkFriends.friends : null;
  const friends = live ?? web ?? sdk ?? lastFriends;
  return [...friends].sort(
    (a, b) =>
      Number(a.status === "offline") - Number(b.status === "offline") ||
      a.name.localeCompare(b.name),
  );
}

/** The presence word for a friend's status (or the account's own). */
function presenceWord(status: string): string {
  switch (status) {
    case "online":
      return t("overlay.discordStatusOnline");
    case "idle":
      return t("overlay.discordStatusIdle");
    case "dnd":
      return t("overlay.discordStatusDnd");
    case "invisible":
      return t("overlay.discordStatusInvisible");
    default:
      return t("overlay.discordStatusOffline");
  }
}

let friendsFilterQuery = "";

function renderDiscordSocial(): void {
  const el = viewEl("discord");
  if (!el) return;
  const requests = sdkFriends.pendingUsers ?? [];
  if (pickerMode === "requests") {
    el.innerHTML = takeoverSocialHtml(
      t("overlay.discordRequests"),
      requests.length
        ? requests.map(requestRowHtml).join("")
        : `<div class="empty-picker-wrap"><span>${esc(t("overlay.discordFriendsEmpty"))}</span></div>`,
    );
    return;
  }
  if (pickerMode === "add") {
    el.innerHTML = takeoverSocialHtml(t("overlay.discordAddFriend"), addFriendBodyHtml());
    return;
  }
  if (pickerMode === "status") {
    el.innerHTML = takeoverSocialHtml(t("overlay.discordStatusLabel"), statusBodyHtml());
    return;
  }

  el.innerHTML = `
    <div class="ov-dc-social-body">
      ${socialProfileHtml()}
      ${socialVoiceHtml()}
      ${socialSearchStripHtml(requests.length)}
      <div class="ov-dc-friends-scroll">
        ${socialListHtml()}
      </div>
    </div>`;
}

function takeoverSocialHtml(title: string, body: string): string {
  return `
    <div class="ov-dc-social-body">
      <div class="takeover-header">
        <button class="takeover-back-btn" data-ov="discord-picker" data-mode="friends">← ${esc(t("overlay.discordFriendsTitle"))}</button>
        <span class="takeover-title">${esc(title)}</span>
      </div>
      <div class="ov-dc-friends-scroll">${body}</div>
    </div>`;
}

function renderDiscordChat(): void {
  const el = viewEl("chat");
  if (!el) return;
  if (sdkState.status !== "ready") {
    el.innerHTML = `
      <div class="ov-dc-chat-body">
        ${connectHtml()}
      </div>`;
    return;
  }
  if (!replyTarget) {
    const stored = localStorage.getItem(LAST_FRIEND_KEY);
    const pick = friendEntries().find((f) => f.id === stored);
    if (pick) replyTarget = { id: pick.id, name: pick.name };
  }
  if (replyTarget) {
    ensureHistory(replyTarget.id);
  }
  const target = replyTarget;
  if (!target) {
    el.innerHTML = `
      <div class="ov-dc-chat-body">
        ${chatEmptyPlaceholderHtml()}
      </div>`;
    return;
  }
  const friend = friendEntries().find((f) => f.id === target.id);
  const draft = replyDrafts.get(target.id) ?? "";
  const editing =
    editingEntryId !== null
      ? replyLog.find((item) => item.id === editingEntryId) ?? null
      : null;

  el.innerHTML = `
    <div class="ov-dc-chat-body">
      ${chatTargetHeaderHtml(target, friend)}
      <div class="ov-dc-chat-messages" id="ov-dc-chat-messages">
        ${chatMessagesHtml(target)}
      </div>
      ${chatComposerHtml(target, draft, editing)}
    </div>`;

  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (box && box.value) growComposer(box);

  const scrollContainer = document.getElementById("ov-dc-chat-messages");
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
}

function renderDiscord(): void {
  if (isWidgetOpen("discord")) renderDiscordSocial();
  if (isWidgetOpen("chat")) renderDiscordChat();
}

/** The field grows with the draft, then scrolls at six lines. */
function growComposer(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(88, Math.max(34, box.scrollHeight))}px`;
}

function repaintDiscordChat(): void {
  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const wasFocused = box !== null && document.activeElement === box;
  const caret = box ? box.selectionStart : 0;
  renderDiscordChat();
  if (!wasFocused) return;
  const fresh = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (!fresh) return;
  fresh.focus();
  fresh.setSelectionRange(caret, caret);
}

function repaintDiscord(): void {
  if (isWidgetOpen("discord")) renderDiscordSocial();
  if (isWidgetOpen("chat")) repaintDiscordChat();
}

/** Puts the caret in the composer: after picking a friend the keyboard belongs
 * to the text box, not to the focus ring (Enter/Space would re-fire the row). */
function focusReplyInput(): void {
  requestAnimationFrame(() => {
    document.getElementById("ov-discord-reply-input")?.focus();
  });
}

/** Selects a friend for the composer; a typed letter can seed the draft. */
function selectReplyTarget(id: string, name: string, seed = ""): void {
  replyTarget = { id, name };
  if (seed) replyDrafts.set(id, seed);
  replyUnread.delete(id);
  pickerMode = "friends";
  localStorage.setItem(LAST_FRIEND_KEY, id);
  ensureHistory(id);
  openWidget("chat");
  bringToFront("chat");
  renderDiscordChat();
  if (isWidgetOpen("discord")) renderDiscordSocial();
  focusReplyInput();
}

/** A message that arrived while the overlay is open: it lands in that friend's
 * thread, and a badge waits on the row if the conversation is not on screen. */
function noteIncoming(
  friendId: string,
  text: string,
  at: number,
  messageId?: string,
  attachment?: string,
): void {
  const time = new Date(at > 0 ? at : Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  replyLog.push({
    id: ++replyLogSeq,
    friendId,
    messageId,
    time,
    text,
    attachment,
    state: "sent",
    direction: "in",
  });
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  if (replyTarget?.id !== friendId) {
    replyUnread.set(friendId, (replyUnread.get(friendId) ?? 0) + 1);
  }
  void notifyMessage(friendId, text);
  if ((isWidgetOpen("discord") || isWidgetOpen("chat")) && !document.hidden) repaintDiscord();
}

/** A desktop notification for a message that arrived while the panel was not
 * showing that conversation. The permission is asked once, on the first one.
 *
 * The toast plugin does not wire clicks on Windows desktop (its action API is
 * mobile-only), so the sender is preselected instead: opening the panel lands
 * straight in their conversation. */
async function notifyMessage(friendId: string, text: string): Promise<void> {
  const showing = isWidgetOpen("chat") && !document.hidden && replyTarget?.id === friendId;
  if (showing) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const friend = friendEntries().find((item) => item.id === friendId);
    sendNotification({
      title: friend?.name ?? t("overlay.tabDiscord"),
      body: text || t("overlay.discordSent"),
    });
    // Next open lands in that conversation.
    if (friend) {
      replyTarget = { id: friend.id, name: friend.name };
      localStorage.setItem(LAST_FRIEND_KEY, friend.id);
    }
  } catch {
    // No permission: the unread badge in the panel is still waiting.
  }
}

/** An incoming call in the launcher's own client: a desktop notification, and
 * the caller is preselected so opening the panel lands in their conversation. */
async function notifyIncomingCall(from: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const friend = friendEntries().find((item) => item.id === from);
    // With a name the title is the caller and the body says what this is; with
    // no name the title carries it alone.
    sendNotification({
      title: friend?.name ?? t("overlay.discordCallIncoming"),
      body: friend ? t("overlay.discordCallIncoming") : "",
    });
    if (friend) {
      replyTarget = { id: friend.id, name: friend.name };
      localStorage.setItem(LAST_FRIEND_KEY, friend.id);
    }
  } catch {
    // No permission: nothing else to do here.
  }
}

/** Ctrl+Up/Down inside the box: walk the friend list without losing the draft. */
function stepReplyTarget(direction: number): void {
  const friends = friendEntries();
  if (friends.length < 2) return;
  const index = friends.findIndex((friend) => friend.id === replyTarget?.id);
  const next = friends[(index < 0 ? 0 : index + direction + friends.length) % friends.length];
  const box = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  if (box && replyTarget) replyDrafts.set(replyTarget.id, box.value);
  selectReplyTarget(next.id, next.name);
}

/** Esc leaves the box back to the selected row; a second Esc closes the panel. */
function focusSelectedFriendRow(): void {
  const row =
    document.querySelector<HTMLElement>('.friend-row[data-ov="discord-reply"].is-active') ??
    document.querySelector<HTMLElement>('.friend-row[data-ov="discord-reply"]');
  row?.focus();
}

/** A conversation's entries, oldest first. Snowflake ids order the messages;
 * ones still in flight (no id yet) go last. */
function threadEntries(friendId: string): ReplyLogEntry[] {
  return replyLog
    .filter((entry) => entry.friendId === friendId)
    .sort((a, b) => compareMessageIds(a.messageId, b.messageId));
}

function compareMessageIds(a?: string, b?: string): number {
  if (a && b) {
    // Snowflakes are all the same length; lexicographic order is time order.
    return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
  }
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Friends whose history was already pulled this session. */
const historyLoaded = new Set<string>();

/** Pulls the last messages once per conversation, so the log opens with the
 * real thread instead of only what happened since the overlay started. */
function ensureHistory(friendId: string): void {
  if (historyLoaded.has(friendId)) return;
  historyLoaded.add(friendId);
  void invoke("discord_sdk_history", { userId: friendId, limit: 30 }).catch(() => {
    historyLoaded.delete(friendId);
  });
}

interface HistoryMessage {
  messageId: string;
  text: string;
  attachment?: string;
  at: number;
  direction: "out" | "in";
}

/** History merges under the session entries: known ids are skipped, and the
 * thread keeps snowflake order. */
function mergeHistory(friendId: string, messages: HistoryMessage[]): void {
  const known = new Set(
    replyLog
      .filter((entry) => entry.friendId === friendId && entry.messageId)
      .map((entry) => entry.messageId),
  );
  let added = 0;
  for (const message of messages) {
    if (!message.messageId || known.has(message.messageId)) continue;
    known.add(message.messageId);
    replyLog.push({
      id: ++replyLogSeq,
      friendId,
      messageId: message.messageId,
      time: new Date(message.at > 0 ? message.at : Date.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      text: message.text,
      attachment: message.attachment || undefined,
      state: "sent",
      direction: message.direction,
    });
    added += 1;
  }
  if (!added) return;
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  if ((isWidgetOpen("discord") || isWidgetOpen("chat")) && !document.hidden) repaintDiscord();
}

/* --- Area 1: Discord Sosyal (Friends List & Voice) --- */

function socialProfileHtml(): string {
  const me = sdkState.me;
  const connected = sdkState.status === "ready";
  if (!connected) {
    return `
      <div class="ov-dc-profile-card">
        <div class="ov-dc-profile-left">
          <div class="ov-dc-avatar-wrap">
            <div class="ov-dc-avatar-fallback">${icon("discord", 18)}</div>
          </div>
          <div class="ov-dc-profile-info">
            <span class="ov-dc-profile-name">${esc(t("overlay.discordNotConnected"))}</span>
            <span class="ov-dc-profile-desc">${esc(t("overlay.discordSdkDesc"))}</span>
          </div>
        </div>
        <button class="btn primary small" data-ov="discord-sdk-start">${icon("discord", 13)} <span>${esc(t("overlay.discordConnect"))}</span></button>
      </div>`;
  }
  const currentStatus = me?.status ?? "online";
  return `
    <div class="ov-dc-profile-card">
      <div class="ov-dc-profile-left">
        <div class="ov-dc-avatar-wrap">
          ${me?.avatarUrl ? `<img class="ov-dc-avatar" src="${esc(me.avatarUrl)}" alt="" />` : `<div class="ov-dc-avatar-fallback">${icon("user", 16)}</div>`}
          <span class="ov-dc-status-dot ${esc(currentStatus)}"></span>
        </div>
        <div class="ov-dc-profile-info">
          <span class="ov-dc-profile-name">${esc(me?.name ?? "Discord")}</span>
          <span class="ov-dc-profile-status">${esc(presenceWord(currentStatus))}</span>
        </div>
      </div>
      <div class="ov-dc-profile-actions">
        <button class="ov-dc-tool-btn" data-ov="discord-picker" data-mode="status" title="${esc(t("overlay.discordStatusLabel"))}">
          ${icon("sliders", 14)}
        </button>
      </div>
    </div>`;
}

function socialVoiceHtml(): string {
  if (voiceState.status === "ready" && voiceState.channel) {
    const ch = voiceState.channel;
    const count = voiceState.participants.length;
    return `
      <div class="ov-dc-voice-strip">
        <div class="ov-dc-voice-left">
          <span class="ov-dc-voice-icon live">${icon("mic", 14)}</span>
          <div class="ov-dc-voice-meta">
            <span class="ov-dc-voice-channel">${esc(ch.name)}</span>
            <span class="ov-dc-voice-count">${count} ${count === 1 ? "kişi" : "katılımcı"}</span>
          </div>
        </div>
        <button class="ov-dc-voice-leave-btn" data-ov="discord-voice-leave" title="${esc(t("overlay.discordCallEnd"))}">
          ${icon("x", 13)}
        </button>
      </div>`;
  }
  if (callState.active) {
    const friend = friendEntries().find((f) => f.id === callState.friendId);
    return `
      <div class="ov-dc-voice-strip">
        <div class="ov-dc-voice-left">
          <span class="ov-dc-voice-icon live">${icon("mic", 14)}</span>
          <div class="ov-dc-voice-meta">
            <span class="ov-dc-voice-channel">${esc(friend?.name ?? t("overlay.discordCallActive"))}</span>
            <span class="ov-dc-voice-count">${esc(t("overlay.discordCallActive"))}</span>
          </div>
        </div>
        <div class="ov-dc-voice-btns">
          <button class="ov-dc-tool-btn ${callState.muted ? "is-muted" : ""}" data-ov="discord-call-mute" title="${esc(callState.muted ? t("overlay.discordCallUnmute") : t("overlay.discordCallMute"))}">
            ${icon(callState.muted ? "mic-off" : "mic", 13)}
          </button>
          <button class="ov-dc-voice-leave-btn" data-ov="discord-call-end" title="${esc(t("overlay.discordCallEnd"))}">
            ${icon("x", 13)}
          </button>
        </div>
      </div>`;
  }
  return "";
}

function socialSearchStripHtml(pendingCount: number): string {
  return `
    <div class="ov-dc-search-row">
      <div class="ov-dc-search-box">
        <span class="ov-dc-search-ico">${icon("search", 13)}</span>
        <input id="ov-dc-friends-filter" class="ov-dc-search-input" placeholder="${esc(t("overlay.discordSearchPlaceholder"))}" value="${esc(friendsFilterQuery)}" spellcheck="false" />
        ${friendsFilterQuery ? `<button class="ov-dc-search-clear" data-ov="discord-clear-filter">${icon("x", 11)}</button>` : ""}
      </div>
      <button class="ov-dc-add-btn" data-ov="discord-picker" data-mode="add" title="${esc(t("overlay.discordAddFriend"))}">
        ${icon("plus", 13)}
      </button>
      ${pendingCount > 0 ? `
        <button class="ov-dc-requests-btn" data-ov="discord-picker" data-mode="requests" title="${esc(t("overlay.discordRequests"))}">
          ${icon("bell", 13)}
          <span class="ov-dc-badge">${pendingCount}</span>
        </button>
      ` : ""}
    </div>`;
}

function socialFriendsListHtml(): string {
  const allFriends = friendEntries();
  const filter = friendsFilterQuery.trim().toLowerCase();
  const filtered = filter
    ? allFriends.filter((f) => f.name.toLowerCase().includes(filter))
    : allFriends;

  const online = filtered.filter((f) => f.status === "online" || f.status === "idle" || f.status === "dnd");
  const offline = filtered.filter((f) => f.status !== "online" && f.status !== "idle" && f.status !== "dnd");

  if (allFriends.length === 0) {
    return `
      <div class="ov-dc-empty-list">
        ${icon("users", 24)}
        <span>${esc(sdkState.status === "ready" ? t("overlay.discordFriendsEmpty") : t("overlay.discordFriendsEmptyHint"))}</span>
      </div>`;
  }

  if (filtered.length === 0) {
    return `
      <div class="ov-dc-empty-list">
        <span>${esc(t("overlay.discordNoResults"))}</span>
      </div>`;
  }

  let html = "";
  if (online.length > 0) {
    html += `
      <div class="ov-dc-group-header">
        <span>${esc(t("overlay.discordFriendsOnline", { count: String(online.length) }))}</span>
      </div>
      <div class="ov-dc-group-items">
        ${online.map(socialFriendItemHtml).join("")}
      </div>`;
  }
  if (offline.length > 0) {
    html += `
      <div class="ov-dc-group-header">
        <span>${esc(t("overlay.discordFriendsOffline", { count: String(offline.length) }))}</span>
      </div>
      <div class="ov-dc-group-items">
        ${offline.map(socialFriendItemHtml).join("")}
      </div>`;
  }
  return html;
}

/** Group DMs the launcher's own client knows: read-only rows that open the
 * conversation in the Discord page (reading and writing stay there). */
function socialGroupsHtml(): string {
  const groups = webVoice?.conversations ?? [];
  if (groups.length === 0) return "";
  return `
    <div class="ov-dc-group-header">
      <span>${esc(t("overlay.discordGroupsTitle"))} · ${groups.length}</span>
    </div>
    <div class="ov-dc-group-items">
      ${groups.map(socialGroupItemHtml).join("")}
    </div>`;
}

/** A group DM has a user-set name or none: fall back to the member names. */
function groupTitle(conv: WebGroupConversation): string {
  const named = conv.name.trim();
  if (named) return named;
  const names = conv.members.map((member) => member.name).filter(Boolean);
  return names.length ? names.slice(0, 3).join(", ") : t("overlay.discordGroupsTitle");
}

function socialGroupItemHtml(conv: WebGroupConversation): string {
  const members = conv.members.slice(0, 3);
  const label = t("overlay.discordGroupMembers", { count: String(conv.memberCount) });
  const preview = conv.preview
    ? `${conv.preview.author ? `${conv.preview.author}: ` : ""}${conv.preview.text}`
    : "";
  return `
    <button class="ov-dc-friend-item ov-dc-group-item" data-ov="discord-open-group" data-id="${esc(conv.id)}" title="${esc(t("overlay.discordGroupOpen"))}">
      <div class="ov-dc-avatar-wrap ov-dc-stack">
        ${members.length
          ? members
              .map(
                (member, index) =>
                  `<img class="ov-dc-avatar ov-dc-stack-avatar" src="${esc(member.avatarUrl)}" alt="" loading="lazy" style="z-index:${members.length - index}" />`,
              )
              .join("")
          : `<div class="ov-dc-avatar-fallback">${icon("users", 14)}</div>`}
      </div>
      <div class="ov-dc-friend-info">
        <span class="ov-dc-friend-name">${esc(groupTitle(conv))}</span>
        <span class="ov-dc-friend-status">${esc(preview ? `${label} · ${preview}` : label)}</span>
      </div>
      ${conv.unread > 0 ? `<span class="ov-dc-unread-pill">${conv.unread}</span>` : ""}
      <span class="ov-dc-item-chat-icon">${icon("external", 13)}</span>
    </button>`;
}

/** Everything in the picker's scroll area: group DMs first, then the friends. */
function socialListHtml(): string {
  return socialGroupsHtml() + socialFriendsListHtml();
}

/** Re-paints only the list while the filter box keeps focus: a full picker
 * re-render on every keystroke used to drop the caret. */
function repaintFriendsList(): void {
  const scroll = document.querySelector<HTMLElement>(".ov-dc-friends-scroll");
  if (scroll) scroll.innerHTML = socialListHtml();
  const row = document.querySelector<HTMLElement>(".ov-dc-search-row");
  const clearBtn = row?.querySelector<HTMLElement>(".ov-dc-search-clear");
  if (friendsFilterQuery && !clearBtn && row) {
    row.insertAdjacentHTML(
      "beforeend",
      `<button class="ov-dc-search-clear" data-ov="discord-clear-filter">${icon("x", 11)}</button>`,
    );
  } else if (!friendsFilterQuery) {
    clearBtn?.remove();
  }
}

function socialFriendItemHtml(friend: FriendEntry): string {
  const active = replyTarget?.id === friend.id;
  const unread = replyUnread.get(friend.id) ?? 0;
  const isOffline = friend.status !== "online" && friend.status !== "idle" && friend.status !== "dnd";
  return `
    <button class="ov-dc-friend-item${active ? " is-active" : ""}${isOffline ? " is-offline" : ""}" data-ov="discord-select-friend" data-id="${esc(friend.id)}" data-name="${esc(friend.name)}" title="${esc(t("overlay.discordReplyTitle"))}">
      <div class="ov-dc-avatar-wrap">
        <img class="ov-dc-avatar" src="${esc(friend.avatarUrl)}" alt="" loading="lazy" />
        <span class="ov-dc-status-dot ${esc(friend.status)}"></span>
      </div>
      <div class="ov-dc-friend-info">
        <span class="ov-dc-friend-name">${esc(friend.name)}</span>
        <span class="ov-dc-friend-status ${esc(friend.status)}">${esc(presenceWord(friend.status))}</span>
      </div>
      ${unread > 0 ? `<span class="ov-dc-unread-pill">${unread}</span>` : ""}
      <span class="ov-dc-item-chat-icon">${icon("mail", 13)}</span>
    </button>`;
}

/** An incoming friend request: accept or decline, right from the list. */
function requestRowHtml(friend: FriendEntry): string {
  return `
    <div class="request-row">
      <span class="avatar-wrap"><img src="${esc(friend.avatarUrl)}" alt="" loading="lazy" /></span>
      <span class="friend-meta">
        <span class="friend-name">${esc(friend.name)}</span>
        <span class="friend-status">${esc(t("overlay.discordIncomingRequest"))}</span>
      </span>
      <span class="conv-actions">
        <button class="action-btn" style="border-color:var(--ok);color:var(--ok)" data-ov="discord-accept" data-id="${esc(friend.id)}">${esc(t("overlay.discordAccept"))}</button>
        <button class="action-btn" data-ov="discord-reject" data-id="${esc(friend.id)}">${esc(t("overlay.discordReject"))}</button>
      </span>
    </div>`;
}

function addFriendBodyHtml(): string {
  const results = searchResults.map(searchRowHtml).join("");
  const empty =
    searchRan && !searchResults.length
      ? `<div class="empty-picker-wrap"><span>${esc(t("overlay.discordNoResults"))}</span></div>`
      : "";
  return `
    <div class="search-strip">
      <input id="ov-discord-search" class="composer-input" type="text" value="${esc(searchQuery)}" placeholder="${esc(t("overlay.discordSearchPlaceholder"))}" spellcheck="false" />
      <button class="action-btn" data-ov="discord-search-run">${esc(t("overlay.discordSearchRun"))}</button>
    </div>
    ${results}${empty}`;
}

function searchRowHtml(user: { id: string; name: string; username: string; avatarUrl: string }): string {
  const handle = user.username || user.name;
  const friend = friendEntries().find((item) => item.id === user.id);
  const action = friend
    ? `<span class="msg-status-text">${esc(t("overlay.discordAlreadyFriend"))}</span>`
    : sentRequests.has(handle)
      ? `<span class="msg-status-text">${esc(t("overlay.discordRequestSent"))}</span>`
      : `<button class="action-btn" style="border-color:var(--ok);color:var(--ok)" data-ov="discord-add" data-username="${esc(handle)}">${esc(t("overlay.discordAddFriend"))}</button>`;
  return `
    <div class="request-row">
      <span class="avatar-wrap"><img src="${esc(user.avatarUrl)}" alt="" loading="lazy" /></span>
      <span class="friend-meta">
        <span class="friend-name">${esc(user.name)}</span>
        ${user.username ? `<span class="friend-status">@${esc(user.username)}</span>` : ""}
      </span>
      <span class="conv-actions">${action}</span>
    </div>`;
}

/** The four statuses Discord shows, with the current one marked. */
function statusBodyHtml(): string {
  const current = sdkState.me?.status ?? "online";
  const options = [
    { id: "online", key: "overlay.discordStatusOnline" },
    { id: "idle", key: "overlay.discordStatusIdle" },
    { id: "dnd", key: "overlay.discordStatusDnd" },
    { id: "invisible", key: "overlay.discordStatusInvisible" },
  ];
  return options
    .map(
      (option) => `
      <button class="friend-row${option.id === current ? " is-active" : ""}" data-ov="discord-status" data-status="${option.id}" style="height:48px">
        <span class="presence-dot ${option.id === "invisible" ? "offline" : option.id}" style="position:static"></span>
        <span class="friend-meta"><span class="friend-name">${esc(t(option.key))}</span></span>
      </button>`,
    )
    .join("");
}

/* --- Area 2: Discord Sohbet (Chat & Messages) --- */

function chatEmptyPlaceholderHtml(): string {
  return `
    <div class="ov-dc-chat-empty">
      <div class="ov-dc-chat-empty-icon">${icon("mail", 28)}</div>
      <div class="ov-dc-chat-empty-title">${esc(t("overlay.discordReplyTitle"))}</div>
      <p class="ov-dc-chat-empty-desc">${esc(t("overlay.discordReplyPick"))}</p>
      <button class="btn primary small" data-ov="discord-open-social">
        ${icon("users", 13)} <span>${esc(t("overlay.discordFriendsTitle"))}</span>
      </button>
    </div>`;
}

function chatTargetHeaderHtml(target: { id: string; name: string }, friend?: FriendEntry): string {
  const status = friend?.status ?? "offline";
  const inCall = callState.active && callState.friendId === target.id;
  return `
    <div class="ov-dc-target-header">
      <div class="ov-dc-target-left">
        <div class="ov-dc-avatar-wrap">
          <img class="ov-dc-avatar" src="${esc(friend?.avatarUrl ?? "")}" alt="" />
          <span class="ov-dc-status-dot ${esc(status)}"></span>
        </div>
        <div class="ov-dc-target-meta">
          <span class="ov-dc-target-name">${esc(target.name)}</span>
          <span class="ov-dc-target-sub ${esc(status)}">● ${esc(presenceWord(status))}</span>
        </div>
      </div>
      <div class="ov-dc-target-actions">
        ${inCall ? `
          <button class="ov-dc-tool-btn is-calling" data-ov="discord-call-end" title="${esc(t("overlay.discordCallEnd"))}">
            ${icon("mic-off", 14)}
          </button>
        ` : `
          <button class="ov-dc-tool-btn" data-ov="discord-call-start" data-id="${esc(target.id)}" title="${esc(t("overlay.discordCall"))}">
            ${icon("mic", 14)}
          </button>
        `}
      </div>
    </div>`;
}

function chatMessagesHtml(target: { id: string; name: string }): string {
  const entries = threadEntries(target.id).slice(-60);
  if (entries.length === 0) {
    return `
      <div class="ov-dc-chat-thread-empty">
        <span>${esc(t("overlay.discordFriendsEmpty"))}</span>
      </div>`;
  }
  const friend = sdkFriends.friends.find((f) => f.id === target.id) || friendsState.friends.find((f) => f.id === target.id);
  const avatarUrl = friend?.avatarUrl;
  return entries.map((entry) => chatBubbleHtml(entry, target.name, avatarUrl)).join("");
}

function chatBubbleHtml(entry: ReplyLogEntry, targetName: string, partnerAvatar?: string): string {
  const isIncoming = entry.direction === "in";
  const actionsHtml =
    !isIncoming && entry.state === "sent" && entry.messageId
      ? `<div class="ov-dc-bubble-actions"><button class="ov-dc-bubble-act-btn" data-ov="discord-edit" data-entry="${entry.id}" title="${esc(t("overlay.discordEdit"))}">${icon("edit", 12)}</button><button class="ov-dc-bubble-act-btn is-danger" data-ov="discord-delete" data-entry="${entry.id}" title="${esc(t("overlay.discordDelete"))}">${icon("trash", 12)}</button></div>`
      : "";
  const statusMeta =
    isIncoming
      ? ""
      : entry.state === "sending"
        ? `<span class="ov-dc-msg-status sending">${esc(t("overlay.discordSending"))}</span>`
        : entry.state === "error"
          ? `<button class="ov-dc-msg-retry" data-ov="discord-retry" data-entry="${entry.id}">${esc(t("overlay.discordRetry"))}</button>`
          : "";
  const errorBadge = entry.state === "error"
    ? `<div class="ov-dc-msg-error-label">${esc(t("overlay.discordNotDelivered"))}</div>`
    : "";
  const attachment = entry.attachment
    ? `<div class="ov-dc-msg-attachment">${icon("clipboard", 12)} <span>${esc(entry.attachment)}</span></div>`
    : "";

  const hasText = Boolean(entry.text && entry.text.trim().length > 0);
  const textHtml = hasText
    ? `<div class="ov-dc-bubble-text">${esc(entry.text)}</div>`
    : "";

  const metaHtml = `<div class="ov-dc-bubble-meta"><span class="ov-dc-bubble-time num">${esc(entry.time)}</span>${statusMeta}</div>`;
  const avatarHtml = isIncoming
    ? `<div class="ov-dc-bubble-avatar-wrap" title="${esc(targetName)}">${partnerAvatar ? `<img class="ov-dc-bubble-avatar" src="${esc(partnerAvatar)}" alt="" />` : `<div class="ov-dc-bubble-avatar placeholder">${icon("user", 12)}</div>`}</div>`
    : "";
  const bubbleClasses = `ov-dc-bubble${entry.state === "error" ? " is-failed" : ""}`;

  return `<div class="ov-dc-bubble-row ${isIncoming ? "incoming" : "outgoing"}">${avatarHtml}<div class="${bubbleClasses}">${actionsHtml}${textHtml}${attachment}${errorBadge}${metaHtml}</div></div>`;
}

function chatComposerHtml(target: { id: string; name: string }, draft: string, editing: ReplyLogEntry | null): string {
  const placeholder = editing
    ? `${t("overlay.discordEdit")} · ${target.name}`
    : t("overlay.discordReplyTo", { name: target.name });
  const sendLabel = editing ? t("overlay.discordSave") : t("overlay.discordSend");
  const sendAction = editing ? "discord-edit-save" : "discord-send";

  return `
    <div class="ov-dc-composer-wrap">
      ${editing ? `
        <div class="ov-dc-editing-banner">
          <span>${icon("edit", 12)} ${esc(t("overlay.discordEdit"))}</span>
          <button class="ov-dc-edit-cancel-btn" data-ov="discord-edit-cancel">${icon("x", 12)}</button>
        </div>
      ` : ""}
      <div class="ov-dc-composer-input-row">
        <textarea
          id="ov-discord-reply-input"
          class="ov-dc-composer-input"
          placeholder="${esc(placeholder)}"
          rows="1"
          spellcheck="false"
        >${esc(draft)}</textarea>
        <button
          class="ov-dc-send-btn ${replySending ? "is-sending" : ""}"
          data-ov="${sendAction}"
          ${replySending ? "disabled" : ""}
          title="${esc(sendLabel)}"
        >
          ${icon("arrow-right", 15)}
        </button>
      </div>
      <div class="ov-dc-composer-hints">
        <span><kbd class="kbd">Enter</kbd> ${esc(t("overlay.discordSend"))} · <kbd class="kbd">Shift+Enter</kbd> ${esc(t("overlay.discordNewLine"))}</span>
      </div>
    </div>`;
}

/** Before the session exists: one clear way in, never a dead end. */
function connectHtml(): string {
  const failed = sdkState.status === "error";
  return `
    <div class="empty-conv-wrap">
      <div class="empty-conv-title">${esc(t("overlay.discordConnect"))}</div>
      <p class="empty-conv-desc">${esc(failed ? sdkState.error || t("common.unknownError") : t("overlay.discordSdkDesc"))}</p>
      <button class="connect-button" data-ov="discord-sdk-start">${icon("discord", 14)} ${esc(t("overlay.discordConnect"))}</button>
    </div>`;
}

/* --- SDK calls the tab drives --- */

/** Fetches the SDK session and its relationship list, so the panel paints at once. */
async function refreshSdkState(): Promise<void> {
  try {
    const state = await invoke<SdkState>("discord_sdk_state");
    if (state) sdkState = state;
    const friends = await invoke<DiscordFriendsState>("discord_sdk_friends");
    if (friends) sdkFriends = friends;
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  } catch {
    // Older hosts have no Social SDK commands; the other sources stay.
  }
}

async function startDiscordSdk(): Promise<void> {
  sdkState = { ...sdkState, status: "starting", error: null };
  renderDiscord();
  try {
    await invoke("discord_sdk_start", { silent: false });
  } catch (error) {
    sdkState = { ...sdkState, status: "error", error: String(error) };
    renderDiscord();
  }
}

/** Sends the draft. The outcome arrives on `discord-sdk-dm` and lands in the
 * log, so the typed text is only cleared once the host accepted the call. */
async function sendDiscordReply(): Promise<void> {
  const target = replyTarget;
  const input = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const text = (input?.value ?? (target ? replyDrafts.get(target.id) ?? "" : "")).trim();
  if (!target || !text || replySending) return;
  replySending = true;
  replyDrafts.set(target.id, "");
  replyLog.push({
    id: ++replyLogSeq,
    friendId: target.id,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    text,
    state: "sending",
    direction: "out",
  });
  if (replyLog.length > 400) replyLog.splice(0, replyLog.length - 400);
  renderDiscord();
  focusReplyInput();
  try {
    await invoke("discord_sdk_send_dm", { userId: target.id, text });
  } catch (error) {
    const entry = [...replyLog].reverse().find((item) => item.state === "sending");
    if (entry) {
      entry.state = "error";
      entry.error = String(error);
    }
    replySending = false;
    repaintDiscord();
  }
}

/** Retries a failed log row in place. */
async function retryReply(entryId: number): Promise<void> {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || entry.state !== "error") return;
  entry.state = "sending";
  entry.error = undefined;
  repaintDiscord();
  try {
    await invoke("discord_sdk_send_dm", { userId: entry.friendId, text: entry.text });
  } catch (error) {
    entry.state = "error";
    entry.error = String(error);
    repaintDiscord();
  }
}

/** Deletes a message this overlay sent; the row goes when Discord confirms. */
async function deleteReply(entryId: number): Promise<void> {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || !entry.messageId) return;
  const button = document.querySelector<HTMLButtonElement>(
    `[data-ov="discord-delete"][data-entry="${entryId}"]`,
  );
  if (button) button.disabled = true;
  try {
    await invoke("discord_sdk_delete_dm", {
      userId: entry.friendId,
      messageId: entry.messageId,
    });
  } catch (error) {
    if (button) button.disabled = false;
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Puts a sent message back in the composer to rewrite it; the compose draft
 * waits in the stash so nothing is lost if the edit is cancelled. */
function startEdit(entryId: number): void {
  const entry = replyLog.find((item) => item.id === entryId);
  if (!entry || entry.direction !== "out" || !entry.messageId) return;
  editingEntryId = entry.id;
  editStash.set(entry.friendId, replyDrafts.get(entry.friendId) ?? "");
  replyDrafts.set(entry.friendId, entry.text);
  renderDiscord();
  focusReplyInput();
}

/** Leaves edit mode and brings the compose draft back. */
function cancelEdit(): void {
  const entry = replyLog.find((item) => item.id === editingEntryId);
  editingEntryId = null;
  if (entry) {
    replyDrafts.set(entry.friendId, editStash.get(entry.friendId) ?? "");
    editStash.delete(entry.friendId);
  }
  renderDiscord();
}

/** Saves the edit through the SDK; the row updates when Discord confirms. */
async function saveEdit(): Promise<void> {
  const entry = replyLog.find((item) => item.id === editingEntryId);
  const input = document.getElementById("ov-discord-reply-input") as HTMLTextAreaElement | null;
  const text = (input?.value ?? "").trim();
  if (!entry || !entry.messageId || !text) return;
  const button = document.querySelector<HTMLButtonElement>('[data-ov="discord-edit-save"]');
  if (button) button.disabled = true;
  try {
    await invoke("discord_sdk_edit_dm", {
      userId: entry.friendId,
      messageId: entry.messageId,
      text,
    });
  } catch (error) {
    if (button) button.disabled = false;
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Sets the account's own Discord status. */
async function setDiscordStatus(status: string): Promise<void> {
  try {
    await invoke("discord_sdk_set_status", { status });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Calls a friend over their DM channel (the SDK's own call). */
async function startDiscordCall(friendId: string): Promise<void> {
  try {
    await invoke("discord_sdk_call", { userId: friendId });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Ends the call the overlay started. */
async function endDiscordCall(): Promise<void> {
  try {
    await invoke("discord_sdk_hangup");
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Mutes (or unmutes) the call's microphone. */
async function muteDiscordCall(mute: boolean): Promise<void> {
  try {
    await invoke("discord_sdk_call_mute", { mute });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Accepts or rejects an incoming friend request; the list refreshes itself
 * when the SDK reports the relationship change. */
async function answerFriendRequest(friendId: string, accept: boolean): Promise<void> {
  try {
    await invoke("discord_sdk_friend_request", { userId: friendId, accept });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Runs the username search through the SDK; results arrive on the event. */
function runUserSearch(): void {
  const input = document.getElementById("ov-discord-search") as HTMLInputElement | null;
  const query = (input?.value ?? searchQuery).trim();
  if (!query) return;
  searchQuery = query;
  searchRan = false;
  void invoke("discord_sdk_search_users", { query }).catch((error) => {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  });
}

/** Sends a friend request to the picked username. */
async function addFriend(username: string): Promise<void> {
  try {
    await invoke("discord_sdk_add_friend", { username });
  } catch (error) {
    toast(t("overlay.discordSendFailed", { error: String(error) }), "err");
  }
}

/** Fetches the web page's last voice report, so the card paints immediately. */
async function refreshWebVoice(): Promise<void> {
  try {
    const state = await invoke<WebVoiceState | null>("discord_web_voice_state");
    if (state) {
      webVoice = state;
      if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
    }
  } catch {
    // Older hosts have no web voice bridge; the RPC source stays.
  }
}

/** The web client's call, shaped like an RPC read. */
function webVoiceAsState(): { channel: VoiceChannel; people: VoiceParticipant[] } | null {
  const web = webVoice;
  if (!web || !web.inCall || !web.channel) return null;
  return {
    channel: { id: web.channel.id, name: web.channel.name, guildId: web.channel.guild || null },
    people: web.participants.map((person) => ({
      id: person.id,
      name: person.name,
      avatarUrl: person.avatarUrl,
      speaking: person.speaking,
      muted: person.muted,
    })),
  };
}

/** The voice state the tab shows: the live desktop read, the launcher's own
 * web client, then the last known channel while (re)connecting. */
function voiceDisplay(): { channel: VoiceChannel; people: VoiceParticipant[]; stale: boolean } | null {
  const state = voiceState;
  const busy = state.status === "connecting" || state.status === "error";
  const web = webVoiceAsState();
  const live = state.channel ? { channel: state.channel, people: state.participants } : null;
  const display =
    live ??
    web ??
    (busy && lastVoiceChannel ? { channel: lastVoiceChannel, people: lastVoiceParticipants } : null);
  if (!display) return null;
  return { channel: display.channel, people: display.people, stale: !live && !web };
}
/* 9. Settings View */
function renderSettings(): void {
  const el = viewEl("settings");
  if (!el) return;
  // The capture-off list lives in Rust (the hotkey listener reads it): pull it
  // once, then paint the per-game row from it.
  if (!overlayDisabledGamesFetched) {
    overlayDisabledGamesFetched = true;
    void epicGetScreenshotDisabledGames()
      .then((list) => {
        overlayDisabledGames = Array.isArray(list) ? list : [];
        if (isWidgetOpen("settings")) renderSettings();
      })
      .catch(() => undefined);
  }
  const enabled = localStorage.getItem(ENABLED_KEY) !== "false";
  const hud = localStorage.getItem(HUD_KEY) === "true";
  const opacity = Number(localStorage.getItem(OPACITY_KEY) ?? "100");
  const disabled = isDisabledGame(context.appName);
  const disabledList = disabledGames();
  const hp = getHomepage();
  const isPresetHp = ["https://www.google.com/", "https://duckduckgo.com/", "https://www.bing.com/", "https://yandex.com/"].includes(hp);

  el.innerHTML = `
    <div class="ov-settings-wrap">
      <!-- Section: General -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("sliders", 13)}
          <span>${esc(t("overlay.settingsGeneral"))}</span>
        </header>
        <div class="ov-settings-group">
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
        </div>
      </section>

      <!-- Section: Appearance -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("monitor", 13)}
          <span>${esc(t("overlay.settingsAppearance"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.clockSecondsTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.clockSecondsDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="clock-seconds" ${showClockSeconds() ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.batteryPercentTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.batteryPercentDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="battery-percent" ${showBatteryPercent() ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.opacityTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.opacityDesc"))}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <input type="range" min="60" max="100" step="1" value="${opacity}" data-ov-opacity style="width:130px" />
              <span id="ov-opacity-val" style="font-variant-numeric: tabular-nums; font-size: 12px; color: var(--text-2); min-width: 34px; text-align: right;">${opacity}%</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Screenshots (the launcher's settings, kept in step) -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("camera", 13)}
          <span>${esc(t("settings.screenshotsTitle"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("ss.sortTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("ss.sortDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${([["newest", "ss.sortNewest"], ["oldest", "ss.sortOldest"], ["name", "ss.sortName"], ["size", "ss.sortSize"]] as const)
                .map(
                  ([value, key]) =>
                    `<button class="${ssSort() === value ? "active" : ""}" data-ov="ss-sort" data-sort="${value}">${esc(t(key))}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("ss.densityTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("ss.densityDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${([["s", "ss.densitySmall"], ["m", "ss.densityMedium"], ["l", "ss.densityLarge"]] as const)
                .map(
                  ([value, key]) =>
                    `<button class="${ssDensity() === value ? "active" : ""}" data-ov="ss-density" data-density="${value}">${esc(t(key))}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("ss.soundTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("ss.soundDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ss-sound" ${ssSoundOn() ? "checked" : ""} /><span class="track"></span></label>
          </div>
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("ss.notifyTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("ss.notifyDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ss-notify" ${ssNotifyOn() ? "checked" : ""} /><span class="track"></span></label>
          </div>
          ${
            !launcherMode && context.appName
              ? `<div class="ov-setting-item">
                  <div class="ov-setting-info">
                    <div class="ov-setting-name">${esc(t("ss.gameCaptureOff"))}</div>
                    <div class="ov-setting-desc">${esc(t("ss.gameCaptureTip"))}</div>
                  </div>
                  <label class="switch"><input type="checkbox" data-ov-toggle="ss-capture-game" ${overlayDisabledGames.includes(context.appName) ? "checked" : ""} /><span class="track"></span></label>
                </div>`
              : ""
          }
        </div>
      </section>

      <!-- Section: Notes (the Notes page's settings, kept in step) -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("edit", 13)}
          <span>${esc(t("settings.secNotes"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("notes.fontSize"))}</div>
              <div class="ov-setting-desc">${esc(t("notes.fontSizeDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${(["s", "m", "l"] as const)
                .map(
                  (size) =>
                    `<button class="${notesFontSize() === size ? "active" : ""}" data-ov="ov-note-font" data-size="${size}">${esc(t(size === "s" ? "notes.fontSmall" : size === "m" ? "notes.fontMedium" : "notes.fontLarge"))}</button>`,
                )
                .join("")}
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Browser -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("globe", 13)}
          <span>${esc(t("overlay.settingsBrowser"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item" style="flex-direction:column;align-items:stretch;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
              <div class="ov-setting-info">
                <div class="ov-setting-name">${esc(t("overlay.browserHomepageTitle"))}</div>
                <div class="ov-setting-desc">${esc(t("overlay.browserHomepageDesc"))}</div>
              </div>
              <select class="input select small" id="ov-setting-browser-hp-select" style="min-width:130px">
                <option value="https://www.google.com/" ${hp === "https://www.google.com/" ? "selected" : ""}>Google</option>
                <option value="https://duckduckgo.com/" ${hp === "https://duckduckgo.com/" ? "selected" : ""}>DuckDuckGo</option>
                <option value="https://www.bing.com/" ${hp === "https://www.bing.com/" ? "selected" : ""}>Bing</option>
                <option value="https://yandex.com/" ${hp === "https://yandex.com/" ? "selected" : ""}>Yandex</option>
                <option value="custom" ${!isPresetHp ? "selected" : ""}>${esc(t("overlay.browserCustomUrl"))}</option>
              </select>
            </div>
            <input type="text" class="input small" id="ov-setting-browser-hp-custom" value="${esc(hp)}" placeholder="https://..." style="${isPresetHp ? "display:none;" : ""}width:100%" />
          </div>

          <div class="ov-setting-item" style="flex-direction:column;align-items:stretch;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div class="ov-setting-info">
                <div class="ov-setting-name">${esc(t("overlay.browserBookmarksTitle"))}</div>
                <div class="ov-setting-desc">${esc(t("overlay.browserBookmarksDesc"))}</div>
              </div>
              <button class="btn ghost small" data-ov="reset-browser-bookmarks" title="${esc(t("overlay.browserBookmarkReset"))}" style="flex-shrink:0">
                ${icon("refresh", 12)}
                <span>${esc(t("overlay.browserBookmarkReset"))}</span>
              </button>
            </div>

            <!-- Add Bookmark Form -->
            <div class="ov-bm-form">
              <input type="text" class="input small" id="ov-add-bm-label" placeholder="${esc(t("overlay.browserBookmarkLabel"))}" />
              <input type="text" class="input small" id="ov-add-bm-url" placeholder="${esc(t("overlay.browserBookmarkUrl"))}" />
              <button class="btn primary small" data-ov="add-browser-bookmark">
                ${icon("plus", 13)}
                <span>${esc(t("overlay.browserBookmarkAdd"))}</span>
              </button>
            </div>

            <!-- Bookmarks List -->
            <div class="ov-bm-list">
              ${loadBookmarks().map((bm, idx) => `
                <div class="ov-bm-item">
                  <div style="display:flex;align-items:center;gap:9px;overflow:hidden;flex:1;margin-right:8px">
                    <span class="ov-bm-icon-pill">${icon(bm.iconName || "globe", 13)}</span>
                    <div style="display:flex;flex-direction:column;min-width:0;overflow:hidden">
                      <span style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(bm.label)}</span>
                      <span style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace">${esc(bm.url)}</span>
                    </div>
                  </div>
                  <button class="btn ghost small danger" data-ov="delete-browser-bookmark" data-index="${idx}" title="${esc(t("common.delete"))}" style="padding:4px 6px">
                    ${icon("trash", 12)}
                  </button>
                </div>
              `).join("")}
            </div>
          </div>
        </div>
      </section>

      <!-- Section: Game Settings -->
      ${!launcherMode && context.appName ? `
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("gamepad-2", 13)}
          <span>${esc(t("overlay.settingsGame"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.disableTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.disableDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="disable-game" ${disabled ? "checked" : ""} /><span class="track"></span></label>
          </div>
        </div>
      </section>` : ""}

      ${disabledList.length > 0 ? `
      <section class="ov-settings-section">
        <div class="ov-card">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(t("overlay.disabledListTitle"))}</div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">${esc(t("overlay.disabledListDesc"))}</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${disabledList.map((g) => `
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:13px">${esc(g.title)}</span>
                <button class="btn ghost small" data-ov="restore-game" data-key="${esc(g.key)}">${esc(t("overlay.restore"))}</button>
              </div>`).join("")}
          </div>
        </div>
      </section>` : ""}
    </div>
  `;
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
  const items = getVisibleScreenshots();
  lightboxIndex = items.findIndex((item) => item.data_url === src);
  img.src = src;
  if (counter) {
    if (lightboxIndex >= 0 && items.length > 1) {
      const g = items[lightboxIndex].game_title ? `${items[lightboxIndex].game_title} • ` : "";
      counter.textContent = `${g}${lightboxIndex + 1} / ${items.length}`;
    } else {
      counter.textContent = items[lightboxIndex]?.game_title || "";
    }
  }
  box.style.display = "grid";
}

/** Steps through the screenshots while the lightbox is open (LB/RB, arrows). */
function stepLightbox(delta: number): void {
  const items = getVisibleScreenshots();
  if (lightboxIndex < 0 || items.length === 0) return;
  lightboxIndex = (lightboxIndex + delta + items.length) % items.length;
  const img = document.getElementById("ov-lightbox-img") as HTMLImageElement | null;
  const counter = document.getElementById("ov-lightbox-counter");
  if (img) img.src = items[lightboxIndex].data_url;
  if (counter) {
    const g = items[lightboxIndex].game_title ? `${items[lightboxIndex].game_title} • ` : "";
    counter.textContent = `${g}${lightboxIndex + 1} / ${items.length}`;
  }
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
      setWidgetPinned(tab, !isWidgetPinned(tab));
      return;
    }

    // Perf metric selection card/chip
    const perfMetricBtn = target.closest<HTMLElement>("[data-perf-metric]");
    if (perfMetricBtn?.dataset.perfMetric) {
      activePerfMetric = perfMetricBtn.dataset.perfMetric as PerfMetric;
      document.querySelectorAll<HTMLElement>("[data-perf-metric]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.perfMetric === activePerfMetric);
      });
      updateMetricsUi();
      return;
    }

    // Screenshot game category filter row (toggle checkbox)
    const filterRow = target.closest<HTMLElement>("[data-ov-filter-game]");
    if (filterRow?.dataset.ovFilterGame) {
      const g = filterRow.dataset.ovFilterGame;
      if (g === "all") {
        selectedGameFilters.clear();
      } else {
        const lower = g.toLowerCase();
        if (selectedGameFilters.has(lower)) {
          selectedGameFilters.delete(lower);
        } else {
          selectedGameFilters.add(lower);
        }
      }
      void loadScreenshots();
      return;
    }

    // Close screenshots filter popover when clicking outside
    if (filterPopoverOpen && !target.closest(".ov-shots-filter-wrapper")) {
      filterPopoverOpen = false;
      const pop = document.getElementById("ov-shots-filter-popover");
      if (pop) pop.classList.remove("open");
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
      filterPopoverOpen = !filterPopoverOpen;
      const pop = document.getElementById("ov-shots-filter-popover");
      if (pop) pop.classList.toggle("open", filterPopoverOpen);
      return;
    } else if (action === "shots-filter-clear") {
      selectedGameFilters.clear();
      void loadScreenshots();
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
      overlayShotsFavoritesOnly = !overlayShotsFavoritesOnly;
      void loadScreenshots();
      return;
    } else if (action === "shots-sort-cycle") {
      const order = ssSort();
      const next = order === "newest" ? "oldest" : order === "oldest" ? "name" : order === "name" ? "size" : "newest";
      localStorage.setItem(SS_SORT_KEY, next);
      void loadScreenshots();
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
      friendsFilterQuery = "";
      renderDiscordSocial();
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
      const mode = target.closest<HTMLElement>("[data-ov]")?.dataset.mode as
        | PickerMode
        | undefined;
      pickerMode = mode ?? "friends";
      repaintDiscord();
      if (pickerMode === "add") {
        requestAnimationFrame(() => document.getElementById("ov-discord-search")?.focus());
      }
    } else if (action === "discord-call-start") {
      const friendId = target.closest<HTMLElement>("[data-ov]")?.dataset.id;
      if (friendId) void startDiscordCall(friendId);
    } else if (action === "discord-call-end") {
      void endDiscordCall();
    } else if (action === "discord-call-mute") {
      void muteDiscordCall(!callState.muted);
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
    } else if (action === "restore-game") {
      const key = target.closest<HTMLElement>("[data-ov]")?.dataset.key;
      if (key) {
        saveDisabled(disabledGames().filter((g) => g.key !== key));
        renderSettings();
      }
    } else if (action === "media-toggle" || action === "sp-toggle") {
      if (spotifyNow) void overlaySpotifyControl(spotifyNow.isPlaying ? "pause" : "play");
    } else if (action === "media-prev" || action === "sp-prev") {
      if (spotifyNow) void overlaySpotifyControl("previous");
    } else if (action === "media-next" || action === "sp-next") {
      if (spotifyNow) void overlaySpotifyControl("next");
    } else if (action === "sp-shuffle") {
      void overlaySpotifyControl("shuffle", spotifyNow?.shuffle ? 0 : 1);
    } else if (action === "sp-repeat") {
      const next = spotifyNow?.repeat === "off" ? 1 : spotifyNow?.repeat === "context" ? 2 : 0;
      void overlaySpotifyControl("repeat", next);
    } else if (action === "sp-seek") {
      const bar = document.getElementById("ov-sp-progress");
      const m = getOverlayMedia();
      if (bar && m.durationMs && m.canSeek) {
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        void overlaySpotifyControl("seek", Math.round(ratio * m.durationMs));
      }
    } else if (action === "sp-engine-start") {
      ensureSpotifyEngine();
    } else if (action === "sp-toggle-mini-view") {
      spotifyMiniView = spotifyMiniView === "player" ? "library" : "player";
      updateMusicMiniViewState();
    } else if (action === "sp-tab-playlists" || action === "sp-back-playlists") {
      setMusicViewMode("playlists");
    } else if (action === "sp-tab-tracks" || action === "sp-show-tracks") {
      setMusicViewMode("tracks");
    } else if (action === "sp-toggle-search") {
      spotifySearchOpen = !spotifySearchOpen;
      if (!spotifySearchOpen) spotifySearchQuery = "";
      const header = document.getElementById("ov-sp-library-header");
      if (header) header.innerHTML = libraryTabsHtml();
      if (musicViewMode === "playlists") renderPlaylistList();
      else renderTrackList();
      if (spotifySearchOpen) {
        window.setTimeout(() => document.getElementById("ov-sp-search-input")?.focus(), 50);
      }
    } else if (action === "sp-clear-search") {
      spotifySearchQuery = "";
      const header = document.getElementById("ov-sp-library-header");
      if (header) header.innerHTML = libraryTabsHtml();
      if (musicViewMode === "playlists") renderPlaylistList();
      else renderTrackList();
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
    } else if (toggle === "clock-seconds") {
      localStorage.setItem(CLOCK_SECONDS_KEY, String(input.checked));
      updateClock();
    } else if (toggle === "battery-percent") {
      localStorage.setItem(BATTERY_PERCENT_KEY, String(input.checked));
      paintBattery();
    } else if (toggle === "ss-sound") {
      localStorage.setItem(SS_SOUND_KEY, String(input.checked));
    } else if (toggle === "ss-notify") {
      localStorage.setItem(SS_NOTIFY_KEY, String(input.checked));
    } else if (toggle === "ss-capture-game") {
      const key = context.appName;
      if (key) {
        const next = input.checked
          ? [...new Set([...overlayDisabledGames, key])]
          : overlayDisabledGames.filter((item) => item !== key);
        overlayDisabledGames = next;
        void epicSetScreenshotDisabledGames(next).catch(() => undefined);
      }
    } else if (toggle === "disable-game") {
      // The panel over the launcher/desktop is not a game: blocking it would
      // hide the overlay from the only place its blocklist can be edited.
      if (launcherMode) {
        input.checked = false;
        return;
      }
      const next = input.checked
        ? [...disabledGames().filter((i) => i.key !== context.appName), { key: context.appName, title: context.title || context.appName }]
        : disabledGames().filter((i) => i.key !== context.appName);
      saveDisabled(next);
      if (input.checked) void invoke("overlay_hide");
    } else if (input.id === "ov-setting-browser-hp-select") {
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
      searchQuery = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-dc-friends-filter") {
      friendsFilterQuery = target.value;
      repaintFriendsList();
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "ov-sp-search-input") {
      spotifySearchQuery = target.value;
      if (musicViewMode === "playlists") renderPlaylistList();
      else renderTrackList();
      return;
    }
    if (target instanceof HTMLTextAreaElement && target.id === "ov-discord-reply-input") {
      if (replyTarget) replyDrafts.set(replyTarget.id, target.value);
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
    if (event.key === "Escape" && filterPopoverOpen) {
      filterPopoverOpen = false;
      const pop = document.getElementById("ov-shots-filter-popover");
      if (pop) pop.classList.remove("open");
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
      if (editingEntryId !== null) void saveEdit();
      else void sendDiscordReply();
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
      if (row?.dataset.ov === "discord-reply" && row.dataset.id) {
        event.preventDefault();
        selectReplyTarget(row.dataset.id, row.dataset.name || row.dataset.id, event.key);
        return;
      }
    }
    if (isTextEntryFocused()) {
      // Esc leaves the box back to the friend row first; the next Esc closes.
      // While editing, it cancels the edit and brings the compose draft back.
      if (event.key === "Escape") {
        if (editingEntryId !== null) {
          cancelEdit();
          focusReplyInput();
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
    gamepadSuppressUntil = performance.now() + 450;
    startOverlayLoops();
    startClipPolling();
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

  push(document.getElementById("ov-topbar-game-hub-btn"));
  document.querySelectorAll(".ov-topbar-btn").forEach(push);

  document.querySelectorAll<HTMLElement>(".ov-widget").forEach((w) => {
    if (w.style.display !== "none") {
      w.querySelectorAll<HTMLElement>(
        "button, [data-ov-preview], [data-nav-row], .ov-card[data-nav-target], textarea, input",
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
  const currentIdx = tabs.findIndex((tab) => tab.id === activeTab);
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
  if (gamepadRaf === null && !document.hidden) {
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
  if (document.hidden) return;

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
  if (mediaPollTimer === null) {
    mediaPollTimer = window.setInterval(() => {
      if (!document.hidden && isWidgetOpen("music")) void refreshMedia();
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

async function onOpen(payload: OpenPayload): Promise<void> {
  // The overlay page outlives a Settings language change: pull the current
  // language on every open so no widget shows the previous one.
  await setLanguage(initialLanguage()).catch(() => undefined);
  context = payload;
  metrics = null;
  fpsHistory = [];
  cpuHistory = [];
  gpuHistory = [];
  vramHistory = [];
  ramHistory = [];
  cachedAchievements = null;
  cachedScreenshots = [];
  spotifyEngineOn = false;
  spotifyDeviceName = "";
  spotifyNow = null;
  spotifyBaseMs = 0;
  spotifyBaseAt = 0;
  lastMediaActive = false;
  if (!selectedPlaylist) {
    musicViewMode = "playlists";
  }
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
  applyOpacity(Number(localStorage.getItem(OPACITY_KEY) ?? "100"));

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
    }
  }

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

  // Preload achievements and screenshots
  const { store } = splitKey(context.appName);
  if (context.appName && store !== "game") {
    if (openWidgets.has("ach")) void loadAchievements();
    if (openWidgets.has("shots")) void loadScreenshots();
  }

  // The receiver starts only when the music widget is opened; opening the
  // panel for performance or captures must not start a Spotify session.
  if (isWidgetOpen("music")) ensureSpotifyEngine();
  void refreshMedia();

  // A connected pad means the user wants controller affordances right away.
  const pad = navigator.getGamepads ? navigator.getGamepads().find((p) => p && p.connected) : undefined;
  if (pad) {
    document.body.classList.add("ov-using-gamepad");
    focusDefault();
  }
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

  startOverlayLoops();

  await listen<OpenPayload>("overlay-open", (event) => {
    startOverlayLoops();
    startClipPolling();
    void onOpen(event.payload);
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
    hideLightbox();
    removeGamepadFocus();
    document.body.classList.remove("ov-using-gamepad");
    stopOverlayLoops();
    stopClipPolling();
    void invoke("overlay_browser_close").catch(() => undefined);
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

  await listen<MetricsSample>("overlay-metrics", (event) => {
    metrics = event.payload;

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
  });

  await listen<DiscordVoiceState>("discord-voice-state", (event) => {
    voiceState = event.payload;
    if (voiceState.status === "ready" && voiceState.channel) {
      lastVoiceChannel = voiceState.channel;
      lastVoiceParticipants = voiceState.participants;
    } else if (voiceState.status === "idle") {
      lastVoiceChannel = null;
      lastVoiceParticipants = [];
    }
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  await listen<DiscordFriendsState>("discord-friends-state", (event) => {
    friendsState = event.payload;
    if (friendsState.status === "ready") {
      lastFriends = friendsState.friends;
      lastFriendsPending = friendsState.pending;
    } else if (friendsState.status === "idle") {
      lastFriends = [];
      lastFriendsPending = 0;
    }
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  await listen<WebVoiceState>("discord-web-voice", (event) => {
    webVoice = event.payload;
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  await listen<SdkState>("discord-sdk-state", (event) => {
    sdkState = event.payload;
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  await listen<DiscordFriendsState>("discord-sdk-friends", (event) => {
    sdkFriends = event.payload;
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  // The send outcome lands in the log row: "Sending…" becomes "Sent", or the
  // row turns into a retry, so a failed message is never silently lost. The
  // message id is what delete and open-in-launcher need later.
  await listen<{ userId: string; ok: boolean; messageId?: string; error?: string }>("discord-sdk-dm", (event) => {
    replySending = false;
    const entry = [...replyLog]
      .reverse()
      .find((item) => item.friendId === event.payload.userId && item.state === "sending");
    if (entry) {
      entry.state = event.payload.ok ? "sent" : "error";
      entry.error = event.payload.error;
      if (event.payload.messageId) entry.messageId = event.payload.messageId;
    }
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
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
    const before = replyLog.length;
    replyLog = replyLog.filter((item) => item.messageId !== event.payload.messageId);
    if (replyLog.length !== before && isWidgetOpen("discord") && !document.hidden) {
      repaintDiscord();
    }
  });

  await listen<{ userId: string; messageId: string; ok: boolean; error?: string }>(
    "discord-sdk-dm-deleted",
    (event) => {
      // Success removes the row through the deleted event; a failure has to say
      // so, otherwise the button would look like it did nothing.
      if (event.payload.ok) return;
      toast(t("overlay.discordSendFailed", { error: event.payload.error || "" }), "err");
      const button = document.querySelector<HTMLButtonElement>(
        '[data-ov="discord-delete"]',
      );
      if (button) button.disabled = false;
    },
  );

  // The DM call the overlay started: active, muted, ended.
  await listen<{ state: string; friendId: string; muted: boolean; error?: string | null }>(
    "discord-sdk-call",
    (event) => {
      const active = event.payload.state === "active";
      callState = {
        active,
        friendId: active ? event.payload.friendId : null,
        muted: event.payload.muted,
      };
      if (!active && event.payload.error) {
        toast(t("overlay.discordSendFailed", { error: event.payload.error }), "err");
      }
      if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
    },
  );

  // The status takeover closes itself on success; the chip takes the new dot
  // (the social graph is re-read by the worker).
  await listen<{ status: string; ok: boolean; error?: string }>("discord-sdk-status-done", (event) => {
    if (!event.payload.ok) {
      toast(t("overlay.discordSendFailed", { error: event.payload.error || "" }), "err");
      return;
    }
    pickerMode = "friends";
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  // The add-friend search: results, and the request outcome.
  await listen<{ query: string; users: { id: string; name: string; username: string; avatarUrl: string }[] }>(
    "discord-sdk-search",
    (event) => {
      if (event.payload.query !== searchQuery) return;
      searchResults = event.payload.users;
      searchRan = true;
      if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
    },
  );

  await listen<{ username: string; ok: boolean; error?: string }>("discord-sdk-request-sent", (event) => {
    if (!event.payload.ok) {
      toast(t("overlay.discordSendFailed", { error: event.payload.error || "" }), "err");
      return;
    }
    toast(t("overlay.discordRequestSent"), "");
    // Keep the row and mark it: a row that vanishes reads as "nothing happened".
    sentRequests.add(event.payload.username);
    if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
  });

  // A friend request answered: the row goes at once, and the relationship
  // callback re-reads the list from Discord shortly after.
  await listen<{ userId: string; accept: boolean; ok: boolean; error?: string }>(
    "discord-sdk-request-done",
    (event) => {
      if (!event.payload.ok) {
        toast(t("overlay.discordSendFailed", { error: event.payload.error || "" }), "err");
        return;
      }
      sdkFriends = {
        ...sdkFriends,
        pendingUsers: (sdkFriends.pendingUsers ?? []).filter(
          (item) => item.id !== event.payload.userId,
        ),
        pending: Math.max(0, sdkFriends.pending - 1),
      };
      if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
    },
  );

  // The edit result: the row takes the new text, and the composer goes back to
  // writing (the compose draft returns from the stash).
  await listen<{ userId: string; messageId: string; text?: string; ok: boolean; error?: string }>(
    "discord-sdk-dm-edited",
    (event) => {
      const entry = replyLog.find((item) => item.messageId === event.payload.messageId);
      if (!event.payload.ok) {
        toast(t("overlay.discordSendFailed", { error: event.payload.error || "" }), "err");
        const button = document.querySelector<HTMLButtonElement>('[data-ov="discord-edit-save"]');
        if (button) button.disabled = false;
        return;
      }
      if (entry) {
        if (event.payload.text) entry.text = event.payload.text;
        if (entry.id === editingEntryId) {
          editingEntryId = null;
          replyDrafts.set(entry.friendId, editStash.get(entry.friendId) ?? "");
          editStash.delete(entry.friendId);
        }
      }
      if (isWidgetOpen("discord") && !document.hidden) repaintDiscord();
    },
  );

  // The SDK resumes its sealed session in the background: after the first
  // approval the panel is connected before it is ever opened, and messages
  // that arrive meanwhile are already in the log. A first-time user gets the
  // Connect button instead of an unasked prompt.
  void invoke("discord_sdk_start", { silent: true }).catch(() => undefined);
  ensureSpotifyEngine();

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

// The notes wiring lives outside boot: boot's `listen` awaits abort in a
// browser (no Tauri), and the notes migration and repaint hook must not depend
// on those succeeding.
void ensureNotesMigration();
onNotesChanged(() => refreshOverlayNotes());
setOverlayNotesSettingsRepaint(() => {
  if (isWidgetOpen("settings")) renderSettings();
});
