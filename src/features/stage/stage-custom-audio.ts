/**
 * User-supplied Stage background music.
 *
 * The built-in generative theme remains the fallback. A player can import a
 * global track and/or one track per game; the focused game's track wins, then
 * the global track. Audio is copied into the app data folder by Rust and
 * served through the asset protocol, so no third-party music ships with the
 * launcher and nothing is fetched from the network.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { duckStageAmbience } from "./stage-ambience";
import { loadStageAudioFiles, stageAudioPath } from "./stage-audio-library";
import { stageHeroSummary } from "./stage-model";

const TARGET_SCALE = 0.55;
const DUCKED_SCALE = 0.18;
const FADE_MS = 850;
/** A library preview is a sample, not a second player in the room. */
const PREVIEW_MS = 15_000;

let element: HTMLAudioElement | null = null;
let loadedName = "";
let active = false;
let fadeTimer = 0;
let switchToken = 0;
let unlockBound = false;
let preview: HTMLAudioElement | null = null;
let previewName = "";
let previewTimer = 0;
let roomPausedForPreview = false;

function gameKeyInFocus(): string {
  if (S.stage.route === "home") {
    if (S.stage.focusKey.startsWith("game:")) return S.stage.focusKey.slice(5);
    return S.stage.homeHeroKey || stageHeroSummary()?.appName || "";
  }
  if (S.stage.route === "library") return S.stage.previewKey || "";
  if (S.stage.route === "program") return S.stage.gameKey || "";
  return "";
}

function desiredName(): string {
  const key = gameKeyInFocus();
  return (key ? S.stage.gameTracks[key] : "") || S.stage.customAmbience || "";
}

function targetVolume(): number {
  const base = (S.stage.ambienceVolume / 100) * TARGET_SCALE;
  return Math.max(0.0001, S.runningGames.size > 0 ? base * DUCKED_SCALE : base);
}

function ensureElement(): HTMLAudioElement | null {
  if (!isTauri) return null;
  if (element) return element;
  try {
    element = new Audio();
    element.loop = true;
    element.preload = "auto";
    element.volume = 0.0001;
    element.addEventListener("ended", () => {
      if (!element || !loadedName) return;
      element.currentTime = 0;
      void element.play().catch(() => undefined);
    });
    return element;
  } catch {
    return null;
  }
}

function rampTo(target: number, duration = FADE_MS): void {
  if (!element) return;
  if (fadeTimer) window.clearInterval(fadeTimer);
  const from = element.volume;
  const to = Math.max(0.0001, Math.min(1, target));
  const started = performance.now();
  if (duration <= 0) {
    element.volume = to;
    return;
  }
  fadeTimer = window.setInterval(() => {
    if (!element) {
      window.clearInterval(fadeTimer);
      fadeTimer = 0;
      return;
    }
    const progress = Math.min(1, (performance.now() - started) / duration);
    // A gentle curve keeps the room from pumping at the start of a track.
    const eased = 1 - Math.pow(1 - progress, 3);
    element.volume = Math.max(0.0001, Math.min(1, from + (to - from) * eased));
    if (progress >= 1) {
      window.clearInterval(fadeTimer);
      fadeTimer = 0;
    }
  }, 30);
}

function bindUnlock(): void {
  if (unlockBound) return;
  unlockBound = true;
  const retry = (): void => {
    if (!element || !loadedName || !active) return;
    if (element.paused) void element.play().catch(() => undefined);
  };
  window.addEventListener("pointerdown", retry, { capture: true });
  window.addEventListener("keydown", retry, { capture: true });
}

function pauseElement(): void {
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  try {
    element.load();
  } catch {
    /* ignore */
  }
  loadedName = "";
}

/** Stop and release the custom player without touching the generative theme. */
export function stopStageCustomAudio(): void {
  if (!active && !loadedName) return;
  active = false;
  switchToken += 1;
  if (fadeTimer) window.clearInterval(fadeTimer);
  fadeTimer = 0;
  if (!element) return;
  rampTo(0.0001, 220);
  window.setTimeout(() => {
    if (active) return;
    pauseElement();
  }, 240);
}

/**
 * Pick the focused game's track, then the global track. Returns true while a
 * custom track owns the room, so the caller can park the generative theme.
 */
export function updateStageCustomAudio(): boolean {
  if (!isTauri || !S.stage.active || !S.stage.ambience || S.stage.ambienceVolume <= 0) {
    stopStageCustomAudio();
    return false;
  }
  const name = desiredName();
  if (!name) {
    stopStageCustomAudio();
    return false;
  }
  if (!stageAudioPath(name)) {
    // The list may still be loading; the load schedules another render.
    void loadStageAudioFiles();
    stopStageCustomAudio();
    return false;
  }
  const audio = ensureElement();
  if (!audio) return false;
  active = true;
  bindUnlock();
  // A library sample owns the speakers; keep the room track loaded but quiet
  // until the sample finishes so a focus move cannot start both at once.
  if (previewName) {
    if (!audio.paused) audio.pause();
    return true;
  }
  const path = stageAudioPath(name);
  const token = ++switchToken;
  if (loadedName === name) {
    if (audio.paused) void audio.play().catch(() => undefined);
    rampTo(targetVolume());
    return true;
  }
  // Fade the old room out before replacing the source; a hard cut between two
  // themes is the one thing a console home screen never does.
  rampTo(0.0001, 240);
  window.setTimeout(() => {
    if (token !== switchToken || !active || !element) return;
    element.src = convertFileSrc(path);
    element.load();
    loadedName = name;
    void element.play().catch(() => undefined);
    rampTo(targetVolume());
  }, 260);
  return true;
}

export function stageCustomAudioActive(): boolean {
  return active && Boolean(element && !element.paused);
}

/** The file the library is sampling right now, or an empty string. */
export function stageAudioPreviewName(): string {
  return previewName;
}

function releasePreview(resumeRoom: boolean, keepRoomDucked = false): void {
  if (previewTimer) {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
  }
  const audio = preview;
  const hadPreview = Boolean(audio || previewName);
  preview = null;
  previewName = "";
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      /* ignore */
    }
  }
  const roomWasPaused = roomPausedForPreview;
  const resume = resumeRoom && roomWasPaused;
  // Replacing one sample with another keeps the room parked; only the final
  // stop hands the speakers back.
  roomPausedForPreview = resumeRoom ? false : roomWasPaused;
  if (resume && active && element && loadedName) {
    void element.play().catch(() => undefined);
    rampTo(targetVolume(), 500);
  }
  if (!keepRoomDucked) {
    duckStageAmbience(S.runningGames.size > 0);
  }
  if (hadPreview) scheduleRender();
}

/** Stop the library sample and hand the room back to its own track. */
export function stopStageAudioPreview(): void {
  if (!preview && !previewName) return;
  releasePreview(true);
}

/**
 * Play a short sample of one imported file. The room track pauses while the
 * sample runs, so two tracks never stack on top of each other.
 */
export function previewStageCustomAudio(name: string): void {
  if (!isTauri || !name) return;
  if (previewName === name) {
    stopStageAudioPreview();
    return;
  }
  // Starting another sample replaces the old one without letting the room
  // blip back in between.
  if (preview || previewName) releasePreview(false, true);
  const path = stageAudioPath(name);
  if (!path) {
    // The row's path was not in the cache yet; hand the room back and let the
    // refresh render the row again.
    releasePreview(true);
    void loadStageAudioFiles();
    return;
  }
  try {
    const audio = new Audio(convertFileSrc(path));
    audio.loop = false;
    audio.preload = "auto";
    audio.volume = Math.max(0.2, Math.min(0.85, (S.stage.ambienceVolume / 100) * 0.8));
    preview = audio;
    previewName = name;
    roomPausedForPreview =
      roomPausedForPreview || Boolean(active && element && !element.paused);
    if (roomPausedForPreview && element && !element.paused) element.pause();
    // The generative room is still running when no custom track owns it; duck
    // it so the sample is not competing with a full pad.
    duckStageAmbience(true);
    audio.addEventListener("ended", () => {
      if (preview === audio) releasePreview(true);
    });
    audio.addEventListener("error", () => {
      if (preview === audio) releasePreview(true);
    });
    void audio.play().catch(() => {
      if (preview === audio) releasePreview(true);
    });
    previewTimer = window.setTimeout(() => {
      if (preview === audio) releasePreview(true);
    }, PREVIEW_MS);
    scheduleRender();
  } catch {
    releasePreview(true);
  }
}

// The webview can be hidden while the launcher is in the tray; pause the room
// instead of letting a hidden renderer keep decoding a long track.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      preview?.pause();
    } else if (preview && preview.paused) {
      void preview.play().catch(() => undefined);
    }
    if (!element || !active) return;
    if (document.hidden) {
      element.pause();
      return;
    }
    if (loadedName) {
      void element.play().catch(() => undefined);
      rampTo(targetVolume(), 500);
    }
  });
}

window.addEventListener("stage-mode", (event) => {
  if ((event as CustomEvent<{ active?: boolean }>).detail?.active) return;
  stopStageAudioPreview();
  stopStageCustomAudio();
});
