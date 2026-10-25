/**
 * Achievement notes and saved guide links.
 *
 * They are ordinary notes in `notes.json`, tagged with the stable achievement
 * key. That makes the same text show up in the game's Notes tab, the global
 * Notes page and the overlay, and it rides the existing profile export. The
 * older `efxlve-ach-notes` / `efxlve-ach-guides` maps are read once per game and
 * folded into the tagged notes.
 */

import { isSafeExternalUrl } from "../../core/achievements";
import { S } from "../../core/state";
import {
  cachedNotes,
  deleteNote,
  loadNotes,
  saveNote,
  type Note,
} from "../notes/notes-client";

const LEGACY_NOTES_KEY = "efxlve-ach-notes";
const LEGACY_GUIDES_KEY = "efxlve-ach-guides";
const MAX_NOTE_CHARS = 4000;
const MAX_URL_CHARS = 2048;

type EntryMap = Record<string, Record<string, string>>;

function readLegacyMap(key: string): EntryMap {
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

function writeLegacyMap(key: string, map: EntryMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // A full quota must not break the game page.
  }
}

function dropLegacyEntry(key: string, appName: string, achievement: string): void {
  const map = readLegacyMap(key);
  const row = map[appName];
  if (!row || !(achievement in row)) return;
  delete row[achievement];
  if (Object.keys(row).length > 0) map[appName] = row;
  else delete map[appName];
  writeLegacyMap(key, map);
}

function findNote(appName: string, achievement: string): Note | undefined {
  return cachedNotes().find(
    (note) => note.scope === appName && note.achievement === achievement,
  );
}

function achievementTitle(appName: string, achievement: string): string {
  const item = S.loadedAchievements
    .get(appName)
    ?.achievements.find((entry) => entry.name === achievement);
  return item?.display_name || item?.name || achievement;
}

export function achievementNote(appName: string, achievement: string): string {
  return findNote(appName, achievement)?.body ?? "";
}

export function achievementGuide(appName: string, achievement: string): string {
  return findNote(appName, achievement)?.guideUrl ?? "";
}

/**
 * One tagged note per achievement holds both fields. A change to either side
 * keeps the other one, so the note editor and the guide field cannot erase each
 * other.
 */
async function upsertNote(
  appName: string,
  achievement: string,
  patch: { body?: string; guideUrl?: string },
): Promise<Note | null> {
  await loadNotes();
  const existing = findNote(appName, achievement);
  const body = (patch.body ?? existing?.body ?? "").slice(0, MAX_NOTE_CHARS);
  const guideUrl = (patch.guideUrl ?? existing?.guideUrl ?? "").slice(0, MAX_URL_CHARS);
  if (!body.trim() && !guideUrl.trim()) {
    if (existing) await deleteNote(existing.id);
    return null;
  }
  return saveNote({
    id: existing?.id,
    scope: appName,
    title: existing?.title.trim() ? existing.title : achievementTitle(appName, achievement),
    body,
    pinned: existing?.pinned ?? false,
    color: existing?.color ?? "",
    achievement,
    guideUrl,
  });
}

export async function saveAchievementNote(
  appName: string,
  achievement: string,
  text: string,
): Promise<boolean> {
  const note = await upsertNote(appName, achievement, { body: text });
  return Boolean(note) || !text.trim();
}

/** Saving validates the URL here as well as in the click handler. */
export async function saveAchievementGuide(
  appName: string,
  achievement: string,
  url: string,
): Promise<boolean> {
  const value = url.trim().slice(0, MAX_URL_CHARS);
  if (!value || !isSafeExternalUrl(value)) return false;
  return Boolean(await upsertNote(appName, achievement, { guideUrl: value }));
}

export async function removeAchievementGuide(
  appName: string,
  achievement: string,
): Promise<void> {
  await upsertNote(appName, achievement, { guideUrl: "" });
}

const migrating = new Set<string>();

/**
 * Folds the old per-achievement localStorage maps into tagged notes. Entries
 * are removed only after the note was written, so a failed run simply retries
 * on the next open instead of losing the text.
 */
export function ensureLegacyAchievementNotes(appName: string, onDone?: () => void): void {
  if (migrating.has(appName)) return;
  const legacyNotes = readLegacyMap(LEGACY_NOTES_KEY)[appName] ?? {};
  const legacyGuides = readLegacyMap(LEGACY_GUIDES_KEY)[appName] ?? {};
  const names = new Set([...Object.keys(legacyNotes), ...Object.keys(legacyGuides)]);
  if (names.size === 0) return;

  migrating.add(appName);
  let changed = false;
  let failed = false;
  void loadNotes()
    .then(async () => {
      for (const achievement of names) {
        const body = (legacyNotes[achievement] ?? "").slice(0, MAX_NOTE_CHARS);
        const rawGuide = (legacyGuides[achievement] ?? "").trim().slice(0, MAX_URL_CHARS);
        const guideUrl = rawGuide && isSafeExternalUrl(rawGuide) ? rawGuide : "";
        if (!body.trim() && !guideUrl) {
          dropLegacyEntry(LEGACY_NOTES_KEY, appName, achievement);
          dropLegacyEntry(LEGACY_GUIDES_KEY, appName, achievement);
          continue;
        }
        const existing = findNote(appName, achievement);
        if (existing) {
          const mergedBody = existing.body.trim() ? existing.body : body;
          const mergedGuide = existing.guideUrl.trim() ? existing.guideUrl : guideUrl;
          if (mergedBody !== existing.body || mergedGuide !== existing.guideUrl) {
            const saved = await saveNote({
              id: existing.id,
              scope: existing.scope,
              title: existing.title,
              body: mergedBody,
              pinned: existing.pinned,
              color: existing.color,
              achievement: existing.achievement || achievement,
              guideUrl: mergedGuide,
            });
            if (!saved) {
              failed = true;
              break;
            }
          }
        } else {
          const saved = await saveNote({
            scope: appName,
            title: achievementTitle(appName, achievement),
            body,
            achievement,
            guideUrl,
          });
          if (!saved) {
            failed = true;
            break;
          }
        }
        dropLegacyEntry(LEGACY_NOTES_KEY, appName, achievement);
        dropLegacyEntry(LEGACY_GUIDES_KEY, appName, achievement);
        changed = true;
      }
    })
    .finally(() => {
      migrating.delete(appName);
      if (changed && !failed) onDone?.();
    });
}
