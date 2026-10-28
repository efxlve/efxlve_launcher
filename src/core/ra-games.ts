/**
 * Launcher game → RetroAchievements game id.
 *
 * RA has no store id to match against: a launcher title can be a ROM inside an
 * emulator, so the player names the RA game once. The mapping is local, rides
 * the profile export, and wins over the store answer for that game page until
 * it is cleared.
 */

const STORAGE_KEY = "efxlve-ra-games";

export interface RaGameMapping {
  gameId: string;
  /** RA title, when the player filled it in; only for the settings list. */
  title: string;
  updatedAt: number;
}

type MappingMap = Record<string, RaGameMapping>;

let cache: MappingMap | null = null;

function loadAll(): MappingMap {
  if (cache) return cache;
  const out: MappingMap = {};
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [appName, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!appName || !value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        const gameId = typeof row.gameId === "string" ? row.gameId.trim() : "";
        if (!/^\d+$/.test(gameId)) continue;
        out[appName] = {
          gameId,
          title: typeof row.title === "string" ? row.title : "",
          updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
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

function persist(map: MappingMap): void {
  cache = map;
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A full quota must not break the game page.
  }
}

export function raGameFor(appName: string): RaGameMapping | undefined {
  return loadAll()[appName];
}

/** Saves a numeric RA game id; an empty id removes the mapping. */
export function setRaGame(
  appName: string,
  gameId: string,
  title = "",
): RaGameMapping | undefined {
  if (!appName) return undefined;
  const cleaned = gameId.trim();
  const map = { ...loadAll() };
  if (!cleaned) {
    if (!map[appName]) return undefined;
    delete map[appName];
    persist(map);
    return undefined;
  }
  if (!/^\d+$/.test(cleaned)) return undefined;
  const mapping: RaGameMapping = {
    gameId: cleaned,
    title: title.trim() || map[appName]?.title || "",
    updatedAt: Date.now(),
  };
  map[appName] = mapping;
  persist(map);
  return mapping;
}

export function raMappedGames(): Array<{ appName: string; mapping: RaGameMapping }> {
  return Object.entries(loadAll())
    .map(([appName, mapping]) => ({ appName, mapping }))
    .sort((a, b) => b.mapping.updatedAt - a.mapping.updatedAt);
}
