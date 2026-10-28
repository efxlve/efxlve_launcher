/**
 * Launcher-only achievement state edits.
 *
 * Some games never report an unlock the player really earned, and some players
 * want to wipe a set and earn it again. Both are answered here: an edit changes
 * only what this launcher shows. The store account, the game and every other
 * device keep their own progress, so nothing here can corrupt a real profile.
 *
 * Each entry remembers the store's own answer when it was written, and a
 * `locked` entry also remembers the unlock date it hid. A genuinely new unlock
 * (a different date) wins over the edit, so a reset set becomes earnable again
 * without pressing anything. `clearAchievementEdits` is the explicit way back
 * to the store's answer.
 */

import {
  achievementProgress,
  isAchievementUnlocked,
} from "./achievements";
import type { AchievementUserState, EpicAchievementSummary } from "../epic-commands";

/** Profile export and cloud sync carry every `efxlve-` key, this one included. */
const STORAGE_KEY = "efxlve-ach-edits";

/**
 * The part of an achievement payload the edit layer reads and writes. Both the
 * launcher's typed payload and the overlay's looser view satisfy it, so the two
 * windows fold the same edits over the same answer.
 */
export interface AchievementStateItem {
  name: string;
  unlocked?: boolean;
  progress?: number;
  unlock_date?: string | null;
  xp?: number;
  user_state?: AchievementUserState;
  store_unlocked?: boolean;
  store_progress?: number;
  store_unlock_date?: string | null;
}

export interface AchievementStateSet {
  achievements: AchievementStateItem[];
  hidden?: AchievementStateItem[];
  user_unlocked: number;
  user_xp?: number;
  total_achievements: number;
  is_platinum?: boolean;
  user_marked?: number;
  user_cleared?: number;
}

export interface AchievementEdit {
  state: AchievementUserState;
  /** Unix milliseconds, for the "your edits" list order. */
  at: number;
  /** The store's unlock date this edit covered; `null` when it had none. */
  date: string | null;
}

export interface AchievementEdits {
  title: string;
  store: string;
  updatedAt: number;
  /**
   * What the edits add to the store's own numbers: `unlocked` can be negative.
   * Library covers and the profile read this without the per-achievement list.
   */
  delta: { unlocked: number; xp: number };
  items: Record<string, AchievementEdit>;
}

type EditMap = Record<string, AchievementEdits>;

export interface AchievementEditMeta {
  title: string;
  store: string;
}

/** The store's own facts for one item, before any edit is applied. */
export interface StoreAchievementFacts {
  unlocked: boolean;
  progress: number;
  date: string | null;
}

let cache: EditMap | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reads the stored map once; a broken value is replaced, never thrown. */
export function loadAchievementEdits(): EditMap {
  if (cache) return cache;
  const out: EditMap = {};
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [appName, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!appName || !value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        const items: Record<string, AchievementEdit> = {};
        const rawItems = row.items;
        if (rawItems && typeof rawItems === "object" && !Array.isArray(rawItems)) {
          for (const [name, entry] of Object.entries(rawItems as Record<string, unknown>)) {
            if (!name || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const edit = entry as Record<string, unknown>;
            if (edit.state !== "unlocked" && edit.state !== "locked") continue;
            items[name] = {
              state: edit.state,
              at: isFiniteNumber(edit.at) ? edit.at : 0,
              date: typeof edit.date === "string" ? edit.date : null,
            };
          }
        }
        if (Object.keys(items).length === 0) continue;
        const delta = (row.delta && typeof row.delta === "object" ? row.delta : {}) as Record<string, unknown>;
        out[appName] = {
          title: typeof row.title === "string" ? row.title : "",
          store: typeof row.store === "string" ? row.store : "",
          updatedAt: isFiniteNumber(row.updatedAt) ? row.updatedAt : 0,
          delta: {
            unlocked: isFiniteNumber(delta.unlocked) ? Math.round(delta.unlocked) : 0,
            xp: isFiniteNumber(delta.xp) ? Math.round(delta.xp) : 0,
          },
          items,
        };
      }
    }
  } catch {
    cache = {};
    return cache;
  }
  cache = out;
  return cache;
}

function persist(map: EditMap): void {
  cache = map;
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A full quota must not break the achievement page.
  }
}

/** Games with at least one edit, newest first. */
export function editedAchievementGames(): Array<{ appName: string; edits: AchievementEdits }> {
  return Object.entries(loadAchievementEdits())
    .map(([appName, edits]) => ({ appName, edits }))
    .sort((a, b) => b.edits.updatedAt - a.edits.updatedAt);
}

export function achievementEditsOf(appName: string): AchievementEdits | undefined {
  return loadAchievementEdits()[appName];
}

function ensureRecord(map: EditMap, appName: string, meta: AchievementEditMeta): AchievementEdits {
  const existing = map[appName];
  if (existing) {
    if (meta.title) existing.title = meta.title;
    if (meta.store) existing.store = meta.store;
    return existing;
  }
  const created: AchievementEdits = {
    title: meta.title,
    store: meta.store,
    updatedAt: Date.now(),
    delta: { unlocked: 0, xp: 0 },
    items: {},
  };
  map[appName] = created;
  return created;
}

/**
 * Writes one edit, or removes it when `state` is null. `storeDate` is the
 * store's own unlock date for a `locked` edit; a later, different date expires
 * the edit on its own.
 */
export function setAchievementEdit(
  appName: string,
  meta: AchievementEditMeta,
  achievement: string,
  state: AchievementUserState | null,
  storeDate: string | null = null,
): void {
  if (!appName || !achievement) return;
  const map = { ...loadAchievementEdits() };
  const record = map[appName];
  if (state === null) {
    if (!record || !(achievement in record.items)) return;
    const nextItems = { ...record.items };
    delete nextItems[achievement];
    if (Object.keys(nextItems).length === 0) delete map[appName];
    else map[appName] = { ...record, items: nextItems, updatedAt: Date.now() };
    persist(map);
    return;
  }
  const target = ensureRecord(map, appName, meta);
  target.items = {
    ...target.items,
    [achievement]: { state, at: Date.now(), date: state === "locked" ? storeDate : null },
  };
  target.updatedAt = Date.now();
  persist(map);
}

/**
 * Replaces every edit for one game. The bulk actions build the full list from
 * the store's own answer, so a partial merge would leave stale entries behind.
 */
export function replaceAchievementEdits(
  appName: string,
  meta: AchievementEditMeta,
  entries: Array<{ name: string; state: AchievementUserState; date: string | null }>,
): void {
  if (!appName) return;
  const map = { ...loadAchievementEdits() };
  if (entries.length === 0) {
    if (!map[appName]) return;
    delete map[appName];
    persist(map);
    return;
  }
  const previous = map[appName];
  const now = Date.now();
  const items: Record<string, AchievementEdit> = {};
  for (const entry of entries) {
    if (!entry.name) continue;
    items[entry.name] = {
      state: entry.state,
      at: now,
      date: entry.state === "locked" ? entry.date : null,
    };
  }
  map[appName] = {
    title: meta.title,
    store: meta.store,
    updatedAt: now,
    delta: previous?.delta ?? { unlocked: 0, xp: 0 },
    items,
  };
  persist(map);
}

/** Drops every edit for one game: the store's own answer is used again. */
export function clearAchievementEdits(appName: string): boolean {
  const map = loadAchievementEdits();
  if (!map[appName]) return false;
  const next = { ...map };
  delete next[appName];
  persist(next);
  return true;
}

/** The store's own answer for one item, before any edit is applied. */
export function storeFactsOf(item: AchievementStateItem): StoreAchievementFacts {
  return {
    unlocked: item.store_unlocked ?? isAchievementUnlocked(item),
    progress: item.store_progress ?? achievementProgress(item),
    date:
      item.store_unlock_date !== undefined
        ? item.store_unlock_date
        : item.unlock_date ?? null,
  };
}

/** The day an edit was written, so a manual mark keeps one date. */
function editDateIso(at: number): string {
  const date = new Date(at > 0 ? at : Date.now());
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * Every edit this game needs to show the state the user picked: the store's
 * answer with the edits folded in. Also the one place the effective counts,
 * XP and platinum flag are recomputed, so the drawer, the overlay, the profile
 * and the library covers all read the same numbers.
 */
export function applyAchievementEdits(appName: string, data: AchievementStateSet): void {
  const map = loadAchievementEdits();
  const record = map[appName];
  const items = data.achievements ?? [];
  const hidden = data.hidden ?? [];
  const touched = items.some((item) => item.store_unlocked !== undefined) ||
    hidden.some((item) => item.store_unlocked !== undefined);
  if (!record && !touched) return;

  for (const list of [items, hidden]) {
    for (const item of list) {
      if (item.store_unlocked === undefined) {
        item.store_unlocked = isAchievementUnlocked(item);
        item.store_progress = achievementProgress(item);
        item.store_unlock_date = item.unlock_date ?? null;
      }
      const raw = storeFactsOf(item);
      item.unlocked = raw.unlocked;
      item.progress = raw.progress;
      item.unlock_date = raw.date;
      delete item.user_state;

      const edit = record?.items[item.name];
      if (!edit) continue;
      if (edit.state === "unlocked") {
        item.unlocked = true;
        item.progress = 1;
        if (!raw.unlocked) {
          item.user_state = "unlocked";
          // The day the user marked it, not today: the date has to stay put
          // when the page is painted again tomorrow.
          item.unlock_date = editDateIso(edit.at);
        }
      } else if (raw.unlocked && (edit.date ?? "") === (raw.date ?? "")) {
        // The same unlock the user cleared: keep it cleared here. A different
        // date is a fresh unlock, and that one wins over the reset.
        item.unlocked = false;
        item.progress = 0;
        item.unlock_date = null;
        item.user_state = "locked";
      }
    }
  }

  let unlocked = 0;
  let xp = 0;
  let marked = 0;
  let cleared = 0;
  let storeUnlocked = 0;
  let storeXp = 0;
  for (const item of items) {
    const earned = isAchievementUnlocked(item);
    if (earned) {
      unlocked += 1;
      xp += Number(item.xp) || 0;
    }
    if (item.user_state === "unlocked") marked += 1;
    else if (item.user_state === "locked") cleared += 1;
    if (item.store_unlocked) {
      storeUnlocked += 1;
      storeXp += Number(item.xp) || 0;
    }
  }
  data.user_unlocked = unlocked;
  data.user_xp = xp;
  data.user_marked = marked;
  data.user_cleared = cleared;
  data.is_platinum = items.length > 0 && unlocked === items.length;

  if (!record) return;
  const delta = { unlocked: unlocked - storeUnlocked, xp: xp - storeXp };
  if (record.delta.unlocked === delta.unlocked && record.delta.xp === delta.xp) return;
  // `record` is a live reference into the cached map, so this update persists
  // with the next write and stays readable from the summary cache meanwhile.
  record.delta = delta;
  persist({ ...map });
}

/** Summary keys a game can be stored under: GOG and Steam carry a prefix. */
function summaryKeys(appName: string): string[] {
  if (appName.startsWith("gog::")) return [appName, appName.slice(5)];
  if (appName.startsWith("steam::")) return [appName, appName.slice(7)];
  return [appName];
}

/**
 * Folds the stored count deltas into the bulk summaries, so a library cover or
 * the profile does not contradict the game page before that page is opened.
 */
export function applyAchievementEditsToSummaries(
  summaries: Record<string, EpicAchievementSummary>,
): void {
  for (const [appName, record] of Object.entries(loadAchievementEdits())) {
    applyDeltaToSummaries(appName, summaries, record.delta);
  }
}

/** Takes one game's stored delta back out of an in-memory summary map. */
export function revertAchievementEditsFromSummaries(
  appName: string,
  summaries: Record<string, EpicAchievementSummary>,
): void {
  const record = achievementEditsOf(appName);
  if (!record) return;
  applyDeltaToSummaries(appName, summaries, {
    unlocked: -record.delta.unlocked,
    xp: -record.delta.xp,
  });
}

function applyDeltaToSummaries(
  appName: string,
  summaries: Record<string, EpicAchievementSummary>,
  delta: { unlocked: number; xp: number },
): void {
  if (delta.unlocked === 0 && delta.xp === 0) return;
  for (const key of summaryKeys(appName)) {
    const summary = summaries[key];
    if (!summary) continue;
    const total = summary.total_achievements ?? 0;
    const raw = summary.user_unlocked + delta.unlocked;
    summary.user_unlocked = total > 0 ? Math.max(0, Math.min(total, raw)) : Math.max(0, raw);
    summary.user_xp = Math.max(0, summary.user_xp + delta.xp);
    summary.is_platinum = total > 0 && summary.user_unlocked >= total;
  }
}
