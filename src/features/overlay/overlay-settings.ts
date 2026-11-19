/**
 * Overlay Settings view: general switches, achievements/notifications,
 * appearance, HUD, crosshair, capture and browser bookmarks.
 *
 * One-way dependency: this module imports core helpers and receives the
 * overlay-owned state (context, disabled games, widget queries) through
 * SettingsDeps. It never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { getHomepage, loadBookmarks } from "./browser-shared";
import {
  applyHudConfig,
  loadHudConfig,
  saveHudConfig,
  type HudConfig,
  type HudCorner,
  type HudMode,
} from "./overlay-hud-config";
import { OVERLAY_ENABLED_KEY, OVERLAY_HUD_KEY, SS_NOTIFY_KEY, SS_SOUND_KEY } from "../../core/constants";
import {
  CROSSHAIR_HOTKEYS,
  applyCrosshairConfig,
  loadCrosshair,
  sanitizeCrosshair,
  saveCrosshair,
  setCrosshairVisible,
  type CrosshairConfig,
} from "../../core/crosshair";
import { IS_WINDOWS } from "../../core/platform";
import { overlayHotkeyLabel } from "../../core/page-visibility";
import { achievementGetNotificationOptions, achievementSetNotificationOptions, steamSetAchievementNotifications, type AchievementNotificationOptions } from "../../steam";
import { achGameNotificationsEnabled, setAchGameNotifications } from "../../core/ach-game-prefs";
import { epicGetScreenshotDisabledGames, epicSetScreenshotDisabledGames } from "../../epic";
import { icon, type IconName } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { ssDensity, ssNotifyOn, ssSort, ssSoundOn } from "../screenshots/ss-settings";
import { notesFontSize } from "../notes/notes-client";

export interface SettingsContext {
  appName: string;
  title: string;
}

export interface DisabledGame {
  key: string;
  title: string;
}

/** The overlay-owned state and callbacks the Settings view needs. */
export interface SettingsDeps {
  context: () => SettingsContext;
  launcherMode: () => boolean;
  isSettingsOpen: () => boolean;
  settingsBody: () => HTMLElement | null;
  /** Scroll-preserving repaint of this view (owned by overlay.ts). */
  repaint: () => void;
  savedOpacity: () => number;
  overlayDisabledGames: () => string[];
  setOverlayDisabledGames: (list: string[]) => void;
  overlayDisabledGamesFetched: () => boolean;
  markOverlayDisabledGamesFetched: () => void;
  disabledGames: () => DisabledGame[];
  saveDisabled: (list: DisabledGame[]) => void;
  isDisabledGame: (key: string) => boolean;
  clockSeconds: () => boolean;
  batteryPercent: () => boolean;
  updateClock: () => void;
  paintBattery: () => void;
  tabs: () => { id: string; icon: IconName; key: string }[];
  pinnedTabs: () => string[];
  ghostOpacity: (tab: string) => number;
}

let currentDeps: SettingsDeps | null = null;

function deps(): SettingsDeps {
  if (!currentDeps) throw new Error("overlay settings rendered before its deps were set");
  return currentDeps;
}

/* 9. Settings View */
const CROSSHAIR_PROFILES_KEY = "efxlve-overlay-crosshair-profiles";
const CLOCK_SECONDS_KEY = "efxlve-overlay-clock-seconds";
const BATTERY_PERCENT_KEY = "efxlve-overlay-battery-percent";

/** Crosshair slider writes are coalesced: one native update per 50 ms. */
let crosshairApplyTimer: number | null = null;

/** Achievement notification options, mirrored from the launcher settings. */
let overlayNotificationOptions: AchievementNotificationOptions = {
  enabled: true,
  sound: true,
  overlay: true,
  volume: 100,
  durationMs: 5000,
  position: "top-right",
  size: "normal",
  customSound: false,
  customSoundName: null,
  cardTheme: "rarity",
  animStyle: "minimal",
  disabledStores: [],
  minRarityPercent: 0,
  unlockScreenshots: false,
};
let overlayNotificationOptionsFetched = false;

/** Per-game crosshair overrides, keyed by app name. */
function loadCrosshairProfiles(): Record<string, CrosshairConfig> {
  try {
    const raw = localStorage.getItem(CROSSHAIR_PROFILES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<CrosshairConfig>>;
    const map: Record<string, CrosshairConfig> = {};
    for (const [app, config] of Object.entries(parsed)) {
      if (config && typeof config === "object") map[app] = sanitizeCrosshair(config);
    }
    return map;
  } catch {
    return {};
  }
}

function saveCrosshairProfiles(map: Record<string, CrosshairConfig>): void {
  localStorage.setItem(CROSSHAIR_PROFILES_KEY, JSON.stringify(map));
}

/** The game's override when it has one, otherwise the global settings. */
export function activeCrosshair(appName = deps().context().appName): CrosshairConfig {
  if (!appName) return loadCrosshair();
  return loadCrosshairProfiles()[appName] ?? loadCrosshair();
}

function hasCrosshairProfile(): boolean {
  return Boolean(deps().context().appName && loadCrosshairProfiles()[deps().context().appName]);
}

/** Writes the global settings, and the game's override when one exists. */
function saveCrosshairForContext(next: CrosshairConfig): void {
  saveCrosshair(next);
  if (!deps().context().appName) return;
  const map = loadCrosshairProfiles();
  if (!map[deps().context().appName]) return;
  map[deps().context().appName] = next;
  saveCrosshairProfiles(map);
}

function setCrosshairProfile(on: boolean): void {
  if (!deps().context().appName) return;
  const map = loadCrosshairProfiles();
  if (on) map[deps().context().appName] = activeCrosshair();
  else delete map[deps().context().appName];
  saveCrosshairProfiles(map);
  applyCrosshairConfig(activeCrosshair());
}

/** Saves and pushes the crosshair settings. `repaint` is for the shape/colour
 *  buttons; the sliders update their own badge without losing focus. */
export function commitCrosshair(next: CrosshairConfig, repaint = false): void {
  if (crosshairApplyTimer !== null) {
    window.clearTimeout(crosshairApplyTimer);
    crosshairApplyTimer = null;
  }
  saveCrosshairForContext(next);
  applyCrosshairConfig(next);
  setCrosshairVisible(next.enabled);
  if (repaint && deps().isSettingsOpen()) {
    const body = deps().settingsBody();
    const scroll = body?.scrollTop ?? 0;
    deps().repaint();
    if (body) body.scrollTop = scroll;
  }
}

/** Repaints the CSS preview without re-rendering the Settings view (which
 *  would drop the focus of the slider under the pointer). */
export function paintCrosshairPreview(config: CrosshairConfig): void {
  const el = document.querySelector<HTMLElement>(".ov-crosshair-preview");
  if (!el) return;
  el.style.setProperty("--ch-size", `${config.size}px`);
  el.style.setProperty("--ch-gap", `${config.gap}px`);
  el.style.setProperty("--ch-thickness", `${config.thickness}px`);
  el.style.setProperty("--ch-color", config.color);
  el.style.setProperty("--ch-opacity", String(config.opacity));
}

/** Slider input: store immediately, but coalesce the native update so a drag
 *  does not flood IPC. */
export function scheduleCrosshairConfig(next: CrosshairConfig): void {
  saveCrosshairForContext(next);
  if (crosshairApplyTimer !== null) window.clearTimeout(crosshairApplyTimer);
  crosshairApplyTimer = window.setTimeout(() => {
    crosshairApplyTimer = null;
    applyCrosshairConfig(next);
    if (next.enabled) setCrosshairVisible(true);
  }, 50);
}

/** Saves the native HUD appearance and repaints the settings view in place. */
export function commitHudConfig(next: HudConfig): void {
  saveHudConfig(next);
  applyHudConfig(next);
  if (deps().isSettingsOpen()) {
    const body = deps().settingsBody();
    const scroll = body?.scrollTop ?? 0;
    deps().repaint();
    if (body) body.scrollTop = scroll;
  }
}

/** Pulls the launcher's achievement notification options once per panel open. */
function loadOverlayNotificationOptions(): void {
  if (overlayNotificationOptionsFetched) return;
  overlayNotificationOptionsFetched = true;
  void achievementGetNotificationOptions()
    .then((options) => {
      overlayNotificationOptions = options;
      if (deps().isSettingsOpen()) {
        const body = deps().settingsBody();
        const scroll = body?.scrollTop ?? 0;
        deps().repaint();
        if (body) body.scrollTop = scroll;
      }
    })
    .catch(() => undefined);
}

function saveOverlayNotificationOptions(next: AchievementNotificationOptions): void {
  overlayNotificationOptions = next;
  void achievementSetNotificationOptions(next).catch((error) =>
    toast(String(error), "err"),
  );
}

/** The panel's version of the game-page bell: storage, the Rust watcher map and
 *  the anti-cheat opt-in always move together. */
function setGameAchievementNotifications(enabled: boolean): void {
  if (deps().launcherMode() || !deps().context().appName) return;
  const title = deps().context().title || deps().context().appName;
  setAchGameNotifications(deps().context().appName, enabled, title);
  void steamSetAchievementNotifications(deps().context().appName, enabled).catch(() => undefined);
  if (deps().context().appName.startsWith("steam::")) {
    const appId = deps().context().appName.slice("steam::".length);
    if (appId) {
      void steamSetAchievementNotifications(appId, enabled).catch(() => undefined);
    }
  }
  void invoke("overlay_set_anti_cheat_notifications", {
    appName: deps().context().appName,
    title,
    allowed: enabled,
  }).catch(() => undefined);
  toast(t(enabled ? "ach.gameNotifOn" : "ach.gameNotifOff"), enabled ? "ok" : "");
}

/** A new panel session must read the launcher's options again. */
export function resetNotificationOptionsSession(): void {
  overlayNotificationOptionsFetched = false;
}

/** The launcher settings changed while this panel was open. */
export function applyNotificationOptions(options: AchievementNotificationOptions): void {
  overlayNotificationOptions = options;
  overlayNotificationOptionsFetched = true;
  if (currentDeps?.isSettingsOpen()) currentDeps.repaint();
}

export function renderSettingsView(settingsDeps: SettingsDeps): void {
  currentDeps = settingsDeps;
  const el = settingsDeps.settingsBody();
  if (!el) return;
  loadOverlayNotificationOptions();
  // The capture-off list lives in Rust (the hotkey listener reads it): pull it
  // once, then paint the per-game row from it.
  if (!deps().overlayDisabledGamesFetched()) {
    deps().markOverlayDisabledGamesFetched();
    void epicGetScreenshotDisabledGames()
      .then((list) => {
        deps().setOverlayDisabledGames(Array.isArray(list) ? list : []);
        if (deps().isSettingsOpen()) deps().repaint();
      })
      .catch(() => undefined);
  }
  const enabled = localStorage.getItem(OVERLAY_ENABLED_KEY) !== "false";
  const hud = localStorage.getItem(OVERLAY_HUD_KEY) === "true";
  const opacity = deps().savedOpacity();
  const crosshair = activeCrosshair();
  const hudConfig = loadHudConfig();
  const disabled = deps().isDisabledGame(deps().context().appName);
  const disabledList = deps().disabledGames();
  const hp = getHomepage();
  const isPresetHp = ["https://www.google.com/", "https://duckduckgo.com/", "https://www.bing.com/", "https://yandex.com/"].includes(hp);
  const notification = overlayNotificationOptions;
  const pinnedTabs = deps().pinnedTabs();
  const showGameNotificationRow = !deps().launcherMode() && Boolean(deps().context().appName);
  const gameNotificationsOn = showGameNotificationRow
    ? achGameNotificationsEnabled(deps().context().appName, deps().context().title || deps().context().appName)
    : true;

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
              <div class="ov-setting-name">${esc(IS_WINDOWS ? t("overlay.enabledTitle", { key: overlayHotkeyLabel() }) : t("overlay.overlayLabel"))}</div>
              <div class="ov-setting-desc">${esc(IS_WINDOWS ? t("overlay.enabledDesc", { key: overlayHotkeyLabel() }) : t("settings.overlayLauncherNote"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="enabled" ${enabled ? "checked" : ""} /><span class="track"></span></label>
          </div>

          ${IS_WINDOWS ? `<div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.hudTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.hudDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="hud" ${hud ? "checked" : ""} /><span class="track"></span></label>
          </div>` : ""}
        </div>
      </section>

      <!-- Section: Achievements & notifications -->
      <section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("bell", 13)}
          <span>${esc(t("settings.secAchievements"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("settings.achNotifyTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("settings.achNotifyDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ach-notifications" ${notification.enabled ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("settings.achOverlayTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("settings.achOverlayDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ach-overlay" ${notification.overlay ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("settings.achSoundTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("settings.achSoundDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ach-sound" ${notification.sound ? "checked" : ""} /><span class="track"></span></label>
          </div>

          ${showGameNotificationRow ? `<div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("ach.gameNotifToggle"))}</div>
              <div class="ov-setting-desc">${esc(t("settings.achNotifyDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="ach-game-notif" ${gameNotificationsOn ? "checked" : ""} /><span class="track"></span></label>
          </div>` : ""}
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
            <label class="switch"><input type="checkbox" data-ov-toggle="clock-seconds" ${deps().clockSeconds() ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.batteryPercentTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.batteryPercentDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="battery-percent" ${deps().batteryPercent() ? "checked" : ""} /><span class="track"></span></label>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.opacityTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.opacityDesc"))}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <input type="range" min="0" max="100" step="1" value="${opacity}" data-ov-opacity style="width:130px" />
              <span id="ov-opacity-val" style="font-variant-numeric: tabular-nums; font-size: 12px; color: var(--text-2); min-width: 34px; text-align: right;">${opacity}%</span>
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.resetLayoutTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.resetLayoutDesc"))}</div>
            </div>
            <button class="btn ghost small" data-ov="reset-widget-layout">
              ${icon("refresh", 12)}
              <span>${esc(t("overlay.resetLayoutAction"))}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Section: HUD appearance -->
      ${IS_WINDOWS ? `<section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("activity", 13)}
          <span>${esc(t("overlay.hudAppearanceTitle"))}</span>
        </header>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.hudModeTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.hudModeDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${([["minimal", "overlay.hudMinimal"], ["compact", "overlay.hudCompact"], ["full", "overlay.hudFull"]] as const)
                .map(([value, key]) => `<button class="${hudConfig.mode === value ? "active" : ""}" data-ov="hud-mode" data-mode="${value}">${esc(t(key))}</button>`)
                .join("")}
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.hudCornerTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.hudCornerDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${([["top-left", "overlay.hudTopLeft"], ["top-right", "overlay.hudTopRight"], ["bottom-left", "overlay.hudBottomLeft"], ["bottom-right", "overlay.hudBottomRight"]] as const)
                .map(([value, key]) => `<button class="${hudConfig.corner === value ? "active" : ""}" data-ov="hud-corner" data-corner="${value}">${esc(t(key))}</button>`)
                .join("")}
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.hudColorTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.hudColorDesc"))}</div>
            </div>
            <div class="ov-crosshair-colors">
              ${["#f2f2f2", "#22c55e", "#f59e0b", "#ef4444", "#38bdf8"]
                .map((color) => `<button class="ov-crosshair-swatch${hudConfig.color.toLowerCase() === color ? " active" : ""}" data-ov="hud-color" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`)
                .join("")}
            </div>
          </div>
        </div>
      </section>` : ""}

      <!-- Section: Ghost HUD opacity -->
      ${IS_WINDOWS ? `<section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("layers", 13)}
          <span>${esc(t("overlay.ghostOpacityTitle"))}</span>
        </header>
        <div class="ov-settings-group">
          ${pinnedTabs.length === 0
            ? `<div class="ov-setting-desc">${esc(t("overlay.ghostOpacityEmpty"))}</div>`
            : pinnedTabs.map((tab) => {
                const meta = deps().tabs().find((entry) => entry.id === tab);
                const pct = Math.round(deps().ghostOpacity(tab) * 100);
                return `<div class="ov-setting-item">
                  <div class="ov-setting-info">
                    <div class="ov-setting-name">${esc(meta ? t(meta.key) : tab)}</div>
                    <div class="ov-setting-desc">${esc(t("overlay.ghostOpacityDesc"))}</div>
                  </div>
                  <div class="ov-crosshair-range">
                    <input type="range" min="25" max="100" step="1" value="${pct}" data-ghost-opacity="${tab}" />
                    <span id="ov-ghost-opacity-${tab}">${pct}%</span>
                  </div>
                </div>`;
              }).join("")}
        </div>
      </section>` : ""}

      <!-- Section: Crosshair -->
      ${IS_WINDOWS ? `<section class="ov-settings-section">
        <header class="ov-settings-section-header">
          ${icon("crosshair", 13)}
          <span>${esc(t("overlay.crosshairTitle"))}</span>
        </header>
        <div class="ov-crosshair-preview" style="--ch-size:${crosshair.size}px;--ch-gap:${crosshair.gap}px;--ch-thickness:${crosshair.thickness}px;--ch-color:${crosshair.color};--ch-opacity:${crosshair.opacity}">
          <div class="ov-crosshair-stage">
            <div class="ov-ch shape-${crosshair.shape}">
              <span class="ov-ch-arm ov-ch-up"></span>
              <span class="ov-ch-arm ov-ch-down"></span>
              <span class="ov-ch-arm ov-ch-left"></span>
              <span class="ov-ch-arm ov-ch-right"></span>
              <span class="ov-ch-ring"></span>
              <span class="ov-ch-point"></span>
            </div>
          </div>
        </div>
        <div class="ov-settings-group">
          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairEnableTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairEnableDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="crosshair-enabled" ${crosshair.enabled ? "checked" : ""} /><span class="track"></span></label>
          </div>

          ${deps().context().appName && !deps().launcherMode() ? `<div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairProfileTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairProfileDesc"))}</div>
            </div>
            <label class="switch"><input type="checkbox" data-ov-toggle="crosshair-profile" ${hasCrosshairProfile() ? "checked" : ""} /><span class="track"></span></label>
          </div>` : ""}

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairShapeTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairShapeDesc"))}</div>
            </div>
            <div class="seg" role="radiogroup">
              ${([["dot", "overlay.crosshairDot"], ["cross", "overlay.crosshairCross"], ["circle", "overlay.crosshairCircle"], ["t", "overlay.crosshairT"]] as const)
                .map(([value, key]) => `<button class="${crosshair.shape === value ? "active" : ""}" data-ov="crosshair-shape" data-shape="${value}">${esc(t(key))}</button>`)
                .join("")}
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairColorTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairColorDesc"))}</div>
            </div>
            <div class="ov-crosshair-colors">
              ${["#ffffff", "#22c55e", "#ef4444", "#38bdf8", "#f59e0b", "#e879f9"]
                .map((color) => `<button class="ov-crosshair-swatch${crosshair.color.toLowerCase() === color ? " active" : ""}" data-ov="crosshair-color" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`)
                .join("")}
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairSizeTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairSizeDesc"))}</div>
            </div>
            <div class="ov-crosshair-range">
              <input type="range" min="8" max="64" step="1" value="${crosshair.size}" data-crosshair-size />
              <span id="ov-crosshair-size-val">${Math.round(crosshair.size)}px</span>
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairGapTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairGapDesc"))}</div>
            </div>
            <div class="ov-crosshair-range">
              <input type="range" min="0" max="16" step="1" value="${crosshair.gap}" data-crosshair-gap />
              <span id="ov-crosshair-gap-val">${Math.round(crosshair.gap)}px</span>
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairThicknessTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairThicknessDesc"))}</div>
            </div>
            <div class="ov-crosshair-range">
              <input type="range" min="1" max="5" step="0.5" value="${crosshair.thickness}" data-crosshair-thickness />
              <span id="ov-crosshair-thickness-val">${crosshair.thickness.toFixed(1)}px</span>
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairOpacityTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairOpacityDesc"))}</div>
            </div>
            <div class="ov-crosshair-range">
              <input type="range" min="10" max="100" step="1" value="${Math.round(crosshair.opacity * 100)}" data-crosshair-opacity />
              <span id="ov-crosshair-opacity-val">${Math.round(crosshair.opacity * 100)}%</span>
            </div>
          </div>

          <div class="ov-setting-item">
            <div class="ov-setting-info">
              <div class="ov-setting-name">${esc(t("overlay.crosshairHotkeyTitle"))}</div>
              <div class="ov-setting-desc">${esc(t("overlay.crosshairHotkeyDesc"))}</div>
            </div>
            <select class="input select small" data-crosshair-hotkey style="min-width:130px">
              ${CROSSHAIR_HOTKEYS.map((hotkey) => `<option value="${hotkey}" ${crosshair.hotkey === hotkey ? "selected" : ""}>${hotkey}</option>`).join("")}
            </select>
          </div>
        </div>
      </section>` : ""}

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
            !deps().launcherMode() && deps().context().appName
              ? `<div class="ov-setting-item">
                  <div class="ov-setting-info">
                    <div class="ov-setting-name">${esc(t("ss.gameCaptureOff"))}</div>
                    <div class="ov-setting-desc">${esc(t("ss.gameCaptureTip"))}</div>
                  </div>
                  <label class="switch"><input type="checkbox" data-ov-toggle="ss-capture-game" ${deps().overlayDisabledGames().includes(deps().context().appName) ? "checked" : ""} /><span class="track"></span></label>
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
      ${!deps().launcherMode() && deps().context().appName ? `
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

/**
 * One change listener for every Settings switch. Returns true when the toggle
 * belongs to this view; the overlay page keeps only its non-settings cases.
 */
export function handleSettingsToggle(
  toggle: string,
  input: HTMLInputElement,
  settingsDeps: SettingsDeps,
): boolean {
  currentDeps = settingsDeps;
  switch (toggle) {
    case "enabled": {
      localStorage.setItem(OVERLAY_ENABLED_KEY, String(input.checked));
      void invoke("overlay_set_enabled", { enabled: input.checked });
      return true;
    }
    case "hud": {
      localStorage.setItem(OVERLAY_HUD_KEY, String(input.checked));
      void invoke("overlay_set_hud", { enabled: input.checked });
      document.querySelectorAll<HTMLInputElement>('input[data-ov-toggle="hud"]').forEach((chk) => {
        chk.checked = input.checked;
      });
      return true;
    }
    case "clock-seconds": {
      localStorage.setItem(CLOCK_SECONDS_KEY, String(input.checked));
      deps().updateClock();
      return true;
    }
    case "battery-percent": {
      localStorage.setItem(BATTERY_PERCENT_KEY, String(input.checked));
      deps().paintBattery();
      return true;
    }
    case "crosshair-enabled": {
      commitCrosshair({ ...activeCrosshair(), enabled: input.checked });
      return true;
    }
    case "crosshair-profile": {
      setCrosshairProfile(input.checked);
      deps().repaint();
      return true;
    }
    case "ss-sound": {
      localStorage.setItem(SS_SOUND_KEY, String(input.checked));
      return true;
    }
    case "ss-notify": {
      localStorage.setItem(SS_NOTIFY_KEY, String(input.checked));
      return true;
    }
    case "ss-capture-game": {
      const key = deps().context().appName;
      if (key) {
        const next = input.checked
          ? [...new Set([...deps().overlayDisabledGames(), key])]
          : deps().overlayDisabledGames().filter((item) => item !== key);
        deps().setOverlayDisabledGames(next);
        void epicSetScreenshotDisabledGames(next).catch(() => undefined);
      }
      return true;
    }
    case "disable-game": {
      // The panel over the launcher/desktop is not a game: blocking it would
      // hide the overlay from the only place its blocklist can be edited.
      if (deps().launcherMode()) {
        input.checked = false;
        return true;
      }
      const ctx = deps().context();
      const next = input.checked
        ? [
            ...deps().disabledGames().filter((item) => item.key !== ctx.appName),
            { key: ctx.appName, title: ctx.title || ctx.appName },
          ]
        : deps().disabledGames().filter((item) => item.key !== ctx.appName);
      deps().saveDisabled(next);
      // Tell the service right away: "off for this game" must stop the panel,
      // not just hide the hint.
      void invoke("overlay_set_active_game", {
        appName: ctx.appName,
        title: ctx.title || ctx.appName,
        disabled: input.checked,
        installPath: "",
      }).catch(() => undefined);
      if (input.checked) void invoke("overlay_hide");
      return true;
    }
    case "ach-notifications": {
      saveOverlayNotificationOptions({ ...overlayNotificationOptions, enabled: input.checked });
      return true;
    }
    case "ach-overlay": {
      saveOverlayNotificationOptions({ ...overlayNotificationOptions, overlay: input.checked });
      return true;
    }
    case "ach-sound": {
      saveOverlayNotificationOptions({ ...overlayNotificationOptions, sound: input.checked });
      return true;
    }
    case "ach-game-notif": {
      setGameAchievementNotifications(input.checked);
      return true;
    }
    default:
      return false;
  }
}

