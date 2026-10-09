/**
 * Typed bridge to the Rust Spotify commands, shared by the launcher's Music
 * page and the in-game overlay music tab.
 *
 * Everything goes through the in-process librespot Connect receiver; there is
 * no Spotify Web API session.
 */

import { invoke } from "@tauri-apps/api/core";

export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  artUrl: string;
  url: string;
  uri: string;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  deviceName: string;
  deviceId: string;
  volumePercent: number | null;
  shuffle: boolean;
  /** "off" | "context" | "track" */
  repeat: string;
}

export interface SpotifyPlaybackStatus {
  /** The one-time browser approval is stored. */
  paired: boolean;
  /** The Connect receiver is running right now. */
  running: boolean;
  deviceName: string;
}

export interface PlaylistSummary {
  uri: string;
  name: string;
  trackCount: number;
  artUrl: string;
}

export const spotifyPlaybackStatus = () =>
  invoke<SpotifyPlaybackStatus>("spotify_playback_status");

export const spotifyPlaybackStart = () =>
  invoke<SpotifyPlaybackStatus>("spotify_playback_start");

/** The track the receiver is on right now; null before the first track. */
export const spotifyPlaybackNow = () =>
  invoke<NowPlaying | null>("spotify_playback_now");

export const spotifyPlaybackControl = (
  action: "play" | "pause" | "next" | "previous" | "seek" | "volume" | "shuffle" | "repeat",
  value?: number | null,
) => invoke<void>("spotify_playback_control", { action, value: value ?? null });

/** The user's playlists for the overlay picker. */
export const spotifyPlaybackPlaylists = () =>
  invoke<PlaylistSummary[]>("spotify_playback_playlists");

/** Loads and starts a playlist context on the launcher's receiver. */
export const spotifyPlaybackPlay = (uri: string) =>
  invoke<void>("spotify_playback_play", { uri });

/** mm:ss for a millisecond timeline position. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
