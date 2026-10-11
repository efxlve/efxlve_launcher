/**
 * Spotify / Discord page visibility.
 *
 * Both the launcher sidebar and the in-game overlay read these flags, so
 * turning a page off hides it everywhere. Discord Rich Presence is a separate
 * feature and is not affected.
 */

import { OVERLAY_DISABLED_KEY, SHOW_DISCORD_KEY, SHOW_MINI_PLAYER_KEY, SHOW_SPOTIFY_KEY } from "./constants";

export function spotifyPageVisible(): boolean {
  return localStorage.getItem(SHOW_SPOTIFY_KEY) !== "false";
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
}
