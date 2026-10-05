/**
 * Amazon Games (Nile) authentication and library lifecycle.
 *
 * Sign-in follows Nile's non-interactive flow: the CLI prints the PKCE material
 * and the Amazon URL, the user signs in there, and the redirect URL they paste
 * back carries the authorization code. `register` finishes the device
 * registration and performs the first library sync.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../core/constants";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import {
  nileAuthStatus,
  nileLibrary,
  nileLoginBegin,
  nileLoginFinish,
  nileLogout,
} from "../../nile";

function openExternal(url: string): void {
  void openUrl(url).catch(() => {
    window.open(url, "_blank");
  });
}

/** Starts sign-in: asks Nile for the PKCE material and opens Amazon. */
export async function beginAmazonLogin(): Promise<void> {
  if (S.amazonBusy) return;
  S.amazonBusy = true;
  scheduleRender();
  try {
    const data = await nileLoginBegin();
    S.amazonLogin = data;
    S.amazonBusy = false;
    scheduleRender();
    openExternal(data.url);
  } catch (err) {
    S.amazonBusy = false;
    toast(String(err), "err");
    scheduleRender();
  }
}

/** Re-opens the sign-in URL of an already started flow. */
export function reopenAmazonLogin(): void {
  if (!S.amazonLogin) {
    toast(t("amazon.openFirst"), "err");
    return;
  }
  openExternal(S.amazonLogin.url);
}

/** Finishes sign-in with the redirect URL (or bare code) the user pasted. */
export async function finishAmazonLogin(raw: string): Promise<void> {
  const data = S.amazonLogin;
  if (!data) {
    toast(t("amazon.openFirst"), "err");
    return;
  }
  const text = raw.trim();
  if (!text) {
    toast(t("amazon.pastePlaceholder"), "err");
    return;
  }
  S.amazonBusy = true;
  scheduleRender();
  try {
    await nileLoginFinish(text, data.client_id, data.code_verifier, data.serial);
    S.amazonLogin = null;
    S.amazonBusy = false;
    toast(t("accounts.connected"), "ok");
    await loadAmazonSession(true);
  } catch (err) {
    S.amazonBusy = false;
    toast(String(err), "err");
    scheduleRender();
  }
}

/**
 * Loads the account state and library. `sync` refreshes the library from
 * Amazon first; without it the cached Nile library is instant.
 */
export async function loadAmazonSession(sync = false): Promise<void> {
  if (!isTauri) return;
  try {
    const status = await nileAuthStatus();
    S.amazonStatus = status;
    if (status.logged_in) {
      try {
        S.amazonGames = await nileLibrary(sync);
      } catch {
        // Keep the previous list when the refresh fails.
      }
    } else {
      S.amazonGames = [];
    }
  } catch {
    // Keep the last state.
  }
  scheduleRender();
}

/** Manual library refresh from the card. */
export async function syncAmazonLibrary(): Promise<void> {
  if (S.amazonBusy) return;
  S.amazonBusy = true;
  scheduleRender();
  try {
    await loadAmazonSession(true);
    toast(t("amazon.synced"), "ok");
  } catch (err) {
    toast(String(err), "err");
  } finally {
    S.amazonBusy = false;
    scheduleRender();
  }
}

/** Signs out and clears the local Amazon state. */
export async function amazonLogoutAction(): Promise<void> {
  try {
    await nileLogout();
  } catch {
    // Ignore: the local state is cleared either way.
  }
  S.amazonStatus = {
    binary: S.amazonStatus?.binary ?? false,
    logged_in: false,
    username: null,
  };
  S.amazonGames = [];
  S.amazonLogin = null;
  scheduleRender();
}
