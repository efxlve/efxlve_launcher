import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem } from "./core/types";
import type { CollectionImport, EpicAchievementSummary, EpicAchievementsData, GameRequirementsResponse } from "./epic";

export interface GogAuthStatus {
  logged_in: boolean;
  user_id: string | null;
  username: string | null;
}

export interface GogGameSummary {
  game_id: string;
  title: string;
  developer: string | null;
  publisher: string | null;
  is_installed: boolean;
  install_path: string | null;
  install_size: number;
  version: string | null;
  cover_url: string | null;
  hero_url: string | null;
  description: string | null;
  cloud_saves_supported: boolean;
  dlc_count: number;
}

export interface GogCachedLibrary {
  account: string | null;
  account_id: string | null;
  games: GogGameSummary[];
}

export const GOG_LOGIN_URL =
  "https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2";

export async function gogAuthStatus(): Promise<GogAuthStatus> {
  return invoke<GogAuthStatus>("gog_auth_status");
}

export async function gogAuthCode(code: string): Promise<GogAuthStatus> {
  return invoke<GogAuthStatus>("gog_auth_code", { code });
}

export async function gogLogout(): Promise<void> {
  return invoke<void>("gog_logout");
}

export async function gogCachedLibrary(): Promise<GogCachedLibrary> {
  return invoke<GogCachedLibrary>("gog_cached_library");
}

export async function gogListGames(): Promise<GogGameSummary[]> {
  return invoke<GogGameSummary[]>("gog_list_games");
}

export async function gogInstallGame(gameId: string, installPath?: string): Promise<void> {
  return invoke<void>("gog_install_game", { gameId, installPath: installPath ?? null });
}

export async function gogCancelDownload(gameId: string): Promise<void> {
  return invoke<void>("gog_cancel_download", { gameId });
}

export async function gogPauseDownload(gameId: string): Promise<string> {
  return invoke<string>("gog_pause_download", { gameId });
}

export async function gogResumeDownload(gameId: string): Promise<string> {
  return invoke<string>("gog_resume_download", { gameId });
}

export async function gogLaunchGame(gameId: string): Promise<string> {
  return invoke<string>("gog_launch_game", { gameId });
}

export async function gogStopGame(gameId: string): Promise<string> {
  return invoke<string>("gog_stop_game", { gameId });
}

export async function gogUninstallGame(gameId: string): Promise<string> {
  return invoke<string>("gog_uninstall_game", { gameId });
}

export async function gogImportGame(gameId: string, installPath: string): Promise<GogGameSummary> {
  return invoke<GogGameSummary>("gog_import_game", { gameId, installPath });
}

export async function gogVerifyGame(gameId: string): Promise<void> {
  return invoke<void>("gog_verify_game", { gameId });
}

export interface GogGameDetails {
  game_id: string;
  title: string;
  description: string | null;
  developer: string | null;
  publisher: string | null;
  cover_url: string | null;
  hero_url: string | null;
  slug: string | null;
  screenshots: string[];
  requirements?: GameRequirementsResponse | null;
}

export async function gogGetGameDetails(gameId: string): Promise<GogGameDetails> {
  return invoke<GogGameDetails>("gog_get_game_details", { gameId });
}

export async function gogGetAchievements(gameId: string): Promise<EpicAchievementsData> {
  return invoke<EpicAchievementsData>("gog_get_achievements", { gameId });
}

export async function gogGetAchievementsSummary(): Promise<Record<string, EpicAchievementSummary>> {
  return invoke<Record<string, EpicAchievementSummary>>("gog_get_achievements_summary");
}

export async function gogSyncAchievements(): Promise<Record<string, EpicAchievementSummary>> {
  return invoke<Record<string, EpicAchievementSummary>>("gog_sync_achievements");
}

export async function gogGetSystemRequirements(gameId: string): Promise<GameRequirementsResponse> {
  return invoke<GameRequirementsResponse>("gog_get_system_requirements", { gameId });
}

/** Convert a raw GOG summary into the unified LibraryItem format. */
export function gogToLibraryItem(g: GogGameSummary): LibraryItem {
  return {
    key: `gog::${g.game_id}`,
    source: "gog",
    id: g.game_id,
    title: g.title,
    developer: g.developer || g.publisher || "",
    version: g.version || "1.0",
    installedVersion: g.is_installed ? g.version : null,
    installed: g.is_installed,
    installPath: g.install_path,
    installSize: g.install_size,
    coverUrl: g.cover_url || null,
    heroUrl: g.hero_url || g.cover_url || null,
    description: g.description || "",
    updateAvailable: false,
    cloudSavesSupported: g.cloud_saves_supported,
    dlcCount: g.dlc_count,
  };
}

export interface SavedGogAccount {
  user_id: string;
  username: string;
  last_used: number;
  is_active: boolean;
  game_count: number | null;
}

export const gogGetSavedAccounts = () =>
  invoke<SavedGogAccount[]>("gog_get_saved_accounts");

export const gogSwitchAccount = (userId: string) =>
  invoke<SavedGogAccount>("gog_switch_account", { userId });

export const gogRemoveSavedAccount = (userId: string) =>
  invoke<void>("gog_remove_saved_account", { userId });

/** One game entry GOG Galaxy reports as installed (registry scan). */
export interface GalaxyDetectedGame {
  gameId: string;
  title: string;
  installPath: string;
  version: string;
  buildId: string;
  executable: string;
}

export const gogDetectGalaxyGames = () =>
  invoke<GalaxyDetectedGame[]>("gog_detect_galaxy_games");

export const gogSyncGalaxyInstalled = () =>
  invoke<number>("gog_sync_galaxy_installed");

/** Update state for one installed GOG game (installed build vs. latest build). */
export interface GogUpdateInfo {
  gameId: string;
  installedBuildId: string;
  latestBuildId: string;
  latestVersion: string;
  datePublished: string;
}

export const gogCheckUpdates = (force = false) =>
  invoke<GogUpdateInfo[]>("gog_check_updates", { force });

/** One playtime row read from GOG Galaxy's local database. */
export interface GalaxyPlaytimeEntry {
  gameId: string;
  seconds: number;
}

export const gogSyncPlaytime = (userId?: string | null) =>
  invoke<GalaxyPlaytimeEntry[]>("gog_sync_playtime", { userId: userId ?? null });

/** GOG install folder from Settings → Downloads (empty = the default). */
export const gogGetInstallDir = () => invoke<string | null>("gog_get_install_dir");

export const gogSetInstallDir = (path: string | null) =>
  invoke<void>("gog_set_install_dir", { path });

/** Fallback GOG install folder: `%USERPROFILE%\Games\GOG`. */
export const gogDefaultInstallDir = () => invoke<string>("gog_default_install_dir");

/**
 * Imports the user's GOG Galaxy tags as collections (read-only) and returns
 * the merged collection list plus the games Galaxy had hidden.
 */
export const gogImportGalaxyTags = () =>
  invoke<CollectionImport>("gog_import_galaxy_tags");
