/**
 * Background pass that fills HowLongToBeat story lengths for the open library.
 *
 * A story-length sort is only useful when most cards have a number. The disk
 * cache read at boot covers the games whose page was opened before; this pass
 * walks the filtered library behind the sort, one game at a time, and stops as
 * soon as the sort changes. A failed request is not remembered, but a stored
 * miss (the game is not on HowLongToBeat) is skipped for the session.
 */

import { isTauri } from "../../core/constants";
import {
  ensureHltbTimesLoaded,
  hltbKnownOf,
  hltbTimesReady,
  isStoryLengthSort,
  recordLiveHltb,
} from "../../core/hltb-times";
import { scheduleRender } from "../../core/render";
import { canonicalGameTitle } from "../../core/selectors";
import { S } from "../../core/state";
import { epicGetHltb } from "../../epic";
import { libraryFilteredList } from "./library-view";
import { effectiveReleaseYear } from "./library-sort";

/** Games per pass: enough to fill a large shelf, quiet enough to go unnoticed. */
const STORY_PASS_GAMES = 150;
/** Pause between two games; the length pass must never look like a burst. */
const STORY_GAP_MS = 900;

interface StoryCandidate {
  appName: string;
  title: string;
  year: number | null;
}

let running = false;
const attempted = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function storyQueue(): StoryCandidate[] {
  const seenTitles = new Set<string>();
  const rows = libraryFilteredList()
    .map((s) => ({
      appName: s.appName,
      title: s.title,
      year: effectiveReleaseYear(s),
      installed: s.installed,
    }))
    // The next game the player starts is usually installed.
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  const queue: StoryCandidate[] = [];
  for (const row of rows) {
    if (attempted.has(row.appName) || hltbKnownOf(row.appName, row.title)) continue;
    // One lookup covers every store copy of the same game.
    const canon = canonicalGameTitle(row.title) || row.appName;
    if (seenTitles.has(canon)) continue;
    seenTitles.add(canon);
    queue.push({ appName: row.appName, title: row.title, year: row.year });
  }
  return queue;
}

async function run(initialDelayMs: number): Promise<void> {
  let fetched = 0;
  try {
    await hltbTimesReady();
    if (initialDelayMs > 0) await sleep(initialDelayMs);
    // Let the library sync finish before walking what it loaded.
    for (let i = 0; i < 30; i++) {
      if (!S.epicSyncing && !S.gogSyncing && !S.steamLibrarySyncing) break;
      await sleep(1000);
      if (S.offlineMode) return;
    }
    if (S.offlineMode) return;
    for (const item of storyQueue()) {
      if (!isStoryLengthSort(S.epicSort) || S.offlineMode) return;
      if (fetched >= STORY_PASS_GAMES) return;
      // Opening a page fetches its own answer; leave the network to the reader.
      while (S.currentModalAppName) {
        await sleep(1500);
        if (!isStoryLengthSort(S.epicSort) || S.offlineMode) return;
      }
      attempted.add(item.appName);
      try {
        const data = await epicGetHltb(item.title, item.appName, false, item.year);
        recordLiveHltb(item.appName, item.title, data);
        S.loadedHltb.set(item.appName, data);
        fetched++;
        if (fetched % 8 === 0) scheduleRender();
      } catch {
        // A request that never reached the site is retried on the next visit.
      }
      await sleep(STORY_GAP_MS);
    }
  } finally {
    if (fetched > 0) scheduleRender();
    running = false;
  }
}

/** Starts one length pass when a story sort is in use; safe to call repeatedly. */
export function syncHltbLengths(initialDelayMs = 900): void {
  ensureHltbTimesLoaded();
  if (running || !isTauri || !isStoryLengthSort(S.epicSort) || S.offlineMode) return;
  running = true;
  void run(initialDelayMs).catch(() => undefined);
}
