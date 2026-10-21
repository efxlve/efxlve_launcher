/**
 * Launcher Spotify page: the normal `open.spotify.com` interface in an embedded
 * child webview, plus the librespot playback engine.
 *
 * WebView2 has no Widevine CDM, so the web player cannot decrypt audio itself;
 * the launcher runs a Spotify Connect receiver ("Efxlve Launcher") in the
 * background and the user picks it as the playback device inside the page.
 * Search, library, playlists and the queue are the real Spotify UI.
 *
 * The only header controls are Back and Reload: signing into Spotify is all a
 * user has to do. The first visit opens the one-time playback approval in the
 * browser by itself.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import { COVERING_ROOT_IDS, setView } from "../store/store-view";
import {
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  type SpotifyPlaybackStatus,
} from "./spotify-client";

let playback: SpotifyPlaybackStatus = { paired: false, running: false, deviceName: "Efxlve Launcher" };
let engineBusy = false;
let pollTimer: number | null = null;
let playerVisible = false;

/** The overlay asked to open a Spotify link here: show the page. */
if (isTauri) {
  void listen("spotify-open", () => {
    setView("music");
    render();
  });
}

function onMusicView(): boolean {
  // The view host can still hold the music markup after the page changed (the
  // store page renders into the child webview), so the page state decides:
  // only the current view may bring the embedded player back.
  return S.view === "music" && Boolean(viewEl?.querySelector(".music"));
}

function coversOpen(): boolean {
  return COVERING_ROOT_IDS.some((id) => document.getElementById(id)?.firstElementChild);
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

/** Header row: Back, Reload, and Pair Connect Receiver only when unpaired. */
function paintHeaderActions(): void {
  const host = document.getElementById("page-header-actions");
  if (!host) return;
  if (!onMusicView()) {
    if (host.childElementCount > 0) host.innerHTML = "";
    host.classList.remove("has-actions");
    host.dataset.ready = "";
    return;
  }
  const pairBtn = !playback.paired
    ? `<button class="btn ghost small" data-music="player-pair" title="${esc(t("music.playbackPairingToast"))}">${icon("music", 14)} ${esc(t("accounts.openMusic"))}</button>`
    : "";
  const startBtn = playback.paired && !playback.running
    ? `<button class="btn ghost small" data-music="player-start">${icon("play", 14)} ${esc(t("music.startEngine"))}</button>`
    : "";
  // Back and Reload live in the player's own bar now (spotify_extension.js
  // injects them there); only the pairing hint stays in the launcher header.
  host.innerHTML = pairBtn + startBtn;
  host.classList.toggle("has-actions", Boolean(pairBtn || startBtn));
}

/* ---------- Embedded player placement ---------- */

/** Wires the Spotify page once it is on screen. */
export function hydrateMusic(): void {
  ensurePolling();
  observeSlot();
  void refreshStatus();
  paintHeaderActions();
  syncPlayer();
  // The Spotify receiver is started only when the user asks for it. Starting
  // librespot while the Music page paints could take the whole launcher down on
  // machines where its audio backend fails before any interaction happened.
  // The page-enter animation slides the view for a moment; re-apply the
  // rectangle afterwards so the webview sits flush under the header.
  window.setTimeout(() => {
    if (playerVisible) syncPlayer();
  }, 450);
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

/** rAF-throttled reposition: the sidebar drag/drawer moves the slot each frame. */
function scheduleSync(): void {
  if (syncRaf !== null) return;
  syncRaf = window.requestAnimationFrame(() => {
    syncRaf = null;
    syncPlayer();
  });
  // A trailing pass lands on the final rectangle once the transition ends.
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    if (playerVisible) syncPlayer();
  }, 340);
}

/**
 * The slot's rectangle changes when the sidebar resizes or drawers open/close
 * (no window resize event fires for those), so follow its size directly.
 */
function observeSlot(): void {
  const slot = document.getElementById("music-webview-slot");
  if (!slot || typeof ResizeObserver === "undefined") return;
  slotObserver?.disconnect();
  slotObserver = new ResizeObserver(() => {
    if (onMusicView()) scheduleSync();
  });
  slotObserver.observe(slot);
}

let slotObserver: ResizeObserver | null = null;
let syncRaf: number | null = null;
let settleTimer: number | null = null;

function ensurePolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden || !onMusicView()) return;
    void refreshStatus();
  }, 2500);
  window.addEventListener("resize", () => {
    if (playerVisible) syncPlayer();
  });
  // Any covering surface (the changelog, a dialog, the palette) parks the child.
  const observer = new MutationObserver(() => {
    if (onMusicView()) syncPlayer();
  });
  for (const id of COVERING_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { childList: true });
  }
}

/* ---------- Playback engine (automatic) ---------- */

async function refreshStatus(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  if (!status) return;
  const wasPaired = playback.paired;
  const wasRunning = playback.running;
  playback = status;
  if (wasPaired !== status.paired || wasRunning !== status.running) paintHeaderActions();
}

/* ---------- Playback engine (explicit) ---------- */

async function startEngine(): Promise<void> {
  engineBusy = true;
  try {
    playback = await spotifyPlaybackStart();
    paintHeaderActions();
  } catch (error) {
    toast(String(error).replace(/^Error: /, ""), "err");
  }
  engineBusy = false;
}

/* ---------- Actions ---------- */

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-music]")?.dataset.music;
  if (!action) return;

  if (action === "player-back") {
    void invoke("spotify_player_back").catch(() => undefined);
    return;
  }
  if (action === "player-reload") {
    void invoke("spotify_player_reload").catch(() => undefined);
    return;
  }
  if (action === "player-pair") {
    toast(t("music.playbackPairingToast"), "");
    void startEngine();
    return;
  }
  if (action === "player-start") {
    void startEngine();
  }
});
