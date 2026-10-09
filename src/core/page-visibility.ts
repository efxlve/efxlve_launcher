/**
 * Spotify / Discord page visibility.
 *
 * Both the launcher sidebar and the in-game overlay read these flags, so
 * turning a page off hides it everywhere. Discord Rich Presence is a separate
 * feature and is not affected.
 */

import { SHOW_DISCORD_KEY, SHOW_SPOTIFY_KEY } from "./constants";

export function spotifyPageVisible(): boolean {
  return localStorage.getItem(SHOW_SPOTIFY_KEY) !== "false";
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
