/**
 * Core domain types shared across the launcher frontend.
 *
 * These types are intentionally dependency-free so they can be imported by any
 * module (state, utils, features) without creating import cycles.
 */

/** Demo catalog game model (browser/mock mode and `list_games` fallback). */
export interface Game {
  id: string;
  title: string;
  genre: string;
  /** 0 means free. */
  price: number;
  sizeMb: number;
  version: string;
  installed: boolean;
  installPath?: string | null;
}

/** Extra presentation metadata for demo catalog entries. */
export interface CatalogMeta {
  description: string;
  gradient: string;
  rating: number;
}

/** Top-level application view/route. */
export type View = "library" | "downloads" | "settings" | "dlc-manager" | "profile" | "store";
