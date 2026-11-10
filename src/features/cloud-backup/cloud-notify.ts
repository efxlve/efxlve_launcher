/**
 * Cloud tab rows for save backups and restores.
 *
 * Every path that writes a save (manual, automatic, bulk, local or cloud)
 * reports through this file, so the notification tab is one history instead of
 * whichever action happened to remember a toast.
 */

import { libraryItemOf } from "../../core/selectors";
import { S } from "../../core/state";
import { localizeMessage, t } from "../../i18n";
import { pushNotification } from "../notifications/notifications";

type CloudKind = "cloud" | "cloud-error";

/** Title of a game in the same order the rest of the launcher resolves it. */
export function cloudGameTitle(appName: string): string {
  return libraryItemOf(appName)?.title ?? S.epicSummariesMap.get(appName)?.title ?? appName;
}

function body(detail?: string): string | undefined {
  const text = detail ? localizeMessage(detail).trim() : "";
  return text || undefined;
}

function push(kind: CloudKind, title: string, appName?: string, detail?: string): void {
  pushNotification({ kind, title, appName, body: body(detail) });
}

function failedList(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const shown = titles.slice(0, 5).join(", ");
  return t("notif.cloudFailedGames", { list: titles.length > 5 ? `${shown}…` : shown });
}

export function notifyCloudUploadDone(appName: string, unchanged = false): void {
  const title = cloudGameTitle(appName);
  push(
    "cloud",
    t(unchanged ? "notif.cloudUploadUnchanged" : "notif.backupCloudDone", { title }),
    appName,
  );
}

export function notifyCloudUploadFailed(appName: string, detail?: string): void {
  push("cloud-error", t("notif.cloudSyncFailed", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyCloudRestoreDone(appName: string, detail?: string): void {
  push("cloud", t("notif.cloudRestoreDone", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyCloudRestoreFailed(appName: string, detail?: string): void {
  push("cloud-error", t("notif.cloudRestoreFailed", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyLocalBackupDone(appName: string): void {
  push("cloud", t("notif.backupLocalDone", { title: cloudGameTitle(appName) }), appName);
}

export function notifyLocalBackupFailed(appName: string, detail?: string): void {
  push("cloud-error", t("notif.backupFailed", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyLocalRestoreDone(appName: string, detail?: string): void {
  push("cloud", t("notif.localRestoreDone", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyLocalRestoreFailed(appName: string, detail?: string): void {
  push("cloud-error", t("notif.localRestoreFailed", { title: cloudGameTitle(appName) }), appName, detail);
}

export function notifyBulkCloudBackupDone(total: number, failed: number, failedTitles: string[]): void {
  push(
    failed > 0 ? "cloud-error" : "cloud",
    t("cloud.bulkDone", { total, failed }),
    undefined,
    failedList(failedTitles),
  );
}

export function notifyBulkCloudRestoreDone(total: number, failed: number, failedTitles: string[]): void {
  push(
    failed > 0 ? "cloud-error" : "cloud",
    t("cloud.bulkRestoreDone", { total, failed }),
    undefined,
    failedList(failedTitles),
  );
}

/** One row for a local bulk backup instead of one row per installed game. */
export function notifyLocalBackupSummary(
  total: number,
  failed: number,
  failedTitles: string[],
  titleKey = "cloud.localBackupTitle",
  skipped = 0,
): void {
  const summary =
    skipped > 0
      ? t("cloud.localDailyDone", {
          created: Math.max(0, total - skipped - failed),
          skipped,
          failed,
        })
      : t("cloud.bulkDone", { total, failed });
  const failures = failedList(failedTitles);
  push(
    failed > 0 ? "cloud-error" : "cloud",
    t(titleKey),
    undefined,
    failures ? `${summary} · ${failures}` : summary,
  );
}

export function notifyProfileUploadDone(date: string): void {
  push("cloud", t("profile.uploaded", { date }));
}

export function notifyProfileUploadFailed(detail?: string): void {
  push("cloud-error", t("notif.profileCloudFailed"), undefined, detail);
}

export function notifyProfileRestoreDone(): void {
  push("cloud", t("profile.done"));
}

export function notifyProfileRestoreFailed(detail?: string): void {
  push("cloud-error", t("notif.profileCloudRestoreFailed"), undefined, detail);
}
