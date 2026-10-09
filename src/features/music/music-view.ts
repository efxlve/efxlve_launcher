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
  spotifyLogin,
  spotifyLogout,
  spotifyNowPlaying,
  spotifyPlay,
  spotifyPlaylists,
  spotifySetClientId,
  spotifyStatus,
  spotifyTransfer,
  type NowPlaying,
  type SpotifyDevice,
  type SpotifyPlaylist,
  type SpotifyStatus,
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
  playlists: SpotifyPlaylist[];
  message: Message | null;
  loginBusy: boolean;
  /** Playback position anchor so the progress bar moves between polls. */
  progressBaseMs: number;
  progressBaseAt: number;
  lastDeviceKey: string;
  lastPlaylistKey: string;
}

const state: MusicState = {
  loaded: false,
  status: { clientIdSet: false, connected: false, user: "", product: "", error: "" },
  now: null,
  devices: [],
  playlists: [],
  message: null,
  loginBusy: false,
  progressBaseMs: 0,
  progressBaseAt: 0,
  lastDeviceKey: "",
  lastPlaylistKey: "",
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
          <li>${esc(t("music.step2"))} <code>http://127.0.0.1:8899/callback</code></li>
          <li>${esc(t("music.step3"))}</li>
        </ol>
        <div class="music-connect-row">
          <input id="music-client-id" class="music-input" type="text" spellcheck="false"
            placeholder="${esc(t("music.clientIdPlaceholder"))}" value="${esc(draft)}" ${withId ? "" : "autofocus"} />
          <button class="btn primary" data-music="connect" ${state.loginBusy ? "disabled" : ""}>
            ${icon("user", 14)} ${esc(withId ? t("music.signIn") : t("music.saveAndConnect"))}
          </button>
          <button class="btn ghost small" data-music="dashboard">${icon("external", 14)} ${esc(t("music.openDashboard"))}</button>
          ${state.loginBusy ? `<button class="btn ghost small" data-music="cancel">${esc(t("music.cancel"))}</button>` : ""}
        </div>
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

      <div class="music-playlists">
        <div class="music-playlists-head">
          <h3>${esc(t("music.playlistsTitle"))}</h3>
        </div>
        <div class="music-playlist-grid" id="music-playlists"></div>
      </div>

      ${state.message ? `<p class="music-note ${state.message.kind}">${esc(state.message.text)}</p>` : ""}
    </div>`;
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
  paintPlaylists();
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

function paintPlaylists(): void {
  const grid = document.getElementById("music-playlists");
  if (!grid) return;
  const key = state.playlists.map((playlist) => playlist.id).join("|");
  if (key === state.lastPlaylistKey) return;
  state.lastPlaylistKey = key;
  grid.innerHTML = state.playlists.length
    ? state.playlists
        .map(
          (playlist) => `
        <button class="music-playlist" data-music="play-playlist" data-uri="${esc(playlist.uri)}" title="${esc(t("music.playPlaylist"))}">
          ${playlist.artUrl ? `<img src="${esc(playlist.artUrl)}" alt="" loading="lazy" />` : `<span class="music-playlist-fallback">${icon("music", 22)}</span>`}
          <span class="music-playlist-name">${esc(playlist.name)}</span>
          <span class="music-playlist-meta">${esc(t("music.trackCount", { count: playlist.trackCount }))}</span>
        </button>`,
        )
        .join("")
    : `<p class="music-note">${esc(t("music.noPlaylists"))}</p>`;
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
    if (state.playlists.length === 0 || connectChanged) {
      state.playlists = await spotifyPlaylists().catch(() => state.playlists);
    }
  } else {
    state.now = null;
    state.devices = [];
    state.playlists = [];
    state.lastDeviceKey = "";
    state.lastPlaylistKey = "";
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
  if (action === "dashboard") {
    void openUrl("https://developer.spotify.com/dashboard");
    return;
  }
  if (action === "open-spotify") {
    if (state.now?.url) void openUrl(state.now.url);
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
});
