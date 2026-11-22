/**
 * Exophase profile client.
 *
 * Exophase is a third-party service with no documented public API; Rust reads
 * the public profile page and the JSON its own frontend uses, then caches the
 * answer. The username is public, so nothing here is a secret.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ExophaseStatus {
  configured: boolean;
  username: string;
}

export interface ExophaseService {
  slug: string;
  label: string;
  games: number;
  awards: number;
  playtimeMinutes: number;
}

export interface ExophaseSummary {
  username: string;
  displayName: string;
  playerId: string;
  userId: string;
  avatar: string;
  profileUrl: string;
  totalAwards: number;
  totalGames: number;
  playtimeMinutes: number;
  completedGames: number;
  rank: number;
  services: ExophaseService[];
  /** Unix seconds of Exophase's own last profile sync. 0 when unknown. */
  lastSync: number;
  /** Unix seconds of this launcher's last successful read. */
  fetchedAt: number;
}

export interface ExophaseGame {
  masterId: number;
  playerId: number;
  title: string;
  platformSlug: string;
  platform: string;
  percent: number;
  earnedAwards: number;
  totalAwards: number;
  playtimeMinutes: number;
  lastPlayed: number;
  /** Wide card art (288x158). */
  cover: string;
  /** Wide hero art used as the tab backdrop. */
  hero: string;
  url: string;
}

export interface ExophaseAward {
  name: string;
  description: string;
  game: string;
  platform: string;
  earned: string;
  icon: string;
  url: string;
  rarity: number | null;
}

export interface ExophaseData {
  summary: ExophaseSummary;
  games: ExophaseGame[];
  awards: ExophaseAward[];
}

export const exophaseStatus = () => invoke<ExophaseStatus>("exophase_status");

export const exophaseSetUsername = (username: string) =>
  invoke<ExophaseStatus>("exophase_set_username", { username });

export const exophaseGet = (force = false) =>
  invoke<ExophaseData>("exophase_get", { force });

export const EXOPHASE_SITE = "https://www.exophase.com/";
