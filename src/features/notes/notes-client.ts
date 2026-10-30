/**
 * Notes client: one cache over the Rust `notes.json`, shared by the launcher,
 * the game drawer and the overlay.
 *
 * Every surface reads the list through here; writes go through the same
 * commands, and the Rust side emits `notes-changed` so the other windows (the
 * overlay is one) reload their view.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Scope of the notes that belong to no game. */
export const LAUNCHER_SCOPE = "launcher";

/** The overlay's old notes lived under this prefix, one note per scope. */
const LEGACY_PREFIX = "efxlve-overlay-notes::";
const MIGRATION_KEY = "efxlve-notes-migrated";
/** Shared with the overlay widget: the editor's text size. */
const FONT_KEY = "efxlve-notes-font";

export type NotesFontSize = "s" | "m" | "l";

export function notesFontSize(): NotesFontSize {
  const value = localStorage.getItem(FONT_KEY);
  return value === "s" || value === "l" ? value : "m";
}

export function setNotesFontSize(size: NotesFontSize): void {
  localStorage.setItem(FONT_KEY, size);
}

export interface Note {
  id: string;
  /** Game key (`steam::123`, `gog::…`, an Epic app name) or `"launcher"`. */
  scope: string;
  title: string;
  body: string;
  pinned: boolean;
  /** Accent name; empty means the neutral color. */
  color: string;
  /** Stable achievement key when the note belongs to one achievement. */
  achievement: string;
  /** Optional guide link attached to the achievement note. Kept for notes
   * written before multiple links; `noteGuideUrls` merges it into the list. */
  guideUrl: string;
  /** Additional guide, video or article links. */
  guideUrls: string[];
  /** Inline images pasted into the body, as data URLs. */
  images?: string[];
  /** Unix milliseconds. */
  created: number;
  updated: number;
}

export interface NoteInput {
  id?: string;
  scope: string;
  title: string;
  body: string;
  pinned?: boolean;
  color?: string;
  achievement?: string;
  guideUrl?: string;
  guideUrls?: string[];
  images?: string[];
}

/** Old notes kept a single guide link in `guideUrl`; surface both as one list. */
export function noteGuideUrls(note: Note): string[] {
  const values = [...(note.guideUrls ?? [])];
  const legacy = note.guideUrl?.trim();
  if (legacy) values.unshift(legacy);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const url = value.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

let cache: Note[] | null = null;
let loading: Promise<Note[]> | null = null;

type NoteDeleteHandler = (note: Note) => void;
const deleteHandlers = new Set<NoteDeleteHandler>();

/** Lets the achievement rail cancel a pending debounced save when its note is
 * deleted from any other notes surface. */
export function onNoteDeleted(handler: NoteDeleteHandler): void {
  deleteHandlers.add(handler);
}

/** Pinned first, then most recently changed. */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated,
  );
}

export async function loadNotes(force = false): Promise<Note[]> {
  if (!force && cache) return cache;
  if (!force && loading) return loading;
  loading = invoke<{ notes: Note[] }>("notes_list")
    .then((file) => {
      cache = Array.isArray(file?.notes) ? file.notes : [];
      return cache;
    })
    .catch(() => {
      cache = cache ?? [];
      return cache;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The last loaded list; empty before the first load. */
export function cachedNotes(): Note[] {
  return cache ?? [];
}

export function notesForScope(scope: string): Note[] {
  return sortNotes(cachedNotes().filter((note) => note.scope === scope));
}

/** Writes a pasted data URL under the app data note-images folder. */
export async function storeNoteImage(dataUrl: string): Promise<string> {
  return invoke<string>("notes_store_image", { dataUrl });
}

export async function saveNote(input: NoteInput): Promise<Note | null> {
  try {
    const note = await invoke<Note>("notes_save", {
      id: input.id ?? null,
      scope: input.scope,
      title: input.title,
      body: input.body,
      pinned: input.pinned ?? false,
      color: input.color ?? "",
      achievement: input.achievement ?? "",
      guideUrl: input.guideUrl ?? "",
      guideUrls: input.guideUrls ?? [],
      images: input.images ?? [],
    });
    if (note) {
      cache = [...(cache ?? []).filter((item) => item.id !== note.id), note];
    }
    return note ?? null;
  } catch {
    return null;
  }
}

export async function deleteNote(id: string): Promise<boolean> {
  const note = (cache ?? []).find((item) => item.id === id);
  try {
    const removed = await invoke<boolean>("notes_delete", { id });
    if (removed) {
      cache = (cache ?? []).filter((item) => item.id !== id);
      if (note) {
        for (const handler of deleteHandlers) handler(note);
      }
    }
    return removed;
  } catch {
    return false;
  }
}

/** Writes an export next to the downloads and returns the file path. */
export async function exportNotes(format: "json" | "markdown"): Promise<string | null> {
  try {
    return await invoke<string>("notes_export", { format });
  } catch {
    return null;
  }
}

/** Merges a pasted export back in; returns how many notes were written. */
export async function importNotesText(json: string): Promise<number | null> {
  try {
    const count = await invoke<number>("notes_import_text", { json });
    await loadNotes(true);
    return count;
  } catch {
    return null;
  }
}

/** The overlay's localStorage notes move into the file once; the old keys stay
 * as they are, so nothing is lost if an older build runs again. */
async function migrateLegacyNotes(): Promise<void> {
  if (localStorage.getItem(MIGRATION_KEY) === "1") return;
  const legacy: NoteInput[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
    const body = localStorage.getItem(key) ?? "";
    if (!body.trim()) continue;
    legacy.push({ scope: key.slice(LEGACY_PREFIX.length), title: "", body });
  }
  try {
    await invoke<number>("notes_import", { notes: legacy });
    localStorage.setItem(MIGRATION_KEY, "1");
    cache = null;
  } catch {
    // Older hosts have no notes commands; the overlay's own keys stay.
  }
}

/** Runs the legacy import once per install, in every window that boots. */
export async function ensureNotesMigration(): Promise<void> {
  await migrateLegacyNotes();
}

/** Reloads the cache when another window wrote to the file. */
export function onNotesChanged(handler: () => void): void {
  void listen("notes-changed", () => {
    void loadNotes(true).then(() => handler());
  }).catch(() => undefined);
}
