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

/** Account/setup lifecycle phase. */
export type EpicPhase = "checking" | "setup" | "login" | "library" | "error";

/** Game detail drawer tabs. */
export type DrawerTab = "overview" | "achievements" | "dlcs" | "screenshots" | "manage" | "specs";

/** Library filter modes. */
export type EpicFilter = "all" | "installed" | "fav" | "updates" | "platinum";
/** Library sort modes. */
export type EpicSort = "recent" | "alpha" | "installed" | "updates" | "platinum";
/** Library layout mode. */
export type EpicViewMode = "grid" | "shelves" | "list";
/** Poster card size. */
export type CardSize = "compact" | "normal" | "large";

/** Live metrics for the currently active download (speed, disk, ETA). */
export interface DlMetrics {
  id: string;
  title: string;
  progress: number;
  done: boolean;
  speed: string;
  speedBytes: number;
  diskSpeed: string;
  diskBytes: number;
  eta: string;
  downloadedBytes: number;
  totalBytes: number;
}
