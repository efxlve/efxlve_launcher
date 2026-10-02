/**
 * GOG authentication and library synchronization lifecycle actions.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { patchLibraryCardDom } from "../../core/game-view";
import { updateBadge } from "../../core/nav";
import { setGogSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { scheduleRender } from "../../core/render";
import { t } from "../../i18n";
import { isTauri } from "../../core/constants";
import {
  GOG_LOGIN_URL,
  gogAuthCode,
  gogAuthStatus,
  gogCachedLibrary,
  gogCheckUpdates,
  gogDefaultInstallDir,
  gogGetInstallDir,
  gogListGames,
  gogLogout,
  gogSyncAchievements,
  gogSyncPlaytime,
  gogToLibraryItem,
} from "../../gog";
import { invalidateLibraryVisibleCache } from "../library/library-view";
import { loadSharedLibrary } from "../library/shared-library";
import { loadSavedGogAccounts } from "./gog-account-switcher";

/** Clean extraction of code from input, whether pasted as raw code or full redirect URL. */
export function extractGogAuthCode(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("code=")) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get("code");
      if (code) return code.trim();
    } catch {
      // Fallback regex if full URL parser fails
      const match = trimmed.match(/[?&]code=([^&#\s]+)/);
      if (match?.[1]) return match[1].trim();
    }
  }
  return trimmed;
}

/** Open official GOG OAuth2 login page in the user's default web browser. */
export async function openGogLoginPage(): Promise<void> {
  try {
    await openUrl(GOG_LOGIN_URL);
  } catch {
    window.open(GOG_LOGIN_URL, "_blank");
  }
}

/** Exchange authorization code, hydrate user details, and start library sync. */
export async function gogLoginWithCode(rawCode: string): Promise<void> {
  const code = extractGogAuthCode(rawCode);
  if (!code) {
    toast(t("gog.pastePlaceholder"));
    return;
  }

  S.gogSyncing = true;
  scheduleRender();

  try {
    const status = await gogAuthCode(code);
    S.gogAccount = status.username || "GOG User";
    S.gogAccountId = status.user_id || null;
    S.gogPhase = "library";
    S.gogAccountsAddMode = false;
    await loadSavedGogAccounts();
    toast(t("accounts.connected"));
    await syncGogLibrary();
  } catch (err) {
    S.gogSyncing = false;
    toast(String(err));
    scheduleRender();
  }
}

/** Synchronize user's owned GOG library in the background. */
export async function syncGogLibrary(force = false): Promise<void> {
  S.gogSyncing = true;
  scheduleRender();

  try {
    const games = await gogListGames();
    const items = games.map(gogToLibraryItem);
    setGogSummaries(items);
    S.gogSyncing = false;
    scheduleRender();
    void syncGogAchievements();
    void refreshGogUpdates(force);
  } catch (err) {
    S.gogSyncing = false;
    toast(t("gog.syncFailed"));
    scheduleRender();
  }
}

/**
 * Compares installed GOG build ids with the newest public builds and mirrors the
 * result onto library items. Offline or rate-limited calls keep the previous
 * state (the backend caches each build lookup for a few hours).
 */
export async function refreshGogUpdates(force = false): Promise<void> {
  if (!isTauri || S.offlineMode || !S.gogAccount) return;
  try {
    const list = await gogCheckUpdates(force);
    S.gogUpdates.clear();
    const updatedIds = new Set<string>();
    for (const u of list) {
      const key = `gog::${u.gameId}`;
      S.gogUpdates.set(key, u);
      updatedIds.add(key);
    }
    // Library items carry the flag so badges, action buttons and the downloads
    // updates list all agree without extra lookups.
    for (const g of S.gogSummaries) {
      g.updateAvailable = updatedIds.has(g.key);
    }
    S.libraryDataRev++;
    if (S.view === "library") {
      document.querySelectorAll<HTMLElement>('[data-lib-item^="gog::"]').forEach((el) => {
        const id = el.dataset.libItem;
        if (id) patchLibraryCardDom(id);
      });
    } else if (S.view === "downloads") {
      scheduleRender();
    }
    updateBadge();
  } catch (err) {
    console.warn("GOG update check failed:", err);
  }
}

/** Synchronize achievement summaries for GOG games in the background. */
export async function syncGogAchievements(): Promise<void> {
  try {
    const summaries = await gogSyncAchievements();
    if (summaries && Object.keys(summaries).length > 0) {
      Object.assign(S.epicAchSummaries, summaries);
      if (S.view === "library") {
        document.querySelectorAll<HTMLElement>("[data-lib-item]").forEach((el) => {
          const id = el.dataset.libItem;
          if (id && id.startsWith("gog::")) patchLibraryCardDom(id);
        });
        invalidateLibraryVisibleCache();
      }
    }
  } catch (err) {
    console.warn("Failed to sync GOG achievements:", err);
  }
}

/**
 * Imports hours played in the official GOG Galaxy client.
 *
 * GOG has no public playtime API; Galaxy keeps `GameTimes.minutesInGame` in its
 * local SQLite database and the backend reads it read-only. Local values are
 * never lowered (same rule as Epic's server playtime merge).
 */
export async function syncGogPlaytime(): Promise<void> {
  if (!isTauri || !S.gogAccount) return;
  try {
    const rows = await gogSyncPlaytime(S.gogAccountId);
    let changed = false;
    for (const row of rows) {
      const key = `gog::${row.gameId}`;
      const rec = S.playtimeMap.get(key);
      if (!rec) {
        S.playtimeMap.set(key, { total_seconds: row.seconds, session_count: 0 });
        changed = true;
      } else if (row.seconds > (rec.total_seconds || 0)) {
        rec.total_seconds = row.seconds;
        changed = true;
      }
    }
    if (changed) {
      S.libraryDataRev++;
      if (S.view === "library" && S.showCoverStats) {
        document.querySelectorAll<HTMLElement>('[data-lib-item^="gog::"]').forEach((el) => {
          const id = el.dataset.libItem;
          if (id) patchLibraryCardDom(id);
        });
      } else if (S.view === "profile") {
        scheduleRender();
      }
    }
  } catch (err) {
    console.warn("GOG Galaxy playtime could not be read:", err);
  }
}

/** Disconnect the GOG account and clear local cache. */
export async function gogLogoutAction(): Promise<void> {
  try {
    await gogLogout();
  } catch {
    // Ignore error
  }
  S.gogAccount = "";
  S.gogAccountId = null;
  S.gogPhase = "login";
  setGogSummaries([]);
  void loadSharedLibrary();
  scheduleRender();
}

/** Check saved GOG session on app boot and hydrate cache-first. */
export async function initGogSession(): Promise<void> {
  // Install folder settings are local and independent of the account state, so
  // the install dialog has them even when Settings was never opened.
  try {
    const [dir, fallback] = await Promise.all([
      gogGetInstallDir().catch(() => null),
      gogDefaultInstallDir().catch(() => ""),
    ]);
    S.gogInstallDir = dir || "";
    S.gogDefaultDir = fallback || "";
  } catch {
    // Keep the last values; the dialog falls back to C:\Games\GOG.
  }
  try {
    const status = await gogAuthStatus();
    if (status.logged_in) {
      S.gogAccount = status.username || "GOG User";
      S.gogAccountId = status.user_id || null;
      S.gogPhase = "library";

      // 1. Instant cache hydration
      const cached = await gogCachedLibrary();
      if (cached.games.length > 0) {
        setGogSummaries(cached.games.map(gogToLibraryItem));
      }
      
      await loadSavedGogAccounts();

      // 2. Background silent sync
      void syncGogLibrary();
      void syncGogAchievements();
      void syncGogPlaytime();
    } else {
      S.gogPhase = "login";
    }
  } catch {
    S.gogPhase = "login";
  }
}
