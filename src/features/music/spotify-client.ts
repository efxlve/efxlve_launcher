/**
 * Typed bridge to the Rust Spotify commands, shared by the launcher's Music
 * page and the in-game overlay music tab.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SpotifyStatus {
  clientIdSet: boolean;
  connected: boolean;
  user: string;
  /** "premium" | "free" | "" */
  product: string;
  error: string;
}

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

export interface SpotifyDevice {
  id: string;
  name: string;
  isActive: boolean;
  volumePercent: number | null;
  kind: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  uri: string;
  artUrl: string;
  trackCount: number;
  owner: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  artUrl: string;
  uri: string;
  durationMs: number;
  url: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artist: string;
  artUrl: string;
  uri: string;
  url: string;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  imageUrl: string;
  uri: string;
  url: string;
}

export interface SpotifySearchResults {
  tracks: SpotifyTrack[];
  albums: SpotifyAlbum[];
  artists: SpotifyArtist[];
  playlists: SpotifyPlaylist[];
}

export interface SpotifyLibrary {
  tracks: SpotifyTrack[];
  playlists: SpotifyPlaylist[];
  albums: SpotifyAlbum[];
  artists: SpotifyArtist[];
}

export interface SpotifyPlaybackStatus {
  /** The one-time browser approval is stored. */
  paired: boolean;
  /** The Connect receiver is running right now. */
  running: boolean;
  deviceName: string;
}

export const spotifyStatus = () => invoke<SpotifyStatus>("spotify_status");

export const spotifySetClientId = (clientId: string) =>
  invoke<void>("spotify_set_client_id", { clientId });

export const spotifyLogin = () => invoke<SpotifyStatus>("spotify_login");

export const spotifyCancelLogin = () => invoke<void>("spotify_cancel_login");

export const spotifyLogout = () => invoke<void>("spotify_logout");

export const spotifyNowPlaying = () => invoke<NowPlaying | null>("spotify_now_playing");

export const spotifyDevices = () => invoke<SpotifyDevice[]>("spotify_devices");

export const spotifyPlaylists = () => invoke<SpotifyPlaylist[]>("spotify_playlists");

export const spotifySearch = (query: string) =>
  invoke<SpotifySearchResults>("spotify_search", { query });

export const spotifyLibrary = () => invoke<SpotifyLibrary>("spotify_library");

export const spotifyControl = (
  action: "play" | "pause" | "next" | "previous" | "seek" | "volume" | "shuffle" | "repeat",
  value?: number | null,
  deviceId?: string | null,
) => invoke<void>("spotify_control", { action, value: value ?? null, deviceId: deviceId ?? null });

export const spotifyPlay = (uri: string, deviceId?: string | null) =>
  invoke<void>("spotify_play", { uri, deviceId: deviceId ?? null });

export const spotifyTransfer = (deviceId: string) =>
  invoke<void>("spotify_transfer", { deviceId });

/* ---------- In-launcher playback (librespot Connect receiver) ---------- */

export const spotifyPlaybackStatus = () =>
  invoke<SpotifyPlaybackStatus>("spotify_playback_status");

export const spotifyPlaybackStart = () =>
  invoke<SpotifyPlaybackStatus>("spotify_playback_start");

export const spotifyPlaybackStop = () => invoke<void>("spotify_playback_stop");

export const spotifyPlaybackForget = () => invoke<void>("spotify_playback_forget");

/** mm:ss for a millisecond timeline position. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
