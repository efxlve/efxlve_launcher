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
  noteGuideUrls,
  onNoteDeleted,
  saveNote,
  type Note,
} from "../notes/notes-client";

const LEGACY_NOTES_KEY = "efxlve-ach-notes";
const LEGACY_GUIDES_KEY = "efxlve-ach-guides";
const MAX_NOTE_CHARS = 4000;
const MAX_URL_CHARS = 2048;
const MAX_LINKS = 20;

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

export function achievementGuides(appName: string, achievement: string): string[] {
  const note = findNote(appName, achievement);
  return note ? noteGuideUrls(note) : [];
}

function cleanLinks(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw.trim().slice(0, MAX_URL_CHARS);
    if (!url || !isSafeExternalUrl(url) || out.includes(url)) continue;
    out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * One tagged note per achievement holds the body and every saved link. A
 * change to either side keeps the other one, and the old single `guideUrl`
 * field is folded into the list on the next save.
 */
async function upsertNote(
  appName: string,
  achievement: string,
  patch: { body?: string; guideUrls?: string[] },
): Promise<Note | null> {
  await loadNotes();
  const existing = findNote(appName, achievement);
  const body = (patch.body ?? existing?.body ?? "").slice(0, MAX_NOTE_CHARS);
  const guideUrls = cleanLinks(
    patch.guideUrls ?? (existing ? noteGuideUrls(existing) : []),
  );
  if (!body.trim() && guideUrls.length === 0) {
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
    guideUrl: "",
    guideUrls,
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

interface PendingNoteSave {
  timer: number;
  value: string;
  onSettled?: (ok: boolean) => void;
}

const pendingNoteSaves = new Map<string, PendingNoteSave>();

function pendingKey(appName: string, achievement: string): string {
  return `${appName}\u0000${achievement}`;
}

/** Debounces a note body while keeping one pending save per achievement. */
export function queueAchievementNoteSave(
  appName: string,
  achievement: string,
  text: string,
  onSettled?: (ok: boolean) => void,
): void {
  const key = pendingKey(appName, achievement);
  const previous = pendingNoteSaves.get(key);
  if (previous) window.clearTimeout(previous.timer);
  const timer = window.setTimeout(() => {
    const pending = pendingNoteSaves.get(key);
    pendingNoteSaves.delete(key);
    const value = pending?.value ?? text;
    void saveAchievementNote(appName, achievement, value).then((ok) => {
      pending?.onSettled?.(ok);
    });
  }, 600);
  pendingNoteSaves.set(key, { timer, value: text, onSettled });
}

export function cancelAchievementNoteSave(appName: string, achievement: string): void {
  const key = pendingKey(appName, achievement);
  const pending = pendingNoteSaves.get(key);
  if (pending) window.clearTimeout(pending.timer);
  pendingNoteSaves.delete(key);
}

/** Flushes the visible textarea before a link edit rewrites the same note. */
export async function flushAchievementNoteSave(
  appName: string,
  achievement: string,
  text: string,
): Promise<boolean> {
  cancelAchievementNoteSave(appName, achievement);
  return saveAchievementNote(appName, achievement, text);
}

export async function addAchievementGuide(
  appName: string,
  achievement: string,
  url: string,
): Promise<boolean> {
  const value = url.trim().slice(0, MAX_URL_CHARS);
  if (!value || !isSafeExternalUrl(value)) return false;
  await loadNotes();
  const existing = findNote(appName, achievement);
  const current = existing ? noteGuideUrls(existing) : [];
  if (current.includes(value)) return true;
  const note = await upsertNote(appName, achievement, {
    guideUrls: [...current, value],
  });
  return Boolean(note);
}

export async function removeAchievementGuide(
  appName: string,
  achievement: string,
  url: string,
): Promise<void> {
  await loadNotes();
  const existing = findNote(appName, achievement);
  if (!existing) return;
  const current = noteGuideUrls(existing);
  const value = url.trim();
  if (!current.includes(value)) return;
  await upsertNote(appName, achievement, {
    guideUrls: current.filter((entry) => entry !== value),
  });
}

export async function deleteAchievementNote(
  appName: string,
  achievement: string,
): Promise<void> {
  cancelAchievementNoteSave(appName, achievement);
  await loadNotes();
  const note = findNote(appName, achievement);
  if (note) await deleteNote(note.id);
}

// Deleting the shared note from the Notes page, the drawer or the overlay must
// stop a debounced achievement save from recreating it a moment later.
onNoteDeleted((note) => {
  if (note.achievement) cancelAchievementNoteSave(note.scope, note.achievement);
});

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
        const legacyLinks = cleanLinks([rawGuide]);
        if (!body.trim() && legacyLinks.length === 0) {
          dropLegacyEntry(LEGACY_NOTES_KEY, appName, achievement);
          dropLegacyEntry(LEGACY_GUIDES_KEY, appName, achievement);
          continue;
        }
        const existing = findNote(appName, achievement);
        if (existing) {
          const existingLinks = noteGuideUrls(existing);
          const mergedLinks = cleanLinks([...existingLinks, ...legacyLinks]);
          const mergedBody = existing.body.trim() ? existing.body : body;
          const linksChanged =
            mergedLinks.length !== existingLinks.length ||
            mergedLinks.some((url, index) => url !== existingLinks[index]);
          if (mergedBody !== existing.body || linksChanged) {
            const saved = await saveNote({
              id: existing.id,
              scope: existing.scope,
              title: existing.title,
              body: mergedBody,
              pinned: existing.pinned,
              color: existing.color,
              achievement: existing.achievement || achievement,
              guideUrl: "",
              guideUrls: mergedLinks,
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
            guideUrl: "",
            guideUrls: legacyLinks,
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
