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
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import {
  spotifyPlaybackForget,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  spotifyPlaybackStop,
  type SpotifyPlaybackStatus,
} from "./spotify-client";

let playback: SpotifyPlaybackStatus = { paired: false, running: false, deviceName: "Efxlve Launcher" };
let busy = false;
let pollTimer: number | null = null;
let playerVisible = false;
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
      <div class="music-webview-slot" id="music-webview-slot"></div>
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

/** Header row: engine chip and controls, only while the Spotify page is open. */
function paintHeaderActions(): void {
  const host = document.getElementById("page-header-actions");
  if (!host) return;
  if (!onMusicView()) {
    if (host.childElementCount > 0) host.innerHTML = "";
    host.classList.remove("has-actions");
    host.dataset.key = "";
    return;
  }
  const key = `${playback.paired}:${playback.running}:${busy}`;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  // The chip only adds information once an approval exists; before that the
  // button already says "Enable playback".
  const chip = playback.paired
    ? `<span class="${engineChipClass()}" title="${esc(t("music.playerHint", { name: playback.deviceName }))}">${esc(engineChipText())}</span>`
    : "";
  host.innerHTML = `
    ${chip}
    ${engineActionsHtml()}
    <button class="btn ghost small" data-music="player-reload">${icon("refresh", 14)} ${esc(t("music.reload"))}</button>
    <button class="btn ghost small" data-music="open-external">${icon("external", 14)} ${esc(t("music.openInBrowser"))}</button>`;
  host.classList.add("has-actions");
}

function fail(error: unknown): void {
  toast(String(error).replace(/^Error: /, ""), "err");
}

/* ---------- Embedded player placement ---------- */

export function hydrateMusic(): void {
  ensurePolling();
  void refreshStatus();
  paintHeaderActions();
  syncPlayer();
}

/** Hides the child webview when another page takes over. */
export function hideSpotifyPlayer(): void {
  paintHeaderActions();
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
  paintHeaderActions();
  // A stored approval needs no browser: bring the receiver up automatically so
  // the page can play on this computer right away.
  if (playback.paired && !playback.running && !busy && !autoStarted) {
    autoStarted = true;
    void startEngine(false);
  }
}

async function startEngine(userInitiated: boolean): Promise<void> {
  busy = true;
  paintHeaderActions();
  try {
    playback = await spotifyPlaybackStart();
    toast(t("music.playbackReady"), "ok");
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
