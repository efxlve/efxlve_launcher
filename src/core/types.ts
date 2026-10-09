/**
 * Core domain types shared across the launcher frontend.
 *
 * These types are intentionally dependency-free so they can be imported by any
 * module (state, utils, features) without creating import cycles.
 */

/** Top-level application view/route. */
export type View = "library" | "downloads" | "settings" | "profile" | "store" | "accounts" | "music" | "tv";

/** Store or catalog provider source for a game. */
export type GameSource = "epic" | "gog" | "steam" | "ea" | "ubisoft" | "xbox" | "battlenet" | "riot" | "amazon";

/** Account/setup lifecycle phase for GOG.COM. */
export type GogPhase = "checking" | "setup" | "login" | "library" | "error";

/** Account/setup lifecycle phase. */
export type EpicPhase = "checking" | "setup" | "login" | "library" | "error";

/** Game detail drawer tabs. */
export type DrawerTab = "overview" | "achievements" | "dlcs" | "screenshots" | "manage" | "specs";

/** Library filter modes. */
export type EpicFilter = "all" | "installed" | "fav" | "updates" | "platinum" | "collections";
/** Library sort modes. */
export type EpicSort = "alpha" | "alphaDesc" | "recent" | "played" | "achievements" | "installed";
/** Library layout mode: cover grid or dense list. */
export type EpicViewMode = "grid" | "list";

/** Category selected in the settings page left rail. */
export type SettingsSection = "account" | "downloads" | "cloud" | "integrations" | "launchers" | "collections" | "controller" | "appearance" | "screenshots" | "system" | "hidden" | "about";

/** Controller family, used to pick the right button glyphs and hints. */
export type ControllerKind = "playstation" | "xbox" | "switch" | "steamdeck" | "generic";

/** Kind of an in-app notification (drives the icon and accent color). */
export type NotifKind = "download" | "update" | "error" | "info" | "social";

/** A single entry in the notification center history. */
export interface AppNotification {
  id: string;
  kind: NotifKind;
  title: string;
  body: string;
  appName?: string;
  /** Optional `data-act` routed when the entry is clicked (e.g. install an app update). */
  action?: string;
  ts: number;
  read: boolean;
}

/** Lifecycle of the launcher self-update. */
export type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

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

/** Saved Epic Games account for fast switching. */
export interface SavedAccount {
  account_id: string;
  display_name: string;
  last_used: number;
  is_active: boolean;
  game_count?: number;
}

/**
 * Unified representation of a game from any store provider (Epic, GOG, etc.).
 *
 * Used by the library grid, list rows, context menu, search and collections to
 * provide a store-agnostic presentation layer.
 */
export interface LibraryItem {
  /** Unique composite key in format `${source}::${id}` (e.g. `epic::Salt`, `gog::1207658924`). */
  key: string;
  /** Provider store. */
  source: GameSource;
  /** Store-specific identifier (Epic appName or GOG product id). */
  id: string;
  /** Normalized display title. */
  title: string;
  /** Developer or studio name (or empty string). */
  developer: string;
  /** Version string or release name. */
  version: string;
  /** Installed version (if installed, otherwise null). */
  installedVersion: string | null;
  /** True when the game files are present on the local disk. */
  installed: boolean;
  /** Local installation directory path (or null). */
  installPath: string | null;
  /** Total installation size in bytes (or 0). */
  installSize: number;
  /** Primary portrait / key cover art URL (or null). */
  coverUrl: string | null;
  /** Wide hero / banner art URL (or null). */
  heroUrl: string | null;
  /** Short or localized game description text. */
  description: string;
  /** Whether an update is available on the remote store. */
  updateAvailable: boolean;
  /** True while the owning store (today: Steam) is downloading this game. */
  downloading?: boolean;
  /** Steam ACF `BytesDownloaded` while a Steam job is running. */
  bytesDownloaded?: number;
  /** Steam ACF `BytesToDownload` while a Steam job is running. */
  bytesToDownload?: number;
  /** Whether the game supports remote cloud save synchronization. */
  cloudSavesSupported: boolean;
  /** Total number of DLC expansions or add-ons owned. */
  dlcCount: number;
  /** Genre labels for the library filters (empty/absent when unknown). */
  genres?: string[];
  /** Release year for the library filters (null when unknown). */
  releaseYear?: number | null;
}

/* ---------- Advanced library filters ---------- */

export type LibPlaytimeBucket = "never" | "under1" | "1to10" | "10to50" | "over50";
export type LibSizeBucket = "under1" | "1to10" | "10to50" | "over50";
export type LibYearBucket = "pre2000" | "2000s" | "2010s" | "2020s";

/**
 * Advanced library filter state. An empty set means "no constraint"; values
 * inside one set are OR-ed, different sets are AND-ed.
 */
export interface LibFilters {
  status: Set<"installed" | "notInstalled" | "update">;
  playtime: Set<LibPlaytimeBucket>;
  size: Set<LibSizeBucket>;
  genres: Set<string>;
  years: Set<LibYearBucket>;
  developers: Set<string>;
}

