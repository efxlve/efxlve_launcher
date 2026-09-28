/**
 * GOG multi-account switcher, mirroring the Epic account-switcher pattern.
 */

import { gogGetSavedAccounts, gogSwitchAccount as gogSwitchAccountIpc, gogRemoveSavedAccount as gogRemoveAccountIpc, type SavedGogAccount } from "../../gog";
import { S } from "../../core/state";
import { render, scheduleRender } from "../../core/render";
import { initGogSession } from "./gog-auth-actions";
import { loadSharedLibrary } from "../library/shared-library";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { setGogSummaries } from "../../core/selectors";

export async function loadSavedGogAccounts(): Promise<SavedGogAccount[]> {
  try {
    const list = await gogGetSavedAccounts();
    S.gogSavedAccounts = list;
    return list;
  } catch {
    return [];
  }
}

let switching = false;

export async function switchGogAccount(userId: string): Promise<void> {
  if (switching || !userId || userId === S.gogAccountId) return;
  switching = true;
  try {
    const result = await gogSwitchAccountIpc(userId);
    S.gogAccount = result.username;
    S.gogAccountId = result.user_id;
    S.gogSyncing = true;
    // Profile follows the newly active account.
    S.profileAccount = null;

    // Clear GOG state for fresh hydration
    setGogSummaries([]);
    S.epicAchSummaries = {};

    await loadSavedGogAccounts();
    render();

    // Background sync
    await initGogSession();
    void loadSharedLibrary();
  } catch (e) {
    toast(String(e), "err");
  } finally {
    switching = false;
  }
}

export async function removeSavedGogAccount(userId: string): Promise<void> {
  try {
    await gogRemoveAccountIpc(userId);
    await loadSavedGogAccounts();
    toast(t("settings.accountRemoved"), "ok");
    scheduleRender();
  } catch (e) {
    toast(String(e), "err");
  }
}

export function promptAddGogAccount(): void {
  S.gogAccountsAddMode = true;
  scheduleRender();
}

export function cancelAddGogAccount(): void {
  S.gogAccountsAddMode = false;
  scheduleRender();
}
