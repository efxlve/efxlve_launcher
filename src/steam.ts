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

/** Playtime from the Steam client's own local config, in seconds. */
export interface SteamPlaytime {
  seconds: number;
  lastPlayed: number | null;
}

/** Store metadata shown on the game page (cached on disk for 6 hours). */
export interface SteamGameDetails {
  appId: string;
  name: string;
  shortDescription: string;
  description: string;
  developers: string[];
  publishers: string[];
  genres: string[];
  releaseDate: string;
  headerImage: string;
  website: string;
  /** DLC app ids listed by the store (names would need one call each). */
  dlc: string[];
  requirementsMin: string[];
  requirementsRec: string[];
}

export const steamStatus = () => invoke<SteamStatus>("steam_status");
export const steamListInstalled = () => invoke<SteamGame[]>("steam_list_installed");
/** Hands an action (launch/install/uninstall/validate) to the Steam client. */
export const steamGameAction = (appId: string, action: "launch" | "install" | "uninstall" | "validate") =>
  invoke<void>("steam_game_action", { appId, action });
export const steamSyncPlaytime = () =>
  invoke<Record<string, SteamPlaytime>>("steam_sync_playtime");
export const steamGetGameDetails = (appId: string, language?: string) =>
  invoke<SteamGameDetails>("steam_get_game_details", { appId, language: language ?? null });

/* ---------- Achievements (opt-in: needs a Steam Web API key) ---------- */

export const steamGetApiKey = () => invoke<string | null>("steam_get_api_key");
export const steamSetApiKey = (apiKey: string) => invoke<void>("steam_set_api_key", { apiKey });
/** Schema + the player's unlocks + global rarity; cached on disk for an hour. */
export const steamGetAchievements = (appId: string, force = false) =>
  invoke<import("./epic").EpicAchievementsData>("steam_get_achievements", { appId, force });
/** Cached summaries for library covers (disk only, no network). */
export const steamGetAchievementsSummary = () =>
  invoke<Record<string, import("./epic").EpicAchievementSummary>>("steam_get_achievements_summary");
