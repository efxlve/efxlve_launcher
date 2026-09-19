import { invoke } from "@tauri-apps/api/core";

/* ---------- Tipler (Rust modelleriyle birebir, snake_case) ---------- */

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

/* ---------- Sunum yardımcıları ---------- */

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

/** Portre kartlar için uzun kapak: Tall → geniş kapak → ilk bulunan. */
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
  return typeof d === "string" && d ? d : "Açıklama yok.";
}

export function isDlc(g: EpicGame): boolean {
  return g.metadata != null && "mainGameItem" in g.metadata;
}

const UE_CATEGORY_PATHS = ["assets", "asset-format", "plugins", "projects"];

/** Oyun değil: Unreal Engine içeriği veya mod (Heroic ile aynı kural). */
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

/** 3. parti başlatıcı tespiti (EA App, Ubisoft Connect, Rockstar Games vb.) */
export function getThirdPartyLauncher(g: EpicGame | undefined | null): ThirdPartyLauncherInfo | null {
  if (!g?.metadata) return null;
  const attrs = (g.metadata.customAttributes as Record<string, { value?: string }>) || {};
  const tpApp = attrs.ThirdPartyManagedApp?.value?.toLowerCase() || "";
  const tpProv = attrs.ThirdPartyManagedProvider?.value?.toLowerCase() || "";
  const pType = attrs.partnerLinkType?.value?.toLowerCase() || "";
  const reg = attrs.RegistryPath?.value?.toLowerCase() || "";
  const dev = String(g.metadata.developer || "").toLowerCase();
  const folder = attrs.FolderName?.value?.toLowerCase() || "";

  if (
    tpApp.includes("origin") ||
    tpApp.includes("ea app") ||
    pType === "ea" ||
    pType === "origin" ||
    reg.includes("ea games") ||
    reg.includes("respawn")
  ) {
    return { name: "EA App", type: "ea", shortName: "EA App" };
  }
  if (
    tpProv.includes("ubisoft") ||
    pType.includes("ubisoft") ||
    reg.includes("ubisoft") ||
    tpApp.includes("ubisoft") ||
    (dev === "ubisoft" && (attrs.partnerLinkId || pType))
  ) {
    return { name: "Ubisoft Connect", type: "ubisoft", shortName: "Ubisoft" };
  }
  if (reg.includes("rockstar games") || tpApp.includes("rockstar") || (dev.includes("rockstar") && attrs.RegistryLocation)) {
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

  // 1. Process adları ve argümanlar
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

  // 2. Popüler rekabetçi ve bilinen oyunlar
  if (appName === "carnation" || title.includes("rainbow six siege")) {
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

  // 3. customAttributes genel kontrolü
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

/** DLC'leri ve atlanan bozuk öğeleri eleyip kurulu bilgisiyle birleştirir. */
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

/* ---------- Komut sarmalayıcıları ---------- */

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
}

export const epicInstallGame = (appName: string, installDir?: string) =>
  // Not: Tauri komut argümanları varsayılan camelCase'tir (Rust snake_case olsa bile)!
  invoke<string>("epic_install_game", { appName, installDir: installDir ?? null });
export const epicCancelDownload = (appName: string) =>
  invoke<string>("epic_cancel_download", { appName });
export const epicUninstallGame = (appName: string, keepFiles = false) =>
  invoke<string>("epic_uninstall_game", { appName, keepFiles });
export const epicLaunchGame = (appName: string) =>
  invoke<string>("epic_launch_game", { appName });
export const epicGetSettings = () => invoke<EpicSettings>("epic_get_settings");
export const epicDefaultInstallDir = () => invoke<string>("epic_default_install_dir");
export const epicSetInstallDir = (dir: string | null) =>
  invoke<EpicSettings>("epic_set_install_dir", { dir });

/* ---------- Başarımlar (Achievements) ---------- */

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

/* ---------- Oyun Yönetimi & Doğrulama (Game Management) ---------- */

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

/* ---------- Gelişmiş İndirme & Kuyruk (Download Hub) ---------- */

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

/* ---------- Eklenti & DLC Yönetimi (DLC Manager) ---------- */

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

/* ---------- Seçici Kurulum (Selective Install Options) ---------- */

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

/* ---------- Güncelleme Motoru (Update Engine) ---------- */

export interface GameUpdateInfo {
  appName: string;
  title: string;
  installedVersion: string;
  latestVersion: string;
}

export const epicCheckUpdates = () =>
  invoke<GameUpdateInfo[]>("epic_check_updates");

/* ---------- Oynama Süresi & Canlı Durum (Playtime & Game Status) ---------- */

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

/* ---------- İndirme Ağ Profili (Network Profile) ---------- */

export type NetworkProfileType = "max" | "balanced" | "low";

export const epicGetNetworkProfile = () =>
  invoke<string>("epic_get_network_profile");

export const epicSetNetworkProfile = (profile: string) =>
  invoke<void>("epic_set_network_profile", { profile });

/* ---------- Çevrimdışı Mod (Offline Mode) ---------- */

export const epicGetOfflineMode = () =>
  invoke<boolean>("epic_get_offline_mode");

export const epicSetOfflineMode = (enabled: boolean) =>
  invoke<void>("epic_set_offline_mode", { enabled });

/* ---------- Oyun Kayıtları Yedekleme (Save Backup Manager) ---------- */

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

/* ---------- Oyuncu Profili ve Başarımlar ---------- */

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

/* ---------- Mağaza Tipleri (store.rs ile birebir, camelCase) ---------- */

export interface StoreKeyImage {
  type: string;
  url: string;
}

export interface StoreSeller {
  id: string;
  name: string;
}

export interface StoreFmtPrice {
  originalPrice: string;
  discountPrice: string;
  intermediatePrice?: string;
}

export interface StoreTotalPrice {
  discountPrice: number;
  originalPrice: number;
  discount: number;
  currencyCode: string;
  fmtPrice?: StoreFmtPrice;
}

export interface StorePriceInfo {
  totalPrice: StoreTotalPrice;
}

export interface StoreDiscountSetting {
  discountType: string;
  discountPercentage: number;
}

export interface StorePromotionOffer {
  startDate: string;
  endDate: string;
  discountSetting?: StoreDiscountSetting;
}

export interface StorePromotionGroup {
  promotionalOffers: StorePromotionOffer[];
}

export interface StorePromotions {
  promotionalOffers: StorePromotionGroup[];
  upcomingPromotionalOffers: StorePromotionGroup[];
}

export interface StoreCategory {
  path: string;
}

export interface StoreCustomAttr {
  key: string;
  value?: string;
}

export interface StoreElement {
  id: string;
  namespace: string;
  title: string;
  description: string;
  productSlug?: string;
  urlSlug?: string;
  effectiveDate?: string;
  seller?: StoreSeller;
  keyImages: StoreKeyImage[];
  categories: StoreCategory[];
  customAttributes: StoreCustomAttr[];
  price?: StorePriceInfo;
  promotions?: StorePromotions;
}

export interface StorePaging {
  count: number;
  total: number;
}

export interface StoreHome {
  featured: StoreElement[];
  freeCurrent: StoreElement[];
  freeUpcoming: StoreElement[];
  topSellers: StoreElement[];
  newReleases: StoreElement[];
  onSale: StoreElement[];
}

export interface StoreSearchResult {
  elements: StoreElement[];
  paging: StorePaging;
}

export interface StoreWishlistEntry {
  id: string;
  offerId: string;
  namespace: string;
  created?: string;
  updated?: string;
  offer?: StoreElement;
}

export interface StoreMediaItem {
  type: string;
  url: string;
}

export interface StoreProductDetail {
  about: string;
  gallery: StoreMediaItem[];
  shortDescription?: string;
}

/* ---------- Mağaza Yardımcıları ---------- */

/** Geniş yatay afiş (16:9) seçer. */
export function storeWideImage(el: StoreElement): string {
  const wide = el.keyImages.find(
    (k) =>
      k.type === "OfferImageWide" ||
      k.type === "DieselStoreFrontWide" ||
      k.type === "featuredMedia",
  );
  return (wide || el.keyImages[0])?.url || "";
}

/** Dikey poster (2:3) seçer. */
export function storeTallImage(el: StoreElement): string {
  const tall = el.keyImages.find(
    (k) =>
      k.type === "OfferImageTall" ||
      k.type === "DieselGameBoxTall" ||
      k.type === "DieselGameBox",
  );
  return (tall || el.keyImages[0])?.url || "";
}

/** Küçük resim. */
export function storeThumbnail(el: StoreElement): string {
  const th = el.keyImages.find((k) => k.type === "Thumbnail");
  return (th || el.keyImages[0])?.url || "";
}

/** İndirim yüzdesi (0 = indirim yok). */
export function storeDiscountPercent(el: StoreElement): number {
  if (!el.price) return 0;
  const { originalPrice, discountPrice } = el.price.totalPrice;
  if (originalPrice > 0 && discountPrice < originalPrice) {
    return Math.round(((originalPrice - discountPrice) / originalPrice) * 100);
  }
  return 0;
}

/** Ücretsiz mi? */
export function storeIsFree(el: StoreElement): boolean {
  if (!el.price) return false;
  return (
    el.price.totalPrice.discountPrice === 0 &&
    el.price.totalPrice.originalPrice > 0
  );
}

/** Formatlanmış fiyat metni. */
export function storeFormattedPrice(el: StoreElement): string {
  if (!el.price) return "";
  const tp = el.price.totalPrice;
  if (tp.discountPrice === 0 && tp.originalPrice === 0) return "Ücretsiz";
  if (tp.discountPrice === 0 && tp.originalPrice > 0) return "Ücretsiz";
  if (tp.fmtPrice?.discountPrice) return tp.fmtPrice.discountPrice;
  // Kuruştan TL'ye çevir
  return `₺${(tp.discountPrice / 100).toFixed(2)}`;
}

/** Orijinal fiyat (indirim varsa). */
export function storeOriginalPrice(el: StoreElement): string {
  if (!el.price) return "";
  const tp = el.price.totalPrice;
  if (tp.fmtPrice?.originalPrice) return tp.fmtPrice.originalPrice;
  if (tp.originalPrice > 0) return `₺${(tp.originalPrice / 100).toFixed(2)}`;
  return "";
}

/** Ücretsiz oyun bitiş tarihi için geri sayım metni. */
export function storeFreeCountdown(el: StoreElement): string {
  if (!el.promotions) return "";
  for (const g of el.promotions.promotionalOffers) {
    for (const p of g.promotionalOffers) {
      if (p.discountSetting?.discountPercentage === 0 && p.endDate) {
        const end = new Date(p.endDate).getTime();
        const now = Date.now();
        const diff = end - now;
        if (diff <= 0) return "Süresi doldu";
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        if (days > 0) return `${days}g ${hours}s kaldı`;
        if (hours > 0) return `${hours}s ${mins}dk kaldı`;
        return `${mins}dk kaldı`;
      }
    }
  }
  return "";
}

/* ---------- Mağaza Invoke Sarmalayıcıları ---------- */

export const epicStoreHomeData = () =>
  invoke<StoreHome>("epic_store_home");

export const epicStoreSearchQuery = (
  keywords?: string,
  category?: string,
  sortBy?: string,
  sortDir?: string,
  page?: number,
  count?: number,
) =>
  invoke<StoreSearchResult>("epic_store_search", {
    keywords: keywords || null,
    category: category || null,
    sortBy: sortBy || null,
    sortDir: sortDir || null,
    page: page ?? null,
    count: count ?? null,
  });

export const epicStoreProductDetail = (slug: string) =>
  invoke<StoreProductDetail | null>("epic_store_product_detail", { slug });

export const epicStoreWishlistData = () =>
  invoke<StoreWishlistEntry[]>("epic_store_wishlist");

export const epicStoreAddWishlist = (namespace: string, offerId: string) =>
  invoke<void>("epic_store_add_wishlist", { namespace, offerId });

export const epicStoreRemoveWishlist = (namespace: string, offerId: string) =>
  invoke<void>("epic_store_remove_wishlist", { namespace, offerId });
