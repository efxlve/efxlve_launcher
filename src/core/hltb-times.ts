/**
 * HowLongToBeat story lengths for the library.
 *
 * The game page fetches a game's completion times on demand and Rust stores
 * every answer — a miss too — on disk. This module reads the hits once at boot,
 * so the library can sort by story length from data that is already local, and
 * exposes the lookup that the sort and the length prefetch share.
 */

import { epicCachedHltbTimes, type HltbData } from "../epic";
import { isTauri } from "./constants";
import { normalizeMetaKey } from "./game-ratings";
import { scheduleRender } from "./render";
import { canonicalGameTitle, storeKeysForTitle, summaryOf } from "./selectors";
import { S } from "./state";
import type { EpicSort } from "./types";

/** Sorts that need a HowLongToBeat length. */
export function isStoryLengthSort(sort: EpicSort): boolean {
  return sort === "storyShort" || sort === "storyLong";
}

/** Main-story hours, then main+extra, then completionist; `null` when unknown. */
export function hltbStoryHours(data?: HltbData | null): number | null {
  if (!data?.supported) return null;
  for (const value of [data.main_story, data.main_extra, data.completionist]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** Every key the HLTB answer for one game can be stored under. */
function candidateKeys(appName: string, title?: string): string[] {
  const resolvedTitle = title ?? summaryOf(appName)?.title ?? "";
  const out = [appName];
  if (resolvedTitle) {
    for (const key of storeKeysForTitle(resolvedTitle)) {
      if (key !== appName) out.push(key);
    }
    const meta = normalizeMetaKey(resolvedTitle);
    if (meta) out.push(`meta:${meta}`);
    const canon = canonicalGameTitle(resolvedTitle);
    if (canon) out.push(`canon:${canon}`);
  }
  return out;
}

/** Best known story length for one library entry. */
export function hltbStoryHoursOf(appName: string, title?: string): number | null {
  const live = hltbStoryHours(S.loadedHltb.get(appName));
  if (live !== null) return live;
  for (const key of candidateKeys(appName, title)) {
    const hours = hltbStoryHours(S.hltbTimes.get(key));
    if (hours !== null) return hours;
  }
  return null;
}

/** True when an answer (a hit or a stored miss) already covers this game. */
export function hltbKnownOf(appName: string, title?: string): boolean {
  if (S.loadedHltb.has(appName)) return true;
  return candidateKeys(appName, title).some((key) => S.hltbTimes.has(key));
}

/** Records a live answer under every key the library uses for the game. */
export function recordLiveHltb(appName: string, title: string, data: HltbData): void {
  for (const key of candidateKeys(appName, title)) S.hltbTimes.set(key, data);
  S.libraryDataRev++;
}

let cachedLoaded = false;
let loading: Promise<void> | null = null;

function applyCachedHltb(rows: HltbData[]): boolean {
  let changed = false;
  for (const row of rows) {
    if (!row.app_name) continue;
    for (const key of candidateKeys(row.app_name, row.title)) {
      if (!S.hltbTimes.has(key)) {
        S.hltbTimes.set(key, row);
        changed = true;
      }
    }
    // The page for the copy that wrote the cache opens without a lookup.
    if (!S.loadedHltb.has(row.app_name)) {
      S.loadedHltb.set(row.app_name, row);
      changed = true;
    }
  }
  return changed;
}

/**
 * Reads every stored HLTB hit once, with zero network calls. The sort then
 * covers the games whose page was opened before; `syncHltbLengths` fills in
 * the rest only while a story-length sort is in use.
 */
export function ensureHltbTimesLoaded(): void {
  if (cachedLoaded || !isTauri) return;
  cachedLoaded = true;
  loading = epicCachedHltbTimes()
    .then((rows) => {
      if (applyCachedHltb(rows)) {
        S.libraryDataRev++;
        scheduleRender();
      }
    })
    .catch(() => undefined)
    .then(() => undefined);
}

/** Resolves once the stored answers are in memory (immediately outside Tauri). */
export function hltbTimesReady(): Promise<void> {
  return loading ?? Promise.resolve();
}
