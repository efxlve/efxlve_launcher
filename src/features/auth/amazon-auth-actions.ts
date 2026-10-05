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
import { setAmazonSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { LibraryItem } from "../../core/types";
import { t } from "../../i18n";
import {
  amazonKey,
  nileAuthStatus,
  nileCheckUpdates,
  nileInstall,
  nileLaunch,
  nileLibrary,
  nileLoginBegin,
  nileLoginFinish,
  nileLogout,
  nileStop,
  nileUninstall,
  type NileGame,
} from "../../nile";

/** One Amazon game as a library item (`amazon::<product id>`). */
function amazonToLibraryItem(game: NileGame): LibraryItem {
  return {
    key: amazonKey(game.id),
    source: "amazon",
    id: game.id,
    title: game.title,
    developer: "",
    version: game.version || "—",
    installedVersion: null,
    installed: game.installed,
    installPath: game.install_path,
    installSize: 0,
    coverUrl: game.art,
    heroUrl: null,
    description: "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}

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
    setAmazonSummaries(S.amazonGames.map(amazonToLibraryItem));
    if (status.logged_in) void refreshAmazonUpdates();
  } catch {
    // Keep the last state.
  }
  scheduleRender();
}

/**
 * Mirrors Nile's live-version check onto the library items so the update badge
 * and the card's Update button agree. Offline or rate-limited calls keep the
 * previous state.
 */
async function refreshAmazonUpdates(): Promise<void> {
  try {
    const updates = new Set(await nileCheckUpdates());
    let changed = false;
    for (const item of S.amazonSummaries) {
      const next = updates.has(item.key);
      if (item.updateAvailable !== next) {
        item.updateAvailable = next;
        changed = true;
      }
    }
    if (changed) {
      S.libraryDataRev++;
      scheduleRender();
    }
  } catch {
    // Keep the previous state.
  }
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
  S.amazonProgress.clear();
  setAmazonSummaries([]);
  scheduleRender();
}

/** Installs or updates one Amazon game; progress streams in as events. */
export async function installAmazonGame(id: string): Promise<void> {
  const key = amazonKey(id);
  S.amazonProgress.set(key, { percent: 0, speed: 0 });
  scheduleRender();
  try {
    await nileInstall(id);
    S.amazonProgress.delete(key);
    toast(t("amazon.installed"), "ok");
    await loadAmazonSession(false);
  } catch (err) {
    S.amazonProgress.delete(key);
    toast(String(err), "err");
    scheduleRender();
  }
}

/** Launches one installed game and starts the playtime session. */
export async function playAmazonGame(id: string): Promise<void> {
  try {
    const msg = await nileLaunch(id);
    toast(msg, "ok");
  } catch (err) {
    toast(String(err), "err");
  }
}

export async function stopAmazonGame(id: string): Promise<void> {
  try {
    const msg = await nileStop(id);
    toast(msg, "ok");
  } catch (err) {
    toast(String(err), "err");
  }
}

/** Removes one installed game and refreshes the installed state. */
export async function uninstallAmazonGame(id: string): Promise<void> {
  try {
    await nileUninstall(id);
    toast(t("amazon.uninstalled"), "ok");
    await loadAmazonSession(false);
  } catch (err) {
    toast(String(err), "err");
  }
}
