/**
 * O(1) lookups over the shared game state.
 *
 * The library can hold 500+ games, so every render must avoid linear array
 * scans. `setEpicSummaries` / `setEpicGamesRaw` keep synchronized hash maps in
 * `S`, and `summaryOf` / `rawOf` read them in constant time.
 */

import { clearCoverCaches, type EpicGame, type EpicSummary } from "../epic";
import { t } from "../i18n";
import { S } from "./state";
import type { GameSource, LibraryItem } from "./types";

/** Wide-art URL cache (key art lookup was repeated for every card render). */
const wideArtCache = new Map<string, string | null>();

/**
 * Maps the canonical stored "last played" values to translation keys. The stored
 * values are kept as-is for backward compatibility; only the displayed label is
 * translated.
 */
const LAST_PLAYED_MAP: Record<string, string> = {
  "Daha önce oynandı (Epic Games)": "playtime.epicPrevious",
  "Bugün": "playtime.today",
  "Dün": "playtime.yesterday",
  "Bu hafta": "playtime.thisWeek",
  "Bu ay": "playtime.thisMonth",
  "Geçen ay": "playtime.lastMonth",
  "6 ay önce": "playtime.sixMonths",
  "1 yıl önce veya daha eski": "playtime.oneYear",
};

/** Translate a stored "last played" value for display (custom values pass through). */
export function lastPlayedLabel(value: string | null | undefined): string {
  if (!value) return t("playtime.notPlayedYet");
  const key = LAST_PLAYED_MAP[value];
  return key ? t(key) : value;
}

/** Replace the raw game list and rebuild its lookup map. */
export function setEpicGamesRaw(games: EpicGame[]): void {
  S.epicGamesRaw = games;
  S.epicGamesRawMap = new Map(games.map((g) => [g.app_name, g]));
  // Cover/key-art URLs may have changed with the new metadata.
  wideArtCache.clear();
  clearCoverCaches();
}

/** Convert an Epic summary item into the store-agnostic LibraryItem interface. */
export function epicToLibraryItem(s: EpicSummary): LibraryItem {
  const g = rawOf(s.appName);
  const d = g?.metadata?.developer;
  const dev = typeof d === "string" ? d.trim() : "";
  return {
    key: `epic::${s.appName}`,
    source: "epic",
    id: s.appName,
    title: s.title,
    developer: dev,
    version: s.version,
    installedVersion: s.installedVersion,
    installed: s.installed,
    installPath: s.installPath,
    installSize: s.installSize,
    coverUrl: s.cover,
    heroUrl: epicWideArt(s),
    description: s.description,
    updateAvailable: s.updateAvailable,
    cloudSavesSupported: true,
    dlcCount: s.dlcCount,
  };
}

let canonStoresMap = new Map<string, string>();

/** Rebuilds the unified allGamesMap and store mapping from both epicSummaries and gogSummaries in O(N). */
export function rebuildAllGamesMap(): void {
  const map = new Map<string, LibraryItem>();
  const storeSets = new Map<string, Set<string>>();

  for (const s of S.epicSummaries) {
    const item = epicToLibraryItem(s);
    map.set(item.key, item);
    // Index by plain appName as well for seamless backward compatibility
    map.set(s.appName, item);
    const c = canonicalGameTitle(s.title);
    if (c) {
      let set = storeSets.get(c);
      if (!set) {
        set = new Set();
        storeSets.set(c, set);
      }
      set.add("Epic");
    }
  }
  for (const g of S.gogSummaries) {
    map.set(g.key, g);
    map.set(g.id, g);
    const c = canonicalGameTitle(g.title);
    if (c) {
      let set = storeSets.get(c);
      if (!set) {
        set = new Set();
        storeSets.set(c, set);
      }
      set.add("GOG");
    }
  }
  // Other accounts' games stay searchable/detail-openable through the same map
  // while the shared library is enabled.
  if (S.showSharedLibrary) {
    for (const g of S.sharedOwners.values()) {
      const item: LibraryItem = {
        key: g.key,
        source: g.store === "gog" ? "gog" : "epic",
        id: g.key.startsWith("gog::") ? g.key.slice(5) : g.key,
        title: g.title,
        developer: "",
        version: "—",
        installedVersion: null,
        installed: false,
        installPath: null,
        installSize: 0,
        coverUrl: g.cover,
        heroUrl: g.cover,
        description: "",
        updateAvailable: false,
        cloudSavesSupported: false,
        dlcCount: 0,
      };
      if (!map.has(item.key)) map.set(item.key, item);
      const c = canonicalGameTitle(g.title);
      if (c) {
        let set = storeSets.get(c);
        if (!set) {
          set = new Set();
          storeSets.set(c, set);
        }
        set.add(g.store === "gog" ? "GOG" : "Epic");
      }
    }
  }
  S.allGamesMap = map;

  const storesMap = new Map<string, string>();
  for (const [canon, set] of storeSets.entries()) {
    storesMap.set(canon, Array.from(set).sort().join(", "));
  }
  canonStoresMap = storesMap;
}

/** Replace the parsed summary list and rebuild its lookup map. */
export function setEpicSummaries(sums: EpicSummary[]): void {
  S.epicSummaries = sums;
  S.epicSummariesMap = new Map(sums.map((s) => [s.appName, s]));
  rebuildAllGamesMap();
  S.libraryDataRev++;
}

/** Replace the GOG library item list and rebuild its lookup map. */
export function setGogSummaries(items: LibraryItem[]): void {
  S.gogSummaries = items;
  S.gogSummariesMap = new Map(items.map((item) => [item.id, item]));
  rebuildAllGamesMap();
  S.libraryDataRev++;
}

/** Converts a GOG LibraryItem into an EpicSummary structure for legacy views. */
export function gogToEpicSummary(g: LibraryItem): EpicSummary {
  return {
    appName: g.key,
    title: g.title,
    version: g.version,
    cover: g.coverUrl,
    description: g.description,
    dlcCount: g.dlcCount,
    installed: g.installed,
    installPath: g.installPath,
    installSize: g.installSize,
    installedVersion: g.installedVersion,
    updateAvailable: g.updateAvailable,
  };
}

/** Returns all games across all stores as EpicSummary items. */
export function allStoreSummaries(): EpicSummary[] {
  if (S.gogSummaries.length === 0) return S.epicSummaries;
  return [...S.epicSummaries, ...S.gogSummaries.map(gogToEpicSummary)];
}

/** O(1) summary lookup by app name (Epic or GOG). */
export function summaryOf(appName: string): EpicSummary | undefined {
  if (appName.startsWith("gog::")) {
    const cleanId = appName.slice(5);
    const g = S.gogSummariesMap.get(cleanId) || S.gogSummariesMap.get(appName);
    if (g) return gogToEpicSummary(g);
  }
  const own = S.epicSummariesMap.get(appName);
  if (own) return own;
  // Games that only another saved account owns resolve to a shared entry so the
  // detail page can show the owner and offer the account switch.
  const shared = sharedOwnerOf(appName);
  if (shared) return sharedToSummary(shared);
  return undefined;
}

/** Owner of a game that belongs to another saved account (shared library). */
export function sharedOwnerOf(key: string): import("../epic").SharedGame | undefined {
  return S.sharedOwners.get(key);
}

/** Minimal summary for a shared (other-account) game. */
export function sharedToSummary(g: import("../epic").SharedGame): EpicSummary {
  return {
    appName: g.key,
    title: g.title,
    version: "—",
    cover: g.cover,
    description: "",
    dlcCount: 0,
    installed: false,
    installPath: null,
    installSize: 0,
    installedVersion: null,
    updateAvailable: false,
  };
}

/** O(1) unified lookup of any library item by composite key (`source::id`) or plain id. */
export function libraryItemOf(keyOrId: string, source?: GameSource): LibraryItem | undefined {
  if (keyOrId.includes("::")) {
    return S.allGamesMap.get(keyOrId);
  }
  if (source) {
    return S.allGamesMap.get(`${source}::${keyOrId}`);
  }
  return S.allGamesMap.get(keyOrId) || S.allGamesMap.get(`epic::${keyOrId}`) || S.allGamesMap.get(`gog::${keyOrId}`);
}

/** O(1) raw metadata lookup by app name. */
export function rawOf(appName: string): EpicGame | undefined {
  return S.epicGamesRawMap.get(appName);
}

export interface GameVersion {
  source: GameSource;
  appName: string;
  title: string;
  installed: boolean;
  version: string | null;
  installPath: string | null;
}

/** Strips edition labels and punctuation to produce a canonical comparison key. */
export function canonicalGameTitle(title: string): string {
  if (!title) return "";
  let s = title.toLowerCase();
  s = s.replace(/[:\-–—]\s*(standard|deluxe|gold|premium|definitive|enhanced|ultimate|special|complete|anniversary|director'?s cut|remastered|goty|game of the year).*/i, "");
  s = s.replace(/\b(standard|deluxe|gold|premium|definitive|enhanced|ultimate|special|complete|anniversary|goty|game of the year)\s*(edition|surum|sürüm)?\b/gi, "");
  s = s.replace(/\b(director'?s cut|remastered|base game|ana oyun|temel oyun|edition|sürüm|surum)\b/gi, "");
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

/** Finds all available store versions (e.g. Epic and GOG) of a given game. */
export function gameVersionsOf(appNameOrTitle: string): GameVersion[] {
  const current = summaryOf(appNameOrTitle);
  const title = current?.title || appNameOrTitle;
  const canon = canonicalGameTitle(title);
  if (!canon) return [];

  const versions: GameVersion[] = [];

  for (const s of S.epicSummaries) {
    if (canonicalGameTitle(s.title) === canon) {
      versions.push({
        source: "epic",
        appName: s.appName,
        title: s.title,
        installed: s.installed,
        version: s.version,
        installPath: s.installPath || null,
      });
      break;
    }
  }

  for (const g of S.gogSummaries) {
    if (canonicalGameTitle(g.title) === canon) {
      versions.push({
        source: "gog",
        appName: g.key,
        title: g.title,
        installed: g.installed,
        version: g.version,
        installPath: g.installPath || null,
      });
      break;
    }
  }

  return versions;
}

/** Returns the formatted store label(s) for a game (e.g. "Epic", "GOG", "Epic, GOG") in O(1). */
export function gameStoresLabel(appNameOrTitle: string): string {
  const canon = canonicalGameTitle(appNameOrTitle);
  const found = canonStoresMap.get(canon);
  if (found) return found;
  if (appNameOrTitle.startsWith("gog::") || S.gogSummariesMap.has(appNameOrTitle)) return "GOG";
  return "Epic";
}

/** Computes the deduplicated total library game count, excluding hidden games. */
export function totalLibraryGamesCount(): number {
  const seenTitles = new Set<string>();
  let count = 0;
  for (const s of S.epicSummaries) {
    if (S.hiddenGames.has(s.appName)) continue;
    seenTitles.add(canonicalGameTitle(s.title));
    count++;
  }
  for (const g of S.gogSummaries) {
    if (S.hiddenGames.has(g.key)) continue;
    const canon = canonicalGameTitle(g.title);
    if (seenTitles.has(canon)) continue;
    seenTitles.add(canon);
    count++;
  }
  // Games from other saved accounts count too while the shared library is on.
  if (S.showSharedLibrary) {
    for (const g of S.sharedOwners.values()) {
      if (S.hiddenGames.has(g.key)) continue;
      const canon = canonicalGameTitle(g.title);
      if (seenTitles.has(canon)) continue;
      seenTitles.add(canon);
      count++;
    }
  }
  return count;
}

/**
 * True when the selected UI language is Turkish. Used to show locale-specific
 * content (e.g. the Goygoy Engine Turkish reviews).
 */
export function isTurkishUser(): boolean {
  if (S.appLanguage) {
    return S.appLanguage === "tr";
  }
  const navLang = navigator.language?.toLowerCase() || "";
  return navLang.startsWith("tr");
}

/**
 * Resolve the wide landscape artwork used by hero banners and the detail
 * drawer. Priority: custom user hero -> Epic key art -> portrait cover.
 */
export function epicWideArt(s: EpicSummary): string | null {
  const customHero = S.customHeroes[s.appName];
  if (customHero) return customHero;
  const cached = wideArtCache.get(s.appName);
  if (cached !== undefined) return cached;

  if (s.appName.startsWith("gog::")) {
    const rawId = s.appName.slice(5);
    const item = S.gogSummariesMap.get(rawId) || S.allGamesMap.get(s.appName);
    if (item?.heroUrl && !item.heroUrl.includes("_glx_vertical_cover")) {
      wideArtCache.set(s.appName, item.heroUrl);
      return item.heroUrl;
    }
    if (item?.coverUrl) {
      const hero = item.coverUrl
        .replace("_glx_vertical_cover.jpg", "_glx_bg_top_padding_7.jpg")
        .replace("_product_card_v2_mobile_slider_639.jpg", "_glx_bg_top_padding_7.jpg");
      wideArtCache.set(s.appName, hero);
      return hero;
    }
  }

  let url: string | null = s.cover;
  const imgs = rawOf(s.appName)?.metadata?.keyImages;
  if (Array.isArray(imgs)) {
    for (const t of [
      "OfferImageWide",
      "DieselStoreFrontWide",
      "DieselGameBox",
      "DieselGameBoxTall",
      "OfferImageTall",
    ]) {
      const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
      if (found) {
        url = found.url;
        break;
      }
    }
  }
  wideArtCache.set(s.appName, url);
  return url;
}
