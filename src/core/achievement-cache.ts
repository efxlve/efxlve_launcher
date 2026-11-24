/**
 * Persistent card summaries for the achievement sources that answer per game.
 *
 * Epic, GOG, Steam and Ubisoft keep their sets on disk, so the bulk pass can
 * rebuild their counts at boot. EA, the EOS/Steam definition reader and Xbox
 * answer only when asked, which used to leave those covers blank until the
 * idle pass reached them. Keep the last real answer here so the first paint
 * already shows a count; the live maps stay authoritative and overwrite it as
 * soon as a fresh answer lands.
 *
 * Rows are stored without the launcher's local edits. The display map gets the
 * current deltas folded in when it is read, so an edit is never applied twice.
 */

import type { EpicAchievementSummary } from "../epic";
import { applyAchievementEditsToSummary } from "./achievement-edits";
import { ACH_SUMMARY_CACHE_KEY } from "./constants";
import { S } from "./state";

/** Enough for a large linked library; a cache miss only costs one idle pass. */
const CACHE_LIMIT = 500;
const SAVE_DELAY_MS = 1_200;

/** Raw rows: the store answer before any local achievement edit. */
let rows: Record<string, EpicAchievementSummary> | null = null;
let loadDone = false;
let saveTimer = 0;
let pagehideBound = false;

function bindFlush(): void {
  if (pagehideBound || typeof window === "undefined") return;
  pagehideBound = true;
  window.addEventListener("pagehide", flushAchievementSummaryCache);
}

/**
 * Reads the last snapshot and folds the current edits into the lookup map.
 * Called before the first library paint; a damaged cache is ignored.
 */
export function loadCachedAchievementSummaries(): void {
  if (loadDone) return;
  loadDone = true;
  bindFlush();
  try {
    const raw = localStorage.getItem(ACH_SUMMARY_CACHE_KEY);
    if (!raw) {
      rows = {};
      return;
    }
    const parsed = JSON.parse(raw) as { rows?: unknown };
    const source = parsed && typeof parsed === "object" ? parsed.rows : null;
    if (!source || typeof source !== "object") {
      rows = {};
      return;
    }
    const clean: Record<string, EpicAchievementSummary> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object") continue;
      const row = value as EpicAchievementSummary;
      if (!row.supported || (row.total_achievements ?? 0) <= 0) continue;
      clean[key] = {
        ...row,
        app_name: row.app_name || key,
        progress_known: row.progress_known !== false,
      };
    }
    rows = clean;
    refreshCachedAchievementSummaries();
  } catch {
    rows = {};
  }
}

/**
 * Keeps the last real answer for one game. Failures and metadata-only rows are
 * not stored: they would hide a better previous answer on the next launch.
 */
export function rememberAchievementSummary(
  appName: string,
  summary: EpicAchievementSummary,
): void {
  if (!appName || !summary.supported || (summary.total_achievements ?? 0) <= 0) return;
  if (summary.progress_known === false) return;
  const store = ensureRows();
  store[appName] = {
    ...summary,
    app_name: summary.app_name || appName,
    progress_known: true,
  };
  S.cachedAchSummaries[appName] = applyAchievementEditsToSummary(appName, store[appName]);
  trimRows(store);
  scheduleSave();
}

/** Rebuilds the lookup map after a local achievement edit changes or is dropped. */
export function refreshCachedAchievementSummaries(): void {
  if (!rows) return;
  const next: Record<string, EpicAchievementSummary> = {};
  for (const [key, summary] of Object.entries(rows)) {
    next[key] = applyAchievementEditsToSummary(key, summary);
  }
  S.cachedAchSummaries = next;
}

/** Drops every row; account switches and companion unlinks call this. */
export function clearAchievementSummaryCache(): void {
  if (saveTimer) {
    if (typeof window !== "undefined") window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  rows = {};
  loadDone = true;
  S.cachedAchSummaries = {};
  try {
    localStorage.removeItem(ACH_SUMMARY_CACHE_KEY);
  } catch {
    // Storage unavailable: the cache is optional.
  }
}

export function flushAchievementSummaryCache(): void {
  if (!rows) return;
  try {
    localStorage.setItem(
      ACH_SUMMARY_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), rows }),
    );
  } catch {
    // Quota or private mode: the next session simply refetches.
  }
}

function ensureRows(): Record<string, EpicAchievementSummary> {
  if (!loadDone) loadCachedAchievementSummaries();
  if (!rows) rows = {};
  return rows;
}

function trimRows(store: Record<string, EpicAchievementSummary>): void {
  const keys = Object.keys(store);
  if (keys.length <= CACHE_LIMIT) return;
  for (const key of keys.slice(0, keys.length - CACHE_LIMIT)) {
    delete store[key];
    delete S.cachedAchSummaries[key];
  }
}

function scheduleSave(): void {
  if (typeof window === "undefined") {
    flushAchievementSummaryCache();
    return;
  }
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    flushAchievementSummaryCache();
  }, SAVE_DELAY_MS);
}

/** Used by callers that receive a full achievement answer; kept beside the store. */
export function achievementSummaryFrom(
  appName: string,
  data: {
    user_unlocked: number;
    total_achievements: number;
    user_xp: number;
    total_xp: number;
    is_platinum: boolean;
  },
): EpicAchievementSummary {
  return {
    app_name: appName,
    user_unlocked: data.user_unlocked,
    total_achievements: data.total_achievements,
    user_xp: data.user_xp,
    total_xp: data.total_xp,
    is_platinum: data.is_platinum,
    supported: (data.total_achievements ?? 0) > 0,
    progress_known: true,
  };
}
