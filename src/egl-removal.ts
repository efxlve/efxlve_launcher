/**
 * Safe removal of the Epic Games Launcher.
 *
 * Epic's own uninstaller deletes the installed games together with the
 * launcher, so the removal runs here: every game is migrated into Legendary
 * first, then only launcher-owned files, shortcuts and registry entries are
 * deleted.
 */

import { invoke } from "@tauri-apps/api/core";

export interface EglKeptGame {
  appName: string;
  title: string;
  installPath: string;
  /** Install folder and its `.egstore` manifest are present. */
  healthy: boolean;
}

export interface EglRemovalPlan {
  games: EglKeptGame[];
  /** Launcher-owned folders that exist and will be removed. */
  removePaths: string[];
  removeShortcuts: string[];
  removeRegistry: string[];
  /** Epic Online Services folder found on disk (kept). */
  eosPath: string;
}

export interface EglRemovalResult {
  removedPaths: number;
  removedShortcuts: number;
  removedRegistry: number;
  gamesKept: number;
  gamesHealthy: number;
}

/** Read-only plan that drives the confirmation dialog. */
export const eglRemovalPlan = () => invoke<EglRemovalPlan>("egl_removal_plan");

/** Migrates the games, then removes the launcher with one UAC prompt. */
export const eglRemove = () => invoke<EglRemovalResult>("egl_remove");
