/**
 * Exophase loading and account actions.
 *
 * The Rust side owns the cache (6 hours) and the network. This module only
 * decides when a paint should ask for a read, and keeps the tab's state in S.
 */

import { render } from "../../core/render";
import { S } from "../../core/state";
import {
  exophaseGet,
  exophaseSetEnabled,
  exophaseSetUsername,
  exophaseStatus,
  type ExophaseStatus,
} from "../../exophase";

const TTL_SECS = 6 * 3600;
let inFlight: Promise<void> | null = null;

export function exophaseIsStale(): boolean {
  if (!S.exophaseData) return true;
  return Date.now() / 1000 - S.exophaseData.summary.fetchedAt >= TTL_SECS;
}

/** Reads the profile when it is missing or older than the cache TTL. */
export async function loadExophase(force = false): Promise<void> {
  if (!S.exophaseConfigured) {
    try {
      const status = await exophaseStatus();
      S.exophaseConfigured = status.configured;
      S.exophaseEnabled = status.enabled;
      S.exophaseUsername = status.username;
      if (!status.configured) {
        render();
        return;
      }
    } catch {
      return;
    }
  }
  if (!force && S.exophaseData && !exophaseIsStale()) return;
  if (inFlight) return inFlight;

  S.exophaseLoading = true;
  S.exophaseError = "";
  render();

  inFlight = (async () => {
    try {
      S.exophaseData = await exophaseGet(force);
      S.exophaseError = "";
    } catch (error) {
      S.exophaseError = String(error);
    } finally {
      S.exophaseLoading = false;
      inFlight = null;
      render();
    }
  })();
  return inFlight;
}

/** Saves the public username/URL/id and drops the previous profile's cache. */
export async function saveExophaseUsername(username: string): Promise<ExophaseStatus> {
  const status = await exophaseSetUsername(username);
  S.exophaseConfigured = status.configured;
  S.exophaseEnabled = status.enabled;
  S.exophaseUsername = status.username;
  S.exophaseData = null;
  S.exophaseError = "";
  S.exophaseService = "all";
  S.exophaseGameCount = 60;
  S.exophaseSearchQuery = "";
  S.exophaseSort = "recent";
  return status;
}

/** Shows or hides the Profile > Exophase tab without deleting the username. */
export async function saveExophaseEnabled(enabled: boolean): Promise<ExophaseStatus> {
  const status = await exophaseSetEnabled(enabled);
  S.exophaseEnabled = status.enabled;
  S.exophaseConfigured = status.configured;
  S.exophaseUsername = status.username;
  if (!status.enabled && S.profileTab === "exophase") {
    S.profileTab = "launcher";
  }
  render();
  return status;
}
