/**
 * Overlay Audio mixer view: per-session volume, the master bus, output devices
 * and the saved volume presets.
 *
 * One-way dependency: the page configures widget queries through
 * configureAudio; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { emptyBlockHtml } from "./overlay-music";

export interface AudioSession {
  id: string;
  pid: number;
  name: string;
  displayName: string;
  icon: string;
  volume: number;
  muted: boolean;
  system: boolean;
}

export interface AudioDevice {
  id: string;
  name: string;
  default: boolean;
}

export interface AudioState {
  master: number;
  masterMuted: boolean;
  sessions: AudioSession[];
  devices: AudioDevice[];
  defaultDevice: string;
}

interface AudioDeps {
  isWidgetOpen: (tab: "audio") => boolean;
  viewEl: (tab: "audio") => HTMLElement | null;
  ghostMode: () => boolean;
  isWidgetPinned: (tab: "audio") => boolean;
}

let deps: AudioDeps | null = null;

export function configureAudio(next: AudioDeps): void {
  deps = next;
}

function audioOpen(): boolean {
  return deps?.isWidgetOpen("audio") ?? false;
}

function audioView(): HTMLElement | null {
  return deps?.viewEl("audio") ?? null;
}

/** Audio mixer: the last poll, a debounce hold while a slider moves, and the
 *  timers that coalesce volume writes. */
let audioState: AudioState | null = null;
let audioError = "";
let audioLoading = false;
let audioPollTimer: number | null = null;
let audioHoldUntil = 0;
const audioVolumeTimers = new Map<string, number>();
let audioMasterTimer: number | null = null;

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
export function audioSessionKey(session: AudioSession): string {
  if (session.system || session.pid === 0) return "system";
  return session.name || `pid:${session.pid}`;
}

export function loadAudioPresets(): AudioPreset[] {
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

export function saveAudioPresets(presets: AudioPreset[]): void {
  // Keep the newest: a preset the UI just reported as saved must not be the one
  // silently dropped at the 12-entry cap.
  localStorage.setItem(AUDIO_PRESETS_KEY, JSON.stringify(presets.slice(-12)));
}

export function captureAudioPreset(): AudioPreset | null {
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

export async function applyAudioPreset(preset: AudioPreset): Promise<void> {
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
export function audioLabel(session: AudioSession): string {
  if (session.system || session.pid === 0) return t("overlay.audioSystem");
  return session.displayName || session.name || `PID ${session.pid}`;
}

/** The muted second line: the executable behind a friendly display name. */
export function audioSubLabel(session: AudioSession): string {
  if (session.system || session.pid === 0) return "";
  if (!session.displayName || !session.name || session.displayName === session.name) return "";
  return session.name;
}

export function audioRowHtml(opts: {
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

export function renderAudio(): void {
  const el = audioView();
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
export async function refreshAudio(force = false): Promise<void> {
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
  if (audioOpen()) {
    if (
      document.activeElement?.id === "ov-audio-preset-select" ||
      document.activeElement?.id === "ov-audio-device"
    ) {
      return;
    }
    renderAudio();
  }
}

export function startAudioPolling(): void {
  if (audioPollTimer !== null) return;
  void refreshAudio(true);
  audioPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (deps?.ghostMode() && !deps?.isWidgetPinned("audio")) return;
    void refreshAudio(false);
  }, 2000);
}

export function stopAudioPolling(): void {
  if (audioPollTimer !== null) {
    window.clearInterval(audioPollTimer);
    audioPollTimer = null;
  }
}

export function scheduleAudioVolume(id: string, volume: number): void {
  const previous = audioVolumeTimers.get(id);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    audioVolumeTimers.delete(id);
    void invoke("overlay_audio_set_volume", { id, volume }).catch(() => undefined);
  }, 60);
  audioVolumeTimers.set(id, timer);
}

export function scheduleAudioMaster(volume: number): void {
  if (audioMasterTimer !== null) window.clearTimeout(audioMasterTimer);
  audioMasterTimer = window.setTimeout(() => {
    audioMasterTimer = null;
    void invoke("overlay_audio_set_master", { volume }).catch(() => undefined);
  }, 60);
}

export async function toggleAudioMute(id: string): Promise<void> {
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

export async function toggleAudioMasterMute(): Promise<void> {
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


/** Slider drags pause the poll so the value under the pointer wins. */
export function holdAudioLevels(): void {
  audioHoldUntil = performance.now() + 1500;
}

export function selectAudioPreset(name: string): void {
  audioPresetSelected = name;
}

export function handleAudioPresetAction(action: string): void {
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
}

export function setAudioDevice(id: string): void {
  void invoke("overlay_audio_set_device", { id })
    .then(() => refreshAudio(true))
    .catch((error) => toast(String(error), "err"));
}
