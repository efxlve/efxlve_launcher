/**
 * Sidebar mini player and the playing equalizer next to the Spotify row.
 *
 * Both follow the launcher's own Connect receiver only — nothing that plays
 * elsewhere on Windows shows up here. The collapsed rail keeps just the
 * transport buttons (CSS handles the layout via `html.sb-narrow`).
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import {
  spotifyPlaybackControl,
  spotifyPlaybackNow,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  spotifySignedIn,
  type NowPlaying,
} from "./spotify-client";

let current: NowPlaying | null = null;
let signedIn = false;
let baseMs = 0;
let baseAt = 0;

/** Wires the sidebar player once; safe to call on every boot. */
export function initMiniPlayer(): void {
  if (!isTauri) return;
  const mini = document.getElementById("sb-mini");
  if (!mini || mini.dataset.ready === "1") return;
  mini.dataset.ready = "1";
  // Stays hidden until a track plays (paint decides).

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
  mini.querySelector(".sb-mini-top")?.setAttribute("title", t("overlay.openSpotify"));

  document.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-mini]")?.dataset.mini;
    if (!action) return;
    if (action === "toggle") {
      if (current) void control(current.isPlaying ? "pause" : "play");
      else void startAndPlay();
    } else if (action === "prev") {
      if (current) void control("previous");
    } else if (action === "next") {
      if (current) void control("next");
    } else if (action === "open") {
      void openCurrent();
    }
  });

  volume?.addEventListener("change", () => {
    void spotifyPlaybackControl("volume", Number(volume.value)).catch(() => undefined);
  });

  // Scrub the timeline: click or drag, then one seek on release.
  const progress = mini.querySelector<HTMLElement>(".sb-mini-progress");
  progress?.addEventListener("pointerdown", (event) => {
    if (!current?.durationMs) return;
    const rect = progress.getBoundingClientRect();
    // The collapsed rail hides the bar; nothing to scrub then.
    if (rect.width < 8) return;
    event.preventDefault();
    const seek = (clientX: number): number => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      baseMs = ratio * (current?.durationMs ?? 0);
      baseAt = Date.now();
      paintProgress();
      return Math.round(baseMs);
    };
    seek(event.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void spotifyPlaybackControl("seek", seek(ev.clientX)).catch(() => undefined);
      window.setTimeout(() => void refresh(), 600);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  window.setInterval(() => void refresh(), 2500);
  window.setInterval(paintProgress, 1000);
  void refresh();
}

/** Opens the current track inside the launcher's embedded Spotify page. */
async function openCurrent(): Promise<void> {
  if (!current) return;
  const url = current.url && current.url !== "spotify:" ? current.url : "https://open.spotify.com/";
  try {
    const opened = await invoke<boolean>("spotify_open_in_launcher", { url });
    if (opened) return;
  } catch {
    // Fall through to the browser.
  }
  void openUrl(url).catch(() => undefined);
}

/** Nothing loaded: make sure the receiver runs, then start its last context. */
async function startAndPlay(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  if (!status?.running) {
    await spotifyPlaybackStart().catch(() => undefined);
  }
  await spotifyPlaybackControl("play").catch(() => undefined);
  window.setTimeout(() => void refresh(), 900);
}

async function refresh(): Promise<void> {
  // The player only exists for a signed-in Spotify account, and it stays out
  // of the way (recently played keeps the room) until something plays.
  signedIn = await spotifySignedIn().catch(() => false);
  if (!signedIn) {
    current = null;
    paint();
    return;
  }

  const status = await spotifyPlaybackStatus().catch(() => null);
  const engineOn = status?.running === true;
  const now = engineOn ? await spotifyPlaybackNow().catch(() => null) : null;
  if (now) {
    baseMs = now.progressMs;
    baseAt = Date.now();
  }
  current = now;
  paint();
}

async function control(action: "play" | "pause" | "next" | "previous"): Promise<void> {
  if ((action === "play" || action === "pause") && current) {
    current = { ...current, isPlaying: action === "play" };
    paint();
  }
  try {
    await spotifyPlaybackControl(action);
  } catch {
    // The next poll re-syncs.
  }
  window.setTimeout(() => void refresh(), 400);
}

function paint(): void {
  const mini = document.getElementById("sb-mini");
  // Hidden until something actually plays: the recently played list is the
  // sidebar's priority, Spotify is secondary.
  if (mini) mini.hidden = !signedIn || !current;

  const eq = document.getElementById("sb-eq");
  if (eq) {
    eq.classList.toggle("playing", Boolean(current?.isPlaying));
    eq.classList.toggle("paused", Boolean(current && !current.isPlaying));
  }

  const title = document.getElementById("sb-mini-title");
  const artist = document.getElementById("sb-mini-artist");
  const art = document.getElementById("sb-mini-art");
  const toggle = document.querySelector<HTMLElement>('[data-mini="toggle"]');
  const volumeRow = document.querySelector<HTMLElement>(".sb-mini-volume");
  if (!title || !artist || !art || !toggle) return;

  if (!current) {
    title.textContent = t("mini.nothing");
    artist.textContent = "";
    art.innerHTML = icon("spotify", 18);
    toggle.innerHTML = icon("play", 16);
  } else {
    title.textContent = current.title || t("mini.nothing");
    artist.textContent = current.artist;
    art.innerHTML = current.artUrl ? `<img src="${esc(current.artUrl)}" alt="" />` : icon("spotify", 18);
    toggle.innerHTML = icon(current.isPlaying ? "pause" : "play", 16);
  }

  // The volume slider only makes sense while the receiver is live.
  if (volumeRow) volumeRow.hidden = current?.volumePercent == null;
  const volume = document.getElementById("sb-mini-volume") as HTMLInputElement | null;
  if (volume && current?.volumePercent != null && document.activeElement !== volume) {
    volume.value = String(current.volumePercent);
  }
  paintProgress();
}

function paintProgress(): void {
  const fill = document.getElementById("sb-mini-fill");
  if (!fill) return;
  const duration = current?.durationMs ?? 0;
  let elapsed = baseMs;
  if (current?.isPlaying) elapsed += Date.now() - baseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
}
