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
import { loadFriends, loadPlayerProfile, setView } from "../store/store-view";

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

let switching = false;

function switchOverlay(): HTMLElement | null {
  return document.getElementById("account-switch");
}

/** Dims the shell until the new account's saved library is on screen. */
function showAccountSwitch(name: string): void {
  const el = switchOverlay();
  if (!el) return;
  const label = el.querySelector(".account-switch-name");
  if (label) label.textContent = name;
  el.classList.remove("leaving");
  el.hidden = false;
}

function hideAccountSwitch(): void {
  const el = switchOverlay();
  if (!el || el.hidden) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    el.hidden = true;
    return;
  }
  el.classList.add("leaving");
  window.setTimeout(() => {
    el.hidden = true;
    el.classList.remove("leaving");
  }, 180);
}

/** Switch the active Epic Games session to the specified accountId. */
export async function switchAccount(accountId: string): Promise<void> {
  if (switching || !accountId || accountId === S.epicAccountId) return;
  switching = true;
  const shownAt = performance.now();
  showAccountSwitch("");

  try {
    const switched = await epicSwitchAccount(accountId);
    showAccountSwitch(switched.display_name);
    S.epicAccount = switched.display_name;
    S.epicAccountId = switched.account_id;
    S.playerProfileData = null;
    S.profileError = "";
    S.friends = [];
    S.friendsError = "";
    S.epicAchSummaries = {};
    S.epicGamesRaw = [];
    S.epicSummaries = [];
    S.epicGamesRawMap.clear();
    S.epicSummariesMap.clear();
    S.epicPhase = "library";
    S.epicSyncing = true;

    await loadSavedAccounts();
    render();

    toast(t("settings.accountSwitched", { name: switched.display_name }), "ok");

    // Snapshot paints first. The Epic list continues behind the overlay.
    // Profile uses the restored cache.
    await refreshEpic(true);
    void loadPlayerProfile(false, true);
    void loadFriends(false, true);
  } catch (err) {
    console.error("Account switch failed:", err);
    toast(String(err), "err");
  } finally {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hold = reduce ? 0 : 420 - (performance.now() - shownAt);
    if (hold > 0) await new Promise((resolve) => window.setTimeout(resolve, hold));
    hideAccountSwitch();
    switching = false;
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

/** Show the sign-in form on the Accounts page to link another Epic account (the current one stays archived). */
export function promptAddAccount(): void {
  S.accountsAddMode = true;
  if (S.view !== "settings") setView("accounts");
  render();
}

/** Hide the add-account form and keep the active session. */
export function cancelAddAccount(): void {
  S.accountsAddMode = false;
  render();
}
