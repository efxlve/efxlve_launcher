/**
 * Launcher self-update manager.
 *
 * Steam-like flow on top of Tauri's official updater plugin:
 * - checks on startup (single delayed shot, never a loop) and when the window
 *   regains focus, throttled to once per hour (Epic-like, zero idle cost);
 * - downloads the new release silently in the background when auto-update is on;
 * - installs only when the user asks, and never while a game download or a
 *   running game would be interrupted by the launcher restart.
 *
 * The update feed is the static `latest.json` published with GitHub Releases by
 * `tauri-action` (see `.github/workflows/release.yml`).
 */

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { APP_AUTO_UPDATE_KEY, isTauri } from "../../core/constants";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { pushNotification } from "../notifications/notifications";

/** Focus-triggered re-checks are limited to one per hour. */
const CHECK_THROTTLE_MS = 60 * 60 * 1000;
/** Delay after startup so the check never competes with the library boot. */
const STARTUP_CHECK_DELAY_MS = 12_000;

let pendingUpdate: Update | null = null;
let checkInFlight = false;

/** True while a launcher restart would kill an active game download or session. */
export function appUpdateInstallBlocked(): boolean {
  if (S.runningGames.size > 0) return true;
  if (S.dlQueueStatus.queue.length > 0) return true;
  for (const dl of S.downloads.values()) {
    if (!dl.done) return true;
  }
  return S.activeDlMetrics !== null;
}

/** In-place progress update (Rule 15: never re-render the whole view). */
function updateProgressDom(): void {
  const bar = document.getElementById("app-update-bar");
  const pct = document.getElementById("app-update-pct");
  if (bar) bar.style.width = `${S.appUpdateProgress}%`;
  if (pct) pct.textContent = `${S.appUpdateProgress}%`;
}

/** One-shot startup check plus throttled focus checks. */
export async function initAppUpdater(): Promise<void> {
  if (!isTauri) return;
  try {
    S.appVersion = await getVersion();
  } catch {
    // Keep the bundled fallback version.
  }
  window.setTimeout(() => {
    void checkForAppUpdate(false);
  }, STARTUP_CHECK_DELAY_MS);
  window.addEventListener("focus", () => {
    if (Date.now() - S.lastAppUpdateCheck < CHECK_THROTTLE_MS) return;
    void checkForAppUpdate(false);
  });
}

/** Queries the update feed. `manual` surfaces checking/error feedback in the UI. */
export async function checkForAppUpdate(manual = false): Promise<void> {
  if (!isTauri || checkInFlight || S.offlineMode) return;
  if (S.appUpdateStatus === "downloading" || S.appUpdateStatus === "ready") return;
  checkInFlight = true;
  S.lastAppUpdateCheck = Date.now();
  if (manual) {
    S.appUpdateStatus = "checking";
    S.appUpdateError = "";
    scheduleRender();
  }
  try {
    const update = await check();
    if (!update) {
      pendingUpdate = null;
      S.appUpdateStatus = "idle";
      S.appUpdateVersion = "";
      S.appUpdateNotes = "";
      if (manual) toast(t("appUpdate.upToDate", { version: S.appVersion }), "ok");
      return;
    }
    pendingUpdate = update;
    S.appUpdateVersion = update.version;
    S.appUpdateNotes = update.body || "";
    S.appUpdateStatus = "available";
    scheduleRender();
    pushNotification({
      kind: "update",
      title: t("appUpdate.available", { version: update.version }),
      body: t("appUpdate.availableBody"),
    });
    if (S.appAutoUpdate) void downloadAppUpdate();
  } catch (e) {
    if (manual) {
      S.appUpdateStatus = "error";
      S.appUpdateError = String(e);
      toast(t("appUpdate.checkFailed"), "err");
      scheduleRender();
    } else {
      console.warn("App update check failed:", e);
    }
  } finally {
    checkInFlight = false;
  }
}

/** Downloads the pending update silently and notifies when it is ready. */
export async function downloadAppUpdate(): Promise<void> {
  if (!isTauri || !pendingUpdate || S.appUpdateStatus === "downloading") return;
  if (S.appUpdateStatus === "ready") return;
  S.appUpdateStatus = "downloading";
  S.appUpdateProgress = 0;
  S.appUpdateDownloaded = 0;
  S.appUpdateTotal = 0;
  scheduleRender();
  try {
    await pendingUpdate.download((event) => {
      if (event.event === "Started") {
        S.appUpdateTotal = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        S.appUpdateDownloaded += event.data.chunkLength;
        S.appUpdateProgress =
          S.appUpdateTotal > 0
            ? Math.min(99, Math.round((S.appUpdateDownloaded / S.appUpdateTotal) * 100))
            : 0;
        updateProgressDom();
      } else if (event.event === "Finished") {
        S.appUpdateProgress = 100;
        updateProgressDom();
      }
    });
    S.appUpdateStatus = "ready";
    scheduleRender();
    const blocked = appUpdateInstallBlocked();
    pushNotification({
      kind: "update",
      title: t("appUpdate.ready", { version: S.appUpdateVersion }),
      body: blocked ? t("appUpdate.readyBlockedBody") : t("appUpdate.readyBody"),
      action: "app-update-install",
    });
  } catch (e) {
    S.appUpdateStatus = "error";
    S.appUpdateError = String(e);
    scheduleRender();
    pushNotification({ kind: "error", title: t("appUpdate.downloadFailed") });
  }
}

/** Installs the downloaded update and restarts the launcher. */
export async function installAppUpdate(): Promise<void> {
  if (!isTauri || !pendingUpdate || S.appUpdateStatus !== "ready") return;
  if (appUpdateInstallBlocked()) {
    toast(t("appUpdate.deferred"), "");
    return;
  }
  try {
    await pendingUpdate.install();
    await relaunch();
  } catch (e) {
    S.appUpdateStatus = "error";
    S.appUpdateError = String(e);
    scheduleRender();
    toast(t("appUpdate.installFailed"), "err");
  }
}

/** Persists the auto-download preference and starts a pending download if any. */
export function setAppAutoUpdate(enabled: boolean): void {
  S.appAutoUpdate = enabled;
  localStorage.setItem(APP_AUTO_UPDATE_KEY, String(enabled));
  if (enabled && S.appUpdateStatus === "available") void downloadAppUpdate();
}
