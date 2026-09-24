/**
 * Epic Games Account Switcher feature.
 *
 * Handles loading saved accounts, switching between multiple accounts with a single
 * click, adding new accounts, and removing inactive sessions.
 */

import { toast } from "../../core/toast";
import { S } from "../../core/state";
import { render } from "../../core/render";
import { t } from "../../i18n";
import {
  epicGetSavedAccounts,
  epicSwitchAccount,
  epicRemoveSavedAccount,
  type SavedAccount,
} from "../../epic";
import { refreshEpic } from "./auth-actions";

/** Load all archived accounts and update state. */
export async function loadSavedAccounts(): Promise<SavedAccount[]> {
  try {
    const list = await epicGetSavedAccounts();
    S.savedAccounts = list || [];
    return S.savedAccounts;
  } catch (e) {
    console.warn("Failed to load saved accounts:", e);
    return [];
  }
}

/** Switch the active Epic Games session to the specified accountId. */
export async function switchAccount(accountId: string): Promise<void> {
  if (!accountId || accountId === S.epicAccountId) return;

  try {
    const switched = await epicSwitchAccount(accountId);
    S.epicAccount = switched.display_name;
    S.epicAccountId = switched.account_id;
    S.playerProfileData = null;
    S.friends = [];
    S.epicGamesRaw = [];
    S.epicSummaries = [];
    S.epicGamesRawMap.clear();
    S.epicSummariesMap.clear();

    // Reload saved accounts list so is_active flag updates
    await loadSavedAccounts();

    toast(t("settings.accountSwitched", { name: switched.display_name }), "ok");

    // Seamlessly re-hydrate library and user profile
    await refreshEpic();
    render();
  } catch (err) {
    console.error("Account switch failed:", err);
    toast(String(err), "err");
  }
}

/** Remove an account from the saved switcher list. */
export async function removeSavedAccount(accountId: string): Promise<void> {
  if (!accountId) return;

  try {
    await epicRemoveSavedAccount(accountId);
    await loadSavedAccounts();
    toast(t("settings.accountRemoved"), "ok");
    render();
  } catch (err) {
    console.error("Account removal failed:", err);
    toast(String(err), "err");
  }
}

/** Transition to login screen to link another Epic account without losing the current one. */
export function promptAddAccount(): void {
  // Current account is already safely archived on disk.
  // Switch view to onboarding login screen.
  S.epicPhase = "login";
  document.body.classList.add("auth-mode");
  render();
}
