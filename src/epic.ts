import { invoke } from "@tauri-apps/api/core";

import { NO_DESC } from "./core/constants";

/* ---------- Types (match the Rust models, snake_case) ---------- */

export interface EpicGameAsset {
  app_name: string;
  asset_id: string;
  build_version: string;
  catalog_item_id: string;
  label_name: string;
  namespace: string;
  metadata: Record<string, unknown>;
  sidecar_rev: number;
}

export interface EpicKeyImage {
  type: string;
  url: string;
}

export interface EpicGame {
  app_name: string;
  app_title: string;
  asset_infos: Record<string, EpicGameAsset>;
  base_urls: string[];
  metadata: {
    description?: string;
    keyImages?: EpicKeyImage[];
    mainGameItem?: unknown;
    [k: string]: unknown;
  };
  sidecar: unknown;
  achievements: unknown;
  dlcs?: unknown[];
}

export interface EpicInstalled {
  app_name: string;
  install_path: string;
  title: string;
  version: string;
  install_size: number;
  executable: string;
  can_run_offline: boolean;
  platform: string;
  needs_verification: boolean;
  save_path: string | null;
}

export interface EpicStatus {
  account: string;
  games_available: number;
  games_installed: number;
  egl_sync_enabled: boolean;
  config_directory: string;
}

export interface SetupStatus {
  binaryPath: string | null;
  version: string | null;
  needsDownload: boolean;
  altBin: string | null;
}

export interface SetupEvent {
  state: string;
  progress: number | null;
  message: string;
}

export interface LibraryEvent {
  state: string;
  attempt: number;
  message: string;
}

export interface CachedLibrary {
  account: string | null;
  accountId: string | null;
  games: EpicGame[];
  installed: EpicInstalled[];
  skipped: string[];
}

export const NOT_AUTH = "NOT_AUTHENTICATED";
export const EPIC_LOGIN_URL = "https://legendary.gl/epiclogin";
export const isNotAuth = (e: unknown): boolean => String(e).includes(NOT_AUTH);

/* ---------- Presentation helpers ---------- */

const COVER_PRIORITY = [
  "DieselGameBox",
  "OfferImageWide",
  "DieselGameBoxTall",
  "OfferImageTall",
  "DieselStoreFrontTall",
  "DieselGameBoxLogo",
];

export function epicCover(g: EpicGame): string | null {
  const imgs = g.metadata?.keyImages;
  if (!Array.isArray(imgs)) return null;
  for (const t of COVER_PRIORITY) {
    const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
    if (found) return found.url;
  }
  const any = imgs.find((i) => typeof i?.url === "string");
  return any ? (any.url as string) : null;
}

/** Portrait cover for cards: Tall → wide art → first available. */
export function epicPortrait(g: EpicGame): string | null {
  const imgs = g.metadata?.keyImages;
  if (!Array.isArray(imgs)) return epicCover(g);
  for (const t of ["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall"]) {
    const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
    if (found) return found.url;
  }
  return epicCover(g);
}

export const EPIC_STORE_URL = "https://store.epicgames.com/";

export function toEpicSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’:]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function epicStorePageUrl(title: string): string {
  const slug = toEpicSlug(title);
  return slug ? `https://store.epicgames.com/p/${slug}` : EPIC_STORE_URL;
}

export function epicStoreSearch(title: string): string {
  return `https://store.epicgames.com/browse?q=${encodeURIComponent(title)}`;
}

export function epicAchievementsUrl(title: string, appName?: string): string {
  if (appName?.toLowerCase() === "carnation") {
    return "https://store.epicgames.com/achievements/rainbow-six-siege-x";
  }
  const slug = toEpicSlug(title);
  return slug ? `https://store.epicgames.com/achievements/${slug}` : EPIC_STORE_URL;
}

export function epicVersion(g: EpicGame): string {
  return g.asset_infos?.["Windows"]?.build_version || "—";
}

export function epicDescription(g: EpicGame): string {
  const d = g.metadata?.description;
  return typeof d === "string" && d ? d : NO_DESC;
}

export function isDlc(g: EpicGame): boolean {
  return g.metadata != null && "mainGameItem" in g.metadata;
}

const UE_CATEGORY_PATHS = ["assets", "asset-format", "plugins", "projects"];

/** Not a game: Unreal Engine content or a mod (same rule as Heroic). */
export function isNonGameContent(g: EpicGame): boolean {
  const md = g.metadata as {
    namespace?: unknown;
    categories?: { path?: unknown }[] | null;
  } | null;
  if (!md || typeof md !== "object") return false;
  if (md.namespace === "ue") return true;
  const cats = md.categories;
  if (!Array.isArray(cats)) return false;
  return cats.some((c) => {
    const p = (c as { path?: unknown } | null)?.path;
    return p === "mods" || (typeof p === "string" && UE_CATEGORY_PATHS.includes(p));
  });
}

export interface ThirdPartyLauncherInfo {
  name: string;
  type: "ea" | "ubisoft" | "rockstar" | "gog" | "other";
  shortName: string;
}

/** Third-party launcher detection (EA App, Ubisoft Connect, Rockstar Games, etc.). */
export function getThirdPartyLauncher(g: EpicGame | undefined | null): ThirdPartyLauncherInfo | null {
  if (!g?.metadata) return null;
  const attrs = (g.metadata.customAttributes as Record<string, { value?: string }>) || {};
  const tpApp = attrs.ThirdPartyManagedApp?.value?.toLowerCase() || "";
  const tpProv = attrs.ThirdPartyManagedProvider?.value?.toLowerCase() || "";
  const pType = attrs.partnerLinkType?.value?.toLowerCase() || "";
  const reg = attrs.RegistryPath?.value?.toLowerCase() || "";
  const dev = String(g.metadata.developer || "").toLowerCase();
  const title = String(g.app_title || "").toLowerCase();
  const folder = attrs.FolderName?.value?.toLowerCase() || "";

  if (
    tpApp.includes("origin") ||
    tpApp.includes("ea app") ||
    pType === "ea" ||
    pType === "origin" ||
    reg.includes("ea games") ||
    reg.includes("respawn") ||
    dev.includes("electronic arts")
  ) {
    return { name: "EA App", type: "ea", shortName: "EA App" };
  }
  if (
    tpProv.includes("ubisoft") ||
    pType.includes("ubisoft") ||
    reg.includes("ubisoft") ||
    tpApp.includes("ubisoft") ||
    dev.includes("ubisoft")
  ) {
    return { name: "Ubisoft Connect", type: "ubisoft", shortName: "Ubisoft" };
  }
  if (
    reg.includes("rockstar") ||
    tpApp.includes("rockstar") ||
    dev.includes("rockstar") ||
    title.includes("grand theft auto") ||
    title.includes("gta") ||
    title.includes("red dead") ||
    folder.includes("gtav") ||
    folder.includes("rdr")
  ) {
    return { name: "Rockstar Games Launcher", type: "rockstar", shortName: "Rockstar" };
  }
  if (folder.includes("goggalaxy") || tpApp.includes("gog")) {
    return { name: "GOG GALAXY", type: "gog", shortName: "GOG" };
  }
  if (attrs.ThirdPartyManagedApp?.value) {
    const val = attrs.ThirdPartyManagedApp.value;
    return { name: val, type: "other", shortName: val };
  }
  return null;
}

/** Hile koruma sistemi (Anti-Cheat) tespiti */
export function getAntiCheat(g: EpicGame | undefined | null): string | null {
  if (!g) return null;
  const appName = g.app_name?.toLowerCase() || "";
  const title = (g.app_title || "").toLowerCase();
  const attrs = (g.metadata?.customAttributes as Record<string, { value?: string }>) || {};
  const procNames = attrs.ProcessNames?.value || "";
  const extraArgs = Object.entries(attrs)
    .filter(([k]) => k.startsWith("extraLaunchOption") || k.startsWith("LaunchOption"))
    .map(([, v]) => v?.value || "")
    .join(" ");

  // 1. Process names and arguments
  const combined = (procNames + " " + extraArgs + " " + (attrs.RequirementsJson?.value || "")).toLowerCase();
  if (combined.includes("battleye") || combined.includes("beservice")) {
    return "BattlEye";
  }
  if (combined.includes("easyanticheat") || combined.includes("easy anti-cheat") || combined.includes("eac.exe")) {
    return "Easy Anti-Cheat";
  }
  if (combined.includes("denuvo")) {
    return "Denuvo Anti-Tamper";
  }
  if (combined.includes("vanguard")) {
    return "Riot Vanguard";
  }

  // 2. Popular competitive and well-known games
  if (appName === "carnation" || title.includes("rainbow six siege")) {
    return "BattlEye";
  }
  if (title.includes("grand theft auto") || title.includes("gta v") || title.includes("gta 5")) {
    return "BattlEye";
  }
  if (appName === "babyblue" || title.includes("battlefield 2042")) {
    return "Easy Anti-Cheat";
  }
  if (appName === "makalu" || title.includes("apex legends")) {
    return "Easy Anti-Cheat";
  }
  if (appName.toLowerCase() === "fortnite" || title === "fortnite") {
    return "Easy Anti-Cheat / BattlEye";
  }
  if (title.includes("destiny 2")) {
    return "BattlEye";
  }
  if (title.includes("ark: survival evolved") || title.includes("ark: survival ascended")) {
    return "BattlEye";
  }
  if (title.includes("fall guys")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("dead by daylight")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("hell let loose")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("the finals")) {
    return "Easy Anti-Cheat";
  }
  if (appName === "saffron" || title.includes("ghost recon breakpoint")) {
    return "BattlEye";
  }
  if (title.includes("ghost recon wildlands")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("for honor")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("the division 2")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("paladins") || title.includes("smite") || title.includes("rogue company")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("war thunder")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("elden ring")) {
    return "Easy Anti-Cheat";
  }
  if (title === "squad" || title.startsWith("squad ")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("hunt: showdown") || title.includes("hunt showdown")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("chivalry 2")) {
    return "Easy Anti-Cheat";
  }
  if (title.includes("conan exiles") || title.includes("dayz")) {
    return "BattlEye";
  }
  if (appName === "bobcat" || title.includes("star wars squadrons") || title.includes("star wars: squadrons")) {
    return "Easy Anti-Cheat";
  }

  // 3. Generic customAttributes check
  for (const [k, v] of Object.entries(attrs)) {
    const val = (v?.value || "").toLowerCase();
    const key = k.toLowerCase();
    if (key.includes("battleye") || val.includes("battleye")) return "BattlEye";
    if (key.includes("easyanticheat") || val.includes("easyanticheat")) return "Easy Anti-Cheat";
    if (key.includes("denuvo") || val.includes("denuvo")) return "Denuvo Anti-Tamper";
    if (key.includes("vanguard") || val.includes("vanguard")) return "Riot Vanguard";
  }

  return null;
}

export interface EpicSummary {
  appName: string;
  title: string;
  version: string;
  cover: string | null;
  description: string;
  dlcCount: number;
  installed: boolean;
  installPath: string | null;
  installSize: number;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** Filters out DLCs and skipped broken items, merging in installed info. */
export function summarize(
  games: EpicGame[],
  installed: EpicInstalled[],
  skipped: string[] = [],
): EpicSummary[] {
  const byId = new Map(installed.map((i) => [i.app_name, i]));
  const skipSet = new Set(skipped);
  return games
    .filter((g) => !isDlc(g) && !isNonGameContent(g) && !skipSet.has(g.app_name))
    .map((g) => {
      const ins = byId.get(g.app_name);
      const ver = epicVersion(g);
      return {
        appName: g.app_name,
        title: g.app_title || g.app_name,
        version: ver,
        cover: epicCover(g),
        description: epicDescription(g),
        dlcCount: Array.isArray(g.dlcs) ? g.dlcs.length : 0,
        installed: !!ins,
        installPath: ins?.install_path ?? null,
        installSize: ins?.install_size ?? 0,
        installedVersion: ins?.version ?? null,
        updateAvailable: !!ins && ver !== "—" && ins.version !== ver,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "tr"));
}

/* ---------- Command wrappers ---------- */

export const epicSetupStatus = () => invoke<SetupStatus>("epic_setup_status");
export const epicEnsureBinary = () => invoke<string>("epic_ensure_binary");
export const epicStatus = () => invoke<EpicStatus>("epic_status");
export const epicListGames = () => invoke<EpicGame[]>("epic_list_games");
export const epicListInstalled = () => invoke<EpicInstalled[]>("epic_list_installed");
export const epicLoginWithCode = (code: string) =>
  invoke<string>("epic_login_with_code", { code });
export const epicImportEgl = () => invoke<string>("epic_import_egl");
export const epicLogout = () => invoke<string>("epic_logout");
export const epicListSkipped = () => invoke<string[]>("epic_list_skipped");
export const epicCachedLibrary = () => invoke<CachedLibrary>("epic_cached_library");

export interface DownloadFailedEvent {
  id: string;
  message: string;
}

export interface DownloadCancelledEvent {
  id: string;
}

export interface EpicSettings {
  alt_legendary_bin: string | null;
  install_dir: string | null;
  network_profile?: string | null;
  offline_mode?: boolean | null;
  steamgrid_api_key?: string | null;
  presence_enabled?: boolean | null;
  presence_client_id?: string | null;
  preferred_cdn?: string | null;
}

export const epicInstallGame = (appName: string, installDir?: string) =>
  // Note: Tauri command arguments are camelCase by default (even if Rust uses snake_case)!
  invoke<string>("epic_install_game", { appName, installDir: installDir ?? null });
export const epicCancelDownload = (appName: string) =>
  invoke<string>("epic_cancel_download", { appName });
export const epicUninstallGame = (appName: string, keepFiles = false) =>
  invoke<string>("epic_uninstall_game", { appName, keepFiles });
export const epicLaunchGame = (appName: string) =>
  invoke<string>("epic_launch_game", { appName });
export const epicGetSettings = () => invoke<EpicSettings>("epic_get_settings");

/** Discord Rich Presence: enable/disable and set the Discord application id. */
export const epicPresenceConfigure = (enabled: boolean, clientId: string) =>
  invoke<void>("epic_presence_configure", { enabled, clientId });
/** Discord Rich Presence: push a localized activity (details + state). */
export const epicPresenceUpdate = (details: string, state: string) =>
  invoke<void>("epic_presence_update", { details, state });
/** Discord Rich Presence: clear the current activity. */
export const epicPresenceClear = () => invoke<void>("epic_presence_clear");

/** CDN speed probe result (time-to-first-byte in ms). */
export interface CdnProbe {
  host: string;
  url: string;
  ms: number;
}

/** Measures the Epic CDNs in `baseUrls` and returns them fastest-first. */
export const epicMeasureCdns = (baseUrls: string[]) =>
  invoke<CdnProbe[]>("epic_measure_cdns", { baseUrls });
/** Persists the preferred CDN hostname (null clears it). */
export const epicSetPreferredCdn = (host: string | null) =>
  invoke<void>("epic_set_preferred_cdn", { host });
/** Removes legendary's temporary/metadata/manifest files. */
export const epicCleanupCache = () => invoke<string>("epic_cleanup_cache");

/** EOS Overlay presence (installed system-wide by the Epic Games Launcher). */
export interface EosOverlayStatus {
  installed: boolean;
  path: string;
}
export const eosOverlayStatus = () => invoke<EosOverlayStatus>("eos_overlay_status");

/** Opens an arbitrary folder path in the OS file manager (returns a @t: status message). */
export const epicOpenFolderPath = (path: string) => invoke<string>("open_folder", { path });
export const epicDefaultInstallDir = () => invoke<string>("epic_default_install_dir");
export const epicSetInstallDir = (dir: string | null) =>
  invoke<EpicSettings>("epic_set_install_dir", { dir });

/* ---------- Achievements ---------- */

export interface EpicAchievementTier {
  name: string;
  hexColor: string;
}

export interface EpicAchievementRarity {
  percent?: number;
}

export interface EpicAchievementItem {
  name: string;
  display_name: string;
  description: string;
  xp: number;
  unlocked: boolean;
  progress: number;
  unlock_date: string | null;
  icon_id: string;
  icon_link: string;
  tier?: EpicAchievementTier;
  rarity?: EpicAchievementRarity;
  hidden: boolean;
  is_base: boolean;
}

export interface EpicAchievementsData {
  achievements: EpicAchievementItem[];
  hidden: EpicAchievementItem[];
  user_unlocked: number;
  user_xp: number;
  total_achievements: number;
  total_xp: number;
  is_platinum: boolean;
  base_achievements?: number;
  base_unlocked?: number;
  base_xp?: number;
  base_user_xp?: number;
}

export interface EpicAchievementSummary {
  app_name: string;
  user_unlocked: number;
  total_achievements: number;
  user_xp: number;
  total_xp: number;
  is_platinum: boolean;
  supported: boolean;
  base_achievements?: number;
  base_unlocked?: number;
}

export const epicGetAchievements = (appName: string, forceRefresh = false) =>
  invoke<EpicAchievementsData>("epic_get_achievements", { appName, forceRefresh });

export const epicGetAchievementsSummary = () =>
  invoke<Record<string, EpicAchievementSummary>>("epic_get_achievements_summary");

/* ---------- Sistem Gereksinimleri (System Requirements) ---------- */

export interface SystemDetailItem {
  title: string;
  minimum?: string;
  recommended?: string;
}

export interface SystemRequirement {
  systemType: string;
  details: SystemDetailItem[];
}

export interface GameRequirementsResponse {
  supported: boolean;
  systems: SystemRequirement[];
  languages: string[];
  appName: string;
  description?: string;
  shortDescription?: string;
  tags?: string[];
}

export const epicGetSystemRequirements = (title: string, appName: string, forceRefresh = false) =>
  invoke<GameRequirementsResponse>("epic_get_system_requirements", { title, appName, forceRefresh });

/* ---------- Epic Games Launcher Entegrasyonu ---------- */

export interface EglDetectedGame {
  appName: string;
  title: string;
  installPath: string;
  executable: string;
  version: string;
  installSize: number;
}

export const epicDetectEglGames = () =>
  invoke<EglDetectedGame[]>("epic_detect_egl_games");

export const epicSyncEglInstalled = () =>
  invoke<number>("epic_sync_egl_installed");

/* ---------- Third-party launchers (EA App, Ubisoft Connect, Rockstar) ---------- */

export interface ThirdPartyLauncher {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  installPath: string | null;
  downloadUrl: string;
}

export const epicThirdPartyLaunchers = () =>
  invoke<ThirdPartyLauncher[]>("epic_third_party_launchers");

/* ---------- Game management & verification ---------- */

export interface GameLocalSettings {
  appName: string;
  title: string;
  launchParameters: string;
  autoUpdate: boolean;
  highPriority: boolean;
  cloudSavesEnabled: boolean;
  lastCloudSync?: string | null;
  installSize: number;
  installPath: string;
  version: string;
}

export interface VerifyProgressEvent {
  id: string;
  current: number;
  total: number;
  percent: number;
  speed: string;
  detail?: string;
}

export interface VerifyCompleteEvent {
  id: string;
  success: boolean;
  message: string;
}

export const epicGetGameSettings = (appName: string) =>
  invoke<GameLocalSettings>("epic_get_game_settings", { appName });

export const epicSaveGameSettings = (settings: GameLocalSettings) =>
  invoke<void>("epic_save_game_settings", { settings });

export const epicVerifyGame = (appName: string) =>
  invoke<string>("epic_verify_game", { appName });

export const epicSyncSaves = (appName: string) =>
  invoke<string>("epic_sync_saves", { appName });

export const epicCreateDesktopShortcut = (appName: string) =>
  invoke<string>("epic_create_desktop_shortcut", { appName });

/* ---------- Advanced downloads & queue ---------- */

export interface DlProgressEvent {
  id: string;
  progress: number;
  done: boolean;
  speed?: string | null;
  speedBytes?: number | null;
  diskSpeed?: string | null;
  diskBytes?: number | null;
  eta?: string | null;
  etaSeconds?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
}

export interface DlQueueStatus {
  active?: string | null;
  isPaused: boolean;
  queue: string[];
}

export const epicPauseDownload = (appName: string) =>
  invoke<string>("epic_pause_download", { appName });

export const epicResumeDownload = (appName: string) =>
  invoke<string>("epic_resume_download", { appName });

export const epicReorderQueue = (
  appName: string,
  action: "up" | "down" | "top" | "now" | "remove",
) => invoke<DlQueueStatus>("epic_reorder_queue", { appName, action });

export const epicGetQueue = () => invoke<DlQueueStatus>("epic_get_queue");

/* ---------- Add-on & DLC management ---------- */

export interface GameDlcItem {
  appId: string;
  title: string;
  installed: boolean;
  size: number;
  image?: string | null;
  downloadable?: boolean;
}

export interface GameDlcResponse {
  appName: string;
  gameTitle: string;
  dlcs: GameDlcItem[];
}

export const epicGetGameDlcs = (appName: string) =>
  invoke<GameDlcResponse>("epic_get_game_dlcs", { appName });

/* ---------- Selective install options ---------- */

export interface InstallOptionTag {
  tag: string;
  label: string;
  size: number;
  downloadSize: number;
  category: string;
}

export interface GameInstallOptions {
  appName: string;
  title: string;
  baseSize: number;
  baseDownloadSize: number;
  tags: InstallOptionTag[];
  dlcs: GameDlcItem[];
  hasOptions: boolean;
}

export const epicGetInstallOptions = (appName: string) =>
  invoke<GameInstallOptions>("epic_get_install_options", { appName });

export const epicInstallWithOptions = (
  appName: string,
  installTags: string[],
  dlcAppIds: string[],
  installDir?: string | null,
) =>
  invoke<string>("epic_install_with_options", {
    appName,
    installTags,
    dlcAppIds,
    installDir: installDir || null,
  });

/* ---------- Update engine ---------- */

export interface GameUpdateInfo {
  appName: string;
  title: string;
  installedVersion: string;
  latestVersion: string;
}

export const epicCheckUpdates = () =>
  invoke<GameUpdateInfo[]>("epic_check_updates");

/* ---------- Playtime & live game status ---------- */

export interface PlaytimeRecord {
  total_seconds: number;
  session_count: number;
  last_played_timestamp?: number;
  last_played?: string;
}

export interface GameStatusEvent {
  id: string;
  running: boolean;
  sessionSeconds?: number;
  totalSeconds?: number;
  sessionCount?: number;
  lastPlayed?: string;
  lastPlayedTimestamp?: number;
}

export const epicGetPlaytimes = () =>
  invoke<Record<string, PlaytimeRecord>>("epic_get_playtimes");

export const epicSetPlaytime = (
  appName: string,
  totalSeconds: number,
  lastPlayed?: string | null,
) =>
  invoke<PlaytimeRecord>("epic_set_playtime", {
    appName,
    totalSeconds,
    lastPlayed: lastPlayed ?? null,
  });

/* ---------- Download network profile ---------- */

export type NetworkProfileType = "max" | "balanced" | "low";

export const epicGetNetworkProfile = () =>
  invoke<string>("epic_get_network_profile");

export const epicSetNetworkProfile = (profile: string) =>
  invoke<void>("epic_set_network_profile", { profile });

/* ---------- Offline mode ---------- */

export const epicGetOfflineMode = () =>
  invoke<boolean>("epic_get_offline_mode");

export const epicSetOfflineMode = (enabled: boolean) =>
  invoke<void>("epic_set_offline_mode", { enabled });

/* ---------- Save backup manager ---------- */

export interface SaveBackupInfo {
  id: string;
  app_name: string;
  timestamp: number;
  formatted_date: string;
  size_bytes: number;
  file_count: number;
  save_path: string;
}

export const epicBackupSave = (appName: string) =>
  invoke<SaveBackupInfo>("epic_backup_save", { appName });

export const epicListBackups = (appName: string) =>
  invoke<SaveBackupInfo[]>("epic_list_backups", { appName });

export const epicRestoreBackup = (appName: string, backupId: string) =>
  invoke<string>("epic_restore_backup", { appName, backupId });

export const epicDeleteBackup = (appName: string, backupId: string) =>
  invoke<void>("epic_delete_backup", { appName, backupId });

export const epicOpenBackupFolder = (appName: string) =>
  invoke<string>("epic_open_backup_folder", { appName });

/* ---------- Koleksiyonlar (Collections / Categories) ---------- */

export interface GameCollection {
  id: string;
  name: string;
  app_names: string[];
  created_at?: string | null;
  emoji?: string | null;
}

export const epicGetCollections = () =>
  invoke<GameCollection[]>("epic_get_collections");

export const epicSaveCollection = (
  name: string,
  appNames: string[],
  id?: string | null,
  emoji?: string | null,
) =>
  invoke<GameCollection>("epic_save_collection", {
    id: id ?? null,
    name,
    appNames,
    emoji: emoji ?? null,
  });

export const epicDeleteCollection = (id: string) =>
  invoke<void>("epic_delete_collection", { id });

export const epicSetGameCollections = (
  appName: string,
  collectionIds: string[],
) =>
  invoke<void>("epic_set_game_collections", {
    appName,
    collectionIds,
  });

export const epicImportEglCollections = () =>
  invoke<GameCollection[]>("epic_import_egl_collections");

/* ---------- HowLongToBeat (HLTB) ---------- */

export interface HltbData {
  app_name: string;
  title: string;
  supported: boolean;
  main_story?: number | null;
  main_extra?: number | null;
  completionist?: number | null;
}

export const epicGetHltb = (title: string, appName: string, forceRefresh = false) =>
  invoke<HltbData>("epic_get_hltb", { title, appName, forceRefresh });

/* ---------- Critic & review scores (OpenCritic / Metacritic / Goygoy Engine) ---------- */

export interface GoygoyReview {
  title: string;
  score?: number | null;
  writer?: string | null;
  summary?: string | null;
  summary_en?: string | null;
  url: string;
  image?: string | null;
}

export interface CriticData {
  app_name: string;
  title: string;
  supported: boolean;
  opencritic_score?: number | null;
  opencritic_url?: string | null;
  metacritic_score?: number | null;
  metacritic_url?: string | null;
  igdb_score?: number | null;
  tier?: "Mighty" | "Strong" | "Fair" | "Weak" | null;
  goygoy_review?: GoygoyReview | null;
}

export const epicGetCritic = (title: string, appName: string, forceRefresh = false) =>
  invoke<CriticData>("epic_get_critic", { title, appName, forceRefresh });

/* ---------- SteamGridDB API v2 ---------- */

export interface SteamGridAuthor {
  name?: string | null;
  steam64?: string | null;
  avatar?: string | null;
}

export interface SteamGridImage {
  id: number;
  score: number;
  style?: string | null;
  width?: number | null;
  height?: number | null;
  nsfw?: boolean | null;
  humor?: boolean | null;
  epilepsy?: boolean | null;
  url: string;
  thumb?: string | null;
  author?: SteamGridAuthor | null;
}

export interface SteamGridGame {
  id: number;
  name: string;
  types: string[];
  verified?: boolean | null;
}

export const epicGetSteamGridKey = () =>
  invoke<string | null>("epic_get_steamgrid_key");

export const epicSetSteamGridKey = (apiKey: string) =>
  invoke<void>("epic_set_steamgrid_key", { apiKey });

export const epicTestSteamGridKey = (apiKey: string) =>
  invoke<boolean>("epic_test_steamgrid_key", { apiKey });

export const epicSearchSteamGrid = (term: string) =>
  invoke<SteamGridGame[]>("epic_search_steamgrid", { term });

export const epicGetSteamGridCovers = (
  gameId: number,
  assetType?: "grids" | "heroes",
  styles?: string,
  dimensions?: string,
) =>
  invoke<SteamGridImage[]>("epic_get_steamgrid_covers", {
    gameId,
    assetType: assetType ?? null,
    styles: styles ?? null,
    dimensions: dimensions ?? null,
  });

/* ---------- Player profile & achievements ---------- */

export interface ProfileGameRecord {
  sandbox_id: string;
  app_name: string;
  app_title: string;
  cover: string | null;
  total_unlocked: number;
  total_achievements: number;
  total_xp: number;
  total_product_xp: number;
  is_platinum: boolean;
  unlocked_percent: number;
  last_unlocked_date: string | null;
}

export interface EpicPlayerProfile {
  account_id: string;
  display_name: string;
  total_xp: number;
  total_unlocked: number;
  platinum_count: number;
  games_count: number;
  games: ProfileGameRecord[];
  last_updated: number;
}

export const epicGetPlayerProfile = (forceRefresh = false) =>
  invoke<EpicPlayerProfile>("epic_get_player_profile", { forceRefresh });

/* ---------- Screenshots ---------- */

export interface GameScreenshotItem {
  id: string;
  file_path: string;
  file_name: string;
  date_str: string;
  timestamp: number;
  size_bytes: number;
  size_str: string;
  data_url: string;
}

export const epicGetGameScreenshots = (appName: string, title: string) =>
  invoke<GameScreenshotItem[]>("epic_get_game_screenshots", { appName, title });

export const epicCaptureGameScreenshot = (appName: string, title: string) =>
  invoke<GameScreenshotItem>("epic_capture_game_screenshot", { appName, title });

export const epicDeleteGameScreenshot = (filePath: string) =>
  invoke<boolean>("epic_delete_game_screenshot", { filePath });

export const epicOpenGameScreenshotsFolder = (appName: string, title: string) =>
  invoke<void>("epic_open_game_screenshots_folder", { appName, title });

export const epicSetScreenshotHotkey = (vkey: number) =>
  invoke<void>("epic_set_screenshot_hotkey", { vkey });

export const epicGetScreenshotHotkey = () =>
  invoke<number>("epic_get_screenshot_hotkey");

export const epicReplaceScreenshotWithCompressed = (
  originalPath: string,
  compressedBase64: string,
  newExt: string
) =>
  invoke<GameScreenshotItem>("epic_replace_screenshot_with_compressed", {
    originalPath,
    compressedBase64,
    newExt,
  });

/* ---------- Move game files ---------- */

export interface SystemDriveInfo {
  letter: string;
  label: string;
  total_bytes: number;
  available_bytes: number;
}

export interface MoveGameProgress {
  id: string;
  stage: "preparing" | "moving" | "verifying" | "cleaning" | "complete" | "failed";
  percent: number;
  copied_bytes: number;
  total_bytes: number;
  speed: string;
  eta: string;
  current_file: string;
  files_copied: number;
  total_files: number;
}

export interface MoveGameResult {
  success: boolean;
  new_path: string;
  message: string;
}

export const epicGetSystemDrives = () =>
  invoke<SystemDriveInfo[]>("epic_get_system_drives");

export const epicSelectFolderDialog = (defaultPath?: string | null, title?: string | null) =>
  invoke<string | null>("epic_select_folder_dialog", { defaultPath: defaultPath ?? null, title: title ?? null });

export const epicMoveGame = (appName: string, targetBasePath: string) =>
  invoke<MoveGameResult>("epic_move_game", { appName, targetBasePath });

export const epicCancelMoveGame = (appName: string) =>
  invoke<boolean>("epic_cancel_move_game", { appName });


