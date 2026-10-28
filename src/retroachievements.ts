/**
 * RetroAchievements IPC. Credentials live in Rust; the frontend only learns
 * whether a pair is stored and the username, never the web API key.
 */

import { invoke } from "@tauri-apps/api/core";
import type { EpicAchievementsData } from "./epic-commands";

export interface RaStatus {
  configured: boolean;
  username: string;
}

export const raStatus = () => invoke<RaStatus>("ra_status");

/** An empty pair clears the credentials; a missing key keeps the stored one. */
export const raSetCredentials = (username: string, apiKey: string) =>
  invoke<RaStatus>("ra_set_credentials", { username, apiKey });

/** Verifies the stored pair and returns the RA username. */
export const raTest = () => invoke<string>("ra_test");

/** One game's set plus the player's progress, mapped onto the shared model. */
export const raGameProgress = (gameId: string) =>
  invoke<EpicAchievementsData>("ra_game_progress", { gameId });
