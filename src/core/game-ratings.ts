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
import { igdbCachedLibrary, type IgdbGame } from "../igdb";
import type { SteamGameDetails } from "../steam";
import { isTauri } from "./constants";
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

/** Cached genre list from IGDB or Steam store details, when known. */
export function cachedGenresOf(appName: string, title?: string): readonly string[] {
  for (const key of candidateKeys(appName, title)) {
    const genres = S.cachedGenres.get(key);
    if (genres && genres.length > 0) return genres;
  }
  return EMPTY_GENRES;
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
  if (game.genres?.length) {
    for (const k of keys) S.cachedGenres.set(k, game.genres);
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
  if (details.genres?.length) {
    for (const k of keys) {
      if (!S.cachedGenres.has(k)) S.cachedGenres.set(k, details.genres);
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

let ratingsLoaded = false;

/**
 * Loads the critic and IGDB disk caches once at boot with zero network calls.
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
      for (const row of igdbRes.value) {
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
        if (row.genres?.length) {
          for (const k of keys) S.cachedGenres.set(k, row.genres);
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
    }
    if (changed) {
      S.libraryDataRev++;
      scheduleRender();
    }
  });
}
