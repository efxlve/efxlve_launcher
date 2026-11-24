/**
 * Overlay Music/Spotify view: the media card, the full player, the playlists
 * browser and the Spotify Connect engine bridge.
 *
 * One-way dependency: the page configures widget queries through
 * configureMusic; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { icon } from "../../core/icons";
import { IS_WINDOWS } from "../../core/platform";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
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
import { emptyBlockHtml, setText } from "./overlay-view-helpers";

interface MusicDeps {
  isWidgetOpen: (tab: "music") => boolean;
  viewEl: (tab: "music") => HTMLElement | null;
  renderHome: () => void;
  syncWidgetSizeClasses: (tab: string, w: number, h: number) => void;
}

let deps: MusicDeps | null = null;

export function configureMusic(next: MusicDeps): void {
  deps = next;
}

function musicOpen(): boolean {
  return deps?.isWidgetOpen("music") ?? false;
}

function musicView(): HTMLElement | null {
  return deps?.viewEl("music") ?? null;
}

/** The launcher's Connect receiver (the only source the overlay shows). */
let spotifyEngineOn = false;
let spotifyPaired = false;
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

export function getOverlayMedia(): OverlayMediaModel {
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

export function spotifyLogoSvg(size = 48): string {
  return `<svg class="ov-sp-logo-svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.563.387-.857.208-2.35-1.435-5.308-1.76-8.793-.963-.335.077-.67-.133-.746-.468-.077-.334.132-.67.467-.746 3.808-.87 7.076-.505 9.72 1.11.295.18.388.563.209.858zm1.224-2.72c-.226.368-.71.482-1.077.256-2.69-1.653-6.79-2.132-9.97-1.167-.412.124-.852-.11-.977-.522-.124-.412.11-.852.522-.977 3.633-1.102 8.147-.568 11.246 1.332.367.227.48.71.256 1.078zm.105-2.835C14.692 8.92 9.375 8.745 6.297 9.68c-.495.15-1.02-.132-1.17-.626-.15-.494.133-1.02.627-1.17 3.535-1.073 9.404-.866 13.14 1.352.444.264.59.84.327 1.284-.264.444-.84.59-1.284.327z"/></svg>`;
}

let lastSpotifyStartAttempt = 0;

/** Ensures the Spotify playback engine is running in the background silently. */
export function ensureSpotifyEngine(force = false): void {
  // The Connect receiver is built on librespot, which ships on Windows only; the
  // web player in the launcher's Spotify page keeps working on other platforms.
  if (!IS_WINDOWS) return;
  // An unpaired receiver would open Spotify's approval page in the browser, so
  // only an explicit user action may start it before pairing. A paired receiver
  // comes up quietly in the background.
  if (!force && !spotifyPaired) return;
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
export async function refreshMedia(): Promise<void> {
  // No Connect receiver outside Windows: skip the poll instead of asking for a
  // status that is always idle.
  if (!IS_WINDOWS) return;
  const status = await spotifyPlaybackStatus().catch(() => null);
  spotifyEngineOn = status?.running === true;
  spotifyPaired = status?.paired === true;
  spotifyDeviceName = status?.deviceName ?? "";
  // Opening the music widget is a user request to use Spotify: a paired
  // receiver may start on its own then. Opening the panel for performance or
  // captures never starts it.
  if (!spotifyEngineOn && spotifyPaired && musicOpen()) {
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
    if (musicOpen()) renderMusicTab();
    else deps?.renderHome();
    return;
  }
  patchMediaSurfaces();
}

/** Home media card header (always the launcher's Spotify receiver). */
export function mediaCardTitleHtml(): string {
  return `${icon("spotify", 14)} <span class="title-text">${esc(t("overlay.tabSpotify"))}</span>`;
}

/** Home dashboard media card content. */
export function mediaCardInnerHtml(): string {
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

export function updateMusicMiniViewState(): void {
  const widget = document.getElementById("ov-widget-music");
  if (!widget) return;
  widget.dataset.miniView = spotifyMiniView;
  const btn = document.getElementById("ov-sp-mini-toggle-btn");
  if (btn) {
    btn.innerHTML = spotifyMiniView === "player" ? icon("list", 12) : icon("music", 12);
    btn.title = spotifyMiniView === "player" ? t("overlay.library") : "Player";
  }
}

export function renderMusicTab(): void {
  const el = musicView();
  if (!el) return;
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
    deps?.syncWidgetSizeClasses("music", widget.offsetWidth, widget.offsetHeight);
    updateMusicMiniViewState();
  }
}

export function unifiedPlayerHtml(m: OverlayMediaModel): string {
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
            <div class="ov-media-source" id="ov-sp-source-badge">${esc(m.source)}</div>
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
          <div class="ov-sp-volume" title="${esc(t("mini.volume"))}">
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

export function libraryTabsHtml(): string {
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
        ${spotifySearchQuery ? `<button class="ov-sp-search-clear" data-ov="sp-clear-search" title="${esc(t("common.clear"))}">${icon("x", 12)}</button>` : ""}
      </div>` : ""}`;
}

export function libraryHtml(): string {
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

export function setMusicViewMode(mode: "playlists" | "tracks"): void {
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

export function retryButtonHtml(): string {
  return `<button class="btn ghost small" data-ov="sp-refresh-library">${icon("refresh", 13)} ${esc(t("overlay.retry"))}</button>`;
}

export function renderPlaylistList(): void {
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
      host.innerHTML = emptyBlockHtml("search", t("common.noResults"), t("lib.noResultsHint"));
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

export function renderTrackList(): void {
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
      host.innerHTML = trackHeaderHtml + emptyBlockHtml("search", t("common.noResults"), t("lib.noResultsHint"));
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
export async function ensurePlaylists(force = false): Promise<void> {
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
export async function selectPlaylist(uri: string): Promise<void> {
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
    const tracks = await spotifyPlaybackPlaylistTracks(uri);
    // A slower earlier request must not replace the playlist the user is on.
    if (tracksFor !== uri) return;
    playlistTracks = tracks;
    tracksState = "ready";
  } catch (error) {
    if (tracksFor !== uri) return;
    tracksError = String(error).replace(/^Error: /, "");
    tracksState = "error";
  }
  renderTrackList();
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
}

/** Starts the open playlist at the clicked track. */
export async function playTrack(trackUri: string): Promise<void> {
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
export async function openSpotifyLink(): Promise<void> {
  const url = spotifyNow?.url && spotifyNow.url !== "spotify:" ? spotifyNow.url : "https://open.spotify.com/";
  try {
    const opened = await invoke<boolean>("spotify_open_in_launcher", { url });
    if (opened) return;
  } catch {
    // Fall through to the browser.
  }
  void openUrl(url).catch(() => undefined);
}

/** Forces a library refresh (the Rust caches are bypassed). */
export async function refreshLibrary(): Promise<void> {
  if (musicViewMode === "tracks" && selectedPlaylist) {
    const requested = selectedPlaylist;
    tracksFor = requested;
    tracksState = "loading";
    tracksError = "";
    renderTrackList();
    try {
      const tracks = await spotifyPlaybackPlaylistTracks(requested);
      if (selectedPlaylist !== requested || tracksFor !== requested) return;
      playlistTracks = tracks;
      tracksState = "ready";
    } catch (error) {
      if (selectedPlaylist !== requested || tracksFor !== requested) return;
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
export function patchMediaSurfaces(): void {
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
    if (badge) badge.textContent = m.source;
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
export function paintSpotifyProgress(): void {
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
export async function overlaySpotifyControl(
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


/** The player's current Spotify state; the page wiring reads it for controls. */
export function spotifyPlaybackState(): NowPlaying | null {
  return spotifyNow;
}

/** A new panel session starts from a clean player/library state. */
export function resetMusicSession(): void {
  spotifyEngineOn = false;
  spotifyDeviceName = "";
  spotifyNow = null;
  spotifyBaseMs = 0;
  spotifyBaseAt = 0;
  lastMediaActive = false;
  // The open library tab, mini-view and search are panel UI, not the Connect
  // session: they survive a close/reopen by design. Only the engine resets.
  if (!selectedPlaylist) musicViewMode = "playlists";
}

export function toggleSpotifyMiniView(): void {
  spotifyMiniView = spotifyMiniView === "player" ? "library" : "player";
  updateMusicMiniViewState();
}

export function toggleSpotifySearch(): void {
  spotifySearchOpen = !spotifySearchOpen;
  if (!spotifySearchOpen) spotifySearchQuery = "";
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
  if (musicViewMode === "playlists") renderPlaylistList();
  else renderTrackList();
  if (spotifySearchOpen) {
    window.setTimeout(() => document.getElementById("ov-sp-search-input")?.focus(), 50);
  }
}

export function clearSpotifySearch(): void {
  spotifySearchQuery = "";
  const header = document.getElementById("ov-sp-library-header");
  if (header) header.innerHTML = libraryTabsHtml();
  if (musicViewMode === "playlists") renderPlaylistList();
  else renderTrackList();
}

export function setSpotifySearchQuery(value: string): void {
  spotifySearchQuery = value;
  if (musicViewMode === "playlists") renderPlaylistList();
  else renderTrackList();
}

export function toggleSpotifyPlay(): void {
  if (spotifyNow) void overlaySpotifyControl(spotifyNow.isPlaying ? "pause" : "play");
}

export function skipSpotifyTrack(direction: -1 | 1): void {
  if (spotifyNow) void overlaySpotifyControl(direction < 0 ? "previous" : "next");
}

export function cycleSpotifyShuffle(): void {
  void overlaySpotifyControl("shuffle", spotifyNow?.shuffle ? 0 : 1);
}

export function cycleSpotifyRepeat(): void {
  const next = spotifyNow?.repeat === "off" ? 1 : spotifyNow?.repeat === "context" ? 2 : 0;
  void overlaySpotifyControl("repeat", next);
}

export function seekSpotifyFromPointer(clientX: number): void {
  const bar = document.getElementById("ov-sp-progress");
  const media = getOverlayMedia();
  if (bar && media.durationMs && media.canSeek) {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    void overlaySpotifyControl("seek", Math.round(ratio * media.durationMs));
  }
}
