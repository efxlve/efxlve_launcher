/**
 * EA App, Ubisoft Connect and Xbox detection (hand-off launching only).
 *
 * Each store licences its games through its own client, so the launcher reads
 * the store's metadata from the registry / disk and hands every action back to
 * that client. No game files are ever installed, moved or removed.
 */

import { invoke } from "@tauri-apps/api/core";

export type ExternalStore = "ea" | "ubisoft" | "xbox";

/** One game installed by an external store. */
export interface ExternalGame {
  store: ExternalStore;
  /** Product id, EA game id or Xbox `<PackageFamilyName>!App`. */
  id: string;
  title: string;
  installPath: string;
}

export const externalDetectGames = (store: ExternalStore) =>
  invoke<ExternalGame[]>("external_detect_games", { store });
export const externalLaunchGame = (store: ExternalStore, id: string) =>
  invoke<void>("external_launch_game", { store, id });
