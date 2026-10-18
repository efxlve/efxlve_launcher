/**
 * Screenshot preferences shared by the settings page, the game page's gallery
 * and the overlay: capture feedback, gallery defaults, favorites and the
 * auto-cleanup policy.
 *
 * Favorites and the policy live in localStorage; the per-game capture list is
 * owned by Rust (the F12 listener reads it), so it round-trips through
 * `epic_set_screenshot_disabled_games`.
 */

import {
  CLIP_ENABLED_KEY,
  CLIP_FPS_KEY,
  CLIP_HEIGHT_KEY,
  CLIP_HOTKEY_KEY,
  CLIP_HOTKEY_NAME_KEY,
  CLIP_MAX_MIN_KEY,
  SS_CLEANUP_KEY,
  SS_DENSITY_KEY,
  SS_FAVORITES_KEY,
  SS_NOTIFY_KEY,
  SS_SORT_KEY,
  SS_SOUND_KEY,
  SS_WEBHOOK_KEY,
  SS_WEBHOOKS_KEY,
  isTauri,
} from "../../core/constants";
import { clipSetHotkey, clipSetOptions } from "../../epic";

export type ShotSort = "newest" | "oldest" | "name" | "size";
export type ShotDensity = "s" | "m" | "l";
export interface CleanupPolicy {
  mode: "off" | "size" | "age";
  /** Cap in GB when mode = "size". */
  sizeGb: number;
  /** Age in days when mode = "age". */
  days: number;
}

export function ssSoundOn(): boolean {
  return localStorage.getItem(SS_SOUND_KEY) !== "false";
}

export function ssNotifyOn(): boolean {
  return localStorage.getItem(SS_NOTIFY_KEY) !== "false";
}

export function ssSort(): ShotSort {
  const value = localStorage.getItem(SS_SORT_KEY);
  return value === "oldest" || value === "name" || value === "size" ? value : "newest";
}

export function ssDensity(): ShotDensity {
  const value = localStorage.getItem(SS_DENSITY_KEY);
  return value === "s" || value === "l" ? value : "m";
}

export function ssFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(SS_FAVORITES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // fall through
  }
  return new Set();
}

/** Flips one path; returns the new state. */
export function ssToggleFavorite(filePath: string): boolean {
  const favorites = ssFavorites();
  const nowFavorite = !favorites.has(filePath);
  if (nowFavorite) favorites.add(filePath);
  else favorites.delete(filePath);
  localStorage.setItem(SS_FAVORITES_KEY, JSON.stringify([...favorites]));
  return nowFavorite;
}

export function ssClearFavorites(): void {
  localStorage.setItem(SS_FAVORITES_KEY, JSON.stringify([]));
}

export function ssCleanupPolicy(): CleanupPolicy {
  try {
    const raw = localStorage.getItem(SS_CLEANUP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CleanupPolicy>;
      const mode = parsed.mode === "size" || parsed.mode === "age" ? parsed.mode : "off";
      return {
        mode,
        sizeGb: typeof parsed.sizeGb === "number" && parsed.sizeGb > 0 ? parsed.sizeGb : 20,
        days: typeof parsed.days === "number" && parsed.days > 0 ? parsed.days : 90,
      };
    }
  } catch {
    // fall through
  }
  return { mode: "off", sizeGb: 20, days: 90 };
}

export function ssSetCleanupPolicy(policy: CleanupPolicy): void {
  localStorage.setItem(SS_CLEANUP_KEY, JSON.stringify(policy));
}

/* ---------- Game clips (the MJPEG recorder) ---------- */

export function clipEnabled(): boolean {
  return localStorage.getItem(CLIP_ENABLED_KEY) === "true";
}

export function clipHotkeyCode(): number {
  const stored = Number(localStorage.getItem(CLIP_HOTKEY_KEY) ?? "0");
  return Number.isFinite(stored) && stored > 0 ? stored : 0x78; // F9
}

/** The hotkey's own name ("F9"), for hints in the launcher and the overlay. */
export function clipHotkeyName(): string {
  return localStorage.getItem(CLIP_HOTKEY_NAME_KEY) || "F9";
}

/** The rates the MJPEG/GDI recorder can actually hold. 60 and 120 need the GPU
 *  path (see TODO.md §8), so their buttons stay disabled until then. */
export const CLIP_FPS_SUPPORTED = [15, 30];

export function clipFps(): number {
  const stored = Number(localStorage.getItem(CLIP_FPS_KEY) ?? "30");
  return CLIP_FPS_SUPPORTED.includes(stored) ? stored : 30;
}

/** Frame height for clips: 0 keeps the screen's own size. */
export function clipHeight(): number {
  const stored = Number(localStorage.getItem(CLIP_HEIGHT_KEY) ?? "0");
  return [0, 720, 1080, 1440].includes(stored) ? stored : 0;
}

export function clipMaxSecs(): number {
  const minutes = Number(localStorage.getItem(CLIP_MAX_MIN_KEY) ?? "5");
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return Math.round(Math.min(60, safe) * 60);
}

/** Hands the stored recorder settings to Rust: the recorder reads them there. */
export function pushClipSettings(): void {
  if (!isTauri) return;
  // Normalise first: a rate stored before 60/120 were disabled would otherwise
  // sit in localStorage for ever, since nothing can select it back.
  localStorage.setItem(CLIP_FPS_KEY, String(clipFps()));
  void clipSetHotkey(clipHotkeyCode()).catch(() => undefined);
  void clipSetOptions({ fps: clipFps(), maxSecs: clipMaxSecs(), height: clipHeight() }).catch(() => undefined);
}

/* ---------- Discord webhooks (one or many) ---------- */

export interface DiscordWebhook {
  id: string;
  /** The webhook's own name from Discord (fallback: "Discord"). */
  name: string;
  url: string;
}

/** The stored list, migrating the single-webhook key from earlier releases. */
export function ssWebhooks(): DiscordWebhook[] {
  try {
    const raw = localStorage.getItem(SS_WEBHOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .filter((item) => typeof item.url === "string" && item.url)
          .map((item) => ({
            id: typeof item.id === "string" && item.id ? item.id : String(item.url),
            name: typeof item.name === "string" && item.name ? item.name : "Discord",
            url: String(item.url),
          }));
      }
    }
  } catch {
    // fall through
  }
  // Migration: the one webhook the settings row used to hold.
  const legacy = (localStorage.getItem(SS_WEBHOOK_KEY) ?? "").trim();
  if (legacy) {
    const migrated: DiscordWebhook[] = [{ id: "legacy", name: "Discord", url: legacy }];
    localStorage.setItem(SS_WEBHOOKS_KEY, JSON.stringify(migrated));
    return migrated;
  }
  return [];
}

export function ssAddWebhook(name: string, url: string): DiscordWebhook[] {
  const list = ssWebhooks();
  const entry: DiscordWebhook = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "Discord",
    url: url.trim(),
  };
  const next = [...list, entry];
  localStorage.setItem(SS_WEBHOOKS_KEY, JSON.stringify(next));
  return next;
}

export function ssRemoveWebhook(id: string): DiscordWebhook[] {
  const next = ssWebhooks().filter((hook) => hook.id !== id);
  localStorage.setItem(SS_WEBHOOKS_KEY, JSON.stringify(next));
  return next;
}

/** Sorts a gallery by the user's default order. */
export function ssSortItems<T>(
  items: T[],
  tsOf: (item: T) => number,
  nameOf: (item: T) => string,
  sizeOf: (item: T) => number,
): T[] {
  const order = ssSort();
  const sorted = [...items];
  switch (order) {
    case "oldest":
      sorted.sort((a, b) => tsOf(a) - tsOf(b));
      break;
    case "name":
      sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }));
      break;
    case "size":
      sorted.sort((a, b) => sizeOf(b) - sizeOf(a));
      break;
    default:
      sorted.sort((a, b) => tsOf(b) - tsOf(a));
  }
  return sorted;
}
