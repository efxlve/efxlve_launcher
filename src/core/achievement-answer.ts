/**
 * The last resolved achievement answer, shared between the launcher window and
 * the overlay.
 *
 * The game page owns the source selection: a store API, a partner client, a
 * local emulator file, an EOS log or RetroAchievements. The overlay has no
 * library state to repeat that choice, so it reads this snapshot of the answer
 * the page already resolved. Both windows share one origin, so localStorage is
 * the hand-off; the payload is stored for one game only.
 */

import type { EpicAchievementsData } from "../epic-commands";

const STORAGE_KEY = "efxlve-ach-answer";
/** A session can run for hours; the page refreshes the slot every poll. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredAchievementAnswer {
  appName: string;
  at: number;
  data: EpicAchievementsData;
}

/** Saves the resolved list for the running game. An empty answer is not stored:
 *  a later page visit may still find a source the first one could not. */
export function storeAchievementAnswer(
  appName: string,
  data: EpicAchievementsData,
): void {
  if (!appName || !Array.isArray(data?.achievements) || data.achievements.length === 0) {
    return;
  }
  try {
    const entry: StoredAchievementAnswer = { appName, at: Date.now(), data };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // A full quota must not break the achievement page.
  }
}

/** The answer for this game, or null after a day or for another title. */
export function loadAchievementAnswer(appName: string): EpicAchievementsData | null {
  if (!appName) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<StoredAchievementAnswer> | null;
    if (!entry || entry.appName !== appName) return null;
    if (!entry.at || Date.now() - entry.at > MAX_AGE_MS) return null;
    if (!entry.data || !Array.isArray(entry.data.achievements)) return null;
    return entry.data.achievements.length > 0 ? entry.data : null;
  } catch {
    return null;
  }
}
