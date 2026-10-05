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
import { updateBadge } from "../../core/nav";
import { scheduleRender } from "../../core/render";
import { setAmazonSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { LibraryItem } from "../../core/types";
import { t } from "../../i18n";
import { stopSpeedChartTimer } from "../downloads/downloads-view";
import {
  amazonDefaultInstallDir,
  amazonGetInstallDir,
  amazonKey,
  amazonRemoveSavedAccount,
  amazonSavedAccounts,
  amazonSwitchAccount,
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
  nileImport,
  type NileGame,
  type SavedAmazonAccount,
} from "../../nile";

/** One Amazon game as a library item (`amazon::<product id>`). */
function amazonToLibraryItem(game: NileGame): LibraryItem {
  return {
    key: amazonKey(game.id),
    source: "amazon",
    id: game.id,
    title: game.title,
    developer: game.developer || "",
    version: game.version || "—",
    installedVersion: null,
    installed: game.installed,
    installPath: game.install_path,
    installSize: game.size || 0,
    coverUrl: game.art,
    heroUrl: game.hero,
    description: game.description || "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
    genres: game.genres,
    releaseYear: game.release_year,
  };
}

function openExternal(url: string): void {
  void openUrl(url).catch(() => {
    window.open(url, "_blank");
  });
}

/** True while an Amazon install or update is still streaming progress. */
export function amazonDownloadActive(): boolean {
  for (const key of S.downloads.keys()) {
    if (key.startsWith("amazon::")) return true;
  }
  return false;
}

/** Account changes rewrite Nile's session files under a running install, so
 *  they wait until the download finishes. */
function accountChangeBlocked(): boolean {
  if (!amazonDownloadActive()) return false;
  toast(t("amazon.lockedWhileDownloading"), "err");
  return true;
}

/** Starts sign-in: asks Nile for the PKCE material and opens Amazon. */
export async function beginAmazonLogin(): Promise<void> {
  if (S.amazonBusy || accountChangeBlocked()) return;
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
  if (S.amazonBusy || accountChangeBlocked()) return;
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
    S.amazonAccountsAddMode = false;
    toast(t("accounts.connected"), "ok");
    invalidateAmazonUpdateCheck();
    await loadAmazonSession(true);
  } catch (err) {
    S.amazonBusy = false;
    toast(String(err), "err");
    await recoverFailedAmazonLogin(text);
  }
}

/**
 * True when the pasted text is a URL that just lacks the authorization code,
 * so the same sign-in window is still usable. Any other failure reached Amazon
 * and consumed the one-shot code.
 */
function isRetryableAmazonLogin(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.includes("openid.oa2.authorization_code");
}

/** Restores the archived account after a failed registration so the card is
 *  never left signed out with the previous session only in the archive. */
async function recoverFailedAmazonLogin(pasted: string): Promise<void> {
  if (isRetryableAmazonLogin(pasted)) {
    scheduleRender();
    return;
  }
  const saved = S.amazonSavedAccounts.length > 0
    ? S.amazonSavedAccounts
    : await amazonSavedAccounts().catch(() => []);
  if (saved.length === 0) {
    scheduleRender();
    return;
  }
  S.amazonLogin = null;
  S.amazonAccountsAddMode = false;
  invalidateAmazonUpdateCheck();
  await loadAmazonSession(false);
  toast(t("amazon.previousRestored"), "ok");
}

/**
 * Loads the account state and library. `sync` refreshes the library from
 * Amazon first; without it the cached Nile library is instant.
 */
export async function loadAmazonSession(sync = false): Promise<void> {
  if (!isTauri) return;
  try {
    let status = await nileAuthStatus();
    if (!status.logged_in) {
      const saved = await amazonSavedAccounts().catch(() => []);
      S.amazonSavedAccounts = saved;
      // An interrupted add/switch leaves archives but no live session; the
      // newest saved session takes over again.
      if (saved.length > 0 && !S.amazonAccountsAddMode) {
        try {
          await amazonSwitchAccount(saved[0].user_id);
          status = await nileAuthStatus();
        } catch {
          // Stay signed out.
        }
      }
    }
    S.amazonStatus = status;
    S.amazonAccountId = status.logged_in ? status.user_id : null;
    if (status.logged_in) {
      try {
        S.amazonGames = await nileLibrary(sync);
      } catch {
        // Keep the previous list when the refresh fails.
      }
      await loadSavedAmazonAccounts();
    } else {
      S.amazonGames = [];
      S.amazonAccountId = null;
    }
    setAmazonSummaries(S.amazonGames.map(amazonToLibraryItem));
    if (status.logged_in) void refreshAmazonUpdates();
  } catch {
    // Keep the last state.
  }
  scheduleRender();
}

/** Every saved Amazon account, active first. */
export async function loadSavedAmazonAccounts(): Promise<SavedAmazonAccount[]> {
  try {
    const list = await amazonSavedAccounts();
    S.amazonSavedAccounts = list;
    return list;
  } catch {
    return S.amazonSavedAccounts;
  }
}

/** Shows the sign-in block on the Amazon card to add another account. */
export function promptAddAmazonAccount(): void {
  S.amazonAccountsAddMode = true;
  scheduleRender();
}

export function cancelAddAmazonAccount(): void {
  S.amazonAccountsAddMode = false;
  // An interrupted add flow left the previous session archived; restore it.
  void loadAmazonSession(false);
}

let amazonSwitching = false;

/** Restores one saved Amazon account and reloads its library. */
export async function switchAmazonAccount(userId: string): Promise<void> {
  if (amazonSwitching || !userId || userId === S.amazonAccountId) return;
  if (accountChangeBlocked()) return;
  amazonSwitching = true;
  S.amazonBusy = true;
  scheduleRender();
  try {
    const result = await amazonSwitchAccount(userId);
    S.amazonAccountId = result.user_id;
    S.amazonAccountsAddMode = false;
    S.amazonProgress.clear();
    setAmazonSummaries([]);
    invalidateAmazonUpdateCheck();
    await loadAmazonSession(false);
    toast(t("settings.accountSwitched", { name: result.username }), "ok");
  } catch (err) {
    toast(String(err), "err");
  } finally {
    amazonSwitching = false;
    S.amazonBusy = false;
    scheduleRender();
  }
}

/**
 * Removes one saved account. Removing the active one signs it out and Rust
 * restores the most recently used remaining account, if any.
 */
export async function removeSavedAmazonAccount(userId: string): Promise<void> {
  if (accountChangeBlocked()) return;
  try {
    await amazonRemoveSavedAccount(userId);
    await loadAmazonSession(false);
    toast(t("settings.accountRemoved"), "ok");
  } catch (err) {
    toast(String(err), "err");
  }
}

/** Reads the Amazon install folder and its default so installs and settings agree. */
export async function loadAmazonInstallDir(): Promise<void> {
  if (!isTauri) return;
  try {
    const [dir, fallback] = await Promise.all([
      amazonGetInstallDir().catch(() => null),
      amazonDefaultInstallDir().catch(() => ""),
    ]);
    S.amazonInstallDir = dir || "";
    S.amazonDefaultDir = fallback || "";
  } catch {
    // Keep the last values.
  }
}

/**
 * Mirrors Nile's live-version check onto the library items so the update badge
 * and the card's Update button agree. Offline or rate-limited calls keep the
 * previous state.
 */
/** Nile's live-version check is a network round trip; keep it to one run per
 *  interval, and never two at once, so session loads stay cheap. */
const AMAZON_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
let lastAmazonUpdateCheck = 0;
let amazonUpdateCheck: Promise<void> | null = null;

/** Lets the next session load refresh live versions, e.g. after an install. */
export function invalidateAmazonUpdateCheck(): void {
  lastAmazonUpdateCheck = 0;
}

async function refreshAmazonUpdates(): Promise<void> {
  if (amazonUpdateCheck) return amazonUpdateCheck;
  if (Date.now() - lastAmazonUpdateCheck < AMAZON_UPDATE_INTERVAL_MS) return;
  lastAmazonUpdateCheck = Date.now();
  amazonUpdateCheck = (async () => {
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
  })().finally(() => {
    amazonUpdateCheck = null;
  });
  return amazonUpdateCheck;
}

/** Signs out the active account; a newer saved account takes over if present. */
export async function amazonLogoutAction(): Promise<void> {
  if (accountChangeBlocked()) return;
  const activeId =
    S.amazonSavedAccounts.find((a) => a.is_active)?.user_id ?? S.amazonAccountId;
  try {
    await nileLogout();
  } catch {
    // Ignore: the local state is cleared either way.
  }
  if (activeId) {
    // The logout revoked this account's tokens, so its archive goes too. Rust
    // restores the most recently used remaining account, if any.
    try {
      await amazonRemoveSavedAccount(activeId);
    } catch {
      // The fallback still happens on the next session load.
    }
  }
  S.amazonLogin = null;
  S.amazonAccountsAddMode = false;
  S.amazonProgress.clear();
  await loadAmazonSession(false);
}

/**
 * Clears the live download state of one Amazon install. The `nile-progress`
 * listener also feeds `S.activeDlMetrics`, so finishing must clear that too or
 * the Downloads hero card stays on a game that is already installed.
 */
function clearAmazonDownload(key: string): void {
  S.amazonProgress.delete(key);
  S.downloads.delete(key);
  if (S.activeDlMetrics?.id === key) {
    S.activeDlMetrics = null;
    S.speedHistory.fill(0);
    S.diskHistory.fill(0);
    stopSpeedChartTimer();
  }
  updateBadge();
}

/** Installs or updates one Amazon game; progress streams in as events. */
export async function installAmazonGame(id: string): Promise<void> {
  const key = amazonKey(id);
  const title = S.amazonGames.find((g) => g.id === id)?.title || id;
  S.amazonProgress.set(key, { percent: 0, speed: 0 });
  // The Downloads page picks the first unfinished entry as the active card.
  S.downloads.set(key, { progress: 0, done: false, title });
  updateBadge();
  scheduleRender();
  try {
    await nileInstall(id, S.amazonInstallDir || S.amazonDefaultDir || null);
    clearAmazonDownload(key);
    toast(t("amazon.installed"), "ok");
    invalidateAmazonUpdateCheck();
    await loadAmazonSession(false);
  } catch (err) {
    clearAmazonDownload(key);
    toast(String(err), "err");
    scheduleRender();
  }
}

/** Imports an Amazon game installed outside Nile (an older client's folder). */
export async function importAmazonGame(id: string, installPath: string): Promise<void> {
  try {
    await nileImport(id, installPath);
    toast(t("amazon.imported"), "ok");
    invalidateAmazonUpdateCheck();
    await loadAmazonSession(false);
  } catch (err) {
    toast(String(err), "err");
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
    invalidateAmazonUpdateCheck();
    await loadAmazonSession(false);
  } catch (err) {
    toast(String(err), "err");
  }
}
