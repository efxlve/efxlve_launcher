/**
 * Sidebar mini player and the playing equalizer next to the Spotify row.
 *
 * Both follow the launcher's own Connect receiver, and the page's own engine
 * while that is the one making sound — nothing else on Windows shows up here.
 * The collapsed rail keeps just the transport buttons (CSS handles the layout
 * via `html.sb-narrow`).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { miniPlayerVisible } from "../../core/page-visibility";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { setPresenceMedia } from "../presence/presence";
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

/** What the page itself reports through its Media Session (its own engine). */
interface PageNow {
  title: string;
  artist: string;
  album: string;
  art: string;
  playing: boolean;
}

let pageNow: PageNow | null = null;

/** True while the page, not the Connect receiver, is the one making sound. */
function pageIsPlaying(): boolean {
  return Boolean(pageNow?.playing);
}

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
  // The tooltips and labels live as `data-i18n-*` attributes on the static
  // markup, so a language change refreshes them; nothing here sets them once.
  if (prev) prev.innerHTML = icon("skip-back", 16);
  if (toggle) toggle.innerHTML = icon("play", 16);
  if (next) next.innerHTML = icon("skip-forward", 16);
  if (volumeIcon) volumeIcon.innerHTML = icon("volume-2", 13);

  document.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-mini]")?.dataset.mini;
    if (!action) return;
    if (action === "toggle") {
      if (current || pageIsPlaying()) void control(current?.isPlaying ? "pause" : "play");
      else void startAndPlay();
    } else if (action === "prev") {
      if (current || pageIsPlaying()) void control("previous");
    } else if (action === "next") {
      if (current || pageIsPlaying()) void control("next");
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
    if (pageIsPlaying() || !current?.durationMs) return;
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

  // The page posts its own playback through the act channel; while it plays it
  // is the truth, because the receiver may still hold an older session.
  void listen<{ act?: string; id?: string }>("notif-overlay-act", (event) => {
    const payload = event.payload;
    if (!payload || payload.act !== "page-now" || !payload.id) return;
    try {
      pageNow = JSON.parse(payload.id) as PageNow;
    } catch {
      return;
    }
    paint();
  }).catch(() => undefined);

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
    setPresenceMedia(null);
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
  // Discord follows whichever engine is actually playing: the page first.
  if (pageIsPlaying() && pageNow) {
    setPresenceMedia({
      title: pageNow.title,
      artist: pageNow.artist,
      album: pageNow.album,
      artUrl: pageNow.art,
      isPlaying: true,
      positionMs: 0,
      durationMs: 0,
    });
  } else {
    setPresenceMedia(
      now
        ? {
            title: now.title,
            artist: now.artist,
            album: now.album,
            artUrl: now.artUrl,
            isPlaying: now.isPlaying,
            positionMs: now.progressMs,
            durationMs: now.durationMs,
          }
        : null,
    );
  }
}

async function control(action: "play" | "pause" | "next" | "previous"): Promise<void> {
  // While the page plays through its own engine, the transport belongs to it.
  if (pageIsPlaying()) {
    const pageAction = action === "next" ? "next" : action === "previous" ? "previous" : "playpause";
    await invoke("spotify_page_control", { action: pageAction }).catch(() => undefined);
    window.setTimeout(() => void refresh(), 500);
    return;
  }
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
  const pageMode = pageIsPlaying();
  const mini = document.getElementById("sb-mini");
  // Hidden until something actually plays: the recently played list is the
  // sidebar's priority, Spotify is secondary. Settings can turn it off.
  if (mini) mini.hidden = !signedIn || !miniPlayerVisible() || (!current && !pageMode);

  const eq = document.getElementById("sb-eq");
  if (eq) {
    eq.classList.toggle("playing", pageMode || Boolean(current?.isPlaying));
    eq.classList.toggle("paused", pageMode ? false : Boolean(current && !current.isPlaying));
  }

  const title = document.getElementById("sb-mini-title");
  const artist = document.getElementById("sb-mini-artist");
  const art = document.getElementById("sb-mini-art");
  const toggle = document.querySelector<HTMLElement>('[data-mini="toggle"]');
  const volumeRow = document.querySelector<HTMLElement>(".sb-mini-volume");
  if (!title || !artist || !art || !toggle) return;

  if (pageMode && pageNow) {
    // The page is the source: its track and its transport, no receiver timeline.
    title.textContent = pageNow.title || t("mini.nothing");
    artist.textContent = pageNow.artist;
    art.innerHTML = pageNow.art ? `<img src="${esc(pageNow.art)}" alt="" />` : icon("spotify", 18);
    toggle.innerHTML = icon("pause", 16);
  } else if (!current) {
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

  // The volume slider only makes sense while the receiver is live; the page
  // has its own volume control in its bar.
  if (volumeRow) volumeRow.hidden = pageMode || current?.volumePercent == null;
  const volume = document.getElementById("sb-mini-volume") as HTMLInputElement | null;
  if (volume && current?.volumePercent != null && document.activeElement !== volume) {
    volume.value = String(current.volumePercent);
  }
  paintProgress();
}

function paintProgress(): void {
  const fill = document.getElementById("sb-mini-fill");
  if (!fill) return;
  if (pageIsPlaying()) {
    // The page owns its own timeline: no estimate from the receiver.
    fill.style.width = "0%";
    return;
  }
  const duration = current?.durationMs ?? 0;
  let elapsed = baseMs;
  if (current?.isPlaying) elapsed += Date.now() - baseAt;
  elapsed = Math.max(0, Math.min(elapsed, duration || elapsed));
  fill.style.width = duration > 0 ? `${Math.min(100, (elapsed / duration) * 100)}%` : "0%";
}
