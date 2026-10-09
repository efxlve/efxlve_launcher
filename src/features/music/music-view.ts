/**
 * Launcher Music page: Spotify Web API player (PKCE login, transport, volume,
 * devices and playlists). The in-game overlay reuses the same Rust commands.
 *
 * The page renders once and every later update patches the DOM in place, so a
 * 2.5 s poll never interrupts dragging the volume slider or reading the page.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import { scheduleRender } from "../../core/render";
import { viewEl } from "../../core/dom";
import { storeLogo } from "../store/store-logos";
import {
  formatTime,
  spotifyCancelLogin,
  spotifyControl,
  spotifyDevices,
  spotifyLibrary,
  spotifyLogin,
  spotifyLogout,
  spotifyNowPlaying,
  spotifyPlay,
  spotifyPlaybackForget,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  spotifyPlaybackStop,
  spotifySearch,
  spotifySetClientId,
  spotifyStatus,
  spotifyTransfer,
  type NowPlaying,
  type SpotifyAlbum,
  type SpotifyArtist,
  type SpotifyDevice,
  type SpotifyLibrary,
  type SpotifyPlaybackStatus,
  type SpotifySearchResults,
  type SpotifyStatus,
  type SpotifyTrack,
} from "./spotify-client";

interface Message {
  text: string;
  kind: "info" | "error" | "ok";
}

interface MusicState {
  loaded: boolean;
  status: SpotifyStatus;
  now: NowPlaying | null;
  devices: SpotifyDevice[];
  playback: SpotifyPlaybackStatus;
  playbackBusy: boolean;
  /** Browse: search box, results and the library tabs. */
  searchQuery: string;
  searchBusy: boolean;
  results: SpotifySearchResults | null;
  library: SpotifyLibrary | null;
  libraryTab: "liked" | "playlists" | "albums" | "artists";
  message: Message | null;
  loginBusy: boolean;
  /** Playback position anchor so the progress bar moves between polls. */
  progressBaseMs: number;
  progressBaseAt: number;
  lastDeviceKey: string;
  lastPlaybackKey: string;
  lastBrowseKey: string;
}

const state: MusicState = {
  loaded: false,
  status: { clientIdSet: false, connected: false, user: "", product: "", error: "" },
  now: null,
  devices: [],
  playback: { paired: false, running: false, deviceName: "Efxlve Launcher" },
  playbackBusy: false,
  searchQuery: "",
  searchBusy: false,
  results: null,
  library: null,
  libraryTab: "liked",
  message: null,
  loginBusy: false,
  progressBaseMs: 0,
  progressBaseAt: 0,
  lastDeviceKey: "",
  lastPlaybackKey: "",
  lastBrowseKey: "",
};

let pollTimer: number | null = null;
let tick = 0;

/* ---------- Rendering ---------- */

/** Full page markup. Called by the main render orchestrator. */
export function renderMusic(): string {
  if (!isTauri) {
    return `<div class="music"><div class="card music-connect"><h2>${esc(t("music.title"))}</h2><p class="music-note">${esc(t("music.desktopOnly"))}</p></div></div>`;
  }
  if (!state.loaded) {
    return `<div class="music"><div class="card music-connect"><p class="music-note">${esc(t("common.calculating"))}</p></div></div>`;
  }
  if (!state.status.connected) return renderConnect();
  return renderPlayer();
}

function renderConnect(): string {
  const draft = "";
  const withId = state.status.clientIdSet;
  return `
    <div class="music">
      <div class="card music-connect">
        <div class="music-brand">${storeLogo("spotify", 22)}<span>Spotify</span></div>
        <h2>${esc(t("music.connectTitle"))}</h2>
        <p class="music-note">${esc(t("music.connectDesc"))}</p>
        <ol class="music-steps">
          <li>${esc(t("music.step1"))}</li>
          <li>
            ${esc(t("music.step2"))} <code id="music-redirect-uri">http://127.0.0.1:8899/callback</code>
            <button class="btn ghost small" data-music="copy-redirect" id="music-copy-redirect">${icon("clipboard", 13)} ${esc(t("music.copyRedirect"))}</button>
          </li>
          <li>${esc(t("music.step3"))}</li>
        </ol>
        <div class="music-connect-row">
          <input id="music-client-id" class="music-input" type="text" spellcheck="false"
            placeholder="${esc(t("music.clientIdPlaceholder"))}" value="${esc(draft)}" ${withId ? "" : "autofocus"} />
          <button class="btn primary" data-music="connect" ${state.loginBusy ? "disabled" : ""}>
            ${icon("user", 14)} ${esc(withId ? t("music.signIn") : t("music.saveAndConnect"))}
          </button>
          <button class="btn ghost small" data-music="create-app">${icon("external", 14)} ${esc(t("music.createApp"))}</button>
          ${state.loginBusy ? `<button class="btn ghost small" data-music="cancel">${esc(t("music.cancel"))}</button>` : ""}
        </div>
        <p class="music-note">${esc(t("music.smtcHint"))}</p>
        ${state.loginBusy ? `<p class="music-note">${esc(t("music.waitingForBrowser"))}</p>` : ""}
        ${state.message ? `<p class="music-note ${state.message.kind}">${esc(state.message.text)}</p>` : ""}
      </div>
    </div>`;
}

function renderPlayer(): string {
  const now = state.now;
  return `
    <div class="music">
      <div class="card music-top">
        <div class="music-brand">${storeLogo("spotify", 22)}<span>Spotify</span></div>
        <span class="chip">${esc(t("music.connectedAs", { user: state.status.user || "Spotify" }))}</span>
        ${state.status.product && state.status.product !== "premium" ? `<span class="chip warn">${esc(t("music.freeHint"))}</span>` : ""}
        <button class="btn ghost small" data-music="logout">${esc(t("music.signOut"))}</button>
      </div>

      <div class="card music-player">
        <img class="music-art" id="music-art" src="${esc(now?.artUrl || "")}" alt="" />
        <div class="music-info">
          <div class="music-title" id="music-title">${esc(now?.title || t("music.nothingPlaying"))}</div>
          <div class="music-artist" id="music-artist">${esc(now?.artist || "")}</div>
          <div class="music-album" id="music-album">${esc(now?.album || "")}</div>

          <div class="music-progress" id="music-progress" data-music="seek" title="${esc(t("music.seek"))}">
            <div class="music-progress-fill" id="music-progress-fill"></div>
          </div>
          <div class="music-times">
            <span id="music-elapsed">0:00</span>
            <span id="music-duration">${now ? formatTime(now.durationMs) : "0:00"}</span>
          </div>

          <div class="music-controls">
            <button class="icon-btn${now?.shuffle ? " active" : ""}" id="music-shuffle" data-music="shuffle" title="${esc(t("music.shuffle"))}">${icon("shuffle", 16)}</button>
            <button class="icon-btn" data-music="previous" title="${esc(t("music.previous"))}">${icon("skip-back", 20)}</button>
            <button class="btn primary music-toggle" id="music-toggle" data-music="toggle" title="${esc(t("music.playPause"))}">${icon(now?.isPlaying ? "pause" : "play", 20)}</button>
            <button class="icon-btn" data-music="next" title="${esc(t("music.next"))}">${icon("skip-forward", 20)}</button>
            <button class="icon-btn${now?.repeat && now.repeat !== "off" ? " active" : ""}" id="music-repeat" data-music="repeat" title="${esc(t("music.repeat"))}">${icon("repeat", 16)}</button>
          </div>

          <div class="music-extras">
            <span class="music-extras-label">${icon("monitor", 14)} ${esc(t("music.devicesTitle"))}</span>
            <select id="music-device" class="music-select" data-music="device"></select>
            <div class="music-volume">
              ${icon("volume-2", 15)}
              <input type="range" id="music-volume" min="0" max="100" value="${now?.volumePercent ?? 100}" />
              <span class="music-volume-value" id="music-volume-value">${now?.volumePercent ?? 100}%</span>
            </div>
            <button class="btn ghost small" data-music="open-spotify" ${now?.url ? "" : "disabled"}>${icon("external", 14)} ${esc(t("music.openSpotify"))}</button>
          </div>
        </div>
      </div>

      <div class="card music-browse" id="music-browse-card">${browseCardHtml()}</div>

      <div class="card music-playback" id="music-playback-card">${playbackCardHtml()}</div>

      ${state.message ? `<p class="music-note ${state.message.kind}">${esc(state.message.text)}</p>` : ""}
    </div>`;
}

/** Search box plus the results/library body. */
function browseCardHtml(): string {
  const searching = state.results !== null;
  return `
    <div class="music-search-row">
      <input id="music-search" class="music-input" type="search" spellcheck="false"
        placeholder="${esc(t("music.searchPlaceholder"))}" value="${esc(state.searchQuery)}" />
      <button class="btn primary" data-music="search-go" ${state.searchBusy ? "disabled" : ""}>
        ${icon("search", 14)} ${esc(state.searchBusy ? t("music.loading") : t("music.search"))}
      </button>
      ${searching ? `<button class="btn ghost small" data-music="search-clear">${esc(t("music.searchClear"))}</button>` : ""}
    </div>
    ${searching ? searchBodyHtml() : libraryBodyHtml()}`;
}

function sectionTitle(label: string, count: number): string {
  return `<div class="music-section-title">${esc(label)} <span>${count}</span></div>`;
}

function searchBodyHtml(): string {
  const results = state.results;
  if (!results) return "";
  const empty =
    results.tracks.length === 0 &&
    results.albums.length === 0 &&
    results.artists.length === 0 &&
    results.playlists.length === 0;
  if (empty) return `<p class="music-note">${esc(t("music.noResults"))}</p>`;
  return `
    ${results.tracks.length ? sectionTitle(t("music.resultsTracks"), results.tracks.length) + `<div class="music-track-list">${results.tracks.map(trackRowHtml).join("")}</div>` : ""}
    ${results.albums.length ? sectionTitle(t("music.resultsAlbums"), results.albums.length) + `<div class="music-card-grid">${results.albums.map(albumCardHtml).join("")}</div>` : ""}
    ${results.artists.length ? sectionTitle(t("music.resultsArtists"), results.artists.length) + `<div class="music-card-grid">${results.artists.map(artistCardHtml).join("")}</div>` : ""}
    ${results.playlists.length ? sectionTitle(t("music.resultsPlaylists"), results.playlists.length) + `<div class="music-card-grid">${results.playlists.map(playlistCardHtml).join("")}</div>` : ""}`;
}

function libraryBodyHtml(): string {
  const library = state.library;
  const tabs: { id: typeof state.libraryTab; key: string }[] = [
    { id: "liked", key: "music.libraryLiked" },
    { id: "playlists", key: "music.libraryPlaylists" },
    { id: "albums", key: "music.libraryAlbums" },
    { id: "artists", key: "music.libraryArtists" },
  ];
  const tabRow = `<div class="music-tabs">${tabs
    .map(
      (tab) =>
        `<button class="music-tab${state.libraryTab === tab.id ? " active" : ""}" data-music="library-tab" data-tab="${tab.id}">${esc(t(tab.key))}</button>`,
    )
    .join("")}</div>`;
  if (!library) return `${tabRow}<p class="music-note">${esc(t("music.loading"))}</p>`;
  let body = "";
  if (state.libraryTab === "liked") {
    body = library.tracks.length
      ? `<div class="music-track-list">${library.tracks.map(trackRowHtml).join("")}</div>`
      : `<p class="music-note">${esc(t("music.noResults"))}</p>`;
  } else if (state.libraryTab === "playlists") {
    body = library.playlists.length
      ? `<div class="music-card-grid">${library.playlists.map(playlistCardHtml).join("")}</div>`
      : `<p class="music-note">${esc(t("music.noPlaylists"))}</p>`;
  } else if (state.libraryTab === "albums") {
    body = library.albums.length
      ? `<div class="music-card-grid">${library.albums.map(albumCardHtml).join("")}</div>`
      : `<p class="music-note">${esc(t("music.noResults"))}</p>`;
  } else {
    body = library.artists.length
      ? `<div class="music-card-grid">${library.artists.map(artistCardHtml).join("")}</div>`
      : `<p class="music-note">${esc(t("music.noResults"))}</p>`;
  }
  return `${tabRow}${body}`;
}

function trackRowHtml(track: SpotifyTrack): string {
  return `
    <button class="music-track" data-music="play-uri" data-uri="${esc(track.uri)}" title="${esc(t("music.play"))}">
      ${track.artUrl ? `<img src="${esc(track.artUrl)}" alt="" loading="lazy" />` : `<span class="music-track-art">${icon("music", 16)}</span>`}
      <span class="music-track-meta">
        <span class="music-track-name">${esc(track.name)}</span>
        <span class="music-track-artist">${esc(track.artist)}${track.album ? ` · ${esc(track.album)}` : ""}</span>
      </span>
      <span class="music-track-time">${formatTime(track.durationMs)}</span>
    </button>`;
}

function playlistCardHtml(playlist: { id: string; name: string; uri: string; artUrl: string; trackCount: number }): string {
  return `
    <button class="music-playlist" data-music="play-uri" data-uri="${esc(playlist.uri)}" title="${esc(t("music.playPlaylist"))}">
      ${playlist.artUrl ? `<img src="${esc(playlist.artUrl)}" alt="" loading="lazy" />` : `<span class="music-playlist-fallback">${icon("music", 22)}</span>`}
      <span class="music-playlist-name">${esc(playlist.name)}</span>
      <span class="music-playlist-meta">${esc(t("music.trackCount", { count: playlist.trackCount }))}</span>
    </button>`;
}

function albumCardHtml(album: SpotifyAlbum): string {
  return `
    <button class="music-playlist" data-music="play-uri" data-uri="${esc(album.uri)}" title="${esc(t("music.play"))}">
      ${album.artUrl ? `<img src="${esc(album.artUrl)}" alt="" loading="lazy" />` : `<span class="music-playlist-fallback">${icon("music", 22)}</span>`}
      <span class="music-playlist-name">${esc(album.name)}</span>
      <span class="music-playlist-meta">${esc(album.artist)}</span>
    </button>`;
}

function artistCardHtml(artist: SpotifyArtist): string {
  return `
    <button class="music-playlist music-artist-card" data-music="open-url" data-url="${esc(artist.url)}" title="${esc(t("music.openSpotify"))}">
      ${artist.imageUrl ? `<img src="${esc(artist.imageUrl)}" alt="" loading="lazy" />` : `<span class="music-playlist-fallback">${icon("user", 22)}</span>`}
      <span class="music-playlist-name">${esc(artist.name)}</span>
      <span class="music-playlist-meta">${esc(t("music.resultsArtists"))}</span>
    </button>`;
}

/** "Play on this computer": librespot Connect receiver controls. */
function playbackCardHtml(): string {
  const playback = state.playback;
  const chip = playback.running
    ? `<span class="chip ok">${esc(t("music.playbackRunning", { name: playback.deviceName }))}</span>`
    : playback.paired
    ? `<span class="chip">${esc(t("music.playbackPaired"))}</span>`
    : "";
  const actions = playback.running
    ? `<button class="btn primary" data-music="playback-here">${icon("play", 14)} ${esc(t("music.playHere"))}</button>
       <button class="btn ghost small" data-music="playback-stop">${esc(t("music.playbackStop"))}</button>`
    : `<button class="btn primary" data-music="playback-start" ${state.playbackBusy ? "disabled" : ""}>${icon("monitor", 14)} ${esc(
        state.playbackBusy
          ? t("music.playbackWaiting")
          : playback.paired
          ? t("music.playbackStart")
          : t("music.playbackEnable"),
      )}</button>
       ${playback.paired ? `<button class="btn ghost small" data-music="playback-forget">${esc(t("music.playbackForget"))}</button>` : ""}`;
  return `
    <div class="music-playback-head">
      <div class="music-brand">${icon("monitor", 18)}<span>${esc(t("music.playbackTitle"))}</span></div>
      ${chip}
      <div class="music-playback-actions">${actions}</div>
    </div>
    <p class="music-note">${esc(t("music.playbackDesc"))}</p>`;
}

/** Rebuilds the whole page through the app render bus (connect changes). */
function rerender(): void {
  scheduleRender();
}

/* ---------- DOM patching ---------- */

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function paintNow(): void {
  const now = state.now;
  const art = document.getElementById("music-art") as HTMLImageElement | null;
  if (art) {
    const src = now?.artUrl || "";
    if (art.dataset.src !== src) {
      art.dataset.src = src;
      art.src = src;
      art.style.visibility = src ? "visible" : "hidden";
    }
  }
  setText("music-title", now?.title || t("music.nothingPlaying"));
  setText("music-artist", now?.artist || "");
  setText("music-album", now?.album || "");
  setText("music-duration", now ? formatTime(now.durationMs) : "0:00");

  const toggle = document.getElementById("music-toggle");
  if (toggle) toggle.innerHTML = icon(now?.isPlaying ? "pause" : "play", 20);
  const shuffle = document.getElementById("music-shuffle");
  if (shuffle) shuffle.classList.toggle("active", Boolean(now?.shuffle));
  const repeat = document.getElementById("music-repeat");
  if (repeat) {
    repeat.classList.toggle("active", Boolean(now && now.repeat !== "off"));
    repeat.classList.toggle("repeat-track", now?.repeat === "track");
  }
  const volume = document.getElementById("music-volume") as HTMLInputElement | null;
  if (volume && document.activeElement !== volume && now?.volumePercent != null) {
    volume.value = String(now.volumePercent);
    setText("music-volume-value", `${now.volumePercent}%`);
  }
  const openButton = document.querySelector<HTMLButtonElement>('[data-music="open-spotify"]');
  if (openButton) openButton.disabled = !now?.url;
  paintProgress();
  paintDevices();
  paintBrowse();
  paintPlayback();
}

/** Re-renders the search/library card when its state changes. */
function paintBrowse(): void {
  const card = document.getElementById("music-browse-card");
  if (!card) return;
  const key = [
    state.results ? "search" : "library",
    state.searchBusy ? "busy" : "",
    state.libraryTab,
    state.results
      ? `${state.results.tracks.length}:${state.results.albums.length}:${state.results.artists.length}:${state.results.playlists.length}`
      : "",
    state.library
      ? `${state.library.tracks.length}:${state.library.playlists.length}:${state.library.albums.length}:${state.library.artists.length}`
      : "none",
  ].join("|");
  if (key === state.lastBrowseKey) return;
  state.lastBrowseKey = key;
  card.innerHTML = browseCardHtml();
}

/** Re-renders the playback card when its state changes (rare). */
function paintPlayback(): void {
  const card = document.getElementById("music-playback-card");
  if (!card) return;
  const key = `${state.playback.paired}:${state.playback.running}:${state.playbackBusy}`;
  if (key === state.lastPlaybackKey) return;
  state.lastPlaybackKey = key;
  card.innerHTML = playbackCardHtml();
}

function paintProgress(): void {
  const now = state.now;
  const duration = now?.durationMs || 0;
  let elapsed = state.progressBaseMs;
  if (now?.isPlaying) elapsed += Date.now() - state.progressBaseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  const fill = document.getElementById("music-progress-fill");
  if (fill) {
    fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
  }
  setText("music-elapsed", formatTime(elapsed));
}

function paintDevices(): void {
  const select = document.getElementById("music-device") as HTMLSelectElement | null;
  if (!select) return;
  const key = state.devices.map((device) => `${device.id}:${device.isActive}`).join("|");
  if (key !== state.lastDeviceKey) {
    state.lastDeviceKey = key;
    select.innerHTML = state.devices.length
      ? state.devices
          .map(
            (device) =>
              `<option value="${esc(device.id)}"${device.isActive ? " selected" : ""}>${esc(device.name)}${device.isActive ? " ✓" : ""}</option>`,
          )
          .join("")
      : `<option value="">${esc(t("music.noDevices"))}</option>`;
  }
}

/* ---------- Data refresh ---------- */

export function hydrateMusic(): void {
  ensurePolling();
  if (state.loaded) {
    // Cached state: paint now, the poll refreshes within a couple of seconds.
    paintNow();
    return;
  }
  void refresh(true);
}

/** Called once per app run; the timer only works while the view is open. */
function ensurePolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (!viewEl?.querySelector(".music")) return;
    tick += 1;
    void refresh(false);
  }, 2500);
  // Local progress interpolation between API polls.
  window.setInterval(() => {
    if (!viewEl?.querySelector(".music")) return;
    paintProgress();
  }, 500);
}

async function refresh(initial: boolean): Promise<void> {
  const status = await spotifyStatus().catch(() => null);
  if (!status) return;
  const playback = await spotifyPlaybackStatus().catch(() => null);
  if (playback) state.playback = playback;
  const connectChanged = status.connected !== state.status.connected;
  state.status = status;
  state.loaded = true;

  if (status.connected) {
    const now = await spotifyNowPlaying().catch(() => null);
    if (now) {
      state.progressBaseMs = now.progressMs;
      state.progressBaseAt = Date.now();
    }
    state.now = now;
    if (state.devices.length === 0 || tick % 4 === 0) {
      state.devices = await spotifyDevices().catch(() => state.devices);
    }
    if (state.library === null) {
      try {
        state.library = await spotifyLibrary();
      } catch (error) {
        // Fail once and keep the empty state so the poll does not spam.
        state.library = { tracks: [], playlists: [], albums: [], artists: [] };
        state.message = { text: messageFor(String(error)), kind: "error" };
      }
    }
  } else {
    state.now = null;
    state.devices = [];
    state.library = null;
    state.results = null;
    state.lastDeviceKey = "";
    state.lastBrowseKey = "";
  }

  if (initial || connectChanged) {
    rerender();
    return;
  }
  paintNow();
}

/* ---------- Actions ---------- */

function fail(error: unknown): void {
  const text = String(error);
  state.message = { text: messageFor(text), kind: "error" };
}

function messageFor(raw: string): string {
  if (raw.includes("port_busy")) return t("music.errorPort", { port: 8899 });
  if (raw.includes("missing_client_id")) return t("music.errorClientId");
  if (raw.includes("cancelled")) return t("music.errorCancelled");
  if (raw.includes("timeout")) return t("music.errorTimeout");
  if (raw.includes("refresh_failed")) return t("music.errorRefresh");
  if (raw.includes("PREMIUM_REQUIRED") || raw.includes("restricted")) return t("music.errorPremium");
  if (raw.includes("NO_ACTIVE_DEVICE")) return t("music.errorNoDevice");
  return raw.replace(/^Error: /, "");
}

/** Copies the loopback redirect URI, or selects it when the clipboard is off. */
async function copyRedirect(): Promise<void> {
  const uri = "http://127.0.0.1:8899/callback";
  const button = document.getElementById("music-copy-redirect");
  let copied = false;
  try {
    await navigator.clipboard.writeText(uri);
    copied = true;
  } catch {
    // Clipboard blocked (window unfocused): select the text for Ctrl+C.
    const code = document.getElementById("music-redirect-uri");
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
  if (copied && button) {
    const original = `${icon("clipboard", 13)} ${esc(t("music.copyRedirect"))}`;
    button.innerHTML = esc(t("music.copied"));
    window.setTimeout(() => {
      if (button.isConnected) button.innerHTML = original;
    }, 2000);
  }
}

async function connect(): Promise<void> {
  const input = document.getElementById("music-client-id") as HTMLInputElement | null;
  const clientId = input?.value.trim() ?? "";
  if (clientId) {
    try {
      await spotifySetClientId(clientId);
    } catch (error) {
      fail(error);
      rerender();
      return;
    }
  }
  state.loginBusy = true;
  state.message = null;
  rerender();
  try {
    const status = await spotifyLogin();
    state.status = status;
    state.message = { text: t("music.connected"), kind: "ok" };
  } catch (error) {
    fail(error);
  }
  state.loginBusy = false;
  await refresh(true);
}

async function withControl(action: () => Promise<void>): Promise<void> {
  try {
    await action();
    await refresh(false);
  } catch (error) {
    fail(error);
    rerender();
  }
}

/** Runs a catalogue search and shows the results instead of the library. */
async function runSearch(): Promise<void> {
  const input = document.getElementById("music-search") as HTMLInputElement | null;
  const query = (input?.value ?? state.searchQuery).trim();
  state.searchQuery = query;
  if (!query) {
    state.results = null;
    paintBrowse();
    return;
  }
  state.searchBusy = true;
  paintBrowse();
  try {
    state.results = await spotifySearch(query);
  } catch (error) {
    fail(error);
    state.results = null;
  }
  state.searchBusy = false;
  paintBrowse();
  (document.getElementById("music-search") as HTMLInputElement | null)?.focus();
}

/** Starts the librespot receiver; the first run waits for browser approval. */
async function playbackStart(): Promise<void> {
  state.playbackBusy = true;
  state.message = null;
  rerender();
  try {
    state.playback = await spotifyPlaybackStart();
    state.message = { text: t("music.playbackReady"), kind: "ok" };
  } catch (error) {
    fail(error);
  }
  state.playbackBusy = false;
  await refresh(true);
}

/** Transfers playback to our own Connect device. */
async function playbackHere(): Promise<void> {
  try {
    let target = state.devices.find((device) => device.name === state.playback.deviceName);
    if (!target) {
      state.devices = await spotifyDevices();
      target = state.devices.find((device) => device.name === state.playback.deviceName);
    }
    if (!target) {
      state.message = { text: t("music.errorNoDevice"), kind: "error" };
      rerender();
      return;
    }
    await spotifyTransfer(target.id);
    await refresh(false);
  } catch (error) {
    fail(error);
    rerender();
  }
}

async function seekAt(clientX: number): Promise<void> {
  const bar = document.getElementById("music-progress");
  const now = state.now;
  if (!bar || !now?.durationMs) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  await withControl(() => spotifyControl("seek", Math.round(ratio * now.durationMs)));
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>("[data-music]");
  if (!el) return;
  const action = el.dataset.music;
  if (!action) return;

  if (action === "seek") {
    void seekAt(event.clientX);
    return;
  }
  if (action === "dashboard" || action === "create-app") {
    void openUrl("https://developer.spotify.com/dashboard/create");
    return;
  }
  if (action === "copy-redirect") {
    void copyRedirect();
    return;
  }
  if (action === "open-spotify") {
    if (state.now?.url) void openUrl(state.now.url);
    return;
  }
  if (action === "search-go") {
    void runSearch();
    return;
  }
  if (action === "search-clear") {
    state.results = null;
    state.searchBusy = false;
    paintBrowse();
    return;
  }
  if (action === "library-tab") {
    const tab = el.dataset.tab as typeof state.libraryTab | undefined;
    if (tab) {
      state.libraryTab = tab;
      paintBrowse();
    }
    return;
  }
  if (action === "play-uri") {
    const uri = el.dataset.uri ?? "";
    if (uri) void withControl(() => spotifyPlay(uri, null));
    return;
  }
  if (action === "open-url") {
    const url = el.dataset.url ?? "";
    if (url) void openUrl(url);
    return;
  }
  if (action === "playback-start") {
    void playbackStart();
    return;
  }
  if (action === "playback-stop") {
    void (async () => {
      await spotifyPlaybackStop();
      await refresh(true);
    })();
    return;
  }
  if (action === "playback-here") {
    void playbackHere();
    return;
  }
  if (action === "playback-forget") {
    void (async () => {
      await spotifyPlaybackForget();
      await refresh(true);
    })();
    return;
  }
  if (action === "connect") {
    void connect();
    return;
  }
  if (action === "cancel") {
    void spotifyCancelLogin();
    state.loginBusy = false;
    state.message = { text: t("music.errorCancelled"), kind: "info" };
    rerender();
    return;
  }
  if (action === "logout") {
    void (async () => {
      await spotifyLogout();
      state.now = null;
      await refresh(true);
    })();
    return;
  }
  if (action === "play-playlist") {
    const uri = el.dataset.uri ?? "";
    const active = state.devices.find((device) => device.isActive)?.id ?? null;
    if (uri) void withControl(() => spotifyPlay(uri, active));
    return;
  }
  if (action === "toggle") {
    void withControl(() => spotifyControl(state.now?.isPlaying ? "pause" : "play"));
    return;
  }
  if (action === "previous" || action === "next") {
    void withControl(() => spotifyControl(action));
    return;
  }
  if (action === "shuffle") {
    void withControl(() => spotifyControl("shuffle", state.now?.shuffle ? 0 : 1));
    return;
  }
  if (action === "repeat") {
    const next = state.now?.repeat === "off" ? 1 : state.now?.repeat === "context" ? 2 : 0;
    void withControl(() => spotifyControl("repeat", next));
  }
});

document.addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "music-device") {
    const deviceId = (target as HTMLSelectElement).value;
    if (deviceId) void withControl(() => spotifyTransfer(deviceId));
    return;
  }
  if (target.id === "music-volume") {
    const value = Number((target as HTMLInputElement).value);
    setText("music-volume-value", `${value}%`);
    void withControl(() => spotifyControl("volume", value));
  }
});

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "music-volume") {
    setText("music-volume-value", `${(target as HTMLInputElement).value}%`);
  }
  if (target.id === "music-search") {
    state.searchQuery = (target as HTMLInputElement).value;
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.id === "music-search" && event.key === "Enter") {
    event.preventDefault();
    void runSearch();
  }
});
