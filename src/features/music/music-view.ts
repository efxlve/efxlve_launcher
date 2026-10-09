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
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import { setView } from "../store/store-view";
import {
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  type SpotifyPlaybackStatus,
} from "./spotify-client";

let playback: SpotifyPlaybackStatus = { paired: false, running: false, deviceName: "Efxlve Launcher" };
let engineBusy = false;
let engineAttempted = false;
let pollTimer: number | null = null;
let playerVisible = false;

/** The overlay asked to open a Spotify link here: show the page. */
if (isTauri) {
  void listen("spotify-open", () => {
    setView("music");
    render();
  });
}

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
  host.innerHTML = `
    <button class="btn ghost small" data-music="player-back">${icon("arrow-left", 14)} ${esc(t("music.back"))}</button>
    <button class="btn ghost small" data-music="player-reload">${icon("refresh", 14)} ${esc(t("music.reload"))}</button>
    ${pairBtn}`;
  host.classList.add("has-actions");
}

/* ---------- Embedded player placement ---------- */

export function hydrateMusic(): void {
  ensurePolling();
  observeSlot();
  void refreshStatus();
  paintHeaderActions();
  syncPlayer();
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
  const observer = new MutationObserver(() => {
    if (onMusicView()) syncPlayer();
  });
  for (const id of COVER_ROOTS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { childList: true });
  }
}

/* ---------- Playback engine (automatic) ---------- */

async function refreshStatus(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  if (!status) return;
  const wasPaired = playback.paired;
  playback = status;
  if (wasPaired !== status.paired) paintHeaderActions();
  // Only start automatically if already paired; avoids unprompted browser popups.
  if (playback.paired && !playback.running && !engineBusy && !engineAttempted) {
    engineAttempted = true;
    void startEngine();
  }
}

async function startEngine(): Promise<void> {
  engineBusy = true;
  try {
    playback = await spotifyPlaybackStart();
    paintHeaderActions();
  } catch (error) {
    engineAttempted = false;
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
  }
});
