/**
 * Stage Mode lifecycle: enter, leave, persistence and controller auto-entry.
 *
 * Stage is a shell mode, not a `View`. The desktop DOM stays alive underneath,
 * so leaving Stage restores the page and scroll position the player came from.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  STAGE_AMBIENCE_KEY,
  STAGE_AMBIENCE_VOLUME_KEY,
  STAGE_ATTRACT_KEY,
  STAGE_AUTO_KEY,
  STAGE_CINEMATIC_KEY,
  STAGE_CUSTOM_AMBIENCE_KEY,
  STAGE_ENABLED_KEY,
  STAGE_GAME_TRACKS_KEY,
  STAGE_HAPTICS_KEY,
  STAGE_LIBRARY_SORT_KEY,
  STAGE_LIBRARY_VIEW_KEY,
  STAGE_OPEN_AT_LAUNCH_KEY,
  STAGE_SAFE_AREA_KEY,
  STAGE_SOUND_KEY,
  STAGE_TEXT_SCALE_KEY,
  STAGE_VOLUME_KEY,
  isTauri,
} from "../../core/constants";
import { applyUiScale } from "../../core/game-status";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { StageLibrarySort, StageLibraryView, StageRoute } from "../../core/types";
import { t } from "../../i18n";
import { destroyDiscordPage } from "../discord/discord-view";
import { hideSpotifyPlayer } from "../music/music-view";
import { hideStore } from "../store/store-view";
import { beginStageBoot, clearStageBoot, endStageBoot, ensureStageChunk, isStageChunkReady } from "./stage-boot";

let pendingDesktopScroll = -1;

function hasOpenDialog(): boolean {
  return Boolean(
    document.querySelector(
      ".modal:not(.hidden), .confirm-dialog:not(.hidden), .selective-overlay, .palette-backdrop, #modal-root > div, #install-root > div",
    ),
  );
}

function activeElementAcceptsText(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el.isContentEditable;
}

/** Native fullscreen is the presentation; the desktop `S.isFullscreen` stays untouched. */
async function setStageFullscreen(on: boolean): Promise<void> {
  if (isTauri) {
    try {
      await invoke("app_set_fullscreen", { enabled: on });
      return;
    } catch {
      /* Fall through to the browser API. */
    }
  }
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* A borderless Stage is still usable when the host refuses fullscreen. */
  }
}

/** Enter Stage. Returns false when a dialog or the master switch blocks it. */
export async function enterStage(opts: { route?: StageRoute; gameKey?: string } = {}): Promise<boolean> {
  if (!S.stage.enabled) return false;
  if (S.stage.active) return true;
  if (hasOpenDialog()) {
    toast(t("stage.closeDialogFirst"), "");
    return false;
  }

  // The first entry pays for the lazy shell chunk. Paint the boot frame first
  // so the press lands on something instead of a window that ignores it.
  beginStageBoot();
  const ready = await ensureStageChunk();
  endStageBoot();
  if (!S.stage.enabled) {
    clearStageBoot();
    return false;
  }
  if (!ready || !isStageChunkReady()) {
    clearStageBoot();
    toast(t("stage.loadFailed"), "err");
    return false;
  }
  if (hasOpenDialog()) {
    clearStageBoot();
    toast(t("stage.closeDialogFirst"), "");
    return false;
  }
  // A second click while the chunk was loading must not reset the session.
  if (S.stage.active) return true;

  S.stage.active = true;
  S.stage.route = opts.route ?? "home";
  S.stage.gameKey = opts.gameKey ?? null;
  S.stage.homeHeroKey = null;
  S.stage.previewKey = null;
  S.stage.programTab = "overview";
  S.stage.settingsTab = "general";
  S.stage.achievementFilter = "all";
  S.stage.collectionId = null;
  S.stage.stillIndex = null;
  S.stage.stillApp = null;
  S.stage.focusKey = "";
  S.stage.stack = [];
  S.stage.query = "";
  S.stage.searchOpen = false;
  S.stage.quickMenu = false;
  S.stage.controlsOpen = false;
  S.stage.spotifyOpen = false;
  S.stage.discordOpen = false;
  S.stage.browserOpen = false;
  S.stage.browserUrl = "";
  S.stage.powerOpen = false;
  S.stage.powerConfirm = false;
  S.stage.manageKey = null;
  S.stage.manageConfirmUninstall = false;
  S.stage.launch = null;
  S.stage.launchError = "";
  // Presentation flags are owned by the Stage chunk; the state is reset here
  // so a re-entry never flashes the previous session's idle frame.
  S.stage.intro = false;
  S.stage.idle = false;
  S.stage.returnView = S.view;
  S.stage.wasFullscreen = S.isFullscreen;
  const view = document.getElementById("view");
  S.stage.returnScroll = view ? view.scrollTop : 0;

  document.body.classList.add("stage-mode");
  // The native children are separate windows: hiding the desktop DOM is not
  // enough. The store helper also moves `S.view` to the last non-store page.
  hideStore();
  hideSpotifyPlayer();
  destroyDiscordPage();
  void applyUiScale(S.stage.textScale);
  await setStageFullscreen(true);
  window.dispatchEvent(new CustomEvent("stage-mode", { detail: { active: true } }));
  updateStageUi();
  scheduleRender();
  return true;
}

/** Leave Stage and restore the desktop presentation. */
export function exitStage(): void {
  if (!S.stage.active) return;

  const returnView = S.stage.returnView;
  const returnScroll = S.stage.returnScroll;
  const wasFullscreen = S.stage.wasFullscreen;

  S.stage.active = false;
  S.stage.quickMenu = false;
  S.stage.searchOpen = false;
  S.stage.controlsOpen = false;
  S.stage.spotifyOpen = false;
  S.stage.discordOpen = false;
  S.stage.browserOpen = false;
  S.stage.browserUrl = "";
  S.stage.powerOpen = false;
  S.stage.powerConfirm = false;
  S.stage.manageKey = null;
  S.stage.manageConfirmUninstall = false;
  S.stage.launch = null;
  S.stage.launchError = "";
  S.stage.intro = false;
  S.stage.idle = false;
  S.stage.focusKey = "";
  S.stage.stack = [];
  S.stage.gameKey = null;
  S.stage.homeHeroKey = null;
  S.stage.previewKey = null;
  S.stage.collectionId = null;
  S.stage.stillIndex = null;
  S.stage.stillApp = null;
  // Stage may have loaded a screenshot listing; the desktop gallery owns the
  // cache, so release it when the mode that asked for it goes away.
  S.loadedScreenshots.clear();
  S.screenshotFullSrc.clear();
  S.screenshotPreviewSrc.clear();

  document.body.classList.remove("stage-mode");
  document.getElementById("stage-root")?.remove();
  // A Stage entered from the store leaves `S.view` on the last non-store page.
  S.view = returnView === "store" ? S.lastNonStoreView : returnView;
  pendingDesktopScroll = returnScroll;

  void applyUiScale(S.uiScale);
  void setStageFullscreen(wasFullscreen);
  window.dispatchEvent(new CustomEvent("stage-mode", { detail: { active: false } }));
  updateStageUi();
  scheduleRender();
  window.requestAnimationFrame(() => {
    if (pendingDesktopScroll < 0) return;
    const view = document.getElementById("view");
    if (view) view.scrollTop = pendingDesktopScroll;
    pendingDesktopScroll = -1;
  });
}

export async function toggleStage(): Promise<void> {
  if (S.stage.active) exitStage();
  else await enterStage();
}

/** The title-bar entry and the settings button share this state. */
export function updateStageUi(): void {
  const btn = document.getElementById("btn-stage-mode");
  if (!btn) return;
  btn.hidden = !S.stage.enabled;
  btn.classList.toggle("active", S.stage.active);
  const title = S.stage.active ? t("stage.exit") : t("stage.enter");
  btn.title = title;
  btn.setAttribute("aria-label", title);
}

export function setStageEnabled(on: boolean): void {
  S.stage.enabled = on;
  try {
    localStorage.setItem(STAGE_ENABLED_KEY, String(on));
  } catch {
    /* Storage can be unavailable in a private profile. */
  }
  if (!on && S.stage.active) exitStage();
  updateStageUi();
  scheduleRender();
}

export function setStageAutoEnter(on: boolean): void {
  S.stage.autoEnter = on;
  try {
    localStorage.setItem(STAGE_AUTO_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageOpenAtLaunch(on: boolean): void {
  S.stage.openAtLaunch = on;
  try {
    localStorage.setItem(STAGE_OPEN_AT_LAUNCH_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageLibraryView(view: StageLibraryView): void {
  S.stage.libraryView = view;
  try {
    localStorage.setItem(STAGE_LIBRARY_VIEW_KEY, view);
  } catch {
    /* ignore */
  }
}

export function setStageLibrarySort(sort: StageLibrarySort): void {
  S.stage.librarySort = sort;
  try {
    localStorage.setItem(STAGE_LIBRARY_SORT_KEY, sort);
  } catch {
    /* ignore */
  }
}

export function setStageTextScale(scale: number): void {
  if (![100, 110, 120].includes(scale)) return;
  S.stage.textScale = scale;
  try {
    localStorage.setItem(STAGE_TEXT_SCALE_KEY, String(scale));
  } catch {
    /* ignore */
  }
  void applyUiScale(scale);
  scheduleRender();
}

export function setStageSafeArea(level: number): void {
  if (![0, 1, 2, 3].includes(level)) return;
  S.stage.safeArea = level;
  try {
    localStorage.setItem(STAGE_SAFE_AREA_KEY, String(level));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageSound(on: boolean): void {
  S.stage.sound = on;
  try {
    localStorage.setItem(STAGE_SOUND_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageSoundVolume(volume: number): void {
  S.stage.soundVolume = Math.max(0, Math.min(100, Math.round(volume)));
  try {
    localStorage.setItem(STAGE_VOLUME_KEY, String(S.stage.soundVolume));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageHaptics(on: boolean): void {
  S.stage.haptics = on;
  try {
    localStorage.setItem(STAGE_HAPTICS_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageAmbience(on: boolean): void {
  S.stage.ambience = on;
  try {
    localStorage.setItem(STAGE_AMBIENCE_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageAmbienceVolume(volume: number): void {
  S.stage.ambienceVolume = Math.max(0, Math.min(100, Math.round(volume)));
  try {
    localStorage.setItem(STAGE_AMBIENCE_VOLUME_KEY, String(S.stage.ambienceVolume));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageCinematic(on: boolean): void {
  S.stage.cinematic = on;
  try {
    localStorage.setItem(STAGE_CINEMATIC_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageCustomAmbience(name: string): void {
  S.stage.customAmbience = name;
  try {
    if (name) localStorage.setItem(STAGE_CUSTOM_AMBIENCE_KEY, name);
    else localStorage.removeItem(STAGE_CUSTOM_AMBIENCE_KEY);
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageGameTrack(appName: string, name: string): void {
  if (!appName) return;
  if (name) S.stage.gameTracks[appName] = name;
  else delete S.stage.gameTracks[appName];
  try {
    localStorage.setItem(STAGE_GAME_TRACKS_KEY, JSON.stringify(S.stage.gameTracks));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

export function setStageAttract(on: boolean): void {
  S.stage.attract = on;
  if (!on) S.stage.idle = false;
  try {
    localStorage.setItem(STAGE_ATTRACT_KEY, String(on));
  } catch {
    /* ignore */
  }
  scheduleRender();
}

function safeToAutoEnter(): boolean {
  if (hasOpenDialog()) return false;
  if (activeElementAcceptsText()) return false;
  return true;
}

/**
 * Called by the gamepad layer when a pad connects. `allowAutoEnter` is false
 * when a game is running or another window owns the screen: a pad reconnecting
 * mid-session must not pull the full-screen Stage shell over the game.
 */
export function stageControllerConnected(
  name: string,
  kind: import("../../core/types").ControllerKind,
  battery: number | null,
  allowAutoEnter = false,
): void {
  S.stage.controllerConnected = true;
  S.stage.controllerName = name;
  S.stage.controllerBattery = battery;
  S.gamepadKind = kind;
  if (allowAutoEnter && !S.stage.active && S.stage.enabled && S.stage.autoEnter && safeToAutoEnter()) {
    void enterStage();
    return;
  }
  if (S.stage.active) scheduleRender();
}

export function stageControllerDisconnected(): void {
  S.stage.controllerConnected = false;
  S.stage.controllerName = "";
  S.stage.controllerBattery = null;
  if (S.stage.active) scheduleRender();
}

/** Some WebView2 builds expose a battery level, some return null. */
export function stageControllerBattery(level: number | null): void {
  S.stage.controllerBattery = level;
  if (S.stage.active) scheduleRender();
}

// F10 is the keyboard twin of the title-bar Stage button. F11 stays with the
// classic Full Screen Mode so both modes keep their own shortcut.
window.addEventListener("keydown", (event) => {
  if (event.key !== "F10" || event.repeat || !S.stage.enabled) return;
  event.preventDefault();
  void toggleStage();
});
