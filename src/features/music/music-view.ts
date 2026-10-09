/**
 * Launcher Spotify page: the normal `open.spotify.com` interface in an embedded
 * child webview, plus the librespot playback engine controls.
 *
 * WebView2 has no Widevine CDM, so the web player cannot decrypt audio itself;
 * the toolbar starts the launcher's Spotify Connect receiver ("Efxlve
 * Launcher") and the user picks it as the playback device inside the page.
 * Search, library, playlists and the queue are the real Spotify UI.
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { icon } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import { storeLogo } from "../store/store-logos";
import {
  spotifyPlaybackForget,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  spotifyPlaybackStop,
  type SpotifyPlaybackStatus,
} from "./spotify-client";

interface Message {
  text: string;
  kind: "info" | "error" | "ok";
}

let playback: SpotifyPlaybackStatus = { paired: false, running: false, deviceName: "Efxlve Launcher" };
let busy = false;
let message: Message | null = null;
let pollTimer: number | null = null;
let playerVisible = false;
let lastPaintKey = "";
let autoStarted = false;

/** Roots that paint above the content area: the child webview must hide then. */
const COVER_ROOTS = [
  "palette-root",
  "modal-root",
  "install-root",
  "manage-root",
  "storage-root",
  "selective-root",
  "playtime-root",
  "collection-root",
  "cover-modal-root",
  "move-modal-root",
];

function onMusicView(): boolean {
  return Boolean(viewEl?.querySelector(".music"));
}

function coversOpen(): boolean {
  return COVER_ROOTS.some((id) => document.getElementById(id)?.firstElementChild);
}

/* ---------- Rendering ---------- */

export function renderMusic(): string {
  if (!isTauri) {
    return `<div class="music music-embedded"><div class="card music-connect"><h2>${esc(t("music.title"))}</h2><p class="music-note">${esc(t("music.desktopOnly"))}</p></div></div>`;
  }
  return `
    <div class="music music-embedded">
      <div class="card music-top">
        <div class="music-brand">${storeLogo("spotify", 22)}<span>Spotify</span></div>
        <span id="music-engine-chip" class="${engineChipClass()}">${esc(engineChipText())}</span>
        <div class="music-playback-actions">
          <span id="music-engine-actions">${engineActionsHtml()}</span>
          <button class="btn ghost small" data-music="player-reload">${icon("refresh", 14)} ${esc(t("music.reload"))}</button>
          <button class="btn ghost small" data-music="open-external">${icon("external", 14)} ${esc(t("music.openInBrowser"))}</button>
        </div>
      </div>
      <p class="music-note">${esc(t("music.playerHint", { name: playback.deviceName }))}</p>
      <div class="music-webview-slot" id="music-webview-slot"></div>
      <p class="music-note${message ? ` ${message.kind}` : ""}" id="music-message">${message ? esc(message.text) : ""}</p>
    </div>`;
}

function engineChipClass(): string {
  if (playback.running) return "chip ok";
  if (playback.paired) return "chip";
  return "chip warn";
}

function engineChipText(): string {
  if (playback.running) {
    return t("music.playbackRunning", { name: playback.deviceName });
  }
  if (playback.paired) {
    return t("music.playbackPaired");
  }
  return t("music.playbackEnable");
}

function engineActionsHtml(): string {
  if (playback.running) {
    return `<button class="btn primary" data-music="playback-stop">${esc(t("music.playbackStop"))}</button>
      <button class="btn ghost small" data-music="playback-forget">${esc(t("music.playbackForget"))}</button>`;
  }
  const label = busy
    ? t("music.playbackWaiting")
    : playback.paired
    ? t("music.playbackStart")
    : t("music.playbackEnable");
  return `<button class="btn primary" data-music="playback-start" ${busy ? "disabled" : ""}>${icon("monitor", 14)} ${esc(label)}</button>
    ${playback.paired ? `<button class="btn ghost small" data-music="playback-forget">${esc(t("music.playbackForget"))}</button>` : ""}`;
}

function fail(error: unknown): void {
  message = { text: String(error).replace(/^Error: /, ""), kind: "error" };
}

/* ---------- Embedded player placement ---------- */

export function hydrateMusic(): void {
  ensurePolling();
  void refreshStatus();
  syncPlayer();
}

/** Hides the child webview when another page takes over. */
export function hideSpotifyPlayer(): void {
  if (!playerVisible) return;
  playerVisible = false;
  void invoke("spotify_player_hide").catch(() => undefined);
}

function syncPlayer(): void {
  const slot = document.getElementById("music-webview-slot");
  if (!slot || !onMusicView() || coversOpen()) {
    hideSpotifyPlayer();
    return;
  }
  const rect = slot.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return;
  playerVisible = true;
  void invoke("spotify_player_show", {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }).catch(() => undefined);
}

function ensurePolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden || !onMusicView()) return;
    void refreshStatus();
  }, 2500);
  window.addEventListener("resize", () => {
    if (playerVisible) syncPlayer();
  });
  const observer = new MutationObserver(() => {
    if (onMusicView()) syncPlayer();
  });
  for (const id of COVER_ROOTS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { childList: true });
  }
}

/* ---------- Engine state ---------- */

async function refreshStatus(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  if (!status) return;
  playback = status;
  paintToolbar();
  // A stored approval needs no browser: bring the receiver up automatically so
  // the page can play on this computer right away.
  if (playback.paired && !playback.running && !busy && !autoStarted) {
    autoStarted = true;
    void startEngine(false);
  }
}

function paintToolbar(): void {
  const key = `${playback.paired}:${playback.running}:${busy}:${message?.text ?? ""}`;
  if (key === lastPaintKey) return;
  lastPaintKey = key;
  const chip = document.getElementById("music-engine-chip");
  if (chip) {
    chip.className = engineChipClass();
    chip.textContent = engineChipText();
  }
  const actions = document.getElementById("music-engine-actions");
  if (actions) actions.innerHTML = engineActionsHtml();
  const note = document.getElementById("music-message");
  if (note) {
    note.className = `music-note${message ? ` ${message.kind}` : ""}`;
    note.textContent = message?.text ?? "";
  }
}

async function startEngine(userInitiated: boolean): Promise<void> {
  busy = true;
  if (userInitiated) message = null;
  paintToolbar();
  try {
    playback = await spotifyPlaybackStart();
    message = { text: t("music.playbackReady"), kind: "ok" };
  } catch (error) {
    if (userInitiated) fail(error);
    autoStarted = false;
  }
  busy = false;
  await refreshStatus();
}

/* ---------- Actions ---------- */

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>("[data-music]");
  const action = el?.dataset.music;
  if (!action) return;

  if (action === "playback-start") {
    void startEngine(true);
    return;
  }
  if (action === "playback-stop") {
    void (async () => {
      await spotifyPlaybackStop().catch(() => undefined);
      await refreshStatus();
    })();
    return;
  }
  if (action === "playback-forget") {
    void (async () => {
      await spotifyPlaybackForget().catch(() => undefined);
      await refreshStatus();
    })();
    return;
  }
  if (action === "player-reload") {
    void invoke("spotify_player_reload").catch(() => undefined);
    return;
  }
  if (action === "open-external") {
    void openUrl("https://open.spotify.com/");
  }
});
