/**
 * DRM launchers other than Steam: EA App, Ubisoft Connect, Xbox and Battle.net.
 *
 * The games stay inside those clients. The launcher lists what they installed
 * and opens the client to play. Owned-but-not-installed libraries and
 * achievement catalogs are not on disk the way Steam's are.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GameSource, LibraryItem } from "./core/types";

export type CompanionStore = "ea" | "ubisoft" | "xbox" | "battlenet";

export interface CompanionGame {
  store: CompanionStore;
  id: string;
  name: string;
  installPath: string;
}

export const companionInstalledGames = () =>
  invoke<CompanionGame[]>("companion_installed_games");

export const companionOpenClient = (store: CompanionStore) =>
  invoke<void>("companion_open_client", { store });

export function companionToItem(g: CompanionGame): LibraryItem {
  const source = g.store as GameSource;
  return {
    key: `${g.store}::${g.id}`,
    source,
    id: g.id,
    title: g.name,
    developer: "",
    version: "—",
    installedVersion: null,
    installed: true,
    installPath: g.installPath || null,
    installSize: 0,
    coverUrl: null,
    heroUrl: null,
    description: "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}
