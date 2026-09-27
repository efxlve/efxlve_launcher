import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem } from "./core/types";

export interface GogAuthStatus {
  logged_in: boolean;
  user_id: string | null;
  username: string | null;
}

export interface GogSetupStatus {
  binary_path: string | null;
  version: string | null;
  needs_download: boolean;
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

export async function gogSetupStatus(): Promise<GogSetupStatus> {
  return invoke<GogSetupStatus>("gog_setup_status");
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

/** Convert a raw GOG summary into the unified LibraryItem format. */
export function gogToLibraryItem(g: GogGameSummary): LibraryItem {
  return {
    key: `gog::${g.game_id}`,
    source: "gog",
    id: g.game_id,
    title: g.title,
    developer: g.developer || "",
    version: g.version || "1.0",
    installedVersion: g.is_installed ? g.version : null,
    installed: g.is_installed,
    installPath: g.install_path,
    installSize: g.install_size,
    coverUrl: g.cover_url,
    heroUrl: g.hero_url,
    description: g.description || "",
    updateAvailable: false,
    cloudSavesSupported: g.cloud_saves_supported,
    dlcCount: g.dlc_count,
  };
}
