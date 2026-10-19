/**
 * Idle warm-up for the game page's metadata cache.
 *
 * The page's sources each have a disk cache in Rust, but a source is only
 * fetched when a page asks for it. On a fresh launch that means the first visit
 * to a game still waits for HLTB, the critic service, the store and IGDB — the
 * same answers that were already fetched on the previous run when the cache was
 * still cold. This pass walks the recently played games once, after the window
 * has gone idle, and fills those caches so the first open is local.
 *
 * Deliberate limits: only the recent list (max eight, limited below), one game
 * at a time, a pause between games, nothing while offline, and a timestamp so a
 * restart does not repeat the whole pass. Opening a page pauses the walk; the
 * player always wins over the prefetch.
 */

import { isTauri } from "../../core/constants";
import { perfMark } from "../../core/perf";
import { S } from "../../core/state";
import { summaryOf } from "../../core/selectors";
import { prefetchGamePage } from "./drawer-view";

/** Games per pass. Enough to cover the shelf, small enough to stay quiet. */
const PREFETCH_GAMES = 6;
/** Pause between two games so the walk never looks like a burst. */
const PREFETCH_GAP_MS = 900;
/** The pass is repeated after half a day, not on every launch. */
const PREFETCH_TTL_MS = 12 * 60 * 60 * 1000;
const PREFETCH_STAMP_KEY = "efxlve-game-prefetch-at";

let running = false;
let hoverBound = false;
let hoverTimer = 0;
let hoverId = "";
const hoverRequested = new Set<string>();

function idleRun(callback: () => void): void {
  const host = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof host.requestIdleCallback === "function") host.requestIdleCallback(callback);
  else window.setTimeout(callback, 6000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** A game page being open means the user is reading: leave the disk alone. */
function userIsReading(): boolean {
  return Boolean(S.currentModalAppName);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  let completed = 0;
  try {
    if (S.offlineMode) return;
    // The first library sync owns the network/disk for its first seconds. A
    // cache warm-up that starts on top of it makes the launcher feel slower,
    // not faster; wait for the pass to settle (up to half a minute).
    for (let i = 0; i < 30; i++) {
      if (!S.epicSyncing && !S.gogSyncing && !S.steamLibrarySyncing) break;
      await sleep(1000);
      if (S.offlineMode || userIsReading()) return;
    }
    const ids = S.epicRecent
      .filter((id) => Boolean(summaryOf(id)?.installed))
      .slice(0, PREFETCH_GAMES);
    // A small library may have an empty recent list: warm the first installed
    // games so the first ever page open is still covered.
    if (ids.length < PREFETCH_GAMES) {
      const installed: Array<{ id: string; installed: boolean }> = [
        ...S.epicSummaries.map((entry) => ({ id: entry.appName, installed: entry.installed })),
        ...S.steamSummaries.map((entry) => ({ id: entry.key, installed: entry.installed })),
        ...S.gogSummaries.map((entry) => ({ id: entry.key, installed: entry.installed })),
        ...S.amazonSummaries.map((entry) => ({ id: entry.key, installed: entry.installed })),
      ];
      for (const entry of installed) {
        if (ids.length >= PREFETCH_GAMES) break;
        if (!entry.installed || S.hiddenGames.has(entry.id)) continue;
        if (!ids.includes(entry.id)) ids.push(entry.id);
      }
    }
    for (const id of ids) {
      if (S.offlineMode || userIsReading()) return;
      await prefetchGamePage(id);
      completed += 1;
      if (S.offlineMode || userIsReading()) return;
      await sleep(PREFETCH_GAP_MS);
    }
    if (completed > 0) {
      localStorage.setItem(PREFETCH_STAMP_KEY, String(Date.now()));
      perfMark(`prefetch:games:${completed}`);
    }
  } finally {
    running = false;
  }
}

/**
 * Warms a card's page after the pointer rests on it. This is the one piece the
 * recent-game pass cannot cover: a library of hundreds of titles, where the
 * player is about to open something that is not in the recent shelf.
 *
 * 700 ms is the line between "reading the grid" and "opening a page"; moving
 * across cards keeps resetting it, so a sweep does not start a request per
 * card. Nothing runs while a page is already open or offline, and one game is
 * warmed at most once per session.
 */
export function initHoverPrefetch(): void {
  if (!isTauri || hoverBound) return;
  hoverBound = true;
  document.addEventListener(
    "pointerover",
    (event) => {
      const card = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-lib-item]");
      const id = card?.dataset.libItem ?? "";
      if (!card || !id || hoverRequested.has(id) || S.offlineMode) return;
      if (hoverId === id) return;
      hoverId = id;
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        hoverTimer = 0;
        if (hoverId !== id || S.offlineMode || S.currentModalAppName) return;
        hoverRequested.add(id);
        void prefetchGamePage(id);
      }, 700);
    },
    { passive: true },
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      const card = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-lib-item]");
      const id = card?.dataset.libItem ?? "";
      if (!card || id !== hoverId) return;
      const next = event.relatedTarget as Node | null;
      if (next && card.contains(next)) return;
      hoverId = "";
      if (hoverTimer) {
        window.clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
    },
    { passive: true },
  );
}

/**
 * Schedules one idle pass. Safe to call more than once; the timestamp and the
 * `running` flag keep it to one walk per half day.
 */
export function prefetchGamePagesWhenIdle(): void {
  if (!isTauri) return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(PREFETCH_STAMP_KEY) ?? 0) || 0;
  } catch {
    last = 0;
  }
  if (Date.now() - last < PREFETCH_TTL_MS) return;
  // Let the boot library finish and the user's first clicks land first.
  idleRun(() => {
    window.setTimeout(() => void run(), 3000);
  });
}
