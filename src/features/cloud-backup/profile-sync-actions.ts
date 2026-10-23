/**
 * Launcher profile export/import and cloud sync. A profile archive carries the
 * custom games, collections, playtime, achievements, notes, themes and settings;
 * secrets and machine-specific install paths stay out of it.
 */

import { relaunch } from "@tauri-apps/plugin-process";
import { askConfirm } from "../../core/confirm-dialog";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { customGamesPickFile } from "../../custom-games";
import { t } from "../../i18n";
import {
  cloudBackupSaveSettings,
  epicOpenFolderPath,
  epicSelectFolderDialog,
  profileCloudList,
  profileCloudRestore,
  profileCloudUpload,
  profileExport,
  profileImport,
  type ProfileRestoreResult,
} from "../../epic";

function fmtCloudDate(timestamp: number): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** localStorage keys that should never leave the machine. */
const PRIVATE_KEY = /(token|secret|password|webhook|api[_-]?key|steamart|steamhero|_cache)/i;
const PROFILE_KEY = /^(efxlve|efx\.)/i;

export function collectProfileLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !PROFILE_KEY.test(key) || PRIVATE_KEY.test(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

function applyProfileLocalStorage(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && PROFILE_KEY.test(key) && !PRIVATE_KEY.test(key)) {
      localStorage.setItem(key, value);
    }
  }
}

async function finishRestore(result: ProfileRestoreResult): Promise<void> {
  applyProfileLocalStorage(result.localStorage);
  toast(t("profile.done"), "ok");
  // The backend files are on disk; a relaunch reloads every store and theme.
  window.setTimeout(() => {
    void relaunch().catch(() => window.location.reload());
  }, 700);
}

export async function exportProfileAction(): Promise<void> {
  const folder = await epicSelectFolderDialog(null, t("profile.pickFolder")).catch(() => null);
  if (!folder) return;
  try {
    const path = await profileExport(folder, collectProfileLocalStorage());
    toast(t("profile.exported", { path }), "ok");
    await epicOpenFolderPath(folder).catch(() => undefined);
  } catch (error) {
    toast(String(error), "err");
  }
}

export async function importProfileAction(): Promise<void> {
  const path = await customGamesPickFile(undefined, t("profile.pickFile")).catch(() => null);
  if (!path) return;
  const proceed = await askConfirm({
    title: t("profile.import"),
    body: t("profile.importConfirm"),
    confirm: t("profile.restore"),
    cancel: t("common.cancel"),
  });
  if (!proceed) return;
  try {
    const result = await profileImport(path);
    await finishRestore(result);
  } catch (error) {
    toast(String(error), "err");
  }
}

export async function loadProfileArchivesAction(force = false): Promise<void> {
  if (S.launcherProfileLoading) return;
  if (!force && S.launcherProfileArchives !== null) return;
  const settings = S.cloudBackupSettings;
  if (!settings || !settings.enabled || settings.provider === "none") {
    S.launcherProfileArchives = [];
    return;
  }
  S.launcherProfileLoading = true;
  try {
    S.launcherProfileArchives = await profileCloudList();
  } catch {
    S.launcherProfileArchives = [];
  } finally {
    S.launcherProfileLoading = false;
    scheduleRender();
  }
}

let profileUploadTimer: number | null = null;

/** Starts the daily profile upload loop. Safe to call more than once. */
export function scheduleProfileUploads(): void {
  if (profileUploadTimer !== null) return;
  const run = () => {
    void runScheduledProfileUpload();
  };
  window.setTimeout(run, 60_000);
  profileUploadTimer = window.setInterval(run, 6 * 60 * 60 * 1000);
}

export function runProfileUploadNow(): void {
  void runScheduledProfileUpload();
}

async function runScheduledProfileUpload(): Promise<void> {
  const settings = S.cloudBackupSettings;
  if (!settings?.profileDailyUpload || !settings.enabled || settings.provider === "none") return;
  const now = Math.floor(Date.now() / 1000);
  if (settings.lastProfileUpload && now - settings.lastProfileUpload < 24 * 60 * 60) return;
  try {
    const entry = await profileCloudUpload(collectProfileLocalStorage());
    S.launcherProfileArchives = [entry, ...(S.launcherProfileArchives ?? [])].slice(0, 5);
    const next = { ...settings, lastProfileUpload: now };
    await cloudBackupSaveSettings(next);
    S.cloudBackupSettings = next;
    scheduleRender();
  } catch {
    // A failed automatic upload must not interrupt the launcher; the next run retries.
  }
}

export async function uploadProfileAction(): Promise<void> {
  const settings = S.cloudBackupSettings;
  if (!settings || !settings.enabled || settings.provider === "none") {
    toast(t("profile.noCloud"), "err");
    return;
  }
  try {
    const entry = await profileCloudUpload(collectProfileLocalStorage());
    S.launcherProfileArchives = [entry, ...(S.launcherProfileArchives ?? [])].slice(0, 5);
    if (S.cloudBackupSettings) {
      const next = { ...S.cloudBackupSettings, lastProfileUpload: Math.floor(Date.now() / 1000) };
      await cloudBackupSaveSettings(next);
      S.cloudBackupSettings = next;
    }
    toast(t("profile.uploaded", { date: fmtCloudDate(entry.timestamp) }), "ok");
    scheduleRender();
  } catch (error) {
    toast(String(error), "err");
  }
}

export async function restoreProfileFromCloudAction(): Promise<void> {
  const latest = S.launcherProfileArchives?.[0];
  if (!latest) {
    toast(t("profile.none"), "");
    return;
  }
  const proceed = await askConfirm({
    title: t("profile.restore"),
    body: t("profile.restoreConfirm", { date: fmtCloudDate(latest.timestamp) }),
    confirm: t("profile.restore"),
    cancel: t("common.cancel"),
  });
  if (!proceed) return;
  try {
    const result = await profileCloudRestore(latest.remoteId, latest.backupId);
    await finishRestore(result);
  } catch (error) {
    toast(String(error), "err");
  }
}
