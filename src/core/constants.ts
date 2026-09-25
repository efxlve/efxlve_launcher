/**
 * Static constants and localStorage keys.
 *
 * `isTauri` decides whether the UI talks to the Rust backend or runs in a plain
 * browser (where most features are disabled).
 */

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
/** Persisted in-app notification history. */
export const NOTIF_KEY = "efxlve-notifications";
/** Hide to the system tray on close instead of quitting. */
export const MINIMIZE_TRAY_KEY = "efxlve-minimize-to-tray";
/** Show optional back/forward navigation buttons in the top bar. */
/** Playtime and achievement chips painted on library covers. On unless set to "false". */
export const COVER_STATS_KEY = "efxlve-cover-stats";
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
/** Favorited game ids. */
export const FAV_KEY = "efxlve-favorites";
/** App names hidden from the library, sidebar and search. */
export const HIDDEN_KEY = "efxlve-hidden-games";
/** Recently launched game ids. */
export const RECENT_KEY = "efxlve-recent";
/** Recently installed and updated game ids. */
export const RECENT_INSTALLS_KEY = "efxlve-recent-installs";
/** Initial number of library cards rendered before progressive chunking kicks in. */
export const INITIAL_CARD_CHUNK = 48;
/** Number of extra library cards appended per scroll sentinel hit. */
export const MORE_CARD_CHUNK = 36;

/** Read a string set from localStorage. */
export function loadStrSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
