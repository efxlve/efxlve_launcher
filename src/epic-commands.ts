/**
 * Epic `invoke` wrappers.
 *
 * The object keys are camelCase (`appName`). The Rust command name stays snake_case.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  EpicGame,
  EpicInstalled,
  GameCollection,
  SetupStatus,
  CachedLibrary,
  SavedAccount,
} from "./epic-model";

/* ---------- Command wrappers ---------- */

export const epicSetupStatus = () => invoke<SetupStatus>("epic_setup_status");
export const epicEnsureBinary = () => invoke<string>("epic_ensure_binary");
export const epicListGames = () => invoke<EpicGame[]>("epic_list_games");
export const epicListInstalled = () => invoke<EpicInstalled[]>("epic_list_installed");
export const epicLoginWithCode = (code: string) =>
  invoke<string>("epic_login_with_code", { code });
export const epicImportEgl = () => invoke<string>("epic_import_egl");
export const epicLogout = () => invoke<string>("epic_logout");
export const epicGetSavedAccounts = () => invoke<SavedAccount[]>("epic_get_saved_accounts");
export const epicSwitchAccount = (accountId: string) =>
  invoke<SavedAccount>("epic_switch_account", { accountId });
export const epicRemoveSavedAccount = (accountId: string) =>
  invoke<void>("epic_remove_saved_account", { accountId });
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
  screenshot_dir?: string | null;
}

export const epicInstallGame = (appName: string, installDir?: string) =>
  // Note: Tauri command arguments are camelCase by default (even if Rust uses snake_case)!
  invoke<string>("epic_install_game", { appName, installDir: installDir ?? null });
export const epicResumePendingDownload = () =>
  invoke<string>("epic_resume_pending_download");
export const epicCancelDownload = (appName: string) =>
  invoke<string>("epic_cancel_download", { appName });
export const epicUninstallGame = (appName: string, keepFiles = false) =>
  invoke<string>("epic_uninstall_game", { appName, keepFiles });
export const epicLaunchGame = (appName: string) =>
  invoke<string>("epic_launch_game", { appName });
export const epicStopGame = (appName: string) =>
  invoke<string>("epic_stop_game", { appName });
/** Game requested by a desktop shortcut (`--launch <app>`), consumed once. */
export const epicTakePendingLaunch = () => invoke<string | null>("epic_take_pending_launch");

/** One game that belongs to another saved account (shared library). */
export interface SharedGame {
  key: string;
  title: string;
  cover: string | null;
  store: string;
  ownerKey: string;
  ownerName: string;
}
export interface SharedLibraryIndex {
  games: SharedGame[];
}
/** Union of every saved account's library (read from disk snapshots, no network). */
export const sharedLibraryIndex = () => invoke<SharedLibraryIndex>("shared_library_index");

/** Controller bridging layers present on this machine (Settings > Controller). */
export interface ControllerSupportStatus {
  viEmBus: boolean;
  steam: boolean;
  steamPath: string;
  bridgeRunning: boolean;
  bridgeDevice: string;
}
export const controllerSupportStatus = () =>
  invoke<ControllerSupportStatus>("controller_support_status");

/** XInput bridge state: running plus the pad it currently bridges. */
export interface ControllerBridgeStatus {
  running: boolean;
  device: string;
}
export const controllerBridgeStart = () =>
  invoke<ControllerBridgeStatus>("controller_bridge_start");
export const controllerBridgeStop = () =>
  invoke<ControllerBridgeStatus>("controller_bridge_stop");

/** Store client detection for Settings > Launchers. */
export interface LauncherStatus {
  id: string;
  name: string;
  installed: boolean;
  path: string;
  downloadUrl: string;
}
export const launchersStatus = () =>
  invoke<LauncherStatus[]>("launchers_status");
export const epicGetSettings = () => invoke<EpicSettings>("epic_get_settings");

/** Discord Rich Presence: enable/disable and set the Discord application id. */
export const epicPresenceConfigure = (enabled: boolean, clientId: string) =>
  invoke<void>("epic_presence_configure", { enabled, clientId });
/** Discord Rich Presence: push a localized activity (details + state). */
export const epicPresenceUpdate = (
  details: string,
  state: string,
  largeImage = "",
  largeText = "",
  smallImage = "",
  startMs = 0,
) => invoke<void>("epic_presence_update", { details, state, largeImage, largeText, smallImage, startMs });
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
  version: string;
  overlaySupported: boolean;
}
export const eosOverlayStatus = () => invoke<EosOverlayStatus>("eos_overlay_status");

/** Whether a game's install directory bundles the EOS SDK runtime. */
export const epicDetectEos = (installPath: string) =>
  invoke<boolean>("epic_detect_eos", { installPath });

/** Opens an arbitrary folder path in the OS file manager (returns a @t: status message). */
export const epicOpenFolderPath = (path: string) => invoke<string>("open_folder", { path });
export const epicDefaultInstallDir = () => invoke<string>("epic_default_install_dir");
export const epicImportInstalledFolder = (path: string) =>
  invoke<{ imported: number; relinked: number }>("epic_import_installed_folder", { path });
export const epicSetInstallDir = (dir: string | null) =>
  invoke<EpicSettings>("epic_set_install_dir", { path: dir });

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

/* ---------- System requirements ---------- */

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

/* ---------- Epic Games Launcher detection ---------- */

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
  wrapper: string;
  envVars: Record<string, string>;
  savePath?: string | null;
  customSavePath?: string | null;
  detectedSavePath?: string | null;
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

/**
 * Epic's own server-side playtime snapshot (`appName -> seconds`), including
 * hours played outside this launcher. Cached on disk for a few hours.
 */
export const epicSyncEpicPlaytimes = (force = false) =>
  invoke<Record<string, number>>("epic_sync_epic_playtimes", { force });

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

export const epicGetNetworkProfile = () =>
  invoke<string>("epic_get_network_profile");

export const epicSetNetworkProfile = (profile: string) =>
  invoke<void>("epic_set_network_profile", { profile });

/* ---------- Offline mode ---------- */

export const epicGetOfflineMode = () =>
  invoke<boolean>("epic_get_offline_mode");

export const epicSetOfflineMode = (enabled: boolean) =>
  invoke<void>("epic_set_offline_mode", { enabled });

export const epicGetAutoDesktopShortcut = () =>
  invoke<boolean>("epic_get_auto_desktop_shortcut");

export const epicSetAutoDesktopShortcut = (enabled: boolean) =>
  invoke<void>("epic_set_auto_desktop_shortcut", { enabled });

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

export const epicBackupSave = (appName: string, savePathOverride?: string) =>
  invoke<SaveBackupInfo>("epic_backup_save", { appName, savePathOverride: savePathOverride ?? null });

export const epicSetCustomSavePath = (appName: string, savePath: string | null) =>
  invoke<void>("epic_set_custom_save_path", { appName, savePath });

export const epicListBackups = (appName: string) =>
  invoke<SaveBackupInfo[]>("epic_list_backups", { appName });

export const epicRestoreBackup = (appName: string, backupId: string) =>
  invoke<string>("epic_restore_backup", { appName, backupId });

export const epicDeleteBackup = (appName: string, backupId: string) =>
  invoke<void>("epic_delete_backup", { appName, backupId });

export const epicOpenBackupFolder = (appName: string) =>
  invoke<string>("epic_open_backup_folder", { appName });

/* ---------- Collections ---------- */

export const epicGetCollections = () =>
  invoke<GameCollection[]>("epic_get_collections");

export const epicReorderCollections = (ids: string[]) =>
  invoke<GameCollection[]>("epic_reorder_collections", { ids });

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

/** Wikipedia fallback text; `supported: false` means "checked, nothing found". */
export interface WikiAbout {
  supported: boolean;
  description: string;
}

/** Wikipedia lead in the launcher language (English when that wiki has none). */
export const epicGetWikiAbout = (title: string, appName: string, lang: string, forceRefresh = false) =>
  invoke<WikiAbout>("epic_get_wiki_about", { title, appName, lang, forceRefresh });

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
  /** True when this row was resolved from the Steam app id, not the name search. */
  matchedSteam?: boolean;
}

export const epicGetSteamGridKey = () =>
  invoke<string | null>("epic_get_steamgrid_key");

export const epicSetSteamGridKey = (apiKey: string) =>
  invoke<void>("epic_set_steamgrid_key", { apiKey });

export const epicTestSteamGridKey = (apiKey: string) =>
  invoke<boolean>("epic_test_steamgrid_key", { apiKey });

export const epicSearchSteamGrid = (term: string, steamAppId?: string | null) =>
  invoke<SteamGridGame[]>("epic_search_steamgrid", { term, steamAppId: steamAppId ?? null });

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
  /** Backend may still send this. The profile list does not show it. */
  set_label?: string;
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
  /** Retained for the wire format; originals load per file when a viewer asks. */
  full_data_url: string;
}

export const epicGetGameScreenshots = (appName: string, title: string) =>
  invoke<GameScreenshotItem[]>("epic_get_game_screenshots", { appName, title });

/** Full-resolution data URL for one screenshot, read only when a viewer asks. */
export const epicGetScreenshotFullData = (filePath: string) =>
  invoke<string>("epic_get_screenshot_full_data", { filePath });

/** Caches a preview the WebView built for a format GDI+ cannot read. */
export const epicSaveScreenshotPreview = (filePath: string, dataUrl: string) =>
  invoke<boolean>("epic_save_screenshot_preview", { filePath, dataUrl });

export const epicDeleteGameScreenshot = (filePath: string) =>
  invoke<boolean>("epic_delete_game_screenshot", { filePath });

export const epicOpenGameScreenshotsFolder = (appName: string, title: string) =>
  invoke<void>("epic_open_game_screenshots_folder", { appName, title });

export const epicSetScreenshotHotkey = (vkey: number) =>
  invoke<void>("epic_set_screenshot_hotkey", { vkey });

/** Effective screenshots root (configured folder, or the default Pictures path). */
export const epicGetScreenshotDir = () =>
  invoke<string>("epic_get_screenshot_dir");

/** Files and bytes currently stored in the screenshots root (move confirmation). */
export interface ScreenshotMoveInfo {
  count: number;
  bytes: number;
  dir: string;
}

/** Outcome of a screenshots root change. */
export interface ScreenshotDirResult {
  dir: string;
  moved: number;
  skipped: number;
}

/** Saves the screenshots root; null restores the default. `moveExisting` moves the old files in. */
export const epicSetScreenshotDir = (path: string | null, moveExisting = false) =>
  invoke<ScreenshotDirResult>("epic_set_screenshot_dir", { path, moveExisting });

/** Stats for the "move existing screenshots?" confirmation. */
export const epicGetScreenshotMoveInfo = () =>
  invoke<ScreenshotMoveInfo>("epic_get_screenshot_move_info");

/** Opens the screenshots root in Explorer, creating it when missing. */
export const epicOpenScreenshotDir = () =>
  invoke<string>("epic_open_screenshot_dir");

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

/* ---------- Cloud Save Backup (WebDAV & Google Drive) ---------- */

export type CloudBackupProvider = "none" | "webdav" | "google_drive";

export interface CloudBackupSettings {
  enabled: boolean;
  provider: CloudBackupProvider;
  autoSyncOnGameExit: boolean;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  gdriveClientId?: string | null;
  gdriveClientSecret?: string | null;
  gdriveFolderId?: string | null;
  gdriveUserEmail?: string | null;
  gdriveRefreshToken?: string | null;
  lastSyncTime?: number | null;
}

export interface CloudBackupEntry {
  backupId: string;
  appName: string;
  timestamp: number;
  formattedDate: string;
  sizeBytes: number;
  fileCount: number;
  sha256: string;
  provider: string;
  remoteId: string;
}

export const cloudBackupGetSettings = () =>
  invoke<CloudBackupSettings>("cloud_backup_get_settings");

export const cloudBackupSaveSettings = (settings: CloudBackupSettings) =>
  invoke<void>("cloud_backup_save_settings", { settings });

export const cloudBackupTestConnection = (settings: CloudBackupSettings) =>
  invoke<string>("cloud_backup_test_connection", { settings });

export const cloudBackupStartGdriveAuth = () =>
  invoke<string>("cloud_backup_start_gdrive_auth");

export const cloudBackupDisconnectGdrive = () =>
  invoke<void>("cloud_backup_disconnect_gdrive");

export const cloudBackupUploadGame = (appName: string, backupId?: string) =>
  invoke<CloudBackupEntry>("cloud_backup_upload_game", { appName, backupId: backupId ?? null });

export const cloudBackupListGame = (appName: string) =>
  invoke<CloudBackupEntry[]>("cloud_backup_list_game", { appName });

export const cloudBackupDownloadGame = (appName: string, remoteId: string, backupId: string) =>
  invoke<string>("cloud_backup_download_game", { appName, remoteId, backupId });

export const cloudBackupDeleteRemote = (remoteId: string) =>
  invoke<void>("cloud_backup_delete_remote", { remoteId });
