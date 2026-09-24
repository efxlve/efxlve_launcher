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

/** Replace the parsed summary list and rebuild its lookup map. */
export function setEpicSummaries(sums: EpicSummary[]): void {
  S.epicSummaries = sums;
  S.epicSummariesMap = new Map(sums.map((s) => [s.appName, s]));
  S.libraryDataRev++;
}

/** O(1) summary lookup by app name. */
export function summaryOf(appName: string): EpicSummary | undefined {
  return S.epicSummariesMap.get(appName);
}

/** O(1) raw metadata lookup by app name. */
export function rawOf(appName: string): EpicGame | undefined {
  return S.epicGamesRawMap.get(appName);
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
