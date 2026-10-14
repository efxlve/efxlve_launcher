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
}

export interface IgdbStatus {
  configured: boolean;
  clientId: string;
}

export const igdbStatus = () => invoke<IgdbStatus>("igdb_status");

export const igdbSetCredentials = (clientId: string, clientSecret: string) =>
  invoke<void>("igdb_set_credentials", { clientId, clientSecret });

export const igdbClearCredentials = () => invoke<void>("igdb_clear_credentials");

export const igdbTest = () => invoke<string>("igdb_test");

export const igdbSearch = (query: string, limit?: number) =>
  invoke<IgdbSearchHit[]>("igdb_search", { query, limit: limit ?? null });

export const igdbGame = (id: number) => invoke<IgdbGame>("igdb_game", { id });

export const igdbEnrich = (title: string, year?: number | null) =>
  invoke<IgdbGame | null>("igdb_enrich", { title, year: year ?? null });

/** `images.igdb.com` size templates (`cover_big`, `screenshot_big`, `720p`). */
export function igdbImage(
  imageId: string,
  size: "cover_big" | "screenshot_big" | "720p" | "thumb" = "cover_big",
): string {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg` : "";
}
