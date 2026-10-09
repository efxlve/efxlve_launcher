/**
 * Sidebar mini player and the playing equalizer next to the Spotify row.
 *
 * Follows the launcher's Connect receiver first and falls back to the Windows
 * media session (desktop Spotify, browsers) — the same priority the overlay
 * uses. Transport buttons drive whichever source is live; the collapsed rail
 * keeps only the transport buttons (CSS handles the layout via `html.sb-narrow`).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import {
  spotifyPlaybackControl,
  spotifyPlaybackNow,
  spotifyPlaybackStatus,
} from "./spotify-client";

interface MediaState {
  available: boolean;
  title: string;
  artist: string;
  playing: boolean;
  source: string;
  positionS: number;
  durationS: number;
}

interface MiniState {
  source: "engine" | "smtc" | "none";
  title: string;
  artist: string;
  artUrl: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  volumePercent: number | null;
  isSpotify: boolean;
}

const IDLE: MiniState = {
  source: "none",
  title: "",
  artist: "",
  artUrl: "",
  playing: false,
  positionMs: 0,
  durationMs: 0,
  volumePercent: null,
  isSpotify: true,
};

let state: MiniState = IDLE;
let baseMs = 0;
let baseAt = 0;

/** Wires the sidebar player once; safe to call on every boot. */
export function initMiniPlayer(): void {
  if (!isTauri) return;
  const mini = document.getElementById("sb-mini");
  if (!mini || mini.dataset.ready === "1") return;
  mini.dataset.ready = "1";
  mini.hidden = false;

  const prev = mini.querySelector<HTMLElement>('[data-mini="prev"]');
  const toggle = mini.querySelector<HTMLElement>('[data-mini="toggle"]');
  const next = mini.querySelector<HTMLElement>('[data-mini="next"]');
  const volumeIcon = mini.querySelector<HTMLElement>(".sb-mini-volume-icon");
  const volume = document.getElementById("sb-mini-volume") as HTMLInputElement | null;
  if (prev) {
    prev.innerHTML = icon("skip-back", 16);
    prev.title = t("music.previous");
  }
  if (toggle) {
    toggle.innerHTML = icon("play", 16);
    toggle.title = t("music.playPause");
  }
  if (next) {
    next.innerHTML = icon("skip-forward", 16);
    next.title = t("music.next");
  }
  if (volumeIcon) volumeIcon.innerHTML = icon("volume-2", 13);
  if (volume) volume.setAttribute("aria-label", t("mini.volume"));

  document.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-mini]")?.dataset.mini;
    if (!action) return;
    if (action === "toggle") void control(state.playing ? "pause" : "play");
    else if (action === "prev") void control("previous");
    else if (action === "next") void control("next");
  });

  volume?.addEventListener("change", () => {
    if (state.source !== "engine") return;
    void spotifyPlaybackControl("volume", Number(volume.value)).catch(() => undefined);
  });

  window.setInterval(() => void refresh(), 2500);
  window.setInterval(paintProgress, 1000);
  void refresh();
}

async function refresh(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  const engineOn = status?.running === true;
  const now = engineOn ? await spotifyPlaybackNow().catch(() => null) : null;

  if (now) {
    state = {
      source: "engine",
      title: now.title,
      artist: now.artist,
      artUrl: now.artUrl,
      playing: now.isPlaying,
      positionMs: now.progressMs,
      durationMs: now.durationMs,
      volumePercent: now.volumePercent,
      isSpotify: true,
    };
  } else {
    const media = await invoke<MediaState>("overlay_media_state").catch(() => null);
    if (media?.available) {
      const source = media.source.toLowerCase();
      state = {
        source: "smtc",
        title: media.title,
        artist: media.artist,
        artUrl: "",
        playing: media.playing,
        positionMs: Math.round(media.positionS * 1000),
        durationMs: Math.round(media.durationS * 1000),
        volumePercent: null,
        isSpotify: source.includes("spotify") || source.includes("webview"),
      };
    } else {
      state = IDLE;
    }
  }

  baseMs = state.positionMs;
  baseAt = Date.now();
  paint();
}

async function control(action: "play" | "pause" | "next" | "previous"): Promise<void> {
  if (state.source === "none") return;
  if (action === "play" || action === "pause") {
    state = { ...state, playing: action === "play" };
    paint();
  }
  try {
    if (state.source === "engine") await spotifyPlaybackControl(action);
    else await invoke("overlay_media_control", { action });
  } catch {
    // The next poll re-syncs.
  }
  window.setTimeout(() => void refresh(), 400);
}

function paint(): void {
  const eq = document.getElementById("sb-eq");
  if (eq) {
    eq.classList.toggle("playing", state.playing);
    eq.classList.toggle("paused", state.source !== "none" && !state.playing);
  }

  const title = document.getElementById("sb-mini-title");
  const artist = document.getElementById("sb-mini-artist");
  const art = document.getElementById("sb-mini-art");
  const toggle = document.querySelector<HTMLElement>('[data-mini="toggle"]');
  const volumeRow = document.querySelector<HTMLElement>(".sb-mini-volume");
  if (!title || !artist || !art || !toggle) return;

  if (state.source === "none") {
    title.textContent = t("mini.nothing");
    artist.textContent = "";
    art.innerHTML = icon("spotify", 18);
    toggle.innerHTML = icon("play", 16);
  } else {
    title.textContent = state.title || t("mini.nothing");
    artist.textContent = state.artist;
    art.innerHTML = state.artUrl
      ? `<img src="${esc(state.artUrl)}" alt="" />`
      : icon(state.isSpotify ? "spotify" : "volume-2", 18);
    toggle.innerHTML = icon(state.playing ? "pause" : "play", 16);
  }

  // Volume only exists on the launcher's own receiver.
  if (volumeRow) volumeRow.hidden = state.volumePercent == null;
  const volume = document.getElementById("sb-mini-volume") as HTMLInputElement | null;
  if (volume && state.volumePercent != null && document.activeElement !== volume) {
    volume.value = String(state.volumePercent);
  }
  paintProgress();
}

function paintProgress(): void {
  const fill = document.getElementById("sb-mini-fill");
  if (!fill) return;
  const duration = state.durationMs;
  let elapsed = baseMs;
  if (state.playing) elapsed += Date.now() - baseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
}
