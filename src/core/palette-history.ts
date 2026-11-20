/** Recent game selections from the command palette, newest first. */

import { PALETTE_HISTORY_KEY } from "./constants";

export interface PaletteHistoryEntry {
  id: string;
  title: string;
  installed: boolean;
}

/** The palette shows at most this many recent games above the live results. */
export const PALETTE_HISTORY_MAX = 5;

export function readPaletteHistory(): PaletteHistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PALETTE_HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PaletteHistoryEntry[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id) continue;
      if (typeof item.title !== "string" || !item.title) continue;
      out.push({ id: item.id, title: item.title, installed: item.installed === true });
      if (out.length >= PALETTE_HISTORY_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Moves a game to the top of the history and caps the list. */
export function rememberPaletteSearch(id: string, title: string, installed: boolean): void {
  if (!id || !title) return;
  const list = readPaletteHistory().filter((item) => item.id !== id);
  list.unshift({ id, title, installed });
  try {
    localStorage.setItem(PALETTE_HISTORY_KEY, JSON.stringify(list.slice(0, PALETTE_HISTORY_MAX)));
  } catch {
    /* private mode: the history still works for this session */
  }
}
