/**
 * Stage's read-only view model.
 *
 * The merge rule mirrors the desktop library: one card per canonical title
 * unless "separate copies" is on, hidden games stay hidden, and the enabled
 * store filter applies. Stage never mutates the desktop library filters.
 */

import { achSummaryOf, epicActionButtons } from "../../core/game-view";
import { collectionGames, collectionMatch, matchCollectionGame } from "../../core/game-collections";
import { canonicalGameTitle, compareLibraryRecent, libraryItemToSummary, libraryPlaytime, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { GameSource } from "../../core/types";
import { t } from "../../i18n";
import type { EpicSummary, GameCollection } from "../../epic";
import { isSmartCollection, smartCollection } from "../library/smart-collections";
import { sharedSummaries } from "../library/shared-library";
import { pickShownCopy } from "../library/store-filter";
import { stageStoreName } from "./stage-ui";

export const STAGE_STORE_ORDER: readonly GameSource[] = [
  "epic",
  "gog",
  "amazon",
  "steam",
  "xbox",
  "battlenet",
  "ubisoft",
  "ea",
  "riot",
  "custom",
];

function withOverride(s: EpicSummary): EpicSummary {
  const override = S.epicCopyOverrides.get(s.appName);
  return override ? { ...s, ...override } : s;
}

function enabled(source: GameSource): boolean {
  return S.enabledStores.has(source);
}

/**
 * The unified shelf. It deliberately reads the same raw stores as the desktop
 * grid; no IPC call and no per-card lookup is involved.
 */
export function stageBaseSummaries(onlyStore: GameSource | "all" = "all"): EpicSummary[] {
  const groups = new Map<string, EpicSummary[]>();
  const copies: EpicSummary[] = [];
  const primaryTitles = new Set<string>();
  const allow = (source: GameSource): boolean =>
    enabled(source) && (onlyStore === "all" || onlyStore === source);
  const addPrimary = (title: string): void => {
    const canon = canonicalGameTitle(title);
    if (canon) primaryTitles.add(canon);
  };
  for (const s of S.epicSummaries) addPrimary(s.title);
  for (const s of S.gogSummaries) addPrimary(s.title);
  for (const s of S.amazonSummaries) addPrimary(s.title);
  for (const s of S.steamSummaries) addPrimary(s.title);

  const push = (s: EpicSummary): void => {
    if (S.hiddenGames.has(s.appName)) return;
    if (!allow(sourceOfKey(s.appName))) return;
    const copy = withOverride(s);
    if (S.separateCopies) {
      copies.push(copy);
      return;
    }
    const canon = canonicalGameTitle(s.title) || `\u0000${s.appName}`;
    const list = groups.get(canon);
    if (list) list.push(copy);
    else groups.set(canon, [copy]);
  };

  if (allow("epic")) {
    for (const s of S.epicSummaries) push(s);
    for (const s of sharedSummaries()) if (!s.appName.startsWith("gog::")) push(s);
  }
  if (allow("gog")) {
    for (const s of S.gogSummaries) push(libraryItemToSummary(s));
    for (const s of sharedSummaries()) if (s.appName.startsWith("gog::")) push(s);
  }
  if (allow("amazon")) for (const s of S.amazonSummaries) push(libraryItemToSummary(s));
  if (allow("steam")) for (const s of S.steamSummaries) push(libraryItemToSummary(s));
  if (allow("custom")) for (const s of S.customSummaries) push(libraryItemToSummary(s));
  for (const s of S.companionSummaries) {
    if (!allow(s.source)) continue;
    // EA App is only the installed backend of a purchase on another store.
    if (s.source === "ea" && primaryTitles.has(canonicalGameTitle(s.title))) continue;
    push(libraryItemToSummary(s));
  }

  if (S.separateCopies) return copies;
  const out: EpicSummary[] = [];
  for (const list of groups.values()) {
    if (list.length > 0) out.push(pickShownCopy(list));
  }
  return out;
}

function recentOrder(list: EpicSummary[]): EpicSummary[] {
  return [...list].sort(compareLibraryRecent);
}

/** Recently launched titles, filled with installed games on a fresh profile. */
export function stageRecentSummaries(limit = 12): EpicSummary[] {
  const out: EpicSummary[] = [];
  const seen = new Set<string>();
  const add = (s: EpicSummary | undefined): void => {
    if (!s || S.hiddenGames.has(s.appName)) return;
    const key = S.separateCopies ? s.appName : canonicalGameTitle(s.title) || s.appName;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const key of S.epicRecent) add(summaryOf(key));
  if (out.length < limit) {
    for (const s of recentOrder(stageBaseSummaries())) {
      if (out.length >= limit) break;
      if (s.installed) add(s);
    }
  }
  return out.slice(0, limit);
}

/** The horizontal ribbon on Home: recent titles, then installed, then favorites. */
export function stageRibbonSummaries(limit = 18): EpicSummary[] {
  const out: EpicSummary[] = [];
  const seen = new Set<string>();
  const add = (s: EpicSummary | undefined): void => {
    if (!s || S.hiddenGames.has(s.appName)) return;
    const key = S.separateCopies ? s.appName : canonicalGameTitle(s.title) || s.appName;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const key of S.epicRecent) add(summaryOf(key));
  const base = recentOrder(stageBaseSummaries());
  for (const s of base) {
    if (out.length >= limit) break;
    if (s.installed) add(s);
  }
  if (out.length < limit) {
    for (const s of base) {
      if (out.length >= limit) break;
      add(s);
    }
  }
  return out.slice(0, limit);
}

/** The big Home hero: the last played game, then the first installed title. */
export function stageHeroSummary(): EpicSummary | null {
  const recent = stageRecentSummaries(1);
  if (recent[0]) return recent[0];
  const base = stageBaseSummaries();
  return base.find((s) => s.installed) ?? base[0] ?? null;
}

/** "Up next" is the personal Playing shelf, then favourites, then installed. */
export function stageUpNext(limit = 10): EpicSummary[] {
  const base = stageBaseSummaries();
  const playing = base.filter((s) => s.installed && S.gameStatus.get(s.appName) === "playing");
  const source = playing.length > 0
    ? playing
    : base.filter((s) => s.installed && S.epicFav.has(s.appName));
  const list = source.length > 0 ? source : base.filter((s) => s.installed);
  return recentOrder(list).slice(0, limit);
}

/** Installed-but-not-recent shelf for the Home page. */
export function stageReadyShelf(limit = 10): EpicSummary[] {
  const recent = new Set(stageRecentSummaries(12).map(stageTitleKey));
  return recentOrder(
    stageBaseSummaries().filter((s) => s.installed && !recent.has(stageTitleKey(s))),
  ).slice(0, limit);
}

function hasUpdate(s: EpicSummary): boolean {
  if (S.ignoredUpdates.has(s.appName)) return false;
  return Boolean(s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName));
}

export function stageFilterCounts(): {
  all: number;
  installed: number;
  favorites: number;
  updates: number;
} {
  const base = stageBaseSummaries();
  return {
    all: base.length,
    installed: base.filter((s) => s.installed).length,
    favorites: base.filter((s) => S.epicFav.has(s.appName)).length,
    updates: base.filter(hasUpdate).length,
  };
}

/** Stores that actually have a card in the shelf, for the LT/RT filter. */
export function stageLibraryStores(): Array<GameSource | "all"> {
  const base = stageBaseSummaries();
  const present = new Set<GameSource>();
  for (const s of base) present.add(sourceOfKey(s.appName));
  return ["all", ...STAGE_STORE_ORDER.filter((source) => present.has(source))];
}

export function stageStoreFilterLabel(): string {
  return S.stage.libraryStore === "all" ? t("stage.storeAll") : stageStoreName(S.stage.libraryStore);
}

/** The visible shelf after Stage's own filter, store, query and sort. */
export function stageLibraryList(): EpicSummary[] {
  const query = S.stage.query.trim().toLowerCase();
  const collectionId = S.stage.collectionId;
  const smart = collectionId && isSmartCollection(collectionId) ? smartCollection(collectionId) : null;
  const manual = collectionId && !smart
    ? S.epicCollections.find((collection) => collection.id === collectionId) ?? null
    : null;
  const match = manual ? collectionMatch(manual) : null;
  let list = stageBaseSummaries(S.stage.libraryStore).filter((s) => {
    if (S.stage.libraryStore !== "all" && sourceOfKey(s.appName) !== S.stage.libraryStore) return false;
    if (S.stage.libraryFilter === "installed" && !s.installed) return false;
    if (S.stage.libraryFilter === "favorites" && !S.epicFav.has(s.appName)) return false;
    if (S.stage.libraryFilter === "updates" && !hasUpdate(s)) return false;
    if (smart && !smart.test(s)) return false;
    if (match && !matchCollectionGame(match, s)) return false;
    if (!query) return true;
    const haystack = `${s.title} ${s.description} ${(s.genres ?? []).join(" ")}`.toLowerCase();
    return query.split(/\s+/).every((part) => haystack.includes(part));
  });

  switch (S.stage.librarySort) {
    case "alpha":
      list = [...list].sort((a, b) => S.trCollator.compare(a.title, b.title));
      break;
    case "playtime":
      list = [...list].sort((a, b) => {
        const diff = libraryPlaytime(b).seconds - libraryPlaytime(a).seconds;
        return diff !== 0 ? diff : S.trCollator.compare(a.title, b.title);
      });
      break;
    case "installed":
      list = [...list].sort((a, b) => {
        const diff = Number(Boolean(b.installed)) - Number(Boolean(a.installed));
        return diff !== 0 ? diff : compareLibraryRecent(a, b);
      });
      break;
    default:
      list = recentOrder(list);
      break;
  }
  return list;
}

/** User-made collections that have at least one loaded game. */
export function stageUserCollections(limit = 8): GameCollection[] {
  return S.epicCollections
    .filter((collection) => collection.app_names.length > 0)
    .slice(0, limit);
}

/** First four representative keys for a collection's cover mosaic. */
export function stageCollectionCoverKeys(collection: GameCollection): string[] {
  return collectionGames(collection).slice(0, 4);
}

/**
 * Search spans the whole library, not the active shelf filter: a player who
 * typed a title expects to find it even when the library is showing only
 * installed games or one collection. The shelf filter is applied again when
 * the search closes, so the result is never a confusing empty wall.
 */
export function stageSearchMatches(query: string, limit = 24): EpicSummary[] {
  const text = query.trim().toLowerCase();
  const base = stageBaseSummaries();
  if (!text) return base.slice(0, limit);
  const parts = text.split(/\s+/).filter(Boolean);
  const out: EpicSummary[] = [];
  for (const summary of base) {
    const haystack = `${summary.title} ${summary.description} ${(summary.genres ?? []).join(" ")}`.toLowerCase();
    if (parts.every((part) => haystack.includes(part))) {
      out.push(summary);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Resolve a key that may come from a card, the recent list or a stale route. */
export function stageGameByKey(key: string | null): EpicSummary | undefined {
  if (!key) return undefined;
  return summaryOf(key) ?? stageBaseSummaries().find((s) => s.appName === key);
}

/** Dedupe key for shelves: one title when copies are combined. */
export function stageTitleKey(s: EpicSummary): string {
  return S.separateCopies ? s.appName : canonicalGameTitle(s.title) || s.appName;
}

/**
 * The primary action HTML, shared with the desktop card markup. The default
 * marker lets the gamepad layer return here after a dialog closes.
 */
export function stagePrimaryAction(s: EpicSummary): string {
  return epicActionButtons(s, "full", { primaryOnly: true }).replace("<button ", "<button data-gp-default ");
}

export function stageAchievements(s: EpicSummary): ReturnType<typeof achSummaryOf> {
  return achSummaryOf(s.appName);
}

/** Total playtime for the program page, already merged across copies. */
export function stageGamePlaytime(s: EpicSummary): { seconds: number; lastPlayed: number } {
  return libraryPlaytime(s);
}
