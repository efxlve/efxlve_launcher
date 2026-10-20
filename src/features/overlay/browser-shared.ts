/**
 * Storage helpers shared by the overlay panel and the in-game browser chrome.
 *
 * This module deliberately has no side effects. The overlay only needs the
 * bookmark list and homepage; importing `browser-window.ts` used to boot the
 * whole browser chrome inside the panel as well, including its IPC calls and
 * bounds sync. Keep the helpers here so that mistake cannot come back.
 */

import type { IconName } from "../../core/icons";

export interface QuickBookmark {
  label: string;
  iconName: IconName;
  url: string;
}

export const BOOKMARKS_STORAGE_KEY = "efxlve-browser-bookmarks";
export const HOMEPAGE_STORAGE_KEY = "efxlve-browser-homepage";

export const DEFAULT_BOOKMARKS: QuickBookmark[] = [
  { label: "Google", iconName: "search", url: "https://www.google.com" },
  { label: "YouTube", iconName: "youtube", url: "https://www.youtube.com" },
  { label: "Twitter", iconName: "twitter", url: "https://x.com" },
  { label: "Reddit", iconName: "users", url: "https://www.reddit.com/r/gaming" },
  { label: "Twitch", iconName: "monitor", url: "https://www.twitch.tv" },
  { label: "Steam Guides", iconName: "gamepad-2", url: "https://steamcommunity.com" },
];

export function loadBookmarks(): QuickBookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return DEFAULT_BOOKMARKS;
    const parsed = JSON.parse(raw) as QuickBookmark[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_BOOKMARKS;
  } catch {
    return DEFAULT_BOOKMARKS;
  }
}

export function getHomepage(): string {
  return localStorage.getItem(HOMEPAGE_STORAGE_KEY) || "https://www.google.com/";
}
