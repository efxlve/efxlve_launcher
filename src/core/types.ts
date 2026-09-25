/**
 * Core domain types shared across the launcher frontend.
 *
 * These types are intentionally dependency-free so they can be imported by any
 * module (state, utils, features) without creating import cycles.
 */

/** Top-level application view/route. */
export type View = "library" | "downloads" | "settings" | "profile" | "store" | "accounts";

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
export type SettingsSection = "downloads" | "integrations" | "appearance" | "screenshots" | "system" | "hidden" | "about";

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

