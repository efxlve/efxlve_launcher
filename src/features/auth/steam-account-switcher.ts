/**
 * Steam multi-account switcher, mirroring the Epic/GOG vault pattern.
 *
 * Each account's refresh token is sealed with DPAPI in its own vault file; the
 * launcher session can hop between them without re-entering a password.
 */

import { render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { steamGetSavedAccounts, steamRemoveSavedAccount, steamSwitchAccount, type SteamSavedAccount } from "../../steam";
import { loadSteamLibrary } from "../library/steam-library";

export async function loadSavedSteamAccounts(): Promise<SteamSavedAccount[]> {
  try {
    const list = await steamGetSavedAccounts();
    S.steamSavedAccounts = list;
    return list;
  } catch {
    return [];
  }
}

let switching = false;

export async function switchSteamAccount(steamId: string): Promise<void> {
  if (switching || !steamId || steamId === S.steamAuth?.steamId) return;
  switching = true;
  try {
    const status = await steamSwitchAccount(steamId);
    S.steamAuth = status;
    S.steamAuthStep = "signed_in";
    S.steamAuthUser = "";
    await loadSavedSteamAccounts();
    render();
    toast(t("settings.accountSwitched", { name: status.accountName }), "ok");
    // The owned library belongs to the active account; installed manifests stay.
    void loadSteamLibrary();
  } catch (e) {
    toast(String(e), "err");
  } finally {
    switching = false;
  }
}

export async function removeSavedSteamAccount(steamId: string): Promise<void> {
  try {
    await steamRemoveSavedAccount(steamId);
    const wasActive = S.steamAuth?.steamId === steamId;
    if (wasActive) {
      S.steamAuth = null;
      S.steamAuthStep = "idle";
      S.steamOwnedCount = 0;
      void loadSteamLibrary();
    }
    await loadSavedSteamAccounts();
    toast(t("settings.accountRemoved"), "ok");
    scheduleRender();
  } catch (e) {
    toast(String(e), "err");
  }
}
