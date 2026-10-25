/**
 * Per-achievement notes and saved guide links.
 *
 * These are user data, not cache: the `efxlve-` prefix means the existing
 * profile export/cloud sync carries them without a backend change. Keys are
 * nested by app and achievement so names containing `:` or `::` cannot collide.
 */

import { isSafeExternalUrl } from "./achievements";

const NOTES_KEY = "efxlve-ach-notes";
const GUIDES_KEY = "efxlve-ach-guides";
const MAX_NOTE_CHARS = 4000;
const MAX_URL_CHARS = 2048;

type EntryMap = Record<string, Record<string, string>>;

function readMap(key: string): EntryMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: EntryMap = {};
    for (const [app, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const row: Record<string, string> = {};
      for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof value === "string") row[name] = value;
      }
      if (Object.keys(row).length > 0) out[app] = row;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(key: string, map: EntryMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // A full quota must not break the game page.
  }
}

function readEntry(key: string, appName: string, achievement: string): string {
  return readMap(key)[appName]?.[achievement] ?? "";
}

function writeEntry(key: string, appName: string, achievement: string, value: string): void {
  const map = readMap(key);
  const row = map[appName] ?? {};
  if (value.trim()) row[achievement] = value;
  else delete row[achievement];
  if (Object.keys(row).length > 0) map[appName] = row;
  else delete map[appName];
  writeMap(key, map);
}

export function achievementNote(appName: string, achievement: string): string {
  return readEntry(NOTES_KEY, appName, achievement);
}

export function saveAchievementNote(appName: string, achievement: string, text: string): void {
  writeEntry(NOTES_KEY, appName, achievement, text.slice(0, MAX_NOTE_CHARS));
}

export function achievementGuide(appName: string, achievement: string): string {
  return readEntry(GUIDES_KEY, appName, achievement);
}

/** Saving validates the URL here as well as in the click handler. */
export function saveAchievementGuide(
  appName: string,
  achievement: string,
  url: string,
): boolean {
  const value = url.trim().slice(0, MAX_URL_CHARS);
  if (!value || !isSafeExternalUrl(value)) return false;
  writeEntry(GUIDES_KEY, appName, achievement, value);
  return true;
}

export function removeAchievementGuide(appName: string, achievement: string): void {
  writeEntry(GUIDES_KEY, appName, achievement, "");
}
