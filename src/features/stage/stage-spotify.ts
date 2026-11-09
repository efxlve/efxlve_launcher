/**
 * Spotify Music Hub for Stage mode.
 *
 * Provides a dedicated console music player with real-time playback controls,
 * album art presentation, playlist browser, and Connect receiver integration.
 */

import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import {
  formatTime,
  spotifyPlaybackControl,
  spotifyPlaybackNow,
  spotifyPlaybackPlay,
  spotifyPlaybackPlaylists,
  spotifyPlaybackStart,
  spotifyPlaybackStatus,
  type NowPlaying,
  type PlaylistSummary,
  type SpotifyPlaybackStatus,
} from "../music/spotify-client";
import { stageFeedback } from "./stage-sound";

let nowPlaying: NowPlaying | null = null;
let playlists: PlaylistSummary[] = [];
let status: SpotifyPlaybackStatus | null = null;
let pollTimer: number | null = null;
let isLoadingPlaylists = false;

export async function refreshStageSpotify(): Promise<void> {
  try {
    const [now, st] = await Promise.all([
      spotifyPlaybackNow().catch(() => null),
      spotifyPlaybackStatus().catch(() => null),
    ]);
    nowPlaying = now;
    status = st;

    if (playlists.length === 0 && !isLoadingPlaylists && st?.running) {
      isLoadingPlaylists = true;
      spotifyPlaybackPlaylists(false)
        .then((list) => {
          playlists = list || [];
          if (S.stage.active && S.stage.spotifyOpen) scheduleRender();
        })
        .catch(() => undefined)
        .finally(() => {
          isLoadingPlaylists = false;
        });
    }
  } catch {
    /* ignore */
  }
}

export function stageOpenSpotifySheet(): void {
  stageFeedback("select");
  S.stage.spotifyOpen = true;
  S.stage.browserOpen = false;
  S.stage.discordOpen = false;
  S.stage.quickMenu = false;
  S.stage.focusKey = "spotify:play-toggle";
  void refreshStageSpotify().then(() => scheduleRender());

  if (!pollTimer) {
    pollTimer = window.setInterval(() => {
      if (!S.stage.active || !S.stage.spotifyOpen) {
        if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }
      void refreshStageSpotify().then(() => scheduleRender());
    }, 1500);
  }
  scheduleRender();
}

export function stageCloseSpotifySheet(): void {
  stageFeedback("back");
  S.stage.spotifyOpen = false;
  S.stage.focusKey = "";
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  scheduleRender();
}

export async function stageSpotifyAction(
  action: "play" | "pause" | "toggle" | "next" | "previous" | "shuffle" | "repeat" | "start",
  val?: number,
): Promise<void> {
  if (action === "toggle") {
    stageFeedback("select");
    const isPlaying = nowPlaying?.isPlaying ?? false;
    await spotifyPlaybackControl(isPlaying ? "pause" : "play").catch(() => undefined);
    await refreshStageSpotify();
    scheduleRender();
    return;
  }
  if (action === "start") {
    stageFeedback("launch");
    await spotifyPlaybackStart().catch(() => undefined);
    await refreshStageSpotify();
    scheduleRender();
    return;
  }
  stageFeedback("select");
  await spotifyPlaybackControl(action, val).catch(() => undefined);
  await refreshStageSpotify();
  scheduleRender();
}

export async function stageSpotifyPlayPlaylist(uri: string): Promise<void> {
  stageFeedback("launch");
  await spotifyPlaybackPlay(uri).catch(() => undefined);
  await refreshStageSpotify();
  scheduleRender();
}

export function stageSpotifyNowSummary(): NowPlaying | null {
  return nowPlaying;
}

export function renderStageSpotifySheet(entered: boolean): string {
  const isRunning = status?.running;
  const isPlaying = nowPlaying?.isPlaying;
  const title = nowPlaying?.title || "Spotify";
  const artist = nowPlaying?.artist || (isRunning ? t("settings.connected") : t("accounts.spotifyDesc"));
  const art = nowPlaying?.artUrl;
  const progress = nowPlaying?.progressMs || 0;
  const duration = nowPlaying?.durationMs || 1;
  const pct = Math.min(100, Math.round((progress / duration) * 100));

  return `<div class="stage-overlay stage-spotify-sheet${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-spotify-panel" role="dialog" aria-modal="true" aria-label="Spotify">
      <div class="stage-spotify-head">
        <div class="stage-spotify-title-wrap">
          <span class="stage-spotify-brand">${icon("spotify", 24)}</span>
          <div>
            <h2 class="stage-spotify-title">Spotify</h2>
            <span class="stage-spotify-subtitle">${isRunning ? `${icon("check", 12)} ${esc(status?.deviceName || "Connect")}` : esc(t("accounts.spotifyDesc"))}</span>
          </div>
        </div>
        <button type="button" class="stage-icon-btn" data-stage-act="close-spotify-sheet" data-gp-item data-gp-key="spotify:close" aria-label="${esc(t("common.close"))}">
          ${icon("x", 20)}
        </button>
      </div>

      <div class="stage-spotify-hero">
        <div class="stage-spotify-art-wrap">
          ${art ? `<img class="stage-spotify-art" src="${esc(art)}" alt="" />` : `<div class="stage-spotify-art-empty">${icon("music", 44)}</div>`}
          ${isPlaying ? `<div class="stage-spotify-playing-badge"><span class="stage-spotify-eq-bar"></span><span class="stage-spotify-eq-bar"></span><span class="stage-spotify-eq-bar"></span></div>` : ""}
        </div>
        <div class="stage-spotify-meta">
          <span class="stage-kicker">${esc(nowPlaying?.album || "Spotify Music")}</span>
          <h3 class="stage-spotify-track">${esc(title)}</h3>
          <span class="stage-spotify-artist">${esc(artist)}</span>

          <div class="stage-spotify-progress-wrap">
            <div class="stage-spotify-timeline">
              <span class="stage-spotify-bar" style="width: ${pct}%"></span>
            </div>
            <div class="stage-spotify-times tabular-nums">
              <span>${formatTime(progress)}</span>
              <span>${formatTime(duration)}</span>
            </div>
          </div>

          <div class="stage-spotify-controls" data-gp-row>
            <button type="button" class="stage-icon-btn${nowPlaying?.shuffle ? " is-active" : ""}" data-stage-act="spotify-shuffle" data-gp-item data-gp-key="spotify:shuffle" aria-label="Shuffle">
              ${icon("shuffle", 18)}
            </button>
            <button type="button" class="stage-icon-btn" data-stage-act="spotify-prev" data-gp-item data-gp-key="spotify:prev" aria-label="Previous">
              ${icon("skip-back", 20)}
            </button>
            <button type="button" class="stage-spotify-play-btn" data-stage-act="spotify-toggle" data-gp-item data-gp-key="spotify:play-toggle" data-gp-default aria-label="${isPlaying ? "Pause" : "Play"}">
              ${icon(isPlaying ? "pause" : "play", 24)}
            </button>
            <button type="button" class="stage-icon-btn" data-stage-act="spotify-next" data-gp-item data-gp-key="spotify:next" aria-label="Next">
              ${icon("skip-forward", 20)}
            </button>
            <button type="button" class="stage-icon-btn${nowPlaying?.repeat && nowPlaying.repeat !== "off" ? " is-active" : ""}" data-stage-act="spotify-repeat" data-gp-item data-gp-key="spotify:repeat" aria-label="Repeat">
              ${icon("repeat", 18)}
            </button>
          </div>
        </div>
      </div>

      ${!isRunning ? `
        <div class="stage-spotify-connect-card">
          <span>${icon("wifi", 22)}</span>
          <div>
            <strong>${esc(t("music.startEngine"))}</strong>
            <p>${esc(t("accounts.spotifyDesc"))}</p>
          </div>
          <button type="button" class="stage-btn stage-btn-primary" data-stage-act="spotify-start" data-gp-item data-gp-key="spotify:start">
            ${icon("play", 16)} <span>${esc(t("music.startEngine"))}</span>
          </button>
        </div>
      ` : ""}

      ${playlists.length > 0 ? `
        <div class="stage-spotify-playlists-section">
          <span class="stage-kicker">${esc(t("overlay.tabMusic"))}</span>
          <div class="stage-spotify-playlists-row" data-gp-row>
            ${playlists.map((pl, idx) => `
              <button
                type="button"
                class="stage-spotify-pl-card"
                data-stage-act="spotify-playlist"
                data-uri="${esc(pl.uri)}"
                data-gp-item
                data-gp-key="pl:${idx}"
                aria-label="${esc(pl.name)}"
              >
                <div class="stage-spotify-pl-art">
                  ${pl.artUrl ? `<img src="${esc(pl.artUrl)}" alt="" loading="lazy" />` : icon("music", 24)}
                </div>
                <div class="stage-spotify-pl-copy">
                  <strong>${esc(pl.name)}</strong>
                  <span class="tabular-nums">${pl.trackCount} ${esc(t("overlay.tracks"))}</span>
                </div>
              </button>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  </div>`;
}
