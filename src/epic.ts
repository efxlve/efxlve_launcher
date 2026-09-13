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

