/**
 * Library ratings and cached metadata hydration.
 *
 * The game page fetches OpenCritic, Metacritic, Steam store and IGDB answers on
 * demand and writes them to disk. This module reads those disk caches once at
 * boot (with zero network calls) so the library can sort, filter and group by
 * rating, release year, genre, studio and franchise immediately. Pages opened
 * during the session contribute their live answers too.
 */

import { epicCachedCriticScores, type CriticData } from "../epic";
import {
  igdbCachedLibrary,
  igdbEnrich,
  igdbEnrichExternalBatch,
  type IgdbCachedSummary,
  type IgdbGame,
} from "../igdb";
import type { SteamGameDetails } from "../steam";
import { isTauri } from "./constants";
import { mergeIgdbGenresAndThemes, normalizeGenreList } from "./genres";
import { scheduleRender } from "./render";
import { canonicalGameTitle, storeKeysForTitle, summaryOf } from "./selectors";
import { S } from "./state";
import type { LibRatingBucket } from "./types";

const EMPTY_GENRES: readonly string[] = [];

/** Matches Rust `igdb::normalize_title`: lowercase alphanumeric characters only. */
export function normalizeMetaKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function externalKeyToAppName(ext: string): string | null {
  if (ext.startsWith("1:")) return `steam::${ext.slice(2)}`;
  if (ext.startsWith("5:")) return `gog::${ext.slice(2)}`;
  if (ext.startsWith("20:")) return `amazon::${ext.slice(3)}`;
  return null;
}

function candidateKeys(appName: string, title?: string): string[] {
  const resolvedTitle = title ?? summaryOf(appName)?.title ?? "";
  const out = [appName];
  if (resolvedTitle) {
    for (const k of storeKeysForTitle(resolvedTitle)) {
      if (k !== appName) out.push(k);
    }
    const meta = normalizeMetaKey(resolvedTitle);
    if (meta) out.push(`meta:${meta}`);
    const canon = canonicalGameTitle(resolvedTitle);
    if (canon) out.push(`canon:${canon}`);
  }
  return out;
}

function putScore(key: string, score: number): void {
  if (!key || !Number.isFinite(score) || score <= 0) return;
  const rounded = Math.round(Math.min(100, Math.max(1, score)));
  const prev = S.gameRatings.get(key) ?? 0;
  if (rounded > prev) S.gameRatings.set(key, rounded);
}

/** Normalizes the mixed scales into 0–100 and keeps the best source. */
export function bestCriticScore(
  data: Pick<CriticData, "opencritic_score" | "metacritic_score" | "igdb_score">,
): number | null {
  const igdb = data.igdb_score;
  const normalized =
    typeof igdb === "number" && Number.isFinite(igdb) && igdb > 0
      ? Math.round(Math.min(100, Math.max(0, igdb <= 10 ? igdb * 10 : igdb)))
      : null;
  const scores = [data.opencritic_score, data.metacritic_score, normalized].filter(
    (score): score is number => typeof score === "number" && score > 0,
  );
  return scores.length > 0 ? Math.max(...scores) : null;
}

/** Best known score for one library key, live answer first, then sibling/title cache. */
export function gameRatingOf(appName: string, title?: string): number | null {
  const live = S.loadedCritic.get(appName);
  if (live) {
    const score = bestCriticScore(live);
    if (score !== null) return score;
  }
  const steamLive = S.steamDetails.get(appName)?.metacriticScore;
  if (typeof steamLive === "number" && steamLive > 0) {
    const cached = S.gameRatings.get(appName) ?? 0;
    return Math.max(steamLive, cached);
  }
  let best: number | null = null;
  for (const key of candidateKeys(appName, title)) {
    const liveCopy = S.loadedCritic.get(key);
    if (liveCopy) {
      const s = bestCriticScore(liveCopy);
      if (s !== null && (best === null || s > best)) best = s;
    }
    const stored = S.gameRatings.get(key);
    if (typeof stored === "number" && stored > 0 && (best === null || stored > best)) {
      best = stored;
    }
  }
  return best;
}

/** Cached PC/original release year from IGDB or Steam store details, when known. */
export function cachedReleaseYearOf(appName: string, title?: string): number | null {
  for (const key of candidateKeys(appName, title)) {
    const year = S.cachedReleaseYears.get(key);
    if (typeof year === "number" && year >= 1970 && year <= 2100) return year;
  }
  return null;
}

/** Cached genre list from IGDB or Steam store details, merged across matching keys. */
export function cachedGenresOf(appName: string, title?: string): readonly string[] {
  let firstHit: string[] | null = null;
  let merged: string[] | null = null;
  for (const key of candidateKeys(appName, title)) {
    const genres = S.cachedGenres.get(key);
    if (!genres || genres.length === 0) continue;
    if (!firstHit) {
      firstHit = genres;
    } else {
      if (!merged) merged = [...firstHit];
      for (const g of genres) {
        if (!merged.includes(g)) merged.push(g);
      }
    }
  }
  return merged ?? firstHit ?? EMPTY_GENRES;
}

/** Cached developer/studio name from IGDB or Steam store details, when known. */
export function cachedDeveloperOf(appName: string, title?: string): string {
  for (const key of candidateKeys(appName, title)) {
    const dev = S.cachedDevelopers.get(key);
    if (dev) return dev;
  }
  return "";
}

/** Cached primary franchise/collection name from IGDB, used by Series sort. */
export function cachedFranchiseOf(appName: string, title?: string): string {
  for (const key of candidateKeys(appName, title)) {
    const franchise = S.gameFranchises.get(key);
    if (franchise) return franchise;
  }
  return "";
}

/** Records a live critic lookup into the shared library index. */
export function recordLiveCritic(appName: string, title: string, data: CriticData): void {
  const score = bestCriticScore(data);
  if (score === null) return;
  putScore(appName, score);
  const meta = normalizeMetaKey(title);
  if (meta) putScore(`meta:${meta}`, score);
  const canon = canonicalGameTitle(title);
  if (canon) putScore(`canon:${canon}`, score);
  S.libraryDataRev++;
}

/** Records a live IGDB enrichment result into the shared library index. */
export function recordLiveIgdbGame(appName: string, title: string, game: IgdbGame): void {
  const keys = [appName];
  const meta = normalizeMetaKey(title);
  if (meta) keys.push(`meta:${meta}`);
  const gameMeta = normalizeMetaKey(game.name);
  if (gameMeta && gameMeta !== meta) keys.push(`meta:${gameMeta}`);
  const canon = canonicalGameTitle(title || game.name);
  if (canon) keys.push(`canon:${canon}`);

  if (typeof game.rating === "number" && Number.isFinite(game.rating) && game.rating > 0) {
    for (const k of keys) putScore(k, game.rating);
  }
  const year = game.pcReleaseYear ?? game.releaseYear;
  if (typeof year === "number" && year >= 1970 && year <= 2100) {
    for (const k of keys) S.cachedReleaseYears.set(k, year);
  }
  const mergedGenres = mergeIgdbGenresAndThemes(game.genres, game.themes);
  if (mergedGenres.length > 0) {
    for (const k of keys) S.cachedGenres.set(k, mergedGenres);
  }
  if (game.developer?.trim()) {
    const dev = game.developer.trim();
    for (const k of keys) S.cachedDevelopers.set(k, dev);
  }
  const primaryFranchise = game.franchises?.find((f) => f && f.trim())?.trim();
  if (primaryFranchise) {
    for (const k of keys) S.gameFranchises.set(k, primaryFranchise);
  }
  S.libraryDataRev++;
}

/** Records a live Steam store details answer into the shared library index. */
export function recordLiveSteamDetails(appName: string, title: string, details: SteamGameDetails): void {
  const keys = [appName];
  const meta = normalizeMetaKey(title || details.name);
  if (meta) keys.push(`meta:${meta}`);
  const canon = canonicalGameTitle(title || details.name);
  if (canon) keys.push(`canon:${canon}`);

  if (typeof details.metacriticScore === "number" && details.metacriticScore > 0) {
    for (const k of keys) putScore(k, details.metacriticScore);
  }
  const yearMatch = details.releaseDate?.match(/\b(19[7-9]\d|20\d{2})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    for (const k of keys) {
      if (!S.cachedReleaseYears.has(k)) S.cachedReleaseYears.set(k, year);
    }
  }
  const normGenres = normalizeGenreList(details.genres ?? []);
  if (normGenres.length > 0) {
    for (const k of keys) {
      const existing = S.cachedGenres.get(k);
      if (!existing || existing.length === 0) {
        S.cachedGenres.set(k, normGenres);
      } else {
        const union = normalizeGenreList([...existing, ...normGenres]);
        if (union.length > existing.length) S.cachedGenres.set(k, union);
      }
    }
  }
  const dev = details.developers?.find((d) => d && d.trim())?.trim();
  if (dev) {
    for (const k of keys) {
      if (!S.cachedDevelopers.has(k)) S.cachedDevelopers.set(k, dev);
    }
  }
  S.libraryDataRev++;
}

/** Rating shelf of a score; `null` means no store has answered yet. */
export function ratingBucket(score: number | null): LibRatingBucket {
  if (score === null) return "unrated";
  if (score >= 90) return "90";
  if (score >= 80) return "80";
  if (score >= 70) return "70";
  if (score >= 60) return "60";
  if (score >= 50) return "50";
  return "under50";
}

function applyIgdbSummaries(rows: IgdbCachedSummary[]): boolean {
  let changed = false;
  for (const row of rows) {
    const keys: string[] = [];
    if (row.normalizedTitle) keys.push(`meta:${row.normalizedTitle}`);
    for (const lk of row.lookupKeys) {
      if (lk) keys.push(`meta:${lk}`);
    }
    const canon = canonicalGameTitle(row.name);
    if (canon) keys.push(`canon:${canon}`);
    for (const ext of row.externalKeys) {
      const appName = externalKeyToAppName(ext);
      if (appName) keys.push(appName);
    }

    if (typeof row.rating === "number" && row.rating > 0) {
      for (const k of keys) putScore(k, row.rating);
      changed = true;
    }
    if (typeof row.releaseYear === "number" && row.releaseYear >= 1970 && row.releaseYear <= 2100) {
      for (const k of keys) S.cachedReleaseYears.set(k, row.releaseYear);
      changed = true;
    }
    const mergedGenres = mergeIgdbGenresAndThemes(row.genres, row.themes);
    if (mergedGenres.length > 0) {
      for (const k of keys) S.cachedGenres.set(k, mergedGenres);
      changed = true;
    }
    if (row.developer?.trim()) {
      const dev = row.developer.trim();
      for (const k of keys) S.cachedDevelopers.set(k, dev);
      changed = true;
    }
    const primaryFranchise = row.franchises?.find((f) => f && f.trim())?.trim();
    if (primaryFranchise) {
      for (const k of keys) S.gameFranchises.set(k, primaryFranchise);
      changed = true;
    }
  }
  return changed;
}

let ratingsLoaded = false;
let batchSyncRunning = false;
const attemptedExternalUids = new Set<string>();
const attemptedTitleApps = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function genreUiVisible(): boolean {
  return (
    S.isFilterPanelOpen ||
    S.libGroupBy === "genre" ||
    S.libGroupBy === "rating" ||
    S.libGroupBy === "year" ||
    S.epicSort === "genre" ||
    S.epicSort === "rating" ||
    S.epicSort === "yearNew" ||
    S.epicSort === "yearOld" ||
    S.epicSort === "series"
  );
}

/**
 * Quiet background pass that enriches uncached library entries from IGDB in
 * rate-limited batches so genre, rating, year and franchise facets cover the
 * whole library rather than only previously opened game pages.
 */
export async function syncUncachedLibraryIgdb(initialDelayMs = 3500): Promise<void> {
  if (batchSyncRunning || !isTauri) return;
  batchSyncRunning = true;

  try {
    if (initialDelayMs > 0) await sleep(initialDelayMs);
    for (let i = 0; i < 30; i++) {
      if (!S.epicSyncing && !S.gogSyncing && !S.steamLibrarySyncing) break;
      await sleep(1000);
    }
    if (!S.igdbConfigured || S.offlineMode) return;

    const byCat = new Map<number, string[]>([
      [1, []],
      [5, []],
      [20, []],
    ]);

    const pushExternal = (cat: number, key: string, uid: string, title: string, installed: boolean): void => {
      if (!uid || S.hiddenGames.has(key)) return;
      const attemptKey = `${cat}:${uid.toLowerCase()}`;
      if (attemptedExternalUids.has(attemptKey)) return;
      if (S.cachedGenres.has(key)) return;
      const meta = normalizeMetaKey(title);
      if (meta && S.cachedGenres.has(`meta:${meta}`)) return;
      const bucket = byCat.get(cat);
      if (!bucket) return;
      if (installed) bucket.unshift(uid);
      else bucket.push(uid);
    };

    for (const g of S.steamSummaries) pushExternal(1, g.key, g.id, g.title, g.installed);
    for (const g of S.gogSummaries) pushExternal(5, g.key, g.id, g.title, g.installed);
    for (const g of S.amazonSummaries) pushExternal(20, g.key, g.id, g.title, g.installed);

    let batchesRun = 0;
    let unrenderedChanges = false;
    const MAX_BATCHES = 30;
    const CHUNK = 25;

    for (const [cat, uids] of byCat) {
      for (let offset = 0; offset < uids.length && batchesRun < MAX_BATCHES; offset += CHUNK) {
        if (!S.igdbConfigured || S.offlineMode) return;
        while (S.currentModalAppName) {
          await sleep(1500);
          if (S.offlineMode) return;
        }
        const slice = uids.slice(offset, offset + CHUNK);
        for (const u of slice) attemptedExternalUids.add(`${cat}:${u.toLowerCase()}`);
        try {
          const rows = await igdbEnrichExternalBatch(cat, slice);
          if (rows.length > 0 && applyIgdbSummaries(rows)) {
            S.libraryDataRev++;
            unrenderedChanges = true;
            if (genreUiVisible() || batchesRun % 4 === 3) {
              unrenderedChanges = false;
              scheduleRender();
            }
          }
        } catch {
          if (unrenderedChanges) scheduleRender();
          return;
        }
        batchesRun++;
        await sleep(850);
      }
    }

    // Enrich a small budget of uncached Epic / Custom titles that lack genres.
    const titleCandidates: { appName: string; title: string; year: number | null }[] = [];
    for (const s of S.epicSummaries) {
      if (S.hiddenGames.has(s.appName) || attemptedTitleApps.has(s.appName)) continue;
      if (s.genres?.length || cachedGenresOf(s.appName, s.title).length > 0) continue;
      titleCandidates.push({ appName: s.appName, title: s.title, year: s.releaseYear ?? null });
      if (titleCandidates.length >= 16) break;
    }
    for (const g of S.customSummaries) {
      if (titleCandidates.length >= 20) break;
      if (S.hiddenGames.has(g.key) || attemptedTitleApps.has(g.key)) continue;
      if (g.genres?.length || cachedGenresOf(g.key, g.title).length > 0) continue;
      titleCandidates.push({ appName: g.key, title: g.title, year: g.releaseYear ?? null });
    }

    for (const cand of titleCandidates) {
      if (!S.igdbConfigured || S.offlineMode) break;
      while (S.currentModalAppName) {
        await sleep(1500);
        if (S.offlineMode) break;
      }
      attemptedTitleApps.add(cand.appName);
      try {
        const game = await igdbEnrich(cand.title, cand.year, null);
        if (game) {
          recordLiveIgdbGame(cand.appName, cand.title, game);
          unrenderedChanges = true;
          if (genreUiVisible()) {
            unrenderedChanges = false;
            scheduleRender();
          }
        }
      } catch {
        break;
      }
      await sleep(1100);
    }

    if (unrenderedChanges) {
      scheduleRender();
    }
  } finally {
    batchSyncRunning = false;
  }
}

/**
 * Loads the critic and IGDB disk caches once at boot with zero network calls,
 * then schedules a polite background pass for uncached library titles.
 */
export function ensureGameRatingsLoaded(): void {
  if (ratingsLoaded || !isTauri) return;
  ratingsLoaded = true;
  void Promise.allSettled([epicCachedCriticScores(), igdbCachedLibrary()]).then(([criticRes, igdbRes]) => {
    let changed = false;
    if (criticRes.status === "fulfilled" && criticRes.value.length > 0) {
      for (const row of criticRes.value) {
        if (row.app_name && Number.isFinite(row.score)) {
          putScore(row.app_name, row.score);
          const summary = summaryOf(row.app_name);
          if (summary?.title) {
            const meta = normalizeMetaKey(summary.title);
            if (meta) putScore(`meta:${meta}`, row.score);
            const canon = canonicalGameTitle(summary.title);
            if (canon) putScore(`canon:${canon}`, row.score);
          }
          changed = true;
        }
      }
    }
    if (igdbRes.status === "fulfilled" && igdbRes.value.length > 0) {
      if (applyIgdbSummaries(igdbRes.value)) changed = true;
    }
    if (changed) {
      S.libraryDataRev++;
      scheduleRender();
    }
    void syncUncachedLibraryIgdb();
  });
}
