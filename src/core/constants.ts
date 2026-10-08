/**
 * Static constants and localStorage keys.
 *
 * `isTauri` decides whether the UI talks to the Rust backend or runs in a plain
 * browser (where most features are disabled).
 */

import type { EpicSort } from "./types";

/** True when running inside the Tauri shell. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ------------------------------------------------------------------ */
/* localStorage keys and state hydration helpers.                      */
/* ------------------------------------------------------------------ */

/**
 * Internal sentinel stored in `EpicSummary.description` when the store item has
 * no description. It is never rendered raw (UI guards against it) and is kept
 * language-neutral in code so cache identity checks stay stable.
 */
export const NO_DESC = "__no_description__";

/** Selected UI language. */
export const LANG_KEY = "efxlve-lang";
/** Demo platinum trophy set. */
export const DEMO_PLAT_KEY = "efxlve-demo-platinum";
/** Global screenshot hotkey (virtual key code). */
export const SS_HOTKEY_KEY = "efxlve-ss-hotkey";
/** Global screenshot hotkey display name. */
export const SS_HOTKEY_NAME_KEY = "efxlve-ss-hotkey-name";
/** Screenshot compression toggle. */
export const SS_COMPRESS_KEY = "efxlve-ss-compression";
/** Screenshot compression format (avif/webp/jpeg). */
export const SS_FORMAT_KEY = "efxlve-ss-format";
/** Screenshot compression quality. */
export const SS_QUALITY_KEY = "efxlve-ss-quality";
/** Show download speed in bits per second instead of bytes. */
export const SPEED_BITS_KEY = "efxlve-speed-bits";
/** Pause active downloads while a game is running. */
export const PAUSE_ON_PLAY_KEY = "efxlve-pause-on-play";
/** Hide the Steam window on launch and quit Steam when the game closes. Default off. */
export const STEAM_EXIT_AFTER_PLAY_KEY = "efxlve-steam-exit-after-play";

/** Settings > Controller: PlayStation pads are mapped to a virtual Xbox pad. */
export const CONTROLLER_BRIDGE_KEY = "efxlve-controller-bridge";

/** Store ids the user hid from the Stores bar (JSON array). */
export const HIDDEN_STORES_KEY = "efxlve-hidden-stores";

/** Settings > System: send the launcher to the taskbar when a game starts. */
export const MINIMIZE_ON_GAME_KEY = "efxlve-minimize-on-game";

/** Set once, so the "start with Windows" default never overrides a choice. */
export const AUTOSTART_INIT_KEY = "efxlve-autostart-init";
/** Persisted in-app notification history. */
export const NOTIF_KEY = "efxlve-notifications";
/** User declined the optional EOS overlay install notice. */
export const EOS_OVERLAY_DECLINE_KEY = "efxlve-eos-overlay-declined";
/** Hide to the system tray on close instead of quitting. */
export const MINIMIZE_TRAY_KEY = "efxlve-minimize-to-tray";
/** Playtime and achievement chips painted on library covers. On unless set to "false". */
export const COVER_STATS_KEY = "efxlve-cover-stats";
/** Show the game title under each cover tile in the library grid. */
export const COVER_TITLES_KEY = "efxlve-cover-titles";
/** Show a store source badge when viewing all stores. */
export const STORE_BADGE_KEY = "efxlve-store-badge";
/** Show the storefront mark on every grid cover. Off by default. */
export const STORE_ICONS_KEY = "efxlve-store-icons";
/** Show every store copy of a multi-store game as its own card. Off = one combined card. */
export const SEPARATE_COPIES_KEY = "efxlve-separate-copies";
/** In-game overlay: Shift+Tab hotkey enabled, managed by the overlay settings tab. */
export const OVERLAY_ENABLED_KEY = "efxlve-overlay-enabled";
/** In-game overlay: always-on mini HUD, managed by the overlay settings tab. */
export const OVERLAY_HUD_KEY = "efxlve-overlay-hud";
/** Library storefronts that stay visible. Missing means every store. */
export const SOURCE_FILTER_KEY = "efxlve-source-filter-v2";
/** Canonical game title → library key of the store version the player picked. */
export const PREFERRED_VERSION_KEY = "efxlve-preferred-version";
/** Enter TV Mode automatically when a controller connects. Missing = Steam Deck only. */
export const TV_AUTO_KEY = "efxlve-tv-auto";

/** Native Steam Deck LCD/OLED panel, or a WebView2 UA that names the device. */
export function isSteamDeckDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("steamdeck") || ua.includes("steam deck") || ua.includes("neptune")) return true;
  const a = Math.min(window.screen.width, window.screen.height);
  const b = Math.max(window.screen.width, window.screen.height);
  return a === 800 && b === 1280;
}
/** Show a quick Play button next to the title for installed games on covers. */
export const INSTALLED_ICON_KEY = "efxlve-installed-icon";
/** Highlight installed games by subtly dimming uninstalled covers and titles. Default ON. */
export const HIGHLIGHT_INSTALLED_KEY = "efxlve-highlight-installed";
/** Show games owned by other saved accounts in the library. Default ON. */
export const SHOW_SHARED_LIBRARY_KEY = "efxlve-show-shared-library";
/** Dim covers and list rows for uninstalled games to make installed titles stand out. */
export const DIM_UNINSTALLED_KEY = "efxlve-dim-uninstalled";
/** Highlight installed game titles in bright white and uninstalled in darker tone. */
export const CONTRAST_TITLES_KEY = "efxlve-contrast-titles";
/** Optional page-by-page library browsing instead of progressive chunking. */
export const LIB_PAGINATION_KEY = "efxlve-lib-pagination";
/** Games rendered per library page when pagination is on. */
export const LIB_PAGE_SIZE_KEY = "efxlve-lib-page-size";
/** Allowed library page sizes (games per page). */
export const LIB_PAGE_SIZES = [24, 48, 96] as const;
/** Coerce a stored page size onto LIB_PAGE_SIZES (defaults to the smallest). */
export function normalizeLibraryPageSize(raw: string | number | null | undefined): number {
  const size = typeof raw === "number" ? raw : Number(raw);
  return (LIB_PAGE_SIZES as readonly number[]).includes(size) ? size : LIB_PAGE_SIZES[0];
}
/** Shell surface: "soft" (default) or "black" (#0a0a0a). */
export const SURFACE_KEY = "efxlve-surface";
/** Persisted left-sidebar width in CSS pixels. */
export const SIDEBAR_W_KEY = "efxlve-sidebar-w";
/** Last expanded sidebar width, restored when the drawer opens. */
export const SIDEBAR_EXPANDED_W_KEY = "efxlve-sidebar-expanded-w";
/** How many profile trophy cards render before "show more". */
export const PROFILE_CARD_CHUNK = 36;
/** Automatically back up local saves when a game closes. */
export const AUTO_BACKUP_KEY = "efxlve-auto-backup";
/** Scheduled automatic update: enabled flag and HH:MM time. */
export const AUTO_UPDATE_KEY = "efxlve-auto-update";
export const AUTO_UPDATE_TIME_KEY = "efxlve-auto-update-time";
/** Launcher self-update: automatically download new releases in the background. */
export const APP_AUTO_UPDATE_KEY = "efxlve-app-auto-update";
/** Automatically create a desktop shortcut when a game installation completes. */
export const AUTO_SHORTCUT_KEY = "efxlve-auto-shortcut";
/** Custom portrait cover URLs keyed by app name. */
export const CUSTOM_COVERS_KEY = "efxlve-custom-covers";
/** Custom hero/landscape URLs keyed by app name. */
export const CUSTOM_HEROES_KEY = "efxlve-custom-heroes";
/** Custom profile avatars keyed by Epic account ID. */
export const CUSTOM_AVATARS_KEY = "efxlve-custom-avatars";
/** Custom user profile display name. */
export const CUSTOM_PROFILE_NAME_KEY = "efxlve-custom-profile-name";
/** Custom profile background banner games keyed by scope or account ID. */
export const CUSTOM_PROFILE_BANNERS_KEY = "efxlve-custom-profile-banners";
/** Profile achievements view mode (grid or list). */
export const PROFILE_VIEW_MODE_KEY = "efxlve-profile-view-mode";
/** Favorited game ids. */
export const FAV_KEY = "efxlve-favorites";
/** App names hidden from the library, sidebar and search. */
export const HIDDEN_KEY = "efxlve-hidden-games";
/** Games whose pending update indicators/badges have been cleared/dismissed by the user. */
export const IGNORED_UPDATES_KEY = "efxlve-ignored-updates";
/** Achievement sandbox ids hidden from the profile list. Separate from hidden games. */
export const HIDDEN_ACH_KEY = "efxlve-hidden-achievements";
/** Recently launched game ids. */
export const RECENT_KEY = "efxlve-recent";
/** Recently installed and updated game ids. */
export const RECENT_INSTALLS_KEY = "efxlve-recent-installs";
/** Initial number of library cards rendered before progressive chunking kicks in. */
export const INITIAL_CARD_CHUNK = 48;
/** Number of extra library cards appended per scroll sentinel hit. */
export const MORE_CARD_CHUNK = 36;

/** Real folder sizes measured off the filesystem, keyed by library key. */
export const FOLDER_SIZES_KEY = "efxlve-folder-sizes";

/** Per-tab library sort order; each tab remembers its own. */
export const SORT_TABS_KEY = "efxlve-sort-tabs";

/** Library tabs that keep a sort order of their own. */
export type SortTab = "all" | "installed" | "fav" | "platinum" | "updates" | "collections";

export const SORT_TAB_KEYS: readonly SortTab[] = ["all", "installed", "fav", "platinum", "updates", "collections"];

/**
 * Read the per-tab sort map. `fallback` is the retired single sort value: it
 * seeds every tab so an upgrade keeps the order the user already had.
 */
export function loadTabSorts(fallback: EpicSort): Record<SortTab, EpicSort> {
  const out = {} as Record<SortTab, EpicSort>;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(localStorage.getItem(SORT_TABS_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    // A corrupt map falls back to the defaults below.
  }
  for (const tab of SORT_TAB_KEYS) {
    const value = raw[tab];
    out[tab] = typeof value === "string" && value ? (value as EpicSort) : fallback;
  }
  return out;
}

/** Persist one tab's sort order. */
export function saveTabSort(tab: SortTab, sort: EpicSort): void {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_TABS_KEY) ?? "{}") as Record<string, unknown>;
    raw[tab] = sort;
    localStorage.setItem(SORT_TABS_KEY, JSON.stringify(raw));
  } catch {
    // Storage is best-effort; the session value still applies.
  }
}

/** Read a string set from localStorage. */
export function loadStrSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Read measured folder sizes (library key -> bytes + timestamp). */
export function loadFolderSizes(): Map<string, { bytes: number; at: number }> {
  const out = new Map<string, { bytes: number; at: number }>();
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDER_SIZES_KEY) ?? "{}") as Record<string, unknown>;
    for (const [key, pair] of Object.entries(raw)) {
      if (Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
        out.set(key, { bytes: pair[0] as number, at: pair[1] as number });
      }
    }
  } catch {
    // A corrupt entry just re-measures on the next view.
  }
  return out;
}
