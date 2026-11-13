/**
 * The page ring behind LT/RT in Full Screen Mode.
 *
 * Stage has its own route stack; the classic shell keeps the desktop pages, so
 * the triggers only need a deterministic order across the five pages the couch
 * top bar offers.
 */

export type CouchPage = "library" | "downloads" | "store" | "profile" | "settings";

export const COUCH_PAGES: readonly CouchPage[] = [
  "store",
  "library",
  "downloads",
  "profile",
  "settings",
];

/** Next page in the ring. Unknown views (notes, media, Spotify, Discord) start at an edge. */
export function stepCouchPage(current: string, direction: -1 | 1): CouchPage {
  const index = COUCH_PAGES.indexOf(current as CouchPage);
  if (index < 0) return direction > 0 ? COUCH_PAGES[0] : COUCH_PAGES[COUCH_PAGES.length - 1];
  const next = (index + direction + COUCH_PAGES.length) % COUCH_PAGES.length;
  return COUCH_PAGES[next];
}
