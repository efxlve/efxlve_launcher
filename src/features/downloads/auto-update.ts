/**
 * Scheduled automatic updates.
 *
 * Uses a single precisely-timed `setTimeout` for the next occurrence of the
 * configured time (no idle polling). When it fires, every pending update is
 * queued and the timer is rescheduled for the following day. Runs only while
 * the launcher is open (the tray keeps it alive in the background).
 */

import { epicInstall } from "../../core/epic-actions";
import { gogInstallGame } from "../../gog";
import { installAmazonGame } from "../auth/amazon-auth-actions";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { pushNotification } from "../notifications/notifications";

let timer: number | null = null;

/** Milliseconds until the next HH:MM occurrence, or -1 when the time is invalid. */
function msUntilNext(time: string): number {
  const [hRaw, mRaw] = time.split(":");
  const h = parseInt(hRaw, 10);
  const m = parseInt(mRaw, 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return -1;
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** (Re)schedules the next automatic update run. */
export function scheduleAutoUpdate(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!S.autoUpdateEnabled) return;
  const ms = msUntilNext(S.autoUpdateTime);
  if (ms < 0) return;
  timer = window.setTimeout(() => {
    void runAutoUpdate();
    scheduleAutoUpdate();
  }, ms);
}

/** Queues every pending update (skips while a download is already running). */
async function runAutoUpdate(): Promise<void> {
  if (S.activeDlMetrics || S.dlQueueStatus.queue.length > 0) return;
  const epicUpdates = [...S.availableUpdates.values()];
  const gogUpdates = S.gogSummaries.filter((g) => g.installed && g.updateAvailable);
  const amazonUpdates = S.amazonSummaries.filter((g) => g.installed && g.updateAvailable);
  const n = epicUpdates.length + gogUpdates.length + amazonUpdates.length;
  if (n === 0) return;
  pushNotification({ kind: "info", title: t("sched.starting", { n }) });
  for (const u of epicUpdates) {
    try {
      await epicInstall(u.appName);
    } catch {
      // Queue conflicts (another active download) are expected and harmless.
    }
  }
  for (const g of gogUpdates) {
    try {
      await gogInstallGame(`gog::${g.id}`);
    } catch {
      /* same: another active download is expected */
    }
  }
  for (const g of amazonUpdates) {
    try {
      await installAmazonGame(g.id);
    } catch {
      /* same: another active download is expected */
    }
  }
}

/** Called once at startup. */
export function initAutoUpdate(): void {
  scheduleAutoUpdate();
}
