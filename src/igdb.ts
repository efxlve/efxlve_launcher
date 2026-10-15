/**
 * IGDB (Twitch) client wrappers.
 *
 * The credentials live in Rust — the secret is sealed with DPAPI on this
 * machine and never reaches the front end again — so these wrappers only carry
 * the settings row and the game pages' requests. Every call is cached by the
 * Rust side (and rate-limited to the API's 4 requests/second).
 */

import { invoke } from "@tauri-apps/api/core";

export interface IgdbSearchHit {
  id: number;
  name: string;
  year: number | null;
  coverId: string;
  rating: number | null;
}

export interface IgdbGame {
  id: number;
  name: string;
  summary: string;
  url: string;
  /** `yyyy-mm-dd`, empty when IGDB has no date. */
  releaseDate: string;
  releaseYear: number | null;
  /** IGDB's own 0-100 rating. */
  rating: number | null;
  genres: string[];
  themes: string[];
  modes: string[];
  developer: string;
  publisher: string;
  franchises: string[];
  coverId: string;
  screenshots: string[];
  similar: IgdbSearchHit[];
  website: string;
  /** ESRB/PEGI-style ratings. */
  ageRatings: { organization: string; rating: string }[];
}

/** One cover-picker row: portrait cover plus key art. */
export interface IgdbCoverHit {
  id: number;
  name: string;
  year: number | null;
  coverId: string;
  artworks: string[];
  screenshots: string[];
}

export interface IgdbStatus {
  configured: boolean;
  clientId: string;
  /** `direct` (own Twitch app) | `proxy` (the shared server) | `off`. */
  mode: "direct" | "proxy" | "off";
  proxyUrl: string;
}

export interface IgdbTestResult {
  mode: "direct" | "proxy";
  name: string;
}

export const igdbStatus = () => invoke<IgdbStatus>("igdb_status");

export const igdbSetCredentials = (clientId: string, clientSecret: string) =>
  invoke<void>("igdb_set_credentials", { clientId, clientSecret });

/** The shared proxy address; an empty string restores the default. */
export const igdbSetProxyUrl = (url: string) =>
  invoke<void>("igdb_set_proxy_url", { url });

export const igdbClearCredentials = () => invoke<void>("igdb_clear_credentials");

export const igdbTest = () => invoke<IgdbTestResult>("igdb_test");

export const igdbSearch = (query: string, limit?: number) =>
  invoke<IgdbSearchHit[]>("igdb_search", { query, limit: limit ?? null });

export const igdbGame = (id: number) => invoke<IgdbGame>("igdb_game", { id });

export const igdbCovers = (query: string, limit?: number) =>
  invoke<IgdbCoverHit[]>("igdb_covers", { query, limit: limit ?? null });

export const igdbEnrich = (
  title: string,
  year?: number | null,
  external?: { category: number; uid: string } | null,
) =>
  invoke<IgdbGame | null>("igdb_enrich", {
    title,
    year: year ?? null,
    externalCategory: external?.category ?? null,
    externalUid: external?.uid ?? null,
  });

/**
 * The exact external id IGDB knows a library key by. Steam/GOG/Amazon keys
 * carry their store id, which beats any fuzzy title match; Epic app names and
 * companion keys have none.
 */
export function igdbExternalId(appName: string): { category: number; uid: string } | null {
  if (appName.startsWith("steam::")) return { category: 1, uid: appName.slice(7) };
  if (appName.startsWith("gog::")) return { category: 5, uid: appName.slice(5) };
  if (appName.startsWith("amazon::")) return { category: 20, uid: appName.slice(8) };
  return null;
}

/** `images.igdb.com` size templates; any size also accepts a `_2x` suffix. */
export function igdbImage(
  imageId: string,
  size:
    | "thumb"
    | "cover_big"
    | "cover_big_2x"
    | "screenshot_big"
    | "screenshot_huge"
    | "720p"
    | "1080p" = "cover_big",
): string {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg` : "";
}
