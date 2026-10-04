/**
 * DRM launchers other than Steam: EA App, Ubisoft Connect, Xbox and Battle.net.
 *
 * Linking an account imports the catalog that client already cached, the same
 * way GOG Galaxy's plugins do. Play hands the game back to that client.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GameSource, LibraryItem } from "./core/types";

export type CompanionStore = "ea" | "ubisoft" | "xbox" | "battlenet" | "riot";

export interface CompanionGame {
  store: CompanionStore;
  id: string;
  name: string;
  installPath: string;
  installed: boolean;
  coverUrl: string;
  heroUrl: string;
  storeId: string;
  /** Store description from the owned catalog; empty when the client has none. */
  description: string;
  /** Studio from the store page or the client's own catalog. */
  developer: string;
  /** Bulk achievement progress from the account's own service (Xbox). */
  achievementsUnlocked: number;
  achievementsTotal: number;
  achievementsXp: number;
  achievementsTotalXp: number;
}

export interface CompanionAccount {
  store: CompanionStore;
  name: string;
}

export interface CompanionStoreStatus {
  store: CompanionStore;
  clientInstalled: boolean;
  accountName: string;
  linked: boolean;
  needsLogin: boolean;
  gameCount: number;
}

export interface CompanionSyncReport {
  updated: boolean;
  count: number;
  needsLogin: boolean;
}

export interface CompanionPlaytimeRow {
  id: string;
  totalSeconds: number;
}

export interface CompanionCoverHit {
  store: CompanionStore;
  id: string;
  coverUrl: string;
  heroUrl: string;
  /** Studio resolved by the same match; empty when nothing matched. */
  developer: string;
}

export const companionLibrary = () => invoke<CompanionGame[]>("companion_library");

export const companionStoreStatus = () => invoke<CompanionStoreStatus[]>("companion_store_status");

/** Refresh a linked account from its own service (Ubisoft has a session). */
export const companionSync = (store: CompanionStore) =>
  invoke<CompanionSyncReport>("companion_sync", { store });

/** Install, uninstall or launch a game inside its own client. */
export const companionGameAction = (store: CompanionStore, id: string, action: "install" | "uninstall" | "launch") =>
  invoke<void>("companion_game_action", { store, id, action });

/** Playtime the store's own service reports for a linked account. */
export const companionPlaytimes = (store: CompanionStore) =>
  invoke<CompanionPlaytimeRow[]>("companion_playtimes", { store });

/**
 * Achievements the local Ubisoft Connect client cached for one game. The id is
 * the library card id; uninstalled owned games use their catalog space id and
 * the title matcher bridges it to the client's cache.
 */
export const companionAchievements = (store: CompanionStore, id: string, title: string, language: string) =>
  invoke<import("./epic").EpicAchievementsData>("companion_achievements", { store, id, title, language });

/**
 * Bulk summaries for stores that keep achievements on disk (Ubisoft reads the
 * client's local cache). Xbox and EA answer per game, so they are absent here.
 */
export const companionAchievementsSummary = (store: CompanionStore, language: string) =>
  invoke<Record<string, import("./epic").EpicAchievementSummary>>("companion_achievements_summary", { store, language });

export const companionLink = (store: CompanionStore) =>
  invoke<CompanionAccount>("companion_link", { store });

export const companionUnlink = (store: CompanionStore) =>
  invoke<void>("companion_unlink", { store });

export const companionOpenClient = (store: CompanionStore) =>
  invoke<void>("companion_open_client", { store });

export const companionShowLogin = (x: number, y: number, width: number, height: number) =>
  invoke<void>("companion_show_login", { x, y, width, height });

/** Opens the EA sign-in window (PKCE + hardware signature). */
export const eaLoginOpen = () => invoke<void>("ea_login_open");

/** Closes the EA sign-in window without importing. */
export const eaLoginHide = () => invoke<void>("ea_login_hide");

/** Opens the Microsoft sign-in window for the Xbox account. */
export const xboxLoginOpen = () => invoke<void>("xbox_login_open");

/** Closes the Xbox sign-in window without importing. */
export const xboxLoginHide = () => invoke<void>("xbox_login_hide");

export const companionLaunch = (store: CompanionStore, id: string) =>
  invoke<void>("companion_launch", { store, id });

/** Per-client behavior toggles (Integrations → After playing). */
export interface CompanionClientSettings {
  closeAfterPlay: Record<string, boolean>;
}

export const companionGetClientSettings = () =>
  invoke<CompanionClientSettings>("companion_get_client_settings");

export const companionSetCloseAfterPlay = (store: CompanionStore, enabled: boolean) =>
  invoke<void>("companion_set_close_after_play", { store, enabled });

export const companionResolveCovers = (
  queries: { store: string; id: string; name: string; storeId: string; cover?: string }[],
) => invoke<CompanionCoverHit[]>("companion_resolve_covers", { queries });

export function companionToItem(g: CompanionGame): LibraryItem {
  const source = g.store as GameSource;
  return {
    key: `${g.store}::${g.id}`,
    source,
    id: g.id,
    title: g.name,
    developer: g.developer || "",
    version: "—",
    installedVersion: null,
    installed: g.installed !== false,
    installPath: g.installPath || null,
    installSize: 0,
    coverUrl: g.coverUrl || null,
    heroUrl: g.heroUrl || null,
    description: g.description || "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}
