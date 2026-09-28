/**
 * Steam integration API — detection and hand-off only.
 *
 * Steamworks DRM means a game cannot run without the Steam client, so the
 * launcher reads the client's own metadata from disk (install path, library
 * folders, app manifests) and hands every action back to Steam through its
 * `steam://` protocol. No game files are touched, no network is used.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SteamStatus {
  installed: boolean;
  path: string;
  games: number;
}

/** One installed Steam game read from `appmanifest_<id>.acf`. */
export interface SteamGame {
  appId: string;
  name: string;
  installDir: string;
  sizeBytes: number;
  /** Steam StateFlags: 4 = fully installed, 2 = update required. */
  stateFlags: number;
  library: string;
}

export const steamStatus = () => invoke<SteamStatus>("steam_status");
export const steamListInstalled = () => invoke<SteamGame[]>("steam_list_installed");
export const steamLaunchGame = (appId: string) => invoke<void>("steam_launch_game", { appId });
