/**
 * GOG authentication and library synchronization lifecycle actions.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { patchLibraryCardDom } from "../../core/game-view";
import { setGogSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { scheduleRender } from "../../core/render";
import { t } from "../../i18n";
import {
  GOG_LOGIN_URL,
  gogAuthCode,
  gogAuthStatus,
  gogCachedLibrary,
  gogListGames,
  gogLogout,
  gogSyncAchievements,
  gogToLibraryItem,
} from "../../gog";
import { invalidateLibraryVisibleCache } from "../library/library-view";
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
export async function syncGogLibrary(): Promise<void> {
  S.gogSyncing = true;
  scheduleRender();

  try {
    const games = await gogListGames();
    const items = games.map(gogToLibraryItem);
    setGogSummaries(items);
    S.gogSyncing = false;
    scheduleRender();
    void syncGogAchievements();
  } catch (err) {
    S.gogSyncing = false;
    toast(t("gog.syncFailed"));
    scheduleRender();
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
  scheduleRender();
}

/** Check saved GOG session on app boot and hydrate cache-first. */
export async function initGogSession(): Promise<void> {
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
    } else {
      S.gogPhase = "login";
    }
  } catch {
    S.gogPhase = "login";
  }
}
