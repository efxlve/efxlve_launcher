/**
 * Epic types and cover / slug helpers.
 *
 * IPC wrappers are `epic-commands.ts`. Rust JSON fields stay snake_case.
 */

import { NO_DESC } from "./core/constants";
import type { SavedAccount } from "./core/types";
export type { SavedAccount };

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

export interface SetupStatus {
  binaryPath: string | null;
  version: string | null;
  needsDownload: boolean;
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

export interface GameCollection {
  id: string;
  name: string;
  app_names: string[];
  created_at?: string | null;
  emoji?: string | null;
}

/** Result of a client collection import: merged collections plus hidden keys. */
export interface CollectionImport {
  collections: GameCollection[];
  hidden: string[];
}

export interface CachedLibrary {
  account: string | null;
  accountId: string | null;
  games: EpicGame[];
  installed: EpicInstalled[];
  skipped: string[];
  collections?: GameCollection[];
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

/**
 * Cover URL resolution is deterministic per game but was recomputed for every
 * card on every render. These caches are cleared when the raw library changes.
 */
const coverCache = new Map<string, string | null>();
const portraitCache = new Map<string, string | null>();

/** Invalidates cached cover URLs (call when the raw game list is replaced). */
export function clearCoverCaches(): void {
  coverCache.clear();
  portraitCache.clear();
}

/**
 * Cards render their covers at roughly 200-280 px, but the Epic CDN hands out
 * 1200 px originals: about 7.7 MB decoded each, so a full grid decodes
 * hundreds of megabytes and pays the JPEG decode on every card. The CDN
 * resizes on the fly, so ask for a card-sized 3:4 variant instead.
 */
const EPIC_COVER_QUERY = "w=480&h=640&resize=1";

function sizedEpicCover(url: string): string {
  if (!url.startsWith("https://cdn1.epicgames.com/") || url.includes("resize=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${EPIC_COVER_QUERY}`;
}

export function epicCover(g: EpicGame): string | null {
  const cached = coverCache.get(g.app_name);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  const imgs = g.metadata?.keyImages;
  if (Array.isArray(imgs)) {
    for (const t of COVER_PRIORITY) {
      const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
      if (found) {
        url = found.url;
        break;
      }
    }
    if (url === null) {
      const any = imgs.find((i) => typeof i?.url === "string");
      url = any ? (any.url as string) : null;
    }
  }
  const sized = url ? sizedEpicCover(url) : null;
  coverCache.set(g.app_name, sized);
  return sized;
}

/** Portrait cover for cards: Tall → wide art → first available. */
export function epicPortrait(g: EpicGame): string | null {
  const cached = portraitCache.get(g.app_name);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  const imgs = g.metadata?.keyImages;
  if (Array.isArray(imgs)) {
    for (const t of ["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall"]) {
      const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
      if (found) {
        url = found.url;
        break;
      }
    }
  }
  if (url === null) url = epicCover(g);
  const sized = url ? sizedEpicCover(url) : null;
  portraitCache.set(g.app_name, sized);
  return sized;
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

/**
 * Folder name legendary creates under the install base path.
 * Mirrors the backend cleanup logic: `customAttributes.FolderName` first,
 * then the title with path-invalid characters stripped, then the app name.
 */
export function epicInstallFolderName(g: EpicGame | undefined | null): string {
  if (!g) return "";
  const attrs = (g.metadata?.customAttributes as Record<string, { value?: string }>) || {};
  const folder = attrs.FolderName?.value?.trim();
  if (folder) return folder;
  const title = String(g.app_title || g.app_name || "").replace(/[/\\:*?"<>|]/g, "").trim();
  return title || g.app_name;
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

/** Uses Epic's catalog slug when title-to-slug guessing would be ambiguous. */
export function epicStorePageUrlForGame(g: EpicGame | undefined, title: string): string {
  const metadata = g?.metadata as Record<string, unknown> | undefined;
  const mappingGroups = [
    (metadata?.catalogNs as { mappings?: unknown } | undefined)?.mappings,
    metadata?.offerMappings,
  ];
  for (const mappings of mappingGroups) {
    if (!Array.isArray(mappings)) continue;
    const slug = mappings.find((mapping) => {
      const value = (mapping as { pageSlug?: unknown } | null)?.pageSlug;
      return typeof value === "string" && value.trim().length > 0;
    }) as { pageSlug?: string } | undefined;
    if (slug?.pageSlug) return `https://store.epicgames.com/p/${slug.pageSlug}`;
  }
  return epicStoreSearch(title);
}

/** Mobile-only catalog entries have no place in the Windows launcher library. */
export function isMobileOnlyGame(g: EpicGame): boolean {
  const assetPlatforms = Object.keys(g.asset_infos || {}).map((key) => key.toLowerCase());
  const hasMobileAsset = assetPlatforms.some((key) =>
    key.includes("android") || key.includes("ios") || key.includes("mobile"),
  );
  const hasPcAsset = assetPlatforms.some((key) =>
    key.includes("windows") || key.includes("win32") || key.includes("win64") ||
    key.includes("mac") || key.includes("linux"),
  );
  if (hasMobileAsset && !hasPcAsset) return true;

  const attrs = g.metadata.customAttributes as Record<string, { value?: unknown }> | undefined;
  const attributeText = attrs
    ? Object.entries(attrs).map(([key, entry]) => `${key} ${String(entry?.value ?? "")}`).join(" ")
    : "";
  const platformFields = [
    g.metadata.platform,
    g.metadata.platforms,
    g.metadata.supportedPlatforms,
  ]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? ""))
    .join(" ");
  const platformText = `${attributeText} ${platformFields}`.toLowerCase();
  if (hasPcAsset || /windows|win32|win64|mac|linux/.test(platformText)) return false;
  return /android|ios|iphone|ipad|mobile/.test(platformText) || Object.entries(attrs || {}).some(([key, entry]) => {
    const text = `${key} ${String(entry?.value ?? "")}`.toLowerCase();
    return text.includes("android") || text.includes("ios") || text.includes("mobile");
  });
}

/** Whether Epic should hand installation and launch control to another client. */
export function requiresThirdPartyLauncher(info: ThirdPartyLauncherInfo | null): boolean {
  // Rockstar metadata identifies the companion client, but Epic still owns the
  // download and launch flow for these catalog entries.
  return info !== null && info.type !== "rockstar";
}

/** Third-party launcher detection (EA App, Ubisoft Connect, Rockstar Games, etc.). */
export function getThirdPartyLauncher(
  g: EpicGame | undefined | null,
  titleHint = "",
  developerHint = "",
): ThirdPartyLauncherInfo | null {
  const attrs = (g?.metadata?.customAttributes as Record<string, { value?: string }>) || {};
  const tpApp = attrs.ThirdPartyManagedApp?.value?.toLowerCase() || "";
  const tpProv = attrs.ThirdPartyManagedProvider?.value?.toLowerCase() || "";
  const pType = attrs.partnerLinkType?.value?.toLowerCase() || "";
  const reg = attrs.RegistryPath?.value?.toLowerCase() || "";
  const dev = String(g?.metadata?.developer || developerHint || "").toLowerCase();
  const title = String(g?.app_title || titleHint || "").toLowerCase();
  const folder = attrs.FolderName?.value?.toLowerCase() || "";

  if (
    tpApp.includes("origin") ||
    tpApp.includes("ea app") ||
    pType === "ea" ||
    pType === "origin" ||
    reg.includes("ea games") ||
    reg.includes("respawn") ||
    dev.includes("electronic arts") ||
    dev.includes("ea sports") ||
    dev.includes("ea dice") ||
    dev.includes("respawn")
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

/** Anti-cheat from catalog metadata, the game title, or (for Steam) VAC. */
export function getAntiCheat(
  g: EpicGame | undefined | null,
  titleHint = "",
  appHint = "",
): string | null {
  const appName = (g?.app_name || appHint || "").toLowerCase();
  const title = (g?.app_title || titleHint || "").toLowerCase();
  if (!g && !title && !appName) return null;
  const attrs = (g?.metadata?.customAttributes as Record<string, { value?: string }>) || {};
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
  // Only GTA V / GTA Online ship BattlEye. The older and Definitive Edition
  // titles (III, Vice City, San Andreas, IV) have no anti-cheat, so match
  // "V"/"5" exactly instead of any "grand theft auto" title.
  if (/\bgta ?(v|5)\b/.test(title) || /grand theft auto (v|5)\b/.test(title)) {
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
  if (title.includes("counter-strike") || title.includes("counter strike") || /\bcs:? ?go\b/.test(title) || title === "cs2") {
    return "VAC";
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
  /** True while the owning store (today: Steam) is downloading this game. */
  downloading?: boolean;
  bytesDownloaded?: number;
  bytesToDownload?: number;
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
    .filter((g) => !isDlc(g) && !isNonGameContent(g) && !isMobileOnlyGame(g) && !skipSet.has(g.app_name))
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

