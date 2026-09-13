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
export const epicSetInstallDir = (path: string | null) =>
  invoke<EpicSettings>("epic_set_install_dir", { path });
export const epicDefaultInstallDir = () => invoke<string>("epic_default_install_dir");
