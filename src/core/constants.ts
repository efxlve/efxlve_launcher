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
export const NO_DESC = "Açıklama yok.";

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
/** Custom portrait cover URLs keyed by app name. */
export const CUSTOM_COVERS_KEY = "efxlve-custom-covers";
/** Custom hero/landscape URLs keyed by app name. */
export const CUSTOM_HEROES_KEY = "efxlve-custom-heroes";
/** Favorited game ids. */
export const FAV_KEY = "efxlve-favorites";
/** Recently launched game ids. */
export const RECENT_KEY = "efxlve-recent";
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
