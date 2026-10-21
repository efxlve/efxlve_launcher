import { invoke } from "@tauri-apps/api/core";
import type { EpicSummary } from "./epic";
import type { LibraryItem } from "./core/types";

export interface CustomGame {
  id: string;
  title: string;
  exePath: string;
  launchArgs?: string;
  coverUrl?: string;
  headerUrl?: string;
  heroUrl?: string;
  description?: string;
  developer?: string;
  releaseYear?: number;
  genres: string[];
  steamAppId?: string;
  addedAt: number;
}

export interface SteamStoreSearchHit {
  id: number;
  name: string;
  coverUrl: string;
  headerUrl: string;
  heroUrl: string;
}

export interface SteamGameStoreDetails {
  name: string;
  shortDescription: string;
  headerImage: string;
  developers: string[];
  genres: string[];
  releaseYear?: number;
}

export const customGamesList = () =>
  invoke<CustomGame[]>("custom_games_list");

export const customGamesAdd = (game: CustomGame) =>
  invoke<CustomGame>("custom_games_add", { game });

export const customGamesEdit = (game: CustomGame) =>
  invoke<CustomGame>("custom_games_edit", { game });

export const customGamesRemove = (id: string) =>
  invoke<void>("custom_games_remove", { id });

export const customGamesLaunch = (id: string) =>
  invoke<void>("custom_games_launch", { id });

export const customGamesPickFile = (defaultPath?: string, title?: string) =>
  invoke<string | null>("custom_games_pick_file", { defaultPath, title });

export const customGamesSearchSteam = (query: string) =>
  invoke<SteamStoreSearchHit[]>("custom_games_search_steam", { query });

export const customGamesSteamDetails = (appId: string) =>
  invoke<SteamGameStoreDetails>("custom_games_steam_details", { appId });

export function customGameToSummary(g: CustomGame): EpicSummary {
  const parts = g.exePath.replace(/\\/g, "/").split("/");
  const installPath = parts.length > 1 ? parts.slice(0, -1).join("\\") : g.exePath;

  return {
    appName: g.id,
    title: g.title,
    version: "1.0",
    cover: g.coverUrl || null,
    description: g.description || "",
    dlcCount: 0,
    installed: true,
    installPath,
    installSize: 0,
    installedVersion: "1.0",
    updateAvailable: false,
    genres: g.genres,
    releaseYear: g.releaseYear ?? null,
  };
}

export function customGameToLibraryItem(g: CustomGame): LibraryItem {
  const parts = g.exePath.replace(/\\/g, "/").split("/");
  const installPath = parts.length > 1 ? parts.slice(0, -1).join("\\") : g.exePath;

  return {
    key: g.id,
    source: "custom",
    id: g.id.startsWith("custom::") ? g.id.slice(8) : g.id,
    title: g.title,
    developer: g.developer || "",
    version: "1.0",
    installedVersion: "1.0",
    installed: true,
    installPath,
    installSize: 0,
    coverUrl: g.coverUrl || null,
    heroUrl: g.heroUrl || g.coverUrl || null,
    description: g.description || "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
    genres: g.genres,
    releaseYear: g.releaseYear ?? null,
  };
}
