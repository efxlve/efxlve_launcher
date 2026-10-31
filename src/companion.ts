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
  /** True while the client is still downloading this game. */
  downloading: boolean;
  /** Bytes the client has written under its download folder. */
  downloadBytes: number;
  /** Total transfer size, or 0 when the client does not expose it. */
  downloadTotal: number;
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

/** One owned base game read straight from Ubisoft's Demux service. */
export interface UbiDirectGame {
  productId: number;
  uplayId: number;
  name: string;
  installable: boolean;
  manifest: string;
}

export interface UbiDirectProbe {
  account: string;
  total: number;
  installable: number;
  games: UbiDirectGame[];
}

/** The manifest summary shown before a direct install starts. */
export interface UbiDirectPlan {
  productId: number;
  name: string;
  manifest: string;
  installDir: string;
  files: number;
  slices: number;
  bytes: number;
  compression: string;
  sliceLayout: string;
}

export interface UbiDirectProgress {
  productId: number;
  doneBytes: number;
  totalBytes: number;
  file: string;
}

export interface UbiDirectSummary {
  productId: number;
  name: string;
  installDir: string;
  files: number;
  bytes: number;
  skippedFiles: number;
}

/** Owned games and their manifest ids, with no Ubisoft Connect process. */
export const ubiDirectProbe = () => invoke<UbiDirectProbe>("ubi_direct_probe");

/** Reads the manifest and reports size/layout without writing files. */
export const ubiDirectPlan = (productId: number, path?: string) =>
  invoke<UbiDirectPlan>("ubi_direct_plan", { productId, path });

/** Starts the direct CDN install; progress arrives as `ubi-direct-progress`. */
export const ubiDirectInstall = (productId: number, path?: string) =>
  invoke<void>("ubi_direct_install", { productId, path });

/** Starts a game the launcher installed, without Ubisoft Connect. */
export const ubiDirectLaunch = (productId: number) =>
  invoke<void>("ubi_direct_launch", { productId });

/** Removes a direct install; `deleteFiles` also removes the game folder. */
export const ubiDirectUninstall = (productId: number, deleteFiles = true) =>
  invoke<void>("ubi_direct_uninstall", { productId, deleteFiles });

/** Stops a running direct install; the partial file is kept for resume. */
export const ubiDirectCancel = (productId: number) =>
  invoke<void>("ubi_direct_cancel", { productId });

export interface UbiDirectVerifyReport {
  files: number;
  checked: number;
  missing: number;
  corrupt: number;
  repaired: number;
  badFiles: string[];
}

/** Checks a direct install against its manifest; repair re-downloads failures. */
export const ubiDirectVerify = (installPath: string, repair = true) =>
  invoke<UbiDirectVerifyReport>("ubi_direct_verify", { installPath, repair });

/** Whether this direct install launches through Ubisoft Connect; null when the
 * folder is client-managed rather than a direct install. */
export const ubiDirectLaunchMode = (installPath: string) =>
  invoke<boolean | null>("ubi_direct_launch_mode", { installPath });

/** Switch one direct install between the local shim and Ubisoft Connect. */
export const ubiDirectSetClientLaunch = (installPath: string, enabled: boolean) =>
  invoke<void>("ubi_direct_set_client_launch", { installPath, enabled });

/** Where a Ubisoft title keeps its saves; null when nothing exists yet. */
export const ubiSavePath = (productId: number, installPath?: string, title?: string) =>
  invoke<string | null>("ubi_save_path", {
    productId,
    installPath: installPath || null,
    title: title || null,
  });

/** Installed build against the current CDN manifest. */
export interface UbiUpdateCheck {
  installed: string;
  latest: string;
  update: boolean;
  unknown: boolean;
}

/** Compares the recorded manifest id with the current Ubisoft CDN build. */
export const ubiDirectUpdateCheck = (installPath: string) =>
  invoke<UbiUpdateCheck>("ubi_direct_update_check", { installPath });

/** One install the launcher adopted from Ubisoft Connect. */
export interface UbiAdoptedInstall {
  productId: number;
  name: string;
  installDir: string;
  exe: string;
}

/** Record an existing Connect install as a direct install; files stay put. */
export const ubiDirectAdopt = (productId: number, installPath: string) =>
  invoke<UbiAdoptedInstall>("ubi_direct_adopt", { productId, installPath });

/** Restore the official loaders and stop managing an adopted install. */
export const ubiDirectRelease = (productId: number) =>
  invoke<number>("ubi_direct_release", { productId });

/** One install after a move. */
export interface UbiMovedInstall {
  productId: number;
  installDir: string;
}

/** Move a direct install into another parent folder; the folder name is kept. */
export const ubiDirectMove = (installPath: string, destination: string) =>
  invoke<UbiMovedInstall>("ubi_direct_move", { installPath, destination });

/** Opens the resolved Ubisoft save folder in the file manager. */
export const ubiOpenSaves = (productId: number, installPath?: string, title?: string) =>
  invoke<void>("ubi_open_saves", {
    productId,
    installPath: installPath || null,
    title: title || null,
  });

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
export const companionAchievements = (
  store: CompanionStore,
  id: string,
  title: string,
  language: string,
  forceRefresh = false,
) =>
  invoke<import("./epic").EpicAchievementsData>("companion_achievements", {
    store,
    id,
    title,
    language,
    forceRefresh,
  });

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

/** One step of a Store install the launcher started. */
export interface XboxInstallEvent {
  /** Package family name, the library id of an Xbox row. */
  id: string;
  state: "waiting" | "done" | "cancelled" | "timeout";
}

/**
 * Hands one Xbox install to the Microsoft Store and watches the package
 * registration. The id is the family name, not the composite library key.
 */
export const xboxInstall = (id: string) => invoke<void>("xbox_install", { id });

/** Stops watching. The Store keeps downloading. */
export const xboxInstallCancel = (id: string) => invoke<void>("xbox_install_cancel", { id });

/** Removes an installed Xbox title through the deployment service. */
export const xboxUninstall = (id: string) => invoke<void>("xbox_uninstall", { id });

/** One title from the public Game Pass PC catalog. */
export interface GamePassTitle {
  productId: string;
  title: string;
  publisher: string;
  developer: string;
  poster: string;
  hero: string;
  /** Empty when the title ships through another client (EA Play, mostly). */
  pfn: string;
}

/**
 * The Game Pass PC catalog. Public store metadata, so it answers before an
 * Xbox account is linked; the backend caches it for six hours. No page reads
 * it today: the feed is kept as the data layer for a cross-store surface.
 */
export const xboxGamePassCatalog = () => invoke<GamePassTitle[]>("xbox_gamepass_catalog");

/** One full Game Pass game page. */
export interface GamePassDetail {
  productId: string;
  title: string;
  publisher: string;
  developer: string;
  description: string;
  /** `YYYY-MM-DD`, empty when the store does not publish one. */
  releaseDate: string;
  age: number;
  /** "PEGI 16", "ESRB M"; empty when the market has no rating. */
  rating: string;
  genres: string[];
  poster: string;
  hero: string;
  /** Transparent wordmark drawn over the hero art. */
  logo: string;
  screenshots: string[];
  pfn: string;
}

/** The full record behind one catalog card. */
export const xboxGamePassDetail = (productId: string) =>
  invoke<GamePassDetail | null>("xbox_gamepass_detail", { productId });

/** Opens the Store page for a catalog title the launcher cannot install. */
export const xboxOpenStore = (productId: string) => invoke<void>("xbox_open_store", { productId });

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
    downloading: g.downloading === true,
    bytesDownloaded: g.downloadBytes || 0,
    bytesToDownload: g.downloadTotal || 0,
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}
