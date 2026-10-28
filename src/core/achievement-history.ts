/**
 * The player's own unlock history, kept on this PC.
 *
 * The stores know their own unlocks, but nothing in the launcher joined them
 * into one list: the notification bell is capped at 50 entries and forgets a
 * day-old history, and a game page only knows one set at a time. This module
 * records every unlock the launcher sees — a live watcher event, a store poll
 * or a page fetch — into one capped list keyed by `<app>:<achievement>`.
 *
 * Recording is idempotent: opening a game page backfills every unlock the store
 * still reports, so the list fills up without a background crawler. A reset set
 * that is earned again rewrites the entry with the new date. Launcher-only
 * marks are recorded too, flagged, so the history never claims the store has
 * something it does not.
 */

import { achievementRarity, isAchievementUnlocked } from "./achievements";
import type { AchievementStateItem, AchievementStateSet } from "./achievement-edits";

const STORAGE_KEY = "efxlve-ach-history";
/** A long-lived record; old launchers never wrote it, so the cap is generous. */
const MAX_ENTRIES = 3000;

export interface AchievementHistoryEntry {
  /** `<appName>:<achievement>`; the dedupe key. */
  key: string;
  appName: string;
  /** Library key the entry was recorded for (`steam::123`, `custom::…`). */
  game: string;
  store: string;
  name: string;
  title: string;
  description: string;
  icon: string;
  /** The store's own date (ISO date or timestamp), or "" when unknown. */
  date: string;
  rarity: number | null;
  /** True when the entry exists only in this launcher (a user mark). */
  manual: boolean;
  /** Unix ms the launcher first saw it; the sort key when `date` is absent. */
  seenAt: number;
}

let cache: AchievementHistoryEntry[] | null = null;
/** The sorted view is rebuilt only after a write; the profile reads it per paint. */
let sortedCache: AchievementHistoryEntry[] | null = null;

function cleanEntry(value: unknown): AchievementHistoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const key = typeof row.key === "string" ? row.key : "";
  const name = typeof row.name === "string" ? row.name : "";
  const appName = typeof row.appName === "string" ? row.appName : "";
  if (!key || !name || !appName) return null;
  return {
    key,
    appName,
    game: typeof row.game === "string" && row.game ? row.game : appName,
    store: typeof row.store === "string" ? row.store : "",
    name,
    title: typeof row.title === "string" ? row.title : name,
    description: typeof row.description === "string" ? row.description : "",
    icon: typeof row.icon === "string" ? row.icon : "",
    date: typeof row.date === "string" ? row.date : "",
    rarity:
      typeof row.rarity === "number" && Number.isFinite(row.rarity)
        ? row.rarity
        : null,
    manual: row.manual === true,
    seenAt: typeof row.seenAt === "number" && Number.isFinite(row.seenAt) ? row.seenAt : 0,
  };
}

/** Reads the stored list once; a broken value becomes an empty history. */
export function achievementHistory(): AchievementHistoryEntry[] {
  if (cache) return cache;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const list = Array.isArray(parsed) ? parsed : [];
    cache = list
      .map(cleanEntry)
      .filter((entry): entry is AchievementHistoryEntry => entry !== null);
  } catch {
    cache = [];
  }
  return cache;
}

function persist(entries: AchievementHistoryEntry[]): void {
  cache = entries;
  sortedCache = null;
  if (typeof localStorage === "undefined") return;
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full quota must not break the game page; the session list still works.
  }
}

/** Date value for sorting; a missing store date falls back to when we saw it. */
export function historySortValue(entry: AchievementHistoryEntry): number {
  if (entry.date) {
    const parsed = Date.parse(entry.date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return entry.seenAt || 0;
}

/** Newest first, for the profile strip and the stats. */
export function sortedAchievementHistory(
  entries: AchievementHistoryEntry[] = achievementHistory(),
): AchievementHistoryEntry[] {
  if (entries === cache) {
    if (!sortedCache) {
      sortedCache = [...entries].sort((a, b) => historySortValue(b) - historySortValue(a));
    }
    return sortedCache;
  }
  return [...entries].sort((a, b) => historySortValue(b) - historySortValue(a));
}

function entryStoreName(appName: string, store?: string): string {
  const trimmed = (store || "").trim();
  if (trimmed) return trimmed;
  const prefix = appName.indexOf("::");
  return prefix > 0 ? appName.slice(0, prefix) : "epic";
}

function entryGameTitle(appName: string, game?: string): string {
  const title = (game || "").trim();
  return title || appName;
}

function toEntry(
  appName: string,
  item: AchievementStateItem,
  seenAt: number,
  meta?: AchievementHistoryMeta,
): AchievementHistoryEntry | null {
  if (!item.name) return null;
  return {
    key: `${appName}:${item.name}`,
    appName,
    game: entryGameTitle(appName, meta?.game),
    store: entryStoreName(appName, meta?.store),
    name: item.name,
    title: (item.display_name || item.name).trim() || item.name,
    description: item.description || "",
    icon: item.icon_link || "",
    date: item.unlock_date || "",
    rarity: achievementRarity(item),
    manual: item.user_state === "unlocked",
    seenAt,
  };
}

/** Game title and store key for the row; the caller reads them from `S`. */
export interface AchievementHistoryMeta {
  game?: string;
  store?: string;
}

/**
 * Folds a game's current answer into the history: every unlocked achievement
 * the list does not know yet is appended, and a re-earned one (a newer store
 * date) replaces its old row. Returns true when the stored list changed.
 */
export function recordAchievementUnlocks(
  appName: string,
  data: AchievementStateSet | null | undefined,
  meta?: AchievementHistoryMeta,
): boolean {
  if (!appName || !data) return false;
  const items = data.achievements ?? [];
  if (items.length === 0) return false;

  const entries = achievementHistory();
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  let changed = false;
  const now = Date.now();

  for (const item of items) {
    if (!isAchievementUnlocked(item)) continue;
    const key = `${appName}:${item.name}`;
    const existing = byKey.get(key);
    const next = toEntry(appName, item, existing?.seenAt ?? now, meta);
    if (!next) continue;
    if (!existing) {
      byKey.set(key, next);
      changed = true;
      continue;
    }
    // A re-earned set reports a new date; keep the newest row. The manual flag
    // also drops once the store itself confirms the unlock, and a row that was
    // recorded without a date takes the first real date it gets.
    const nextValue = historySortValue(next);
    const existingValue = historySortValue(existing);
    const gainedDate = !existing.date && Boolean(next.date);
    if (
      gainedDate ||
      (next.date && next.date !== existing.date && nextValue >= existingValue) ||
      next.manual !== existing.manual
    ) {
      byKey.set(key, { ...existing, ...next, seenAt: existing.seenAt || now });
      changed = true;
    }
  }

  if (!changed) return false;
  const merged = [...byKey.values()].sort((a, b) => historySortValue(b) - historySortValue(a));
  persist(merged.slice(0, MAX_ENTRIES));
  return true;
}

export interface AchievementHistoryStats {
  total: number;
  thisMonth: number;
  thisYear: number;
  /** Consecutive days with at least one unlock, ending today or yesterday. */
  streakDays: number;
  /** The rarest entry (lowest global unlock rate), when a store reported one. */
  rarest: AchievementHistoryEntry | null;
}

function localDayKey(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Counts and streaks over the whole history. */
export function achievementHistoryStats(
  entries: AchievementHistoryEntry[] = achievementHistory(),
): AchievementHistoryStats {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  let thisMonth = 0;
  let thisYear = 0;
  let rarest: AchievementHistoryEntry | null = null;
  const days = new Set<string>();

  for (const entry of entries) {
    const at = historySortValue(entry);
    const date = new Date(at);
    if (!Number.isNaN(date.getTime())) {
      if (date.getFullYear() === year) thisYear += 1;
      if (date.getFullYear() === year && date.getMonth() === month) thisMonth += 1;
      const day = localDayKey(at);
      if (day) days.add(day);
    }
    if (
      entry.rarity != null &&
      Number.isFinite(entry.rarity) &&
      (rarest == null || (rarest.rarity ?? 101) > entry.rarity)
    ) {
      rarest = entry;
    }
  }

  // A streak stays alive while today is empty as long as yesterday had one:
  // an evening session at 23:50 and the next at 00:10 are one streak.
  let streakDays = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(localDayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (days.has(localDayKey(cursor.getTime()))) {
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (streakDays > 4000) break;
  }

  return {
    total: entries.length,
    thisMonth,
    thisYear,
    streakDays,
    rarest,
  };
}

/** Drops the whole history; the game pages refill it on their next open. */
export function clearAchievementHistory(): void {
  persist([]);
}
