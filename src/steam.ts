/**
 * Steam integration API.
 *
 * Steamworks DRM means a game cannot run without the Steam client, so the
 * launcher reads the client's own metadata from disk (install path, library
 * folders, app manifests) and hands every game action back to Steam through
 * its `steam://` protocol. No game files are touched.
 *
 * The optional account sign-in (ROADMAP §13) additionally reads the owned
 * library through Steam's own auth service; the password is never stored and
 * the refresh token is sealed with Windows DPAPI.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SteamStatus {
  installed: boolean;
  path: string;
  games: number;
  /** Persona name signed in to the Steam client (empty when unknown). */
  userName: string;
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
  /** True while the Steam client is downloading this app. */
  downloading: boolean;
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
/** Opens the Steam client itself (no game launch). */
export const steamOpenClient = () => invoke<void>("steam_open_client");
export const steamListInstalled = () => invoke<SteamGame[]>("steam_list_installed");
/** Hands an action (launch/install/uninstall/validate) to the Steam client. */
export const steamGameAction = (appId: string, action: "launch" | "install" | "uninstall" | "validate") =>
  invoke<void>("steam_game_action", { appId, action });
export const steamSyncPlaytime = () =>
  invoke<Record<string, SteamPlaytime>>("steam_sync_playtime");
export const steamGetGameDetails = (appId: string, language?: string, force = false) =>
  invoke<SteamGameDetails>("steam_get_game_details", { appId, language: language ?? null, force });

/* ---------- Achievements (opt-in: needs a Steam Web API key) ---------- */

export const steamGetApiKey = () => invoke<string | null>("steam_get_api_key");
export const steamSetApiKey = (apiKey: string) => invoke<void>("steam_set_api_key", { apiKey });
/** Schema + the player's unlocks + global rarity; cached on disk for an hour. */
export const steamGetAchievements = (appId: string, force = false) =>
  invoke<import("./epic").EpicAchievementsData>("steam_get_achievements", { appId, force });
/** Cached summaries for library covers (disk only, no network). */
export const steamGetAchievementsSummary = () =>
  invoke<Record<string, import("./epic").EpicAchievementSummary>>("steam_get_achievements_summary");
/**
 * Screenshots taken by the Steam client for one app (read-only gallery: the
 * files belong to the client, so they are never edited or deleted here).
 */
export const steamGetGameScreenshots = (appId: string) =>
  invoke<import("./epic").GameScreenshotItem[]>("steam_get_game_screenshots", { appId });

/* ---------- Account sign-in (ROADMAP §13, the web auth flow) ---------- */

/** Sign-in state from `steam_login_begin` / `steam_login_code` / `steam_login_status`. */
export interface SteamLoginStatus {
  /** `idle` | `code` | `confirm` | `pending` | `signed_in` */
  state: "idle" | "code" | "confirm" | "pending" | "signed_in";
  accountName: string;
  steamId: string;
  /** Email domain hint when Steam Guard sent a code by mail. */
  emailHint: string;
  /** Poll interval suggested by Steam, in seconds. */
  interval: number;
  /**
   * Steam also accepts a one-tap approval in the mobile app (or an email link)
   * for this session, so the code is optional.
   */
  confirm: boolean;
}

/** One owned Steam game read through `IPlayerService/GetOwnedGames`. */
export interface SteamOwnedGame {
  appId: string;
  name: string;
  /** Total playtime in minutes (Steam's own unit). */
  playtimeForever: number;
  playtimeTwoWeeks: number;
  iconUrl: string;
}

export interface SteamOwnedGames {
  gameCount: number;
  games: SteamOwnedGame[];
}

/**
 * Starts a sign-in: the password is sent RSA encrypted for this one request and
 * is never stored. `remember` seals the refresh token with Windows DPAPI.
 */
export const steamLoginBegin = (accountName: string, password: string, remember: boolean) =>
  invoke<SteamLoginStatus>("steam_login_begin", { accountName, password, remember });
/** Submits the Steam Guard code (email or mobile authenticator). */
export const steamLoginCode = (code: string) => invoke<SteamLoginStatus>("steam_login_code", { code });
/**
 * Reports the current session, and polls the pending sign-in while one exists
 * (no login in flight means no network request at all).
 */
export const steamLoginStatus = () => invoke<SteamLoginStatus>("steam_login_status");
/** Drops the session from memory and deletes the sealed token file. */
export const steamLogout = () => invoke<void>("steam_logout");
/** Every owned game (installed or not); refreshes the access token silently. */
export const steamOwnedGames = () => invoke<SteamOwnedGames>("steam_owned_games");
