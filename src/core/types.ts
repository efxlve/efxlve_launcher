/**
 * Core domain types shared across the launcher frontend.
 *
 * These types are intentionally dependency-free so they can be imported by any
 * module (state, utils, features) without creating import cycles.
 */

/** Top-level application view/route. */
export type View = "library" | "downloads" | "settings" | "dlc-manager" | "profile" | "store";

/** Account/setup lifecycle phase. */
export type EpicPhase = "checking" | "setup" | "login" | "library" | "error";

/** Game detail drawer tabs. */
export type DrawerTab = "overview" | "achievements" | "dlcs" | "screenshots" | "manage" | "specs";

/** Library filter modes. */
export type EpicFilter = "all" | "installed" | "fav" | "updates" | "platinum" | "collections";
/** Library sort modes. */
export type EpicSort = "recent" | "alpha" | "installed" | "updates" | "platinum";
/** Library layout mode. */
export type EpicViewMode = "grid" | "shelves" | "list";
/** Poster card size. */
export type CardSize = "compact" | "normal" | "large";

/** Category selected in the settings page left rail. */
export type SettingsSection = "account" | "downloads" | "integrations" | "appearance" | "screenshots" | "system" | "about";

/** Kind of an in-app notification (drives the icon and accent color). */
export type NotifKind = "download" | "update" | "error" | "info" | "social";

/** A single entry in the notification center history. */
export interface AppNotification {
  id: string;
  kind: NotifKind;
  title: string;
  body: string;
  appName?: string;
  ts: number;
  read: boolean;
}

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
