/**
 * Bulk achievement-summary pass shared by every page that needs per-game trophy
 * counts (library covers, the profile, store sections).
 *
 * The four stores keep their sets on disk, so one parallel pass answers them
 * all. Boot, the first library sync, a manual refresh and the profile used to
 * start their own copy; this module owns the in-flight promise and a short TTL
 * so those callers share a single disk pass instead of racing four each.
 */

import { applyAchievementEditsToSummaries } from "./achievement-edits";
import { isTauri } from "./constants";
import { scheduleRender } from "./render";
import { S } from "./state";
import { currentLanguage } from "../i18n";
import { epicGetAchievementsSummary } from "../epic";
import { gogGetAchievementsSummary } from "../gog";
import { steamGetAchievementsSummary } from "../steam";
import { companionAchievementsSummary } from "../companion";

let summariesInFlight: Promise<void> | null = null;
let summariesAt = 0;
/** A boot/sync pair used to run the same four disk passes twice in a row. */
const SUMMARIES_TTL_MS = 30_000;

/**
 * One bulk achievement pass at a time, reused for a short window.
 *
 * Concurrent callers share the pass; a caller inside the TTL gets the answer
 * from the previous one. `force` is for an account switch or a new store link,
 * where the old account's numbers must not be reused.
 */
export function loadEpicAchSummaries(force = false, repaint = true): Promise<void> {
  if (!isTauri) return Promise.resolve();
  if (summariesInFlight) {
    if (!force) return summariesInFlight;
    return summariesInFlight.finally(() => loadEpicAchSummaries(true, repaint));
  }
  if (!force && summariesAt > 0 && Date.now() - summariesAt < SUMMARIES_TTL_MS) {
    return Promise.resolve();
  }
  summariesInFlight = (async () => {
    try {
      const [epicSummaries, gogSummaries, steamSummaries, ubiSummaries] = await Promise.all([
        epicGetAchievementsSummary().catch(() => ({})),
        gogGetAchievementsSummary().catch(() => ({})),
        // Steam summaries come from the disk cache: no key or network needed.
        steamGetAchievementsSummary().catch(() => ({})),
        // Ubisoft also keeps its sets on disk, so the bulk pass is offline.
        // Xbox and EA answer per game over the network and stay out of this map.
        companionAchievementsSummary("ubisoft", currentLanguage()).catch(() => ({})),
      ]);
      S.epicAchSummaries = { ...epicSummaries, ...gogSummaries, ...steamSummaries, ...ubiSummaries };
      // Local edits survive a restart as a count delta, so covers and the
      // profile agree with the game page before it is opened again.
      applyAchievementEditsToSummaries(S.epicAchSummaries);
      summariesAt = Date.now();
      S.libraryDataRev++;
      if (repaint && (S.view === "library" || S.view === "profile")) scheduleRender();
    } catch (e) {
      console.warn("Achievement summaries could not be fetched:", e);
    } finally {
      summariesInFlight = null;
    }
  })();
  return summariesInFlight;
}
