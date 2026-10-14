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
  SS_CLEANUP_KEY,
  SS_DENSITY_KEY,
  SS_FAVORITES_KEY,
  SS_NOTIFY_KEY,
  SS_SORT_KEY,
  SS_SOUND_KEY,
} from "../../core/constants";

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
