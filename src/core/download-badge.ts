/**
 * Download badge arithmetic shared by the sidebar and the Full Screen top bar.
 *
 * Downloads and waiting game updates are different things: a count of one on
 * the Downloads entry should not look like a transfer when nothing is moving.
 */

import { pendingGameUpdates } from "./selectors";
import { S } from "./state";

export interface DownloadBadgeCounts {
  /** Downloads currently moving. */
  active: number;
  /** Games waiting behind the active download. */
  queued: number;
  /** Steam client downloads in progress. */
  steam: number;
  /** Installed games with a newer build waiting. */
  updates: number;
  /** Active + queued + Steam; the number the sidebar badge shows as downloads. */
  downloads: number;
  /** Downloads plus updates. */
  total: number;
}

/** Last pending-update total. Byte progress does not rescan the library. */
let lastPendingUpdates = -1;

export function downloadBadgeCounts(scope: "full" | "progress" = "full"): DownloadBadgeCounts {
  let active = 0;
  // `S.downloads` holds queued installs too; the queue length is added below,
  // so counting those here showed two badges for one queued game.
  const queuedIds = new Set(S.dlQueueStatus.queue);
  for (const [id, d] of S.downloads) {
    if (!d.done && !queuedIds.has(id)) active++;
  }
  let steam = 0;
  for (const g of S.steamGames) if (g.downloading) steam++;
  if (scope === "full" || lastPendingUpdates < 0) lastPendingUpdates = pendingGameUpdates().length;
  const queued = S.dlQueueStatus.queue.length;
  const downloads = active + queued + steam;
  return {
    active,
    queued,
    steam,
    updates: lastPendingUpdates,
    downloads,
    total: downloads + lastPendingUpdates,
  };
}
