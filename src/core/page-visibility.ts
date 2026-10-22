/**
 * Spotify / Discord page visibility.
 *
 * Both the launcher sidebar and the in-game overlay read these flags, so
 * turning a page off hides it everywhere. Discord Rich Presence is a separate
 * feature and is not affected.
 */

import { OVERLAY_DISABLED_KEY, OVERLAY_ENABLED_KEY, OVERLAY_HOTKEY_KEY, SHOW_DISCORD_KEY, SHOW_MINI_PLAYER_KEY, SHOW_NOTES_SIDEBAR_KEY, SHOW_SCREENSHOTS_SIDEBAR_KEY, SHOW_SPOTIFY_KEY } from "./constants";

export function spotifyPageVisible(): boolean {
  return localStorage.getItem(SHOW_SPOTIFY_KEY) !== "false";
}

/** The in-game overlay is on unless the user switched it off. */
export function overlayEnabled(): boolean {
  return localStorage.getItem(OVERLAY_ENABLED_KEY) !== "false";
}

/**
 * Overlay hotkey, as a lowercase spec joined with `+` ("shift+tab",
 * "ctrl+shift+k"). The backend parses the same vocabulary.
 */
const HOTKEY_MODIFIERS = ["ctrl", "alt", "shift"] as const;

const HOTKEY_KEYS = new Set([
  "tab", "enter", "space", "backspace", "insert", "delete", "home", "end",
  "pageup", "pagedown", "left", "up", "right", "down",
  "-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`",
]);

export const DEFAULT_OVERLAY_HOTKEY = "shift+tab";

/** True for a spec the backend also accepts: a modifier plus one key. */
export function isValidHotkey(spec: string): boolean {
  const parts = spec.toLowerCase().split("+").filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!modifiers.length || modifiers.some((mod) => !(HOTKEY_MODIFIERS as readonly string[]).includes(mod))) return false;
  return HOTKEY_KEYS.has(key) || /^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-9]|2[0-4])$/.test(key);
}

export function overlayHotkey(): string {
  const stored = (localStorage.getItem(OVERLAY_HOTKEY_KEY) ?? "").trim().toLowerCase();
  return isValidHotkey(stored) ? stored : DEFAULT_OVERLAY_HOTKEY;
}

/** "Ctrl + Shift + K", for every hint that names the key. */
export function hotkeyLabel(spec: string): string {
  return spec
    .split("+")
    .filter(Boolean)
    .map((part) => {
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "pageup") return "Page Up";
      if (part === "pagedown") return "Page Down";
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" + ");
}

export function overlayHotkeyLabel(): string {
  return hotkeyLabel(overlayHotkey());
}

/**
 * Games kept in the overlay's own blocklist ("Disable for this game").
 *
 * The overlay edits this list, so a launcher-side copy is the way back when a
 * block left someone without the panel to undo it from.
 */
export function overlayBlockedGames(): { key: string; title: string }[] {
  try {
    const raw = localStorage.getItem(OVERLAY_DISABLED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => typeof item.key === "string")
      .map((item) => ({
        key: String(item.key),
        title: typeof item.title === "string" && item.title ? item.title : String(item.key),
      }));
  } catch {
    return [];
  }
}

/** The sidebar mini player can be turned off entirely; shown by default. */
export function miniPlayerVisible(): boolean {
  return localStorage.getItem(SHOW_MINI_PLAYER_KEY) !== "false";
}

export function discordPageVisible(): boolean {
  return localStorage.getItem(SHOW_DISCORD_KEY) !== "false";
}

/** The Notes sidebar entry: off unless the user asked for it. The page itself
 * stays reachable from Settings > Notes either way. */
export function notesSidebarVisible(): boolean {
  return localStorage.getItem(SHOW_NOTES_SIDEBAR_KEY) === "true";
}

/** The Screenshots sidebar entry: opt-in, like Notes. */
export function screenshotsSidebarVisible(): boolean {
  return localStorage.getItem(SHOW_SCREENSHOTS_SIDEBAR_KEY) === "true";
}

/** Shows/hides the sidebar entries (and their shared divider). */
export function applySidebarPageVisibility(): void {
  const spotify = spotifyPageVisible();
  const discord = discordPageVisible();
  document
    .querySelector<HTMLElement>('#sidebar .sb-item[data-view="music"]')
    ?.classList.toggle("is-hidden", !spotify);
  document
    .querySelector<HTMLElement>('#sidebar .sb-item[data-app="discord"]')
    ?.classList.toggle("is-hidden", !discord);
  document
    .querySelector<HTMLElement>("#sidebar .sb-divider")
    ?.classList.toggle("is-hidden", !spotify && !discord);
  document
    .querySelector<HTMLElement>('#sidebar .sb-item[data-view="notes"]')
    ?.classList.toggle("is-hidden", !notesSidebarVisible());
  document
    .querySelector<HTMLElement>('#sidebar .sb-item[data-view="screenshots"]')
    ?.classList.toggle("is-hidden", !screenshotsSidebarVisible());
}
