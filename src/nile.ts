/**
 * Amazon Games through the Nile CLI (account + library).
 *
 * Nile is downloaded on demand into `<app_data>/bin` and pointed at a
 * launcher-owned config directory; these wrappers only expose the account and
 * library surface for now. Install, launch and update follow the same CLI.
 */

import { invoke } from "@tauri-apps/api/core";

export interface NileAuthStatus {
  /** True when the Nile binary is already on disk (no download was made). */
  binary: boolean;
  logged_in: boolean;
  username: string | null;
}

export interface NileLoginData {
  /** Amazon sign-in URL to open in the browser. */
  url: string;
  client_id: string;
  code_verifier: string;
  serial: string;
}

export interface NileGame {
  /** Amazon product id every Nile command takes. */
  id: string;
  title: string;
  art: string | null;
  installed: boolean;
  install_path: string | null;
  version: string | null;
  /** Installed size in bytes (0 when not installed). */
  size: number;
}

export const nileAuthStatus = () => invoke<NileAuthStatus>("nile_auth_status");

/** Starts sign-in and returns the PKCE material plus the Amazon URL. */
export const nileLoginBegin = () => invoke<NileLoginData>("nile_login_begin");

/** Finishes sign-in with the redirect URL (or bare code) the user pasted. */
export const nileLoginFinish = (
  redirect: string,
  clientId: string,
  codeVerifier: string,
  serial: string,
) => invoke<string>("nile_login_finish", { redirect, clientId, codeVerifier, serial });

export const nileLogout = () => invoke<void>("nile_logout");

/** Library list; `sync` refreshes it from Amazon first. */
export const nileLibrary = (sync = false) => invoke<NileGame[]>("nile_library", { sync });

/** Installs or updates one game; progress arrives as `nile-progress` events. */
export const nileInstall = (id: string, basePath?: string | null, maxWorkers?: number) =>
  invoke<void>("nile_install", {
    id,
    basePath: basePath ?? null,
    maxWorkers: maxWorkers ?? null,
  });

/** Download size for the install dialog, without downloading anything. */
export const nileInstallInfo = (id: string) =>
  invoke<number>("nile_install_info", { id });

export const nileUninstall = (id: string) => invoke<void>("nile_uninstall", { id });

/** Launches one installed game; the promise resolves when the game exits. */
export const nileLaunch = (id: string) => invoke<string>("nile_launch", { id });

export const nileStop = (id: string) => invoke<string>("nile_stop", { id });

/** Composite library ids with a newer build on Amazon. */
export const nileCheckUpdates = () => invoke<string[]>("nile_check_updates");

/** Verifies (and repairs) one installed game; progress arrives as events. */
export const nileVerify = (id: string) => invoke<void>("nile_verify", { id });

/** Moves one installed game to a new root folder. */
export const nileMoveGame = (appName: string, targetBasePath: string) =>
  invoke<import("./epic-commands").MoveGameResult>("nile_move_game", {
    appName,
    targetBasePath,
  });

/** Creates a desktop shortcut that launches the game through the launcher. */
export const nileCreateDesktopShortcut = (id: string) =>
  invoke<string>("nile_create_desktop_shortcut", { id });

/** Per-game manage settings (save path, backups) in the shared shape. */
export const nileGameSettings = (id: string) =>
  invoke<import("./epic-commands").GameLocalSettings>("nile_game_settings", { id });

/** Base folder Amazon Games install into (empty = Nile's default). */
export const amazonGetInstallDir = () => invoke<string | null>("amazon_get_install_dir");

export const amazonSetInstallDir = (dir: string) =>
  invoke<void>("amazon_set_install_dir", { dir });

/** Default base folder for Amazon installs (`<home>\Games\Amazon`). */
export const amazonDefaultInstallDir = () => invoke<string>("amazon_default_install_dir");

export interface NileProgressEvent {
  /** Composite id (`amazon::<product id>`). */
  id: string;
  percent: number;
  downloaded: number;
  total: number;
  /** MiB/s, 0 until the first speed line arrives. */
  speed: number;
  /** Disk write MiB/s, 0 until the first disk line arrives. */
  diskSpeed: number;
  /** Nile's own estimate as `HH:MM:SS`, null until the first progress line. */
  eta: string | null;
}

/** Composite library key for one Amazon product id. */
export function amazonKey(id: string): string {
  return `amazon::${id}`;
}
