/**
 * User-created achievement sets.
 *
 * Some titles never shipped achievements — delisted games, regional releases,
 * small indie builds — and their players still want a checklist. A local set is
 * authored here and lives only on this PC: it is never sent to a store, and the
 * store's own set (when one appears) takes the page back the moment the set is
 * deleted.
 *
 * Definitions live in `efxlve-ach-sets`; the earned state is the same local
 * edit overlay every store uses (`efxlve-ach-edits`), so marking, clearing,
 * history, notes and guides all work without a second code path.
 */

import type { EpicAchievementItem, EpicAchievementsData } from "../epic-commands";

const STORAGE_KEY = "efxlve-ach-sets";
/** A checklist for one game is a few dozen rows; this only stops a runaway paste. */
const MAX_ACHIEVEMENTS = 300;

export interface LocalAchievementDefinition {
  /** Stable id; the achievement's store-style `name`. */
  id: string;
  title: string;
  description: string;
}

export interface LocalAchievementSet {
  /** Game title at the last edit, for lists that read the set without a page. */
  game: string;
  updatedAt: number;
  achievements: LocalAchievementDefinition[];
}

export interface LocalAchievementRow {
  id?: string;
  title: string;
  description: string;
}

type SetMap = Record<string, LocalAchievementSet>;

let cache: SetMap | null = null;

function cleanRow(value: unknown): LocalAchievementDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!id || !title) return null;
  return {
    id,
    title,
    description: typeof row.description === "string" ? row.description : "",
  };
}

function loadAll(): SetMap {
  if (cache) return cache;
  const out: SetMap = {};
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [appName, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!appName || !value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        const rawAchievements = Array.isArray(row.achievements) ? row.achievements : [];
        const achievements = rawAchievements
          .map(cleanRow)
          .filter((entry): entry is LocalAchievementDefinition => entry !== null)
          .slice(0, MAX_ACHIEVEMENTS);
        if (achievements.length === 0) continue;
        out[appName] = {
          game: typeof row.game === "string" ? row.game : "",
          updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
            ? row.updatedAt
            : 0,
          achievements,
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

function persist(map: SetMap): void {
  cache = map;
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A full quota must not break the game page.
  }
}

function newId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `local-${cryptoApi.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function localAchievementSet(appName: string): LocalAchievementSet | undefined {
  return loadAll()[appName];
}

export function localAchievementCount(appName: string): number {
  return localAchievementSet(appName)?.achievements.length ?? 0;
}

export function localAchievementGames(): Array<{ appName: string; set: LocalAchievementSet }> {
  return Object.entries(loadAll())
    .map(([appName, set]) => ({ appName, set }))
    .sort((a, b) => b.set.updatedAt - a.set.updatedAt);
}

/**
 * Replaces a game's set with the given rows. Empty titles are dropped, an
 * existing id is kept so earned marks survive a rename, and a new row gets a
 * stable id. Returns the stored count.
 */
export function saveLocalAchievementSet(
  appName: string,
  game: string,
  rows: LocalAchievementRow[],
): number {
  if (!appName) return 0;
  const used = new Set<string>();
  const achievements: LocalAchievementDefinition[] = [];
  for (const row of rows) {
    const title = (row.title || "").trim();
    if (!title) continue;
    let id = (row.id || "").trim();
    if (!id || used.has(id)) id = newId();
    while (used.has(id)) id = newId();
    used.add(id);
    achievements.push({
      id,
      title: title.slice(0, 200),
      description: (row.description || "").slice(0, 500),
    });
    if (achievements.length >= MAX_ACHIEVEMENTS) break;
  }
  const map = { ...loadAll() };
  if (achievements.length === 0) {
    if (!map[appName]) return 0;
    delete map[appName];
    persist(map);
    return 0;
  }
  map[appName] = {
    game: game || map[appName]?.game || "",
    updatedAt: Date.now(),
    achievements,
  };
  persist(map);
  return achievements.length;
}

export function deleteLocalAchievementSet(appName: string): boolean {
  const map = loadAll();
  if (!map[appName]) return false;
  const next = { ...map };
  delete next[appName];
  persist(next);
  return true;
}

/**
 * The page payload for a local set. Every achievement starts locked; the local
 * edit overlay is what marks one earned, exactly like a store answer would be
 * overridden.
 */
export function localAchievementData(appName: string): EpicAchievementsData | null {
  const set = localAchievementSet(appName);
  if (!set || set.achievements.length === 0) return null;
  const achievements: EpicAchievementItem[] = set.achievements.map((definition) => ({
    name: definition.id,
    display_name: definition.title,
    description: definition.description,
    xp: 0,
    unlocked: false,
    progress: 0,
    unlock_date: null,
    icon_id: "",
    icon_link: "",
    hidden: false,
    is_base: true,
  }));
  return {
    achievements,
    hidden: [],
    user_unlocked: 0,
    user_xp: 0,
    total_achievements: achievements.length,
    total_xp: 0,
    is_platinum: false,
  };
}
