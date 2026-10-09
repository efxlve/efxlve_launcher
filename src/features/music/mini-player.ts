/**
 * Sidebar mini player and the playing equalizer next to the Spotify row.
 *
 * Both follow the launcher's own Connect receiver: the transport buttons drive
 * it directly and the equalizer animates while it plays. The collapsed rail
 * keeps only the transport buttons (CSS handles the layout via `html.sb-narrow`).
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import {
  spotifyPlaybackControl,
  spotifyPlaybackNow,
  spotifyPlaybackStatus,
  type NowPlaying,
} from "./spotify-client";

let current: NowPlaying | null = null;
let engineOn = false;
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
    if (action === "toggle") void control(current?.isPlaying ? "pause" : "play");
    else if (action === "prev") void control("previous");
    else if (action === "next") void control("next");
  });

  volume?.addEventListener("change", () => {
    void spotifyPlaybackControl("volume", Number(volume.value)).catch(() => undefined);
  });

  window.setInterval(() => void refresh(), 2500);
  window.setInterval(paintProgress, 1000);
  void refresh();
}

async function refresh(): Promise<void> {
  const status = await spotifyPlaybackStatus().catch(() => null);
  engineOn = status?.running === true;
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
  const eq = document.getElementById("sb-eq");
  if (eq) {
    eq.classList.toggle("playing", Boolean(current?.isPlaying));
    eq.classList.toggle("paused", Boolean(current && !current.isPlaying));
  }

  const title = document.getElementById("sb-mini-title");
  const artist = document.getElementById("sb-mini-artist");
  const art = document.getElementById("sb-mini-art");
  const toggle = document.querySelector<HTMLElement>('[data-mini="toggle"]');
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
