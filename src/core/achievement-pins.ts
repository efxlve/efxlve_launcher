/**
 * The player's achievement showcase.
 *
 * Three pins, the same budget a console profile grants. A pin is a snapshot:
 * the card keeps the achievement's name, art and rarity even when the game page
 * was never opened in this session and the store is offline. The store is never
 * involved; this is a local display choice.
 */

import { achievementRarity, achievementTier } from "./achievements";
import type { AchievementStateItem } from "./achievement-edits";

const STORAGE_KEY = "efxlve-ach-pins";
/** Three cards fit one row and match the console convention. */
export const MAX_ACHIEVEMENT_PINS = 3;

export interface AchievementPin {
  /** `<appName>:<achievement>`; the dedupe key. */
  key: string;
  appName: string;
  name: string;
  /** Game title at pin time. */
  game: string;
  /** Achievement title at pin time. */
  title: string;
  icon: string;
  rarity: number | null;
  tier: string;
  date: string;
}

let cache: AchievementPin[] | null = null;

function cleanPin(value: unknown): AchievementPin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const key = typeof row.key === "string" ? row.key : "";
  const appName = typeof row.appName === "string" ? row.appName : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (!key || !appName || !name) return null;
  return {
    key,
    appName,
    name,
    game: typeof row.game === "string" ? row.game : appName,
    title: typeof row.title === "string" ? row.title : name,
    icon: typeof row.icon === "string" ? row.icon : "",
    rarity: typeof row.rarity === "number" && Number.isFinite(row.rarity) ? row.rarity : null,
    tier: typeof row.tier === "string" ? row.tier : "",
    date: typeof row.date === "string" ? row.date : "",
  };
}

/** Pins in display order (newest first). */
export function achievementPins(): AchievementPin[] {
  if (cache) return cache;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const list = Array.isArray(parsed) ? parsed : [];
    cache = list
      .map(cleanPin)
      .filter((pin): pin is AchievementPin => pin !== null)
      .slice(0, MAX_ACHIEVEMENT_PINS);
  } catch {
    cache = [];
  }
  return cache;
}

function persist(pins: AchievementPin[]): void {
  cache = pins;
  if (typeof localStorage === "undefined") return;
  try {
    if (pins.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // A full quota must not break the achievement page.
  }
}

export function isAchievementPinned(appName: string, achievement: string): boolean {
  return achievementPins().some((pin) => pin.appName === appName && pin.name === achievement);
}

/**
 * Pins or unpins one achievement. Returns true when it is now pinned. A fourth
 * pin drops the oldest one instead of refusing: the card is the point, the
 * limit only decides what fits on the profile.
 */
export function toggleAchievementPin(
  appName: string,
  game: string,
  item: AchievementStateItem,
): boolean {
  if (!appName || !item.name) return false;
  const key = `${appName}:${item.name}`;
  const pins = achievementPins();
  const existing = pins.findIndex((pin) => pin.key === key);
  if (existing >= 0) {
    persist(pins.filter((pin) => pin.key !== key));
    return false;
  }
  const tier = achievementTier(item);
  const pin: AchievementPin = {
    key,
    appName,
    name: item.name,
    game: game || appName,
    title: (item.display_name || item.name).trim() || item.name,
    icon: item.icon_link || "",
    rarity: achievementRarity(item),
    tier: tier || "",
    date: item.unlock_date || "",
  };
  persist([pin, ...pins].slice(0, MAX_ACHIEVEMENT_PINS));
  return true;
}

export function removeAchievementPin(key: string): void {
  const pins = achievementPins();
  if (!pins.some((pin) => pin.key === key)) return;
  persist(pins.filter((pin) => pin.key !== key));
}
